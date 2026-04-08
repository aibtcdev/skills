#!/usr/bin/env bun
/**
 * HODLMM Emergency Exit skill CLI
 *
 * Automated risk-gated LP withdrawal for Bitflow HODLMM pools.
 * Monitors pool risk conditions (volatility regime, depth imbalance, fee
 * deterioration), scores exit urgency, and emits withdrawal MCP commands
 * when conditions breach safety thresholds.
 *
 * Write skill: emits bitflow_hodlmm_remove_liquidity MCP commands.
 * HODLMM bonus eligible: Yes — directly manages HODLMM LP risk.
 *
 * Usage: bun run hodlmm-emergency-exit/hodlmm-emergency-exit.ts <subcommand>
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://bff.bitflowapis.finance";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// Safety limits (hardcoded, not configurable)
const MAX_POSITIONS_PER_EXIT = 10; // Never withdraw more than 10 bin positions at once
const MIN_POSITION_VALUE_USD = 0.50; // Don't exit positions worth less than $0.50 (gas waste)
const IMBALANCE_CRISIS_THRESHOLD = 0.85; // 85% single-sided = crisis
const IMBALANCE_WARNING_THRESHOLD = 0.60; // 60% single-sided = warning
const DEPTH_CRISIS_THRESHOLD = 5; // Depth score below 5 = crisis
const FEE_DEAD_POOL_THRESHOLD = 0; // Zero 7-day fees = dead pool
const VOLATILITY_CRISIS_BINS = 30; // Active bin moved 30+ bins from position center = crisis

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface HodlmmRichPool {
  poolId: string;
  tokens?: {
    tokenX?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
    tokenY?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
  };
  tvlUsd?: number;
  volumeUsd1d?: number;
  volumeUsd7d?: number;
  feesUsd1d?: number;
  feesUsd7d?: number;
  apr?: number;
  binStep?: string;
  baseFee?: number;
  poolComposition?: {
    tokenX?: { percentage?: number };
    tokenY?: { percentage?: number };
  };
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface BinListResponse {
  active_bin_id?: number;
  bins: BinData[];
}

interface PositionBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface UserPositionResponse {
  bins?: PositionBin[];
  position_bins?: PositionBin[];
  positions?: { bins?: PositionBin[] };
}

type ExitUrgency = "critical" | "warning" | "monitor" | "safe";

interface RiskAssessment {
  urgency: ExitUrgency;
  score: number;
  triggers: string[];
  poolMetrics: {
    imbalanceRatio: number;
    depthScore: number;
    feesUsd7d: number;
    volumeUsd7d: number;
    apr: number;
  };
  positionMetrics: {
    binCount: number;
    valueUsd: number;
    driftFromActive: number;
    inRange: boolean;
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function output(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function blocked(code: string, message: string, next: string): void {
  output({ status: "blocked", action: next, data: {}, error: { code, message, next } });
}

function fail(code: string, message: string, next: string): void {
  output({ status: "error", action: next, data: {}, error: { code, message, next } });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText} (${url})`);
  return res.json() as Promise<T>;
}

async function getRichPool(poolId: string): Promise<HodlmmRichPool> {
  return fetchJson<HodlmmRichPool>(`${BITFLOW_API}/api/app/v1/pools/${poolId}`);
}

async function getPoolBins(poolId: string): Promise<BinListResponse> {
  return fetchJson<BinListResponse>(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`);
}

async function getUserPositionBins(
  address: string,
  poolId: string
): Promise<PositionBin[]> {
  try {
    const data = await fetchJson<UserPositionResponse>(
      `${BITFLOW_API}/api/app/v1/users/${address}/positions/${poolId}/bins`
    );
    return data?.bins ?? data?.position_bins ?? data?.positions?.bins ?? [];
  } catch (e) {
    // 404 = no position (expected). Other errors should propagate.
    if (e instanceof Error && e.message.includes("404")) return [];
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

function computeDepthScore(
  bins: BinData[],
  activeBinId: number,
  radius: number
): number {
  const nearby = bins.filter((b) => Math.abs(b.bin_id - activeBinId) <= radius);
  let totalReserves = 0;
  for (const b of nearby) {
    totalReserves += Number(b.reserve_x) + Number(b.reserve_y);
  }
  // Simple log-scale depth: 0-100
  if (totalReserves <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(totalReserves) * 10));
}

function assessRisk(
  pool: HodlmmRichPool,
  bins: BinListResponse,
  positionBins: PositionBin[]
): RiskAssessment {
  const triggers: string[] = [];
  let score = 0; // 0 = safe, higher = more urgent

  const activeBinId = bins.active_bin_id ?? 0;
  const xDecimals = pool.tokens?.tokenX?.decimals ?? 8;
  const yDecimals = pool.tokens?.tokenY?.decimals ?? 6;
  const xPriceUsd = pool.tokens?.tokenX?.priceUsd ?? 0;
  const yPriceUsd = pool.tokens?.tokenY?.priceUsd ?? 0;

  // Pool metrics
  const pctX = pool.poolComposition?.tokenX?.percentage ?? 50;
  const imbalanceRatio = Math.abs(pctX - 50) / 50; // 0 = balanced, 1 = single-sided
  const depthScore = computeDepthScore(bins.bins, activeBinId, 20);
  const feesUsd7d = pool.feesUsd7d ?? 0;
  const volumeUsd7d = pool.volumeUsd7d ?? 0;
  const apr = pool.apr ?? 0;

  // Position metrics
  const positionBinIds = positionBins.map((b) => b.bin_id);
  const positionCenter = positionBinIds.length > 0
    ? Math.round(positionBinIds.reduce((s, id) => s + id, 0) / positionBinIds.length)
    : activeBinId;
  const driftFromActive = Math.abs(positionCenter - activeBinId);
  const inRange = positionBinIds.some((id) => Math.abs(id - activeBinId) <= 5);

  // Compute position value in USD
  let positionValueUsd = 0;
  const xFactor = 10 ** xDecimals;
  const yFactor = 10 ** yDecimals;
  for (const bin of positionBins) {
    positionValueUsd += (Number(bin.reserve_x) / xFactor) * xPriceUsd;
    positionValueUsd += (Number(bin.reserve_y) / yFactor) * yPriceUsd;
  }

  // Trigger 1: Extreme composition imbalance (single-sided = IL crystallized)
  if (imbalanceRatio >= IMBALANCE_CRISIS_THRESHOLD) {
    score += 40;
    triggers.push(`CRITICAL: Pool is ${(imbalanceRatio * 100).toFixed(0)}% single-sided. IL has crystallized.`);
  } else if (imbalanceRatio >= IMBALANCE_WARNING_THRESHOLD) {
    score += 20;
    triggers.push(`WARNING: Pool composition is ${(imbalanceRatio * 100).toFixed(0)}% imbalanced.`);
  }

  // Trigger 2: Position out of range (not earning fees)
  if (!inRange && positionBins.length > 0) {
    score += 25;
    triggers.push(`CRITICAL: Position is out of range. Active bin ${activeBinId}, position center ${positionCenter} (drift: ${driftFromActive} bins). Not earning fees.`);
  }

  // Trigger 3: Extreme bin drift from position
  if (driftFromActive >= VOLATILITY_CRISIS_BINS) {
    score += 30;
    triggers.push(`CRITICAL: Active bin has moved ${driftFromActive} bins from position center. High volatility or structural shift.`);
  }

  // Trigger 4: Depth crisis (liquidity evaporated)
  if (depthScore <= DEPTH_CRISIS_THRESHOLD) {
    score += 25;
    triggers.push(`CRITICAL: Depth score ${depthScore}/100. Liquidity has evaporated near active bin.`);
  }

  // Trigger 5: Dead pool (no fees for 7 days)
  if (feesUsd7d <= FEE_DEAD_POOL_THRESHOLD && positionBins.length > 0) {
    score += 15;
    triggers.push(`WARNING: Zero fees earned in 7 days. Pool may be abandoned.`);
  }

  // Classify urgency
  let urgency: ExitUrgency;
  if (score >= 50) urgency = "critical";
  else if (score >= 25) urgency = "warning";
  else if (score > 0) urgency = "monitor";
  else urgency = "safe";

  return {
    urgency,
    score: Math.min(score, 100),
    triggers,
    poolMetrics: { imbalanceRatio: Number(imbalanceRatio.toFixed(4)), depthScore, feesUsd7d, volumeUsd7d, apr },
    positionMetrics: {
      binCount: positionBins.length,
      valueUsd: Number(positionValueUsd.toFixed(2)),
      driftFromActive,
      inRange,
    },
  };
}

// ---------------------------------------------------------------------------
// Withdrawal command builder
// ---------------------------------------------------------------------------

function buildWithdrawalCommand(
  poolId: string,
  positionBins: PositionBin[],
  activeBinId: number
): Record<string, unknown> {
  // Build relative withdrawal positions (offset from active bin)
  const positions = positionBins
    .slice(0, MAX_POSITIONS_PER_EXIT) // Hard cap on positions per exit
    .map((bin) => ({
      activeBinOffset: bin.bin_id - activeBinId,
      amount: String(Math.max(Number(bin.reserve_x), Number(bin.reserve_y), 1)),
      minXAmount: "0",
      minYAmount: "0",
    }));

  return {
    tool: "bitflow",
    command: "withdraw-liquidity-simple",
    params: {
      poolId,
      positions: JSON.stringify(positions),
    },
    note: "Execute this MCP command to withdraw the position. Requires an unlocked wallet.",
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-emergency-exit")
  .description(
    "Risk-gated HODLMM LP withdrawal. Monitors pool conditions (imbalance, depth, " +
    "fee activity, bin drift), scores exit urgency, and emits withdrawal MCP commands " +
    "when safety thresholds are breached. Requires wallet address for position queries."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify API connectivity and display safety thresholds.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
        safetyThresholds: {
          maxPositionsPerExit: MAX_POSITIONS_PER_EXIT,
          minPositionValueUsd: MIN_POSITION_VALUE_USD,
          imbalanceCrisisPct: IMBALANCE_CRISIS_THRESHOLD * 100,
          imbalanceWarningPct: IMBALANCE_WARNING_THRESHOLD * 100,
          depthCrisisScore: DEPTH_CRISIS_THRESHOLD,
          feeDeadPoolDays: 7,
          volatilityCrisisBins: VOLATILITY_CRISIS_BINS,
        },
      };

      try {
        const pool = await getRichPool("dlmm_1");
        checks.appApi = { status: "ok", hasComposition: pool.poolComposition !== undefined };
      } catch (e) {
        checks.appApi = { status: "error", error: String(e) };
      }

      try {
        const bins = await getPoolBins("dlmm_1");
        checks.binsApi = { status: "ok", hasActiveBin: bins.active_bin_id !== undefined };
      } catch (e) {
        checks.binsApi = { status: "error", error: String(e) };
      }

      try {
        await getUserPositionBins("SP000000000000000000002Q6VF78", "dlmm_1");
        checks.positionApi = { status: "ok" };
      } catch (e) {
        const msg = String(e);
        checks.positionApi = { status: msg.includes("404") ? "ok" : "error" };
      }

      const allOk =
        (checks.appApi as Record<string, unknown>).status === "ok" &&
        (checks.binsApi as Record<string, unknown>).status === "ok";

      output({
        status: allOk ? "success" : "error",
        action: allOk ? "All systems operational" : "API connectivity issues detected",
        data: { ...checks, healthy: allOk, timestamp: new Date().toISOString() },
        error: allOk ? null : { code: "unhealthy", message: "One or more APIs unreachable", next: "Check network connectivity and retry" },
      });
    } catch (e) {
      fail("doctor_failed", String(e), "Check network connectivity");
    }
  });

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------
program
  .command("assess")
  .description(
    "Assess exit urgency for a wallet's position in a specific pool. " +
    "Returns risk score, triggers, and urgency level without taking any action."
  )
  .requiredOption("--address <addr>", "Stacks wallet address")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .action(async (opts: { address: string; poolId: string }) => {
    try {
      const [pool, bins, positionBins] = await Promise.all([
        getRichPool(opts.poolId),
        getPoolBins(opts.poolId),
        getUserPositionBins(opts.address, opts.poolId),
      ]);

      if (positionBins.length === 0) {
        output({
          status: "success",
          action: "No position found",
          data: {
            network: NETWORK,
            poolId: opts.poolId,
            address: opts.address,
            hasPosition: false,
            message: "No HODLMM position found for this address in this pool.",
            timestamp: new Date().toISOString(),
          },
          error: null,
        });
        return;
      }

      const assessment = assessRisk(pool, bins, positionBins);
      const xSym = pool.tokens?.tokenX?.symbol ?? "?";
      const ySym = pool.tokens?.tokenY?.symbol ?? "?";

      output({
        status: "success",
        action: assessment.urgency === "critical"
          ? "CRITICAL: Immediate exit recommended"
          : assessment.urgency === "warning"
          ? "WARNING: Consider exiting or reducing position"
          : assessment.urgency === "monitor"
          ? "MONITOR: Minor concerns detected, watch closely"
          : "SAFE: No exit triggers active",
        data: {
          network: NETWORK,
          poolId: opts.poolId,
          pair: `${xSym}/${ySym}`,
          address: opts.address,
          ...assessment,
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    } catch (e) {
      fail("assess_failed", String(e), "Check pool ID and address, then retry");
    }
  });

// ---------------------------------------------------------------------------
// exit
// ---------------------------------------------------------------------------
program
  .command("exit")
  .description(
    "Generate a withdrawal MCP command for a position. Only proceeds if risk assessment " +
    "shows warning or critical urgency. Requires --confirm flag to emit the command."
  )
  .requiredOption("--address <addr>", "Stacks wallet address")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .option("--confirm", "Required flag to emit the withdrawal command")
  .option("--force", "Override urgency check and exit regardless of risk level")
  .action(async (opts: { address: string; poolId: string; confirm?: boolean; force?: boolean }) => {
    try {
      const [pool, bins, positionBins] = await Promise.all([
        getRichPool(opts.poolId),
        getPoolBins(opts.poolId),
        getUserPositionBins(opts.address, opts.poolId),
      ]);

      if (positionBins.length === 0) {
        blocked(
          "no_position",
          "No HODLMM position found for this address in this pool.",
          "Verify the address and pool ID"
        );
        return;
      }

      const assessment = assessRisk(pool, bins, positionBins);
      const activeBinId = bins.active_bin_id ?? 0;
      const xSym = pool.tokens?.tokenX?.symbol ?? "?";
      const ySym = pool.tokens?.tokenY?.symbol ?? "?";

      // Gate 1: Position value too low to justify gas
      if (assessment.positionMetrics.valueUsd < MIN_POSITION_VALUE_USD) {
        blocked(
          "position_too_small",
          `Position value $${assessment.positionMetrics.valueUsd} is below minimum $${MIN_POSITION_VALUE_USD}. Gas would exceed position value.`,
          "Leave position or wait for value to increase"
        );
        return;
      }

      // Gate 2: Urgency check (unless --force)
      if (!opts.force && assessment.urgency !== "critical" && assessment.urgency !== "warning") {
        blocked(
          "no_exit_trigger",
          `Risk assessment is "${assessment.urgency}" (score ${assessment.score}/100). No exit triggers active.`,
          "Use --force to override, or wait for conditions to deteriorate"
        );
        return;
      }

      // Gate 3: Confirmation required
      if (!opts.confirm) {
        blocked(
          "confirmation_required",
          `Exit conditions met (urgency: ${assessment.urgency}, score: ${assessment.score}). Add --confirm to emit the withdrawal command.`,
          `Re-run with --confirm to proceed: hodlmm-emergency-exit exit --address ${opts.address} --pool-id ${opts.poolId} --confirm`
        );
        return;
      }

      // All gates passed — emit withdrawal command
      const mcpCommand = buildWithdrawalCommand(opts.poolId, positionBins, activeBinId);

      output({
        status: "success",
        action: "Execute withdrawal via MCP bitflow withdraw-liquidity-simple",
        data: {
          network: NETWORK,
          poolId: opts.poolId,
          pair: `${xSym}/${ySym}`,
          address: opts.address,
          assessment: {
            urgency: assessment.urgency,
            score: assessment.score,
            triggers: assessment.triggers,
          },
          position: {
            binCount: positionBins.length,
            valueUsd: assessment.positionMetrics.valueUsd,
            binsWithdrawn: Math.min(positionBins.length, MAX_POSITIONS_PER_EXIT),
          },
          mcp_command: mcpCommand,
          gates_passed: {
            position_value_sufficient: true,
            exit_urgency_met: true,
            confirmation_provided: true,
          },
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    } catch (e) {
      fail("exit_failed", String(e), "Check pool ID, address, and network connectivity");
    }
  });

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description(
    "Scan all pools for a wallet's positions and assess exit urgency for each."
  )
  .requiredOption("--address <addr>", "Stacks wallet address")
  .action(async (opts: { address: string }) => {
    try {
      const poolListRes = await fetchJson<{ pools?: Array<{ pool_id: string; active?: boolean }> }>(
        `${BITFLOW_API}/api/quotes/v1/pools`
      );
      const poolIds = (poolListRes.pools ?? [])
        .filter((p) => p.active !== false)
        .map((p) => p.pool_id);

      const results = await Promise.all(
        poolIds.map(async (poolId) => {
          try {
            const [pool, bins, positionBins] = await Promise.all([
              getRichPool(poolId),
              getPoolBins(poolId),
              getUserPositionBins(opts.address, poolId),
            ]);

            if (positionBins.length === 0) return null;

            const assessment = assessRisk(pool, bins, positionBins);
            const xSym = pool.tokens?.tokenX?.symbol ?? "?";
            const ySym = pool.tokens?.tokenY?.symbol ?? "?";

            return {
              poolId,
              pair: `${xSym}/${ySym}`,
              ...assessment,
            };
          } catch (e) {
            process.stderr.write(
              JSON.stringify({ warning: `Failed to scan ${poolId}`, error: String(e) }) + "\n"
            );
            return null;
          }
        })
      );

      const positions = results.filter((r) => r !== null);
      const criticalCount = positions.filter((p) => p.urgency === "critical").length;
      const warningCount = positions.filter((p) => p.urgency === "warning").length;

      const summary = positions.length > 0
        ? `Found ${positions.length} position(s). ${criticalCount} critical, ${warningCount} warning.`
        : "No HODLMM positions found for this address.";

      output({
        status: "success",
        action: criticalCount > 0
          ? `CRITICAL: ${criticalCount} position(s) need immediate exit`
          : warningCount > 0
          ? `WARNING: ${warningCount} position(s) should be reviewed`
          : "All positions are safe",
        data: {
          network: NETWORK,
          address: opts.address,
          positionCount: positions.length,
          criticalCount,
          warningCount,
          positions,
          summary,
          timestamp: new Date().toISOString(),
        },
        error: null,
      });
    } catch (e) {
      fail("scan_failed", String(e), "Check network connectivity and retry");
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
