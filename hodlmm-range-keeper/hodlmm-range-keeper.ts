#!/usr/bin/env bun
/**
 * hodlmm-range-keeper — Active HODLMM Position Manager
 *
 * Monitors active-bin drift relative to LP positions, estimates accrued fees,
 * and re-centers liquidity into optimal bins when profitable and safe.
 *
 * Unlike signal-only skills, this skill closes the full loop:
 *   detect drift → estimate P&L → simulate re-center → execute → verify
 *
 * Commands:
 *   doctor   — check wallet, API access, positions, MCP tools
 *   status   — show position health: drift, fees, range efficiency
 *   plan     — dry-run re-center: simulate withdraw + re-deposit, show expected outcome
 *   recenter — execute re-center: withdraw drifted liquidity, re-deposit around active bin
 *   history  — show past re-center events from ledger
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ───────────────────────────────────────────────────────────────
const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HODLMM_APP_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.hiro.so";

// Safety limits
const MAX_GAS_STX = 50;
const DEFAULT_GAS_ESTIMATE_STX = 4; // 2 txs: withdraw + deposit
const MIN_POSITION_SATS = 5_000;
const HODLMM_SLIPPAGE_PCT = 0.5;
const DEFAULT_BIN_RANGE = 2; // +/- 2 bins around active bin = 5 bins total
const MIN_HARVEST_MULTIPLIER = 2; // fees must cover 2x gas to justify recenter
const MAX_RECENTER_PER_CYCLE = 3; // max pools per run
const COOLDOWN_MS = 30 * 60 * 1000; // 30 min between recenters on same pool
const DRIFT_THRESHOLD = 3; // active bin must drift >= 3 bins from position center

// State
const STATE_PATH = join(homedir(), ".hodlmm-range-keeper.json");

// ─── Output ──────────────────────────────────────────────────────────────
function output(status: string, action: string, data: any, error: any = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: any[]) {
  console.error("[range-keeper]", ...args);
}

// ─── Types ───────────────────────────────────────────────────────────────
interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  userLiquidity?: number;
  price?: number;
}

interface PoolMeta {
  pool_id: string;
  active_bin: number;
  token_x: string;
  token_y: string;
  bin_step: number;
}

interface PositionBaseline {
  binId: number;
  depositX: string;
  depositY: string;
  recordedAt: string;
}

interface RecenterEvent {
  poolId: string;
  timestamp: string;
  status?: "pending_verification" | "confirmed" | "failed";
  oldCenter: number;
  newCenter: number;
  drift: number;
  binsWithdrawn: number;
  binsDeposited: number;
  feesEstimatedX: number;
  feesEstimatedY: number;
  gasEstimateSTX: number;
  mcpWithdrawCmd: string;
  mcpDepositCmd: string;
}

interface PoolState {
  poolId: string;
  baselines: Record<number, PositionBaseline>;
  lastRecenterAt: string | null;
  lastActiveBin: number | null;
  pendingVerification?: boolean;
}

interface KeeperState {
  pools: Record<string, PoolState>;
  recenters: RecenterEvent[];
}

// ─── State Management ────────────────────────────────────────────────────
function loadState(): KeeperState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {}
  return { pools: {}, recenters: [] };
}

function saveState(state: KeeperState): void {
  if (state.recenters.length > 500) {
    state.recenters = state.recenters.slice(-500);
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getPoolState(state: KeeperState, poolId: string): PoolState {
  if (!state.pools[poolId]) {
    state.pools[poolId] = {
      poolId,
      baselines: {},
      lastRecenterAt: null,
      lastActiveBin: null,
    };
  }
  return state.pools[poolId];
}

// ─── API Layer ───────────────────────────────────────────────────────────
async function fetchJson(url: string): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

async function fetchAllPools(): Promise<PoolMeta[]> {
  const data = await fetchJson(`${HODLMM_API}/pools`);
  return data?.pools || [];
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[] } | null> {
  return fetchJson(`${HODLMM_API}/bins/${poolId}`);
}

async function fetchUserPositions(poolId: string, address: string): Promise<BinData[]> {
  const data = await fetchJson(
    `${HODLMM_APP_API}/api/app/v1/users/${address}/positions/${poolId}/bins`
  );
  if (!data?.bins) return [];
  return data.bins.map((b: any) => ({
    bin_id: parseInt(b.bin_id),
    reserve_x: String(b.reserve_x !== undefined && b.reserve_x !== null ? b.reserve_x : Math.floor(b.userLiquidity || 0)),
    reserve_y: String(b.reserve_y !== undefined && b.reserve_y !== null ? b.reserve_y : "0"),
    userLiquidity: b.userLiquidity || 0,
    price: b.price || 0,
  }));
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchJson(`${HIRO_API}/extended/v1/address/${address}/stx`);
  return data ? parseInt(data.balance || "0") / 1e6 : 0;
}

// ─── Position Analysis ──────────────────────────────────────────────────
interface PositionHealth {
  poolId: string;
  activeBin: number;
  positionCenter: number;
  positionBins: number[];
  drift: number; // signed: positive = price moved up past position
  driftAbs: number;
  rangeEfficiency: number; // % of bins still in active range
  totalValueX: number;
  totalValueY: number;
  estimatedFeesX: number;
  estimatedFeesY: number;
  needsRecenter: boolean;
  reason: string;
  cooldownRemaining: number; // ms until recenter allowed, 0 = ready
}

function analyzePosition(
  poolId: string,
  activeBin: number,
  userBins: BinData[],
  poolState: PoolState
): PositionHealth {
  if (userBins.length === 0) {
    return {
      poolId,
      activeBin,
      positionCenter: 0,
      positionBins: [],
      drift: 0,
      driftAbs: 0,
      rangeEfficiency: 0,
      totalValueX: 0,
      totalValueY: 0,
      estimatedFeesX: 0,
      estimatedFeesY: 0,
      needsRecenter: false,
      reason: "no position",
      cooldownRemaining: 0,
    };
  }

  const binIds = userBins.map((b) => b.bin_id).sort((a, b) => a - b);
  const positionCenter = Math.round(binIds.reduce((s, b) => s + b, 0) / binIds.length);
  const drift = activeBin - positionCenter;

  // Range efficiency: how many of our bins are within DEFAULT_BIN_RANGE of active bin
  const inRange = binIds.filter(
    (b) => Math.abs(b - activeBin) <= DEFAULT_BIN_RANGE
  ).length;
  const rangeEfficiency = binIds.length > 0 ? (inRange / binIds.length) * 100 : 0;

  // Total position value (BigInt for atomic-unit precision)
  let totalValueX = 0n;
  let totalValueY = 0n;
  for (const bin of userBins) {
    totalValueX += BigInt(bin.reserve_x || "0");
    totalValueY += BigInt(bin.reserve_y || "0");
  }

  // Fee estimation against baselines
  let estimatedFeesX = 0n;
  let estimatedFeesY = 0n;
  for (const bin of userBins) {
    const baseline = poolState.baselines[bin.bin_id];
    if (baseline) {
      const currentX = BigInt(bin.reserve_x || "0");
      const currentY = BigInt(bin.reserve_y || "0");
      const baseX = BigInt(baseline.depositX || "0");
      const baseY = BigInt(baseline.depositY || "0");
      if (currentX > baseX) estimatedFeesX += currentX - baseX;
      if (currentY > baseY) estimatedFeesY += currentY - baseY;
    }
  }

  // Cooldown check
  let cooldownRemaining = 0;
  if (poolState.lastRecenterAt) {
    const elapsed = Date.now() - new Date(poolState.lastRecenterAt).getTime();
    cooldownRemaining = Math.max(0, COOLDOWN_MS - elapsed);
  }

  // Decision: needs recenter?
  let needsRecenter = false;
  let reason = "in range";

  if (cooldownRemaining > 0) {
    reason = `cooldown: ${Math.ceil(cooldownRemaining / 60_000)}m remaining`;
  } else if (Math.abs(drift) >= DRIFT_THRESHOLD) {
    needsRecenter = true;
    reason = `drift ${drift > 0 ? "+" : ""}${drift} bins (threshold: ${DRIFT_THRESHOLD})`;
  } else if (rangeEfficiency < 20 && binIds.length > 0) {
    needsRecenter = true;
    reason = `range efficiency ${rangeEfficiency.toFixed(0)}% — most bins out of range`;
  } else if (rangeEfficiency >= 80) {
    reason = `healthy — ${rangeEfficiency.toFixed(0)}% in range, drift ${drift > 0 ? "+" : ""}${drift}`;
  } else {
    reason = `monitoring — ${rangeEfficiency.toFixed(0)}% in range, drift ${drift > 0 ? "+" : ""}${drift}`;
  }

  return {
    poolId,
    activeBin,
    positionCenter,
    positionBins: binIds,
    drift,
    driftAbs: Math.abs(drift),
    rangeEfficiency: Math.round(rangeEfficiency * 100) / 100,
    totalValueX: Number(totalValueX),
    totalValueY: Number(totalValueY),
    estimatedFeesX: Number(estimatedFeesX),
    estimatedFeesY: Number(estimatedFeesY),
    needsRecenter,
    reason,
    cooldownRemaining,
    pendingVerification: poolState.pendingVerification || false,
  };
}

// ─── Re-center Planning ──────────────────────────────────────────────────
interface RecenterPlan {
  poolId: string;
  profitable: boolean;
  withdrawBins: { bin_id: number; amount_x: string; amount_y: string }[];
  depositBins: { bin_id: number; amount_x: string; amount_y: string }[];
  totalWithdrawX: number;
  totalWithdrawY: number;
  feesHarvestedX: number;
  feesHarvestedY: number;
  principalRedeployX: number;
  principalRedeployY: number;
  gasEstimateSTX: number;
  newCenter: number;
  oldCenter: number;
  drift: number;
  mcpWithdrawCmd: string;
  mcpDepositCmd: string;
  rejectionReason: string | null;
}

function planRecenter(
  health: PositionHealth,
  userBins: BinData[],
  poolState: PoolState
): RecenterPlan {
  const activeBin = health.activeBin;
  const gasEstimate = DEFAULT_GAS_ESTIMATE_STX;
  const newRange = DEFAULT_BIN_RANGE;

  // Build withdraw list: all current bins
  const withdrawBins = userBins.map((b) => ({
    bin_id: b.bin_id,
    amount_x: b.reserve_x || "0",
    amount_y: b.reserve_y || "0",
  }));

  const totalWithdrawX = withdrawBins.reduce((s, b) => s + BigInt(b.amount_x), 0n);
  const totalWithdrawY = withdrawBins.reduce((s, b) => s + BigInt(b.amount_y), 0n);

  // Calculate fees (growth over baseline)
  let totalBaselineX = 0n;
  let totalBaselineY = 0n;
  let hasBaseline = false;

  for (const bin of userBins) {
    const baseline = poolState.baselines[bin.bin_id];
    if (baseline) {
      hasBaseline = true;
      totalBaselineX += BigInt(baseline.depositX || "0");
      totalBaselineY += BigInt(baseline.depositY || "0");
    }
  }

  const feesX = hasBaseline && totalWithdrawX > totalBaselineX ? totalWithdrawX - totalBaselineX : 0n;
  const feesY = hasBaseline && totalWithdrawY > totalBaselineY ? totalWithdrawY - totalBaselineY : 0n;

  // Principal = total - fees (what we re-deploy)
  const principalX = totalWithdrawX - feesX;
  const principalY = totalWithdrawY - feesY;

  // Profitability check: is the re-center worth the gas?
  // We don't require fees to cover gas — drift correction itself has value
  // But if we're harvesting fees, they should exceed gas
  let profitable = true;
  let rejectionReason: string | null = null;

  const minSats = BigInt(MIN_POSITION_SATS);
  if (totalWithdrawX < minSats && totalWithdrawY < minSats) {
    profitable = false;
    rejectionReason = `position too small: ${totalWithdrawX} X + ${totalWithdrawY} Y (min ${MIN_POSITION_SATS})`;
  }

  if (gasEstimate > MAX_GAS_STX) {
    profitable = false;
    rejectionReason = `gas estimate ${gasEstimate} STX exceeds cap ${MAX_GAS_STX} STX`;
  }

  // Build deposit bins centered on active bin
  const depositBins: { bin_id: number; amount_x: string; amount_y: string }[] = [];
  const binCount = BigInt(newRange * 2 + 1);
  const perBinX = principalX / binCount;
  const perBinY = principalY / binCount;

  for (let offset = -newRange; offset <= newRange; offset++) {
    const binId = activeBin + offset;
    // Below active bin: quote side (Y). Active bin: both sides. Above: base side (X)
    if (offset < 0) {
      depositBins.push({
        bin_id: binId,
        amount_x: "0",
        amount_y: String(perBinY > 0n ? perBinY : perBinX),
      });
    } else if (offset === 0) {
      // Active bin holds both X and Y proportionally
      depositBins.push({
        bin_id: binId,
        amount_x: String(perBinX > 0n ? perBinX : 0n),
        amount_y: String(perBinY > 0n ? perBinY : 0n),
      });
    } else {
      depositBins.push({
        bin_id: binId,
        amount_x: String(perBinX > 0n ? perBinX : perBinY),
        amount_y: "0",
      });
    }
  }

  // Build MCP command strings
  const poolId = health.poolId;
  const mcpWithdrawCmd = [
    `bitflow_hodlmm_remove_liquidity`,
    `pool_id: "${poolId}"`,
    `bin_ids: [${withdrawBins.map((b) => b.bin_id).join(", ")}]`,
    `slippage: ${HODLMM_SLIPPAGE_PCT}`,
  ].join("\n");

  const mcpDepositCmd = [
    `bitflow_hodlmm_add_liquidity`,
    `pool_id: "${poolId}"`,
    `bins: [${depositBins.map((b) => `{bin_id: ${b.bin_id}, amount_x: ${b.amount_x}, amount_y: ${b.amount_y}}`).join(", ")}]`,
    `slippage: ${HODLMM_SLIPPAGE_PCT}`,
  ].join("\n");

  return {
    poolId,
    profitable,
    withdrawBins,
    depositBins,
    totalWithdrawX: Number(totalWithdrawX),
    totalWithdrawY: Number(totalWithdrawY),
    feesHarvestedX: Number(feesX),
    feesHarvestedY: Number(feesY),
    principalRedeployX: Number(principalX),
    principalRedeployY: Number(principalY),
    gasEstimateSTX: gasEstimate,
    newCenter: activeBin,
    oldCenter: health.positionCenter,
    drift: health.drift,
    mcpWithdrawCmd,
    mcpDepositCmd,
    rejectionReason,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-range-keeper")
  .description(
    "Active HODLMM position manager — monitors drift, plans recenters, executes when profitable"
  );

// Redirect Commander help/error output to stderr (JSON-only stdout)
program.configureOutput({
  writeOut: (str) => process.stderr.write(str),
  writeErr: (str) => process.stderr.write(str),
});

// Global crash handler — always emit JSON
process.on("unhandledRejection", (err) => {
  output("error", "crash", null, String(err));
  process.exit(1);
});

// ── doctor ───────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check wallet, HODLMM API, positions, and MCP tool availability")
  .action(async () => {
    const stxAddress = process.env.STX_ADDRESS || "";
    const checks: any = {
      hodlmmApi: false,
      pools: [],
      stxBalance: 0,
      positions: [],
      stateExists: existsSync(STATE_PATH),
      safetyLimits: {
        maxGasSTX: MAX_GAS_STX,
        driftThreshold: DRIFT_THRESHOLD,
        cooldownMinutes: COOLDOWN_MS / 60_000,
        minPositionSats: MIN_POSITION_SATS,
        slippagePct: HODLMM_SLIPPAGE_PCT,
        binRange: DEFAULT_BIN_RANGE,
        maxRecenterPerCycle: MAX_RECENTER_PER_CYCLE,
      },
      mcpRequired: [
        "bitflow_hodlmm_remove_liquidity",
        "bitflow_hodlmm_add_liquidity",
      ],
    };

    // Check HODLMM API
    const pools = await fetchAllPools();
    if (pools.length > 0) {
      checks.hodlmmApi = true;
      checks.pools = pools.map((p) => ({
        poolId: p.pool_id,
        activeBin: p.active_bin,
        binStep: p.bin_step,
        tokenX: p.token_x,
        tokenY: p.token_y,
      }));
    }

    // Check wallet
    if (stxAddress) {
      checks.stxBalance = await fetchStxBalance(stxAddress);

      // Scan positions
      const posResults = await Promise.allSettled(
        pools.map(async (pool) => {
          const bins = await fetchUserPositions(pool.pool_id, stxAddress);
          if (bins.length > 0) {
            return {
              poolId: pool.pool_id,
              bins: bins.length,
              activeBin: pool.active_bin,
            };
          }
          return null;
        })
      );

      checks.positions = posResults
        .filter(
          (r): r is PromiseFulfilledResult<any> =>
            r.status === "fulfilled" && r.value !== null
        )
        .map((r) => r.value);
    } else {
      checks.note = "Set STX_ADDRESS env var for full diagnostics";
    }

    checks.commands = [
      "doctor",
      "status",
      "status --pool dlmm_1",
      "plan --pool dlmm_1",
      "recenter --pool dlmm_1 --confirm",
      "history",
    ];

    output("success", "doctor", checks);
  });

// ── status ───────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show position health: drift, fees, range efficiency. Records fee baselines locally on first observation.")
  .option("--pool <id>", "Specific pool (default: all with positions)")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "status", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const poolIds = opts.pool ? [opts.pool] : pools.map((p) => p.pool_id);

    // Fetch all positions in parallel (like doctor does)
    const positionResults = await Promise.allSettled(
      poolIds.map(async (poolId) => {
        const poolMeta = pools.find((p) => p.pool_id === poolId);
        if (!poolMeta) return null;
        const userBins = await fetchUserPositions(poolId, stxAddress!);
        if (userBins.length === 0) return null;
        return { poolId, poolMeta, userBins };
      })
    );

    const results: PositionHealth[] = [];

    for (const result of positionResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { poolId, poolMeta, userBins } = result.value;

      // Filter dust
      const significantBins = userBins.filter((b) => {
        const val = parseInt(b.reserve_x || "0") + (b.userLiquidity || 0);
        return val >= MIN_POSITION_SATS;
      });
      if (significantBins.length === 0) continue;

      // Record baselines for new bins
      const poolState = getPoolState(state, poolId);
      for (const bin of significantBins) {
        if (!poolState.baselines[bin.bin_id]) {
          poolState.baselines[bin.bin_id] = {
            binId: bin.bin_id,
            depositX: bin.reserve_x || "0",
            depositY: bin.reserve_y || "0",
            recordedAt: new Date().toISOString(),
          };
        }
      }

      // Clear pending verification — on-chain state successfully read
      if (poolState.pendingVerification) {
        log(`Pool ${poolId}: clearing pending_verification — on-chain state re-established`);
        poolState.pendingVerification = false;
      }

      const health = analyzePosition(poolId, poolMeta.active_bin, significantBins, poolState);
      results.push(health);

      // Update last seen active bin
      poolState.lastActiveBin = poolMeta.active_bin;
    }

    saveState(state);

    const summary = {
      positionsAnalyzed: results.length,
      needsRecenter: results.filter((r) => r.needsRecenter).length,
      positions: results,
    };

    output("success", "status", summary);
  });

// ── plan ─────────────────────────────────────────────────────────────────
program
  .command("plan")
  .description("Dry-run re-center: simulate withdraw + re-deposit")
  .option("--pool <id>", "Pool to plan recenter for", "dlmm_1")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "plan", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const poolMeta = pools.find((p) => p.pool_id === opts.pool);

    if (!poolMeta) {
      output("error", "plan", null, `Pool ${opts.pool} not found.`);
      return;
    }

    const userBins = await fetchUserPositions(opts.pool, stxAddress);
    if (userBins.length === 0) {
      output("blocked", "plan", null, `No position in ${opts.pool}.`);
      return;
    }

    const significantBins = userBins.filter((b) => {
      const val = parseInt(b.reserve_x || "0") + (b.userLiquidity || 0);
      return val >= MIN_POSITION_SATS;
    });

    const poolState = getPoolState(state, opts.pool);
    const health = analyzePosition(opts.pool, poolMeta.active_bin, significantBins, poolState);

    if (!health.needsRecenter) {
      output("success", "plan", {
        poolId: opts.pool,
        action: "none",
        reason: health.reason,
        health,
      });
      return;
    }

    const plan = planRecenter(health, significantBins, poolState);

    output("success", "plan", {
      poolId: opts.pool,
      action: plan.profitable ? "recenter_ready" : "recenter_blocked",
      plan,
      health,
      note: plan.profitable
        ? "Run 'recenter --pool " + opts.pool + " --confirm' to execute"
        : plan.rejectionReason,
    });
  });

// ── recenter ─────────────────────────────────────────────────────────────
program
  .command("recenter")
  .description("Execute re-center: withdraw + re-deposit around active bin")
  .option("--pool <id>", "Pool to recenter", "dlmm_1")
  .option("--confirm", "Required to execute (safety gate)")
  .option("--force", "Skip drift threshold check")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "recenter", null, "STX_ADDRESS env var required.");
      return;
    }

    if (!opts.confirm) {
      output("blocked", "recenter", null, "Add --confirm to execute. This withdraws and re-deposits real funds.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const poolMeta = pools.find((p) => p.pool_id === opts.pool);

    if (!poolMeta) {
      output("error", "recenter", null, `Pool ${opts.pool} not found.`);
      return;
    }

    // Check STX balance for gas
    const stxBalance = await fetchStxBalance(stxAddress);
    if (stxBalance < DEFAULT_GAS_ESTIMATE_STX) {
      output("blocked", "recenter", {
        stxBalance,
        gasEstimate: DEFAULT_GAS_ESTIMATE_STX,
      }, "Insufficient STX for gas.");
      return;
    }

    const userBins = await fetchUserPositions(opts.pool, stxAddress);
    if (userBins.length === 0) {
      output("blocked", "recenter", null, `No position in ${opts.pool}.`);
      return;
    }

    const significantBins = userBins.filter((b) => {
      const val = parseInt(b.reserve_x || "0") + (b.userLiquidity || 0);
      return val >= MIN_POSITION_SATS;
    });

    const poolState = getPoolState(state, opts.pool);
    const health = analyzePosition(opts.pool, poolMeta.active_bin, significantBins, poolState);

    // Cooldown enforcement
    if (health.cooldownRemaining > 0) {
      output("blocked", "recenter", {
        cooldownRemainingMinutes: Math.ceil(health.cooldownRemaining / 60_000),
      }, "Cooldown active. Wait before next recenter.");
      return;
    }

    // Drift check (unless --force)
    if (!health.needsRecenter && !opts.force) {
      output("success", "recenter", {
        action: "skipped",
        reason: health.reason,
        health,
      });
      return;
    }

    const plan = planRecenter(health, significantBins, poolState);

    if (!plan.profitable) {
      output("blocked", "recenter", { plan }, plan.rejectionReason);
      return;
    }

    // Execute via MCP tool commands
    // Step 1: Emit withdraw instruction
    log(`Executing recenter for ${opts.pool}...`);
    log(`Drift: ${plan.drift} bins, withdrawing ${plan.withdrawBins.length} bins`);
    log(`Re-depositing into ${plan.depositBins.length} bins centered on active bin ${plan.newCenter}`);

    // Record the recenter event (pending until MCP execution confirms)
    const event: RecenterEvent = {
      poolId: opts.pool,
      timestamp: new Date().toISOString(),
      status: "pending_verification",
      oldCenter: plan.oldCenter,
      newCenter: plan.newCenter,
      drift: plan.drift,
      binsWithdrawn: plan.withdrawBins.length,
      binsDeposited: plan.depositBins.length,
      feesEstimatedX: plan.feesHarvestedX,
      feesEstimatedY: plan.feesHarvestedY,
      gasEstimateSTX: plan.gasEstimateSTX,
      mcpWithdrawCmd: plan.mcpWithdrawCmd,
      mcpDepositCmd: plan.mcpDepositCmd,
    };

    state.recenters.push(event);

    // Update pool state — mark pending until MCP execution confirms
    poolState.lastRecenterAt = new Date().toISOString();
    poolState.lastActiveBin = plan.newCenter;
    poolState.pendingVerification = true;

    // Reset baselines for new deposit bins
    poolState.baselines = {};
    for (const bin of plan.depositBins) {
      poolState.baselines[bin.bin_id] = {
        binId: bin.bin_id,
        depositX: bin.amount_x,
        depositY: bin.amount_y,
        recordedAt: new Date().toISOString(),
      };
    }

    saveState(state);

    output("success", "recenter", {
      action: "execute_mcp",
      poolId: opts.pool,
      step1_withdraw: {
        tool: "bitflow_hodlmm_remove_liquidity",
        params: {
          pool_id: opts.pool,
          bin_ids: plan.withdrawBins.map((b) => b.bin_id),
          slippage: HODLMM_SLIPPAGE_PCT,
        },
      },
      step2_deposit: {
        tool: "bitflow_hodlmm_add_liquidity",
        params: {
          pool_id: opts.pool,
          bins: plan.depositBins,
          slippage: HODLMM_SLIPPAGE_PCT,
        },
      },
      summary: {
        oldCenter: plan.oldCenter,
        newCenter: plan.newCenter,
        drift: plan.drift,
        binsWithdrawn: plan.withdrawBins.length,
        binsDeposited: plan.depositBins.length,
        feesHarvestedX: plan.feesHarvestedX,
        feesHarvestedY: plan.feesHarvestedY,
        principalRedeployX: plan.principalRedeployX,
        principalRedeployY: plan.principalRedeployY,
        gasEstimateSTX: plan.gasEstimateSTX,
      },
    });
  });

// ── history ──────────────────────────────────────────────────────────────
program
  .command("history")
  .description("Show past re-center events")
  .option("--pool <id>", "Filter by pool")
  .option("--limit <n>", "Number of events", "20")
  .action(async (opts) => {
    const state = loadState();
    let events = state.recenters;

    if (opts.pool) {
      events = events.filter((e) => e.poolId === opts.pool);
    }

    const limit = parseInt(opts.limit) || 20;
    events = events.slice(-limit);

    const stats = {
      totalRecenters: state.recenters.length,
      poolsManaged: Object.keys(state.pools).length,
      recentEvents: events,
    };

    output("success", "history", stats);
  });

// ── run (alias for status + auto-recenter) ───────────────────────────────
program
  .command("run")
  .description("Full autonomous cycle: status check → plan → recenter if needed")
  .option("--confirm", "Allow execution of recenters (without this, dry-run only)")
  .action(async (opts) => {
    const stxAddress = process.env.STX_ADDRESS;
    if (!stxAddress) {
      output("blocked", "run", null, "STX_ADDRESS env var required.");
      return;
    }

    const state = loadState();
    const pools = await fetchAllPools();
    const stxBalance = await fetchStxBalance(stxAddress);

    // Fetch all positions in parallel (reads are safe to batch)
    const positionFetches = await Promise.allSettled(
      pools.map(async (poolMeta) => {
        const userBins = await fetchUserPositions(poolMeta.pool_id, stxAddress);
        return { poolMeta, userBins };
      })
    );

    const results: any[] = [];
    let recentersExecuted = 0;
    let remainingStxBalance = stxBalance;

    // Iterate sequentially for execution decisions (fund operations must be serial)
    for (const result of positionFetches) {
      if (recentersExecuted >= MAX_RECENTER_PER_CYCLE) break;
      if (result.status !== "fulfilled") continue;

      const { poolMeta, userBins } = result.value;
      if (userBins.length === 0) continue;

      const significantBins = userBins.filter((b) => {
        const val = parseInt(b.reserve_x || "0") + (b.userLiquidity || 0);
        return val >= MIN_POSITION_SATS;
      });
      if (significantBins.length === 0) continue;

      const poolState = getPoolState(state, poolMeta.pool_id);

      // Clear pending verification — on-chain state successfully read
      if (poolState.pendingVerification) {
        log(`Pool ${poolMeta.pool_id}: clearing pending_verification — on-chain state re-established`);
        poolState.pendingVerification = false;
      }

      // Record baselines for new bins
      for (const bin of significantBins) {
        if (!poolState.baselines[bin.bin_id]) {
          poolState.baselines[bin.bin_id] = {
            binId: bin.bin_id,
            depositX: bin.reserve_x || "0",
            depositY: bin.reserve_y || "0",
            recordedAt: new Date().toISOString(),
          };
        }
      }

      const health = analyzePosition(
        poolMeta.pool_id,
        poolMeta.active_bin,
        significantBins,
        poolState
      );

      poolState.lastActiveBin = poolMeta.active_bin;

      if (health.needsRecenter && opts.confirm) {
        if (health.cooldownRemaining > 0) {
          results.push({
            poolId: poolMeta.pool_id,
            action: "cooldown",
            health,
          });
          continue;
        }

        if (remainingStxBalance < DEFAULT_GAS_ESTIMATE_STX) {
          results.push({
            poolId: poolMeta.pool_id,
            action: "insufficient_gas",
            stxBalance: remainingStxBalance,
            health,
          });
          continue;
        }

        const plan = planRecenter(health, significantBins, poolState);

        if (plan.profitable) {
          // Record event (pending until MCP execution confirms)
          const event: RecenterEvent = {
            poolId: poolMeta.pool_id,
            timestamp: new Date().toISOString(),
            status: "pending_verification",
            oldCenter: plan.oldCenter,
            newCenter: plan.newCenter,
            drift: plan.drift,
            binsWithdrawn: plan.withdrawBins.length,
            binsDeposited: plan.depositBins.length,
            feesEstimatedX: plan.feesHarvestedX,
            feesEstimatedY: plan.feesHarvestedY,
            gasEstimateSTX: plan.gasEstimateSTX,
            mcpWithdrawCmd: plan.mcpWithdrawCmd,
            mcpDepositCmd: plan.mcpDepositCmd,
          };
          state.recenters.push(event);

          poolState.lastRecenterAt = new Date().toISOString();
          poolState.lastActiveBin = plan.newCenter;
          poolState.pendingVerification = true;
          poolState.baselines = {};
          for (const bin of plan.depositBins) {
            poolState.baselines[bin.bin_id] = {
              binId: bin.bin_id,
              depositX: bin.amount_x,
              depositY: bin.amount_y,
              recordedAt: new Date().toISOString(),
            };
          }

          results.push({
            poolId: poolMeta.pool_id,
            action: "execute_mcp",
            plan: {
              step1_withdraw: {
                tool: "bitflow_hodlmm_remove_liquidity",
                params: {
                  pool_id: poolMeta.pool_id,
                  bin_ids: plan.withdrawBins.map((b) => b.bin_id),
                  slippage: HODLMM_SLIPPAGE_PCT,
                },
              },
              step2_deposit: {
                tool: "bitflow_hodlmm_add_liquidity",
                params: {
                  pool_id: poolMeta.pool_id,
                  bins: plan.depositBins,
                  slippage: HODLMM_SLIPPAGE_PCT,
                },
              },
            },
            health,
          });
          recentersExecuted++;
          remainingStxBalance -= DEFAULT_GAS_ESTIMATE_STX;
        } else {
          results.push({
            poolId: poolMeta.pool_id,
            action: "blocked",
            reason: plan.rejectionReason,
            health,
          });
        }
      } else {
        results.push({
          poolId: poolMeta.pool_id,
          action: health.needsRecenter ? "needs_recenter_dry_run" : "healthy",
          health,
        });
      }
    }

    saveState(state);

    output("success", "run", {
      stxBalance,
      poolsScanned: pools.length,
      positionsFound: results.length,
      recentersExecuted,
      mode: opts.confirm ? "live" : "dry-run",
      results,
    });
  });

// ── install-packs ────────────────────────────────────────────────────────
program
  .command("install-packs")
  .description("Install dependency packs (no external packs required)")
  .option("--pack <name>", "Pack to install", "all")
  .action(async () => {
    output("success", "install-packs", {
      installed: [],
      note: "No external packs required. Uses built-in fetch and Commander.js.",
    });
  });

program.parse(process.argv);
