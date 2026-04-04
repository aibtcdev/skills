#!/usr/bin/env bun
/**
 * bitflow-lp-sniper — Autonomous HODLMM Concentrated Liquidity Manager
 *
 * Execution layer for Bitflow HODLMM LP positions on Stacks mainnet.
 * Computes optimal bin ranges from live pool state, deploys capital,
 * rebalances out-of-range positions, and exits cleanly — all with
 * enforced spend caps and gas reserves.
 *
 * Pipeline integration:
 *   hodlmm-pulse (when) -> hodlmm-risk (safe?) -> bitflow-lp-sniper (execute)
 *
 * Author: Nix (ThankNIXlater / earntoshi)
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================
// SAFETY CONSTANTS - Hard-coded, cannot be overridden by flags
// ============================================================
const HARD_CAP_PER_DEPLOY_SATS = 5_000_000;     // 0.05 BTC absolute max
const DEFAULT_CAP_PER_DEPLOY_SATS = 1_000_000;  // 0.01 BTC default
const MIN_STX_GAS_RESERVE_MICRO = 500_000;       // 0.5 STX always preserved
const MAX_REBALANCES_PER_DAY = 3;
const REBALANCE_COOLDOWN_SECONDS = 3600;         // 1 hour between rebalances
const MIN_POOL_TVL_USD = 5_000;
const MIN_POOL_VOLUME_1D_USD = 1_000;
const FETCH_TIMEOUT_MS = 20_000;
const NETWORK = "mainnet";

// Bin strategy definitions
const STRATEGIES: Record<string, { halfWidth: number; label: string }> = {
  tight:  { halfWidth: 5,  label: "tight (±5 bins, 11 total)" },
  normal: { halfWidth: 15, label: "normal (±15 bins, 31 total)" },
  wide:   { halfWidth: 50, label: "wide (±50 bins, 101 total)" },
};

// ============================================================
// API ENDPOINTS
// ============================================================
const BITFLOW_APP_API    = "https://bff.bitflowapis.finance/api/app/v1";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const HIRO_API           = "https://api.mainnet.hiro.so";

// ============================================================
// STATE FILE
// ============================================================
const STATE_FILE = join(homedir(), ".bitflow-lp-sniper-state.json");

interface PositionRecord {
  pool_id: string;
  min_bin: number;
  max_bin: number;
  strategy: string;
  deployed_at: string;
  amount_x_sats: number;
  amount_y_micro: number;
  active_bin_at_entry: number;
}

interface LpSniperState {
  version: number;
  date: string;
  rebalances_today: number;
  last_rebalance_epoch: number;
  positions: Record<string, PositionRecord>;  // keyed by pool_id
}

function loadState(): LpSniperState {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as LpSniperState;
      if (raw.date === today) return raw;
      // New day - reset daily counters but keep positions
      return { ...raw, date: today, rebalances_today: 0 };
    }
  } catch { /* corrupt - start fresh */ }
  return {
    version: 1,
    date: today,
    rebalances_today: 0,
    last_rebalance_epoch: 0,
    positions: {},
  };
}

function saveState(state: LpSniperState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ============================================================
// API HELPERS
// ============================================================
async function fetchWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

interface AppPool {
  poolId: string;
  poolStatus: boolean;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr: number;
  apr24h: number;
  binStep: number;
  tokens: {
    tokenX: { symbol: string; contract: string; priceUsd: number; decimals: number };
    tokenY: { symbol: string; contract: string; priceUsd: number; decimals: number };
  };
}

interface QuotePool {
  pool_id: string;
  active_bin: number;
  active: boolean;
  bin_step: number;
}

interface QuoteBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface UserPositionBin {
  bin_id: number;
  liquidity: string;
  amount_x: string;
  amount_y: string;
}

async function fetchAllAppPools(): Promise<AppPool[]> {
  const data = await fetchWithTimeout(`${BITFLOW_APP_API}/pools`) as { data: AppPool[] };
  return data.data ?? [];
}

async function fetchQuotePools(): Promise<QuotePool[]> {
  const data = await fetchWithTimeout(`${BITFLOW_QUOTES_API}/pools`) as { pools: QuotePool[] };
  return data.pools ?? [];
}

async function fetchActiveBin(poolId: string): Promise<{ activeBin: number; totalBins: number }> {
  const data = await fetchWithTimeout(`${BITFLOW_QUOTES_API}/bins/${poolId}`) as {
    active_bin_id: number;
    total_bins: number;
  };
  return { activeBin: data.active_bin_id, totalBins: data.total_bins };
}

async function fetchUserPositionBins(wallet: string, poolId: string): Promise<UserPositionBin[]> {
  try {
    const data = await fetchWithTimeout(
      `${BITFLOW_APP_API}/users/${wallet}/positions/${poolId}/bins`
    ) as { bins: UserPositionBin[] };
    return data.bins ?? [];
  } catch {
    return [];
  }
}

async function fetchWalletBalances(wallet: string): Promise<{
  stx_micro: number;
  ft: Record<string, number>;
}> {
  const data = await fetchWithTimeout(
    `${HIRO_API}/extended/v1/address/${wallet}/balances`
  ) as {
    stx: { balance: string };
    fungible_tokens: Record<string, { balance: string }>;
  };
  const ft: Record<string, number> = {};
  for (const [k, v] of Object.entries(data.fungible_tokens ?? {})) {
    ft[k] = parseInt(v.balance, 10);
  }
  return {
    stx_micro: parseInt(data.stx.balance, 10),
    ft,
  };
}

// ============================================================
// CORE LOGIC
// ============================================================
interface MomentumScore {
  feeVelocity: number;
  signal: "spike" | "elevated" | "normal" | "cooling" | "flat";
}

function computeMomentum(pool: AppPool): MomentumScore {
  const baseline7d = pool.feesUsd7d / 7;
  if (baseline7d < 0.01 && pool.feesUsd1d < 0.01) {
    return { feeVelocity: 0, signal: "flat" };
  }
  const feeVelocity = baseline7d > 0 ? pool.feesUsd1d / baseline7d : 0;

  let signal: MomentumScore["signal"];
  if (feeVelocity >= 3.0)      signal = "spike";
  else if (feeVelocity >= 1.5) signal = "elevated";
  else if (feeVelocity >= 0.5) signal = "normal";
  else if (feeVelocity > 0)    signal = "cooling";
  else                          signal = "flat";

  return { feeVelocity, signal };
}

interface BinRange {
  minBin: number;
  maxBin: number;
  width: number;
}

function computeBinRange(activeBin: number, strategy: string): BinRange {
  const hw = STRATEGIES[strategy]?.halfWidth ?? STRATEGIES.normal.halfWidth;
  return {
    minBin: Math.max(0, activeBin - hw),
    maxBin: activeBin + hw,
    width: hw * 2 + 1,
  };
}

function isPositionInRange(positionBins: UserPositionBin[], activeBin: number): boolean {
  if (!positionBins.length) return false;
  const binIds = positionBins.map(b => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  return activeBin >= minBin && activeBin <= maxBin;
}

function estimateProjectedApr(pool: AppPool, strategy: string): number {
  const hw = STRATEGIES[strategy]?.halfWidth ?? 15;
  const totalBinWidth = hw * 2 + 1;
  // Narrower range = higher density = better fee capture when in range
  // Rough scaling: normal width (31) = base APR, adjust proportionally
  const densityMultiplier = 31 / totalBinWidth;
  return pool.apr * densityMultiplier;
}

// ============================================================
// OUTPUT HELPERS
// ============================================================
function success(action: string, data: object): void {
  console.log(JSON.stringify({ status: "success", action, data, error: null }, null, 2));
}

function error(code: string, message: string, next: string, action?: string): void {
  console.log(JSON.stringify({
    status: "error",
    action: action ?? `Blocked: ${message}`,
    data: null,
    error: { code, message, next },
  }, null, 2));
}

function blocked(reason: string, code: string, next: string): void {
  error(code, reason, next, `Blocked: ${reason}`);
}

// ============================================================
// COMMANDS
// ============================================================
async function cmdDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Bitflow App API
  try {
    const pools = await fetchAllAppPools();
    const activePools = pools.filter(p => p.poolStatus).length;
    checks.push({ name: "Bitflow App API", ok: true, detail: `${activePools} active HODLMM pools` });
  } catch (e) {
    checks.push({ name: "Bitflow App API", ok: false, detail: String(e) });
  }

  // Bitflow Quotes API
  try {
    const qPools = await fetchQuotePools();
    checks.push({ name: "Bitflow Quotes API", ok: true, detail: `${qPools.length} pools indexed` });
  } catch (e) {
    checks.push({ name: "Bitflow Quotes API", ok: false, detail: String(e) });
  }

  // Hiro API
  try {
    const r = await fetchWithTimeout(`${HIRO_API}/extended/v1/status`) as { server_version: string };
    checks.push({ name: "Hiro Stacks API", ok: true, detail: `status: ok, version: ${r.server_version ?? "unknown"}` });
  } catch (e) {
    checks.push({ name: "Hiro Stacks API", ok: false, detail: String(e) });
  }

  // dlmm_1 bin data
  try {
    const { activeBin } = await fetchActiveBin("dlmm_1");
    checks.push({ name: "HODLMM bins API (dlmm_1)", ok: true, detail: `active bin: ${activeBin}` });
  } catch (e) {
    checks.push({ name: "HODLMM bins API (dlmm_1)", ok: false, detail: String(e) });
  }

  // State file
  const state = loadState();
  checks.push({
    name: "Local state file",
    ok: true,
    detail: `rebalances today: ${state.rebalances_today}/${MAX_REBALANCES_PER_DAY}, positions: ${Object.keys(state.positions).length}`,
  });

  const allOk = checks.every(c => c.ok);
  console.log(JSON.stringify({
    status: allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All data sources reachable. Ready to run."
      : "Some checks failed. Resolve issues before deploying.",
  }, null, 2));
}

async function cmdInstallPacks(): Promise<void> {
  console.log(JSON.stringify({
    status: "ok",
    message: "Read operations (analyze, status) require no additional packs. Write operations (deploy, rebalance, exit) require AIBTC MCP server: npx @aibtc/mcp-server@latest --install",
    data: { requires: ["@aibtc/mcp-server (for write actions only)"] },
  }, null, 2));
}

async function cmdAnalyze(poolId?: string, strategy: string = "normal"): Promise<void> {
  const [allPools, qPools] = await Promise.all([fetchAllAppPools(), fetchQuotePools()]);

  const activePools = allPools.filter(p => p.poolStatus && (!poolId || p.poolId === poolId));

  if (!activePools.length) {
    blocked(
      poolId ? `Pool ${poolId} not found or inactive` : "No active HODLMM pools found",
      "POOL_NOT_FOUND",
      "Check pool ID or wait for pools to become active."
    );
    return;
  }

  const results = await Promise.all(activePools.map(async (pool) => {
    const qPool = qPools.find(q => q.pool_id === pool.poolId);
    let activeBin = qPool?.active_bin ?? null;

    // Fetch precise active bin from bins API
    try {
      const binData = await fetchActiveBin(pool.poolId);
      activeBin = binData.activeBin;
    } catch { /* use quotes fallback */ }

    const momentum = computeMomentum(pool);
    const range = activeBin !== null ? computeBinRange(activeBin, strategy) : null;
    const projectedApr = estimateProjectedApr(pool, strategy);

    return {
      pool_id: pool.poolId,
      tokens: `${pool.tokens.tokenX.symbol}/${pool.tokens.tokenY.symbol}`,
      active_bin: activeBin,
      tvl_usd: pool.tvlUsd,
      apr_pct: pool.apr,
      apr_24h_pct: pool.apr24h,
      fees_usd_1d: pool.feesUsd1d,
      fees_usd_7d: pool.feesUsd7d,
      volume_usd_1d: pool.volumeUsd1d,
      fee_velocity: parseFloat((pool.feesUsd1d / Math.max(pool.feesUsd7d / 7, 0.01)).toFixed(2)),
      momentum_signal: momentum.signal,
      strategy: STRATEGIES[strategy]?.label ?? strategy,
      recommended_range: range,
      projected_apr_pct: parseFloat(projectedApr.toFixed(2)),
      deploy_eligible: (
        pool.tvlUsd >= MIN_POOL_TVL_USD &&
        pool.volumeUsd1d >= MIN_POOL_VOLUME_1D_USD &&
        (momentum.signal === "spike" || momentum.signal === "elevated")
      ),
    };
  }));

  // Sort by projected APR descending
  results.sort((a, b) => b.projected_apr_pct - a.projected_apr_pct);

  success("ANALYZE", {
    network: NETWORK,
    timestamp: new Date().toISOString(),
    strategy: STRATEGIES[strategy]?.label ?? strategy,
    pools: results,
    deploy_gate: {
      min_tvl_usd: MIN_POOL_TVL_USD,
      min_volume_1d_usd: MIN_POOL_VOLUME_1D_USD,
      required_signals: ["spike", "elevated"],
    },
  });
}

async function cmdStatus(wallet: string): Promise<void> {
  const state = loadState();
  const positions = state.positions;

  if (!Object.keys(positions).length) {
    success("STATUS", {
      network: NETWORK,
      wallet,
      message: "No tracked positions. Run deploy to add one.",
      positions: [],
      rebalances_today: state.rebalances_today,
      rebalance_daily_cap: MAX_REBALANCES_PER_DAY,
    });
    return;
  }

  const statusResults = await Promise.all(
    Object.entries(positions).map(async ([pool_id, pos]) => {
      let activeBin: number | null = null;
      try {
        const binData = await fetchActiveBin(pool_id);
        activeBin = binData.activeBin;
      } catch { /* ignore */ }

      let positionBins: UserPositionBin[] = [];
      try {
        positionBins = await fetchUserPositionBins(wallet, pool_id);
      } catch { /* ignore */ }

      const inRange = activeBin !== null ? isPositionInRange(positionBins, activeBin) : null;
      const binIds = positionBins.map(b => b.bin_id);
      const minUserBin = binIds.length ? Math.min(...binIds) : null;
      const maxUserBin = binIds.length ? Math.max(...binIds) : null;
      const activeBinDistance = (activeBin !== null && minUserBin !== null && maxUserBin !== null)
        ? (activeBin < minUserBin ? minUserBin - activeBin : activeBin > maxUserBin ? activeBin - maxUserBin : 0)
        : null;

      return {
        pool_id,
        strategy: pos.strategy,
        recorded_range: { min_bin: pos.min_bin, max_bin: pos.max_bin },
        live_active_bin: activeBin,
        live_position_bins: positionBins.length,
        in_range: inRange,
        active_bin_distance_from_range: activeBinDistance,
        deployed_at: pos.deployed_at,
        amount_x_sats: pos.amount_x_sats,
        amount_y_micro: pos.amount_y_micro,
        action_needed: inRange === false ? "REBALANCE recommended" : inRange === true ? "HOLD" : "UNKNOWN",
      };
    })
  );

  success("STATUS", {
    network: NETWORK,
    wallet,
    timestamp: new Date().toISOString(),
    positions: statusResults,
    rebalances_today: state.rebalances_today,
    rebalance_daily_cap: MAX_REBALANCES_PER_DAY,
    cooldown_active: (Date.now() / 1000) - state.last_rebalance_epoch < REBALANCE_COOLDOWN_SECONDS,
  });
}

async function cmdDeploy(
  wallet: string,
  poolId: string,
  amountX: number,
  amountY: number,
  strategy: string,
  confirm: boolean
): Promise<void> {
  // Confirm gate
  if (!confirm) {
    blocked("--confirm required for action 'deploy'", "CONFIRM_REQUIRED", "Re-run with --confirm to execute.");
    return;
  }

  // Hard cap check
  if (amountX > HARD_CAP_PER_DEPLOY_SATS) {
    blocked(
      `Amount ${amountX} sats exceeds hard cap ${HARD_CAP_PER_DEPLOY_SATS} sats`,
      "EXCEEDS_HARD_CAP",
      `Reduce --amount-x to at most ${HARD_CAP_PER_DEPLOY_SATS} sats.`
    );
    return;
  }

  // Strategy validation
  if (!STRATEGIES[strategy]) {
    error("INVALID_STRATEGY", `Unknown strategy '${strategy}'`, "Use: tight, normal, or wide");
    return;
  }

  // Fetch pool data
  let appPool: AppPool | undefined;
  try {
    const pools = await fetchAllAppPools();
    appPool = pools.find(p => p.poolId === poolId);
  } catch (e) {
    error("API_UNREACHABLE", `Bitflow API unreachable: ${e}`, "Check connectivity and retry.");
    return;
  }

  if (!appPool) {
    blocked(`Pool ${poolId} not found`, "POOL_NOT_FOUND", "Run analyze to see available pools.");
    return;
  }

  if (!appPool.poolStatus) {
    blocked(`Pool ${poolId} is inactive`, "POOL_INACTIVE", "Wait for pool to become active.");
    return;
  }

  // Pool health gates
  if (appPool.tvlUsd < MIN_POOL_TVL_USD) {
    blocked(
      `Pool TVL $${appPool.tvlUsd.toFixed(0)} below minimum $${MIN_POOL_TVL_USD}`,
      "BELOW_TVL_THRESHOLD",
      "Wait for more liquidity to enter the pool."
    );
    return;
  }

  if (appPool.volumeUsd1d < MIN_POOL_VOLUME_1D_USD) {
    blocked(
      `Pool 24h volume $${appPool.volumeUsd1d.toFixed(0)} below minimum $${MIN_POOL_VOLUME_1D_USD}`,
      "BELOW_VOLUME_THRESHOLD",
      "Pool is too illiquid. Wait for volume to recover."
    );
    return;
  }

  const momentum = computeMomentum(appPool);
  if (momentum.signal === "cooling" || momentum.signal === "flat") {
    blocked(
      `Pool momentum is '${momentum.signal}' — not an entry window`,
      "POOR_MOMENTUM",
      "Wait for pulse signal to reach 'elevated' or 'spike' before deploying."
    );
    return;
  }

  // Wallet gas check
  let walletData: { stx_micro: number; ft: Record<string, number> };
  try {
    walletData = await fetchWalletBalances(wallet);
  } catch (e) {
    error("WALLET_FETCH_FAILED", `Cannot fetch wallet balances: ${e}`, "Check wallet address and Hiro API.");
    return;
  }

  if (walletData.stx_micro < MIN_STX_GAS_RESERVE_MICRO) {
    blocked(
      `STX balance ${walletData.stx_micro} micro-STX below gas reserve ${MIN_STX_GAS_RESERVE_MICRO}`,
      "INSUFFICIENT_GAS",
      `Add at least ${(MIN_STX_GAS_RESERVE_MICRO / 1_000_000).toFixed(2)} STX to wallet for gas.`
    );
    return;
  }

  // Get active bin for range computation
  let activeBin: number;
  try {
    const binData = await fetchActiveBin(poolId);
    activeBin = binData.activeBin;
  } catch (e) {
    error("BINS_API_FAILED", `Cannot fetch active bin: ${e}`, "Retry or check Bitflow API status.");
    return;
  }

  const range = computeBinRange(activeBin, strategy);
  const projectedApr = estimateProjectedApr(appPool, strategy);

  // Build MCP commands
  const mcpCommands = [
    {
      tool: "bitflow_hodlmm_add_liquidity",
      params: {
        pool_id: poolId,
        pool_contract: `${appPool.tokens.tokenX.contract}:${appPool.tokens.tokenY.contract}`,
        token_x: appPool.tokens.tokenX.contract,
        token_y: appPool.tokens.tokenY.contract,
        amount_x: amountX.toString(),
        amount_y: amountY.toString(),
        min_bin: range.minBin,
        max_bin: range.maxBin,
        bin_count: range.width,
        strategy: "uniform",
        slippage_tolerance_bps: 50,
      },
    },
  ];

  // Record position in state
  const state = loadState();
  state.positions[poolId] = {
    pool_id: poolId,
    min_bin: range.minBin,
    max_bin: range.maxBin,
    strategy,
    deployed_at: new Date().toISOString(),
    amount_x_sats: amountX,
    amount_y_micro: amountY,
    active_bin_at_entry: activeBin,
  };
  saveState(state);

  success("DEPLOY", {
    network: NETWORK,
    wallet,
    pool_id: poolId,
    tokens: `${appPool.tokens.tokenX.symbol}/${appPool.tokens.tokenY.symbol}`,
    amount_x: amountX,
    amount_y: amountY,
    strategy: STRATEGIES[strategy].label,
    active_bin: activeBin,
    recommended_range: range,
    entry_price_usd: appPool.tokens.tokenX.priceUsd,
    projected_apr_pct: parseFloat(projectedApr.toFixed(2)),
    momentum_signal: momentum.signal,
    fee_velocity: parseFloat((appPool.feesUsd1d / Math.max(appPool.feesUsd7d / 7, 0.01)).toFixed(2)),
    tvl_usd: appPool.tvlUsd,
    mcp_commands: mcpCommands,
    message: `Deploy ${amountX} ${appPool.tokens.tokenX.symbol} + ${amountY} ${appPool.tokens.tokenY.symbol} into ${poolId} bins ${range.minBin}-${range.maxBin}.`,
  });
}

async function cmdRebalance(
  wallet: string,
  poolId: string,
  strategy: string,
  confirm: boolean
): Promise<void> {
  if (!confirm) {
    blocked("--confirm required for action 'rebalance'", "CONFIRM_REQUIRED", "Re-run with --confirm to execute.");
    return;
  }

  const state = loadState();

  // Daily cap check
  if (state.rebalances_today >= MAX_REBALANCES_PER_DAY) {
    blocked(
      `Daily rebalance cap (${MAX_REBALANCES_PER_DAY}) reached`,
      "DAILY_CAP_REACHED",
      "Manual intervention required if position is critically out-of-range."
    );
    return;
  }

  // Cooldown check
  const nowSec = Date.now() / 1000;
  const elapsed = nowSec - state.last_rebalance_epoch;
  if (elapsed < REBALANCE_COOLDOWN_SECONDS) {
    const remaining = Math.ceil(REBALANCE_COOLDOWN_SECONDS - elapsed);
    blocked(
      `Rebalance cooldown active — ${remaining}s remaining`,
      "COOLDOWN_ACTIVE",
      `Next rebalance allowed at ${new Date((state.last_rebalance_epoch + REBALANCE_COOLDOWN_SECONDS) * 1000).toISOString()}.`
    );
    return;
  }

  // Fetch current pool state
  let appPool: AppPool | undefined;
  try {
    const pools = await fetchAllAppPools();
    appPool = pools.find(p => p.poolId === poolId);
  } catch (e) {
    error("API_UNREACHABLE", `Bitflow API unreachable: ${e}`, "Check connectivity and retry.");
    return;
  }

  if (!appPool) {
    blocked(`Pool ${poolId} not found`, "POOL_NOT_FOUND", "Check pool ID.");
    return;
  }

  // Fetch position
  let positionBins: UserPositionBin[] = [];
  try {
    positionBins = await fetchUserPositionBins(wallet, poolId);
  } catch { /* will handle below */ }

  if (!positionBins.length) {
    blocked("No LP position found in this pool", "NO_POSITION", "Deploy first before rebalancing.");
    return;
  }

  // Fetch active bin
  let activeBin: number;
  try {
    const binData = await fetchActiveBin(poolId);
    activeBin = binData.activeBin;
  } catch (e) {
    error("BINS_API_FAILED", `Cannot fetch active bin: ${e}`, "Retry.");
    return;
  }

  // Check if in-range
  const inRange = isPositionInRange(positionBins, activeBin);
  if (inRange) {
    success("REBALANCE", {
      network: NETWORK,
      wallet,
      pool_id: poolId,
      active_bin: activeBin,
      position_bins: positionBins.map(b => b.bin_id),
      in_range: true,
      message: "Position is in-range — no rebalance needed. Gas saved.",
      mcp_commands: null,
    });
    return;
  }

  // Gas check
  let walletData: { stx_micro: number; ft: Record<string, number> };
  try {
    walletData = await fetchWalletBalances(wallet);
  } catch (e) {
    error("WALLET_FETCH_FAILED", `Cannot fetch wallet balances: ${e}`, "Check wallet and retry.");
    return;
  }

  // Rebalance needs 2 txs - require more gas
  const gasRequired = MIN_STX_GAS_RESERVE_MICRO * 2;
  if (walletData.stx_micro < gasRequired) {
    blocked(
      `STX balance ${walletData.stx_micro} micro-STX below rebalance gas requirement ${gasRequired}`,
      "INSUFFICIENT_GAS",
      `Add at least ${(gasRequired / 1_000_000).toFixed(2)} STX for remove+add transactions.`
    );
    return;
  }

  const binIds = positionBins.map(b => b.bin_id);
  const oldMinBin = Math.min(...binIds);
  const oldMaxBin = Math.max(...binIds);
  const newRange = computeBinRange(activeBin, strategy);

  // Total amounts to re-deploy (sum from position bins)
  const totalAmountX = positionBins.reduce((sum, b) => sum + parseInt(b.amount_x ?? "0", 10), 0);
  const totalAmountY = positionBins.reduce((sum, b) => sum + parseInt(b.amount_y ?? "0", 10), 0);

  const mcpCommands = [
    {
      tool: "bitflow_hodlmm_remove_liquidity",
      params: {
        pool_id: poolId,
        token_x: appPool.tokens.tokenX.contract,
        token_y: appPool.tokens.tokenY.contract,
        bin_ids: binIds,
        remove_all: true,
      },
    },
    {
      tool: "bitflow_hodlmm_add_liquidity",
      params: {
        pool_id: poolId,
        token_x: appPool.tokens.tokenX.contract,
        token_y: appPool.tokens.tokenY.contract,
        amount_x: totalAmountX.toString(),
        amount_y: totalAmountY.toString(),
        min_bin: newRange.minBin,
        max_bin: newRange.maxBin,
        bin_count: newRange.width,
        strategy: "uniform",
        slippage_tolerance_bps: 75,
      },
    },
  ];

  // Update state
  state.rebalances_today += 1;
  state.last_rebalance_epoch = Math.floor(Date.now() / 1000);
  if (state.positions[poolId]) {
    state.positions[poolId].min_bin = newRange.minBin;
    state.positions[poolId].max_bin = newRange.maxBin;
    state.positions[poolId].strategy = strategy;
    state.positions[poolId].active_bin_at_entry = activeBin;
  }
  saveState(state);

  success("REBALANCE", {
    network: NETWORK,
    wallet,
    pool_id: poolId,
    old_range: { min_bin: oldMinBin, max_bin: oldMaxBin },
    new_range: newRange,
    active_bin: activeBin,
    strategy: STRATEGIES[strategy]?.label ?? strategy,
    bins_to_remove: binIds,
    rebalances_today: state.rebalances_today,
    rebalances_remaining_today: MAX_REBALANCES_PER_DAY - state.rebalances_today,
    mcp_commands: mcpCommands,
    message: `Rebalance ${poolId}: remove bins ${oldMinBin}-${oldMaxBin}, deploy fresh range ${newRange.minBin}-${newRange.maxBin} at active bin ${activeBin}.`,
  });
}

async function cmdExit(wallet: string, poolId: string, confirm: boolean): Promise<void> {
  if (!confirm) {
    blocked("--confirm required for action 'exit'", "CONFIRM_REQUIRED", "Re-run with --confirm to execute.");
    return;
  }

  // Fetch pool for contract addresses
  let appPool: AppPool | undefined;
  try {
    const pools = await fetchAllAppPools();
    appPool = pools.find(p => p.poolId === poolId);
  } catch (e) {
    error("API_UNREACHABLE", `Bitflow API unreachable: ${e}`, "Check connectivity and retry.");
    return;
  }

  if (!appPool) {
    blocked(`Pool ${poolId} not found`, "POOL_NOT_FOUND", "Check pool ID.");
    return;
  }

  // Fetch position bins
  let positionBins: UserPositionBin[] = [];
  try {
    positionBins = await fetchUserPositionBins(wallet, poolId);
  } catch { /* will handle below */ }

  if (!positionBins.length) {
    blocked("No LP position found in this pool", "NO_POSITION", "Nothing to exit.");
    return;
  }

  const binIds = positionBins.map(b => b.bin_id);

  const mcpCommands = [
    {
      tool: "bitflow_hodlmm_remove_liquidity",
      params: {
        pool_id: poolId,
        token_x: appPool.tokens.tokenX.contract,
        token_y: appPool.tokens.tokenY.contract,
        bin_ids: binIds,
        remove_all: true,
      },
    },
  ];

  // Remove from state
  const state = loadState();
  delete state.positions[poolId];
  saveState(state);

  success("EXIT", {
    network: NETWORK,
    wallet,
    pool_id: poolId,
    bins_removed: binIds.length,
    bin_ids: binIds,
    mcp_commands: mcpCommands,
    message: `Exit ${poolId}: removing ${binIds.length} bins. Capital returns to wallet.`,
  });
}

// ============================================================
// CLI SETUP
// ============================================================
const program = new Command();

program
  .name("bitflow-lp-sniper")
  .description("Autonomous HODLMM concentrated liquidity manager for Bitflow on Stacks mainnet")
  .version("1.0.0");

program
  .command("doctor")
  .description("Pre-flight check: APIs, wallet readiness, state file")
  .action(async () => {
    try { await cmdDoctor(); }
    catch (e) { error("DOCTOR_FAILED", String(e), "Check network and retry."); }
  });

program
  .command("install-packs")
  .description("Show required dependencies")
  .action(async () => { await cmdInstallPacks(); });

program
  .command("run")
  .description("Execute LP sniper action")
  .option("--wallet <address>", "Stacks address")
  .option("--action <action>", "Action: analyze | deploy | rebalance | exit | status", "analyze")
  .option("--pool-id <id>", "HODLMM pool ID (e.g. dlmm_1)")
  .option("--amount-x <sats>", "TokenX amount in smallest unit", (v) => parseInt(v, 10), 0)
  .option("--amount-y <micro>", "TokenY amount in smallest unit", (v) => parseInt(v, 10), 0)
  .option("--strategy <s>", "Bin strategy: tight | normal | wide", "normal")
  .option("--confirm", "Required for write actions (deploy/rebalance/exit)", false)
  .action(async (opts) => {
    try {
      const action = opts.action as string;

      switch (action) {
        case "analyze":
          await cmdAnalyze(opts.poolId, opts.strategy);
          break;

        case "status":
          if (!opts.wallet) { error("NO_WALLET", "--wallet required for status", "Provide --wallet <STX_ADDRESS>"); return; }
          await cmdStatus(opts.wallet);
          break;

        case "deploy":
          if (!opts.wallet) { error("NO_WALLET", "--wallet required for deploy", "Provide --wallet <STX_ADDRESS>"); return; }
          if (!opts.poolId) { error("NO_POOL", "--pool-id required for deploy", "Provide --pool-id <id>"); return; }
          if (!opts.amountX) { error("NO_AMOUNT", "--amount-x required for deploy", "Provide --amount-x <sats>"); return; }
          if (!opts.amountY) { error("NO_AMOUNT", "--amount-y required for deploy", "Provide --amount-y <micro>"); return; }
          await cmdDeploy(opts.wallet, opts.poolId, opts.amountX, opts.amountY, opts.strategy, opts.confirm);
          break;

        case "rebalance":
          if (!opts.wallet) { error("NO_WALLET", "--wallet required for rebalance", "Provide --wallet <STX_ADDRESS>"); return; }
          if (!opts.poolId) { error("NO_POOL", "--pool-id required for rebalance", "Provide --pool-id <id>"); return; }
          await cmdRebalance(opts.wallet, opts.poolId, opts.strategy, opts.confirm);
          break;

        case "exit":
          if (!opts.wallet) { error("NO_WALLET", "--wallet required for exit", "Provide --wallet <STX_ADDRESS>"); return; }
          if (!opts.poolId) { error("NO_POOL", "--pool-id required for exit", "Provide --pool-id <id>"); return; }
          await cmdExit(opts.wallet, opts.poolId, opts.confirm);
          break;

        default:
          error("UNKNOWN_ACTION", `Unknown action '${action}'`, "Use: analyze | deploy | rebalance | exit | status");
      }
    } catch (e) {
      error("RUNTIME_ERROR", String(e), "Check inputs and retry.");
    }
  });

program.parseAsync(process.argv).catch((e) => {
  error("CLI_ERROR", String(e), "Run with --help for usage.");
  process.exit(1);
});
