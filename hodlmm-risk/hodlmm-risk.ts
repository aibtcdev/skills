#!/usr/bin/env bun
/**
 * HODLMM Risk skill CLI
 * Volatility risk monitoring for Bitflow HODLMM (DLMM) pools
 *
 * Usage: bun run hodlmm-risk/hodlmm-risk.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  getBitflowService,
  type HodlmmBinData,
  type HodlmmPoolInfo,
  type HodlmmBinListResponse,
} from "../src/lib/services/bitflow.service.js";
import { getWalletAddress } from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Risk computation helpers
// ---------------------------------------------------------------------------

interface RiskMetrics {
  activeBinId: number;
  totalBins: number;
  binSpread: number;
  reserveImbalanceRatio: number;
  volatilityScore: number;
  regime: "calm" | "elevated" | "crisis";
}

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
  const totalBins = bins.length;

  // Bin spread: normalized distance between lowest and highest non-empty bin
  const nonEmptyBins = bins.filter(
    (b) => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0
  );
  const binIds = nonEmptyBins.map((b) => b.bin_id);
  const minBin = Math.min(...binIds);
  const maxBin = Math.max(...binIds);
  const binSpread = totalBins > 0 ? (maxBin - minBin) / Math.max(totalBins, 1) : 0;

  // Reserve imbalance: ratio of total X reserves to total (X + Y) reserves
  let totalX = 0;
  let totalY = 0;
  for (const bin of bins) {
    totalX += Number(bin.reserve_x);
    totalY += Number(bin.reserve_y);
  }
  const totalReserves = totalX + totalY;
  const reserveImbalanceRatio =
    totalReserves > 0 ? Math.abs(totalX - totalY) / totalReserves : 0;

  // Active bin concentration: what fraction of liquidity is in the active bin
  const activeBin = bins.find((b) => b.bin_id === activeBinId);
  const activeLiquidity = activeBin
    ? Number(activeBin.reserve_x) + Number(activeBin.reserve_y)
    : 0;
  const activeBinConcentration =
    totalReserves > 0 ? activeLiquidity / totalReserves : 0;

  // Volatility score: weighted combination of signals
  // Higher spread = higher vol, higher imbalance = higher vol,
  // lower active bin concentration = higher vol (liquidity dispersed)
  const spreadScore = Math.min(binSpread * 100, 40); // 0-40
  const imbalanceScore = reserveImbalanceRatio * 30; // 0-30
  const concentrationScore = (1 - activeBinConcentration) * 30; // 0-30
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
    "HODLMM volatility risk monitoring \u2014 pool assessment, position scoring, and regime classification"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// assess-pool
// ---------------------------------------------------------------------------

program
  .command("assess-pool")
  .description(
    "Assess volatility and risk metrics for a HODLMM pool. Returns regime classification and position-sizing signals."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool identifier (e.g. dlmm_3)")
  .action(async (opts: { poolId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error("Network must be mainnet \u2014 Bitflow HODLMM is mainnet-only");
      }

      const service = getBitflowService(NETWORK);
      const [pool, binsResponse] = await Promise.all([
        service.getHodlmmPool(opts.poolId),
        service.getHodlmmPoolBins(opts.poolId),
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
  .requiredOption("--pool-id <poolId>", "HODLMM pool identifier")
  .option("--address <address>", "Stacks address (uses wallet default if omitted)")
  .action(async (opts: { poolId: string; address?: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error("Network must be mainnet \u2014 Bitflow HODLMM is mainnet-only");
      }

      const service = getBitflowService(NETWORK);
      const address = opts.address || (await getWalletAddress());

      const [pool, binsResponse, positionResponse] = await Promise.all([
        service.getHodlmmPool(opts.poolId),
        service.getHodlmmPoolBins(opts.poolId),
        service.getHodlmmUserPositionBins(address, opts.poolId),
      ]);

      const positionBins = positionResponse.bins;
      if (!positionBins || positionBins.length === 0) {
        throw new Error("Address has no position in this pool");
      }

      const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
      const positionBinIds = positionBins.map((b) => b.bin_id);

      // Distance from active bin
      const offsets = positionBinIds.map((id) => Math.abs(id - activeBinId));
      const nearestOffset = Math.min(...offsets);
      const avgOffset =
        offsets.reduce((sum, o) => sum + o, 0) / offsets.length;

      // Drift score: 0-100 based on how far position has drifted
      const driftScore = Math.round(Math.min(avgOffset * 5, 100));

      // Concentration risk
      const concentrationRisk =
        positionBins.length === 1
          ? "high"
          : positionBins.length <= 3
          ? "medium"
          : "low";

      // Approximate IL estimate based on drift
      const impermanentLossEstimatePct = Number(
        (driftScore * 0.08).toFixed(2)
      );

      // Recommendation
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
        address,
        positionBinCount: positionBins.length,
        activeBinId,
        nearestPositionBinOffset: nearestOffset,
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
// regime-history
// ---------------------------------------------------------------------------

program
  .command("regime-history")
  .description(
    "Compute current volatility regime snapshot for a pool. Returns a single-point assessment with trend indicator."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool identifier")
  .option("--samples <count>", "Number of data points (currently returns 1 live snapshot)", "1")
  .action(async (opts: { poolId: string; samples: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error("Network must be mainnet \u2014 Bitflow HODLMM is mainnet-only");
      }

      const service = getBitflowService(NETWORK);
      const [pool, binsResponse] = await Promise.all([
        service.getHodlmmPool(opts.poolId),
        service.getHodlmmPoolBins(opts.poolId),
      ]);

      if (!binsResponse.bins || binsResponse.bins.length === 0) {
        throw new Error("No bins returned for this pool");
      }

      const metrics = computePoolRiskMetrics(pool, binsResponse);

      const snapshot = {
        volatilityScore: metrics.volatilityScore,
        regime: metrics.regime,
        activeBinId: metrics.activeBinId,
        timestamp: new Date().toISOString(),
      };

      // Single snapshot: trend is stable since we have one data point
      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        samples: 1,
        history: [snapshot],
        trend: "stable",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
