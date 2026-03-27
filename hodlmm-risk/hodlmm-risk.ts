#!/usr/bin/env bun
/**
 * HODLMM Risk skill CLI
 * Volatility risk monitoring for Bitflow HODLMM (DLMM) pools
 *
 * Self-contained: uses Bitflow API directly, no external dependencies beyond commander.
 * HODLMM bonus eligible: Yes — directly monitors HODLMM pool risk.
 *
 * Usage: bun run skills/hodlmm-risk/hodlmm-risk.ts <subcommand> [options]
 */
import { Command } from "commander";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HodlmmBinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}
interface HodlmmPoolInfo {
  active_bin: number;
  token_x: string;
  token_y: string;
  token_x_symbol?: string;
  token_y_symbol?: string;
}
interface HodlmmBinListResponse {
  active_bin_id?: number;
  bins: HodlmmBinData[];
}
interface RiskMetrics {
  activeBinId: number;
  totalBins: number;
  binSpread: number;
  reserveImbalanceRatio: number;
  volatilityScore: number;
  regime: "calm" | "elevated" | "crisis";
}
// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}
async function getHodlmmPool(poolId: string): Promise<HodlmmPoolInfo> {
  return fetchJson<HodlmmPoolInfo>(`${BITFLOW_API}/hodlmm/pools/${poolId}`);
}
async function getHodlmmPoolBins(poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(`${BITFLOW_API}/hodlmm/pools/${poolId}/bins`);
}
async function getHodlmmUserPositionBins(address: string, poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson<HodlmmBinListResponse>(`${BITFLOW_API}/hodlmm/pools/${poolId}/positions/${address}`);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function printJson(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}
function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
      const output = { error: message };
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}
// ---------------------------------------------------------------------------
// Risk computation helpers
// ---------------------------------------------------------------------------
function classifyRegime(score: number): "calm" | "elevated" | "crisis" {
  if (score <= 30) return "calm";
  if (score <= 60) return "elevated";
  return "crisis";
}
function computePoolRiskMetrics(
  pool: HodlmmPoolInfo,
  binsResponse: HodlmmBinListResponse
): RiskMetrics {
  const bins = binsResponse.bins;
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) {
    throw new Error("Cannot determine active bin from pool or bins response");
  }
  const totalBins = bins.length;
  const nonEmptyBins = bins.filter(
    (b) => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0
  );
  if (nonEmptyBins.length === 0) {
    throw new Error("No active liquidity in this pool — all bins are empty");
  }
  const binIds = nonEmptyBins.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const binSpread = totalBins > 0 ? (maxBin - minBin) / Math.max(totalBins, 1) : 0;
  let totalX = 0;
  let totalY = 0;
  for (const bin of bins) {
    totalX += Number(bin.reserve_x);
    totalY += Number(bin.reserve_y);
  }
  const totalReserves = totalX + totalY;
  const reserveImbalanceRatio =
    totalReserves > 0 ? Math.abs(totalX - totalY) / totalReserves : 0;
  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  const activeLiquidity = activeBin
    ? Number(activeBin.reserve_x) + Number(activeBin.reserve_y)
    : 0;
  const activeBinConcentration =
    totalReserves > 0 ? activeLiquidity / totalReserves : 0;
  // Weights: spread (40%), imbalance (30%), concentration (30%) = max 100.
  // Bin spread is the strongest indicator of price movement (40%),
  // while reserve imbalance and liquidity dispersion are secondary (30% each).
  const SPREAD_WEIGHT = 40;
  const IMBALANCE_WEIGHT = 30;
  const CONCENTRATION_WEIGHT = 30;
  const spreadScore = Math.min(binSpread * 100, SPREAD_WEIGHT);
  const imbalanceScore = reserveImbalanceRatio * IMBALANCE_WEIGHT;
  const concentrationScore = (1 - activeBinConcentration) * CONCENTRATION_WEIGHT;
  const volatilityScore = Math.round(
    Math.min(spreadScore + imbalanceScore + concentrationScore, 100)
  );
  return {
    activeBinId,
    totalBins,
    binSpread: Number(binSpread.toFixed(4)),
    reserveImbalanceRatio: Number(reserveImbalanceRatio.toFixed(4)),
    volatilityScore,
    regime: classifyRegime(volatilityScore),
  };
}
function computeSignals(metrics: RiskMetrics) {
  const safeToAddLiquidity = metrics.regime !== "crisis";
  const recommendedBinWidth =
    metrics.regime === "calm" ? 3 : metrics.regime === "elevated" ? 7 : 15;
  const maxExposurePct =
    metrics.regime === "calm" ? 0.25 : metrics.regime === "elevated" ? 0.1 : 0.0;
  return { safeToAddLiquidity, recommendedBinWidth, maxExposurePct };
}
// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();
program
  .name("hodlmm-risk")
  .description(
    "HODLMM volatility risk monitoring — pool assessment, position scoring, and regime classification"
  )
  .version("0.3.0");
// ---------------------------------------------------------------------------
// assess-pool
// ---------------------------------------------------------------------------
program
  .command("assess-pool")
  .description(
    "Assess volatility and risk metrics for a HODLMM pool. Returns regime classification and position-sizing signals."
  )
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_3)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [pool, binsResponse] = await Promise.all([
        getHodlmmPool(opts.poolId),
        getHodlmmPoolBins(opts.poolId),
      ]);
      if (!binsResponse.bins || binsResponse.bins.length === 0) {
        throw new Error("No bins returned for this pool");
      }
      const metrics = computePoolRiskMetrics(pool, binsResponse);
      const signals = computeSignals(metrics);
      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        tokenX: pool.token_x_symbol || pool.token_x,
        tokenY: pool.token_y_symbol || pool.token_y,
        activeBinId: metrics.activeBinId,
        totalBins: metrics.totalBins,
        binSpread: metrics.binSpread,
        reserveImbalanceRatio: metrics.reserveImbalanceRatio,
        volatilityScore: metrics.volatilityScore,
        regime: metrics.regime,
        signals,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });
// ---------------------------------------------------------------------------
// assess-position
// ---------------------------------------------------------------------------
program
  .command("assess-position")
  .description(
    "Assess risk for a wallet's HODLMM position in a pool. Returns drift score and hold/withdraw/rebalance recommendation."
  )
  .requiredOption("--pool-id <id>", "HODLMM pool identifier")
  .requiredOption("--address <addr>", "Stacks address to check")
  .action(async (opts: { poolId: string; address: string }) => {
    try {
      const [pool, binsResponse, positionResponse] = await Promise.all([
        getHodlmmPool(opts.poolId),
        getHodlmmPoolBins(opts.poolId),
        getHodlmmUserPositionBins(opts.address, opts.poolId),
      ]);
      const positionBins = positionResponse.bins;
      if (!positionBins || positionBins.length === 0) {
        throw new Error("Address has no position in this pool");
      }
      const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
      if (activeBinId == null) {
        throw new Error("Cannot determine active bin from pool or bins response");
      }
      const positionBinIds = positionBins.map((b) => b.bin_id);
      const offsets = positionBinIds.map((id) => Math.abs(id - activeBinId));
      const nearestOffset = Math.min(...offsets);
      const avgOffset =
        offsets.reduce((sum, o) => sum + o, 0) / offsets.length;
      const driftScore = Math.round(Math.min(avgOffset * 5, 100));
      const concentrationRisk =
        positionBins.length === 1
          ? "high"
          : positionBins.length <= 3
          ? "medium"
          : "low";
      const impermanentLossEstimatePct = Number(
        (driftScore * 0.08).toFixed(2)
      );
      let recommendation: "hold" | "withdraw" | "rebalance";
      if (driftScore > 50) {
        recommendation = "withdraw";
      } else if (driftScore > 20) {
        recommendation = "rebalance";
      } else {
        recommendation = "hold";
      }
      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        address: opts.address,
        positionBinCount: positionBins.length,
        activeBinId,
        nearestPositionBinOffset: nearestOffset,
        avgBinOffset: Number(avgOffset.toFixed(2)),
        concentrationRisk,
        driftScore,
        impermanentLossEstimatePct,
        recommendation,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });
// ---------------------------------------------------------------------------
// regime-snapshot
// ---------------------------------------------------------------------------
program
  .command("regime-snapshot")
  .description(
    "Get a single-point volatility regime snapshot for a pool. For trend history, use an external time-series store."
  )
  .requiredOption("--pool-id <id>", "HODLMM pool identifier")
  .action(async (opts: { poolId: string }) => {
    try {
      const [pool, binsResponse] = await Promise.all([
        getHodlmmPool(opts.poolId),
        getHodlmmPoolBins(opts.poolId),
      ]);
      if (!binsResponse.bins || binsResponse.bins.length === 0) {
        throw new Error("No bins returned for this pool");
      }
      const metrics = computePoolRiskMetrics(pool, binsResponse);
      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        volatilityScore: metrics.volatilityScore,
        regime: metrics.regime,
        activeBinId: metrics.activeBinId,
        binSpread: metrics.binSpread,
        reserveImbalanceRatio: metrics.reserveImbalanceRatio,
        note: "Single-point snapshot. For trend analysis, store snapshots externally over time.",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });
// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
