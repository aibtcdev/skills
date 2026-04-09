#!/usr/bin/env bun
/**
 * bitflow-arb-scanner — Arbitrage Scanner for Bitflow DEX
 *
 * Detects price discrepancies between SDK (XYK AMM) routes and HODLMM (DLMM)
 * quotes on Bitflow DEX. Surfaces profitable arbitrage opportunities with
 * spread analysis and fee-adjusted P&L estimation.
 *
 * All operations are read-only. No swaps executed.
 *
 * Commands:
 *   scan       — scan all pairs for SDK vs HODLMM spread
 *   scan-pair  — deep route comparison for one pair
 *   scan-pools — bin-level pricing analysis within HODLMM pools
 *   watchlist  — monitor specific pairs for actionable spreads
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  getBitflowService,
  type UnifiedBitflowRouteQuote,
} from "../src/lib/services/bitflow.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const HODLMM_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const DEFAULT_AMOUNT = "10.0";
const DEFAULT_MIN_SPREAD = 0.1;
const DEFAULT_TOP = 10;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureMainnet(): void {
  if (NETWORK !== "mainnet") {
    throw new Error("Bitflow arbitrage scanner is mainnet only. Set NETWORK=mainnet.");
  }
}

interface RouteBreakdown {
  source: "sdk" | "hodlmm";
  label: string;
  amountOut: string;
  executable: boolean;
  priceImpactPct: string;
  feeBps: number;
}

function routeToBreakdown(route: UnifiedBitflowRouteQuote): RouteBreakdown {
  return {
    source: route.source,
    label: route.label,
    amountOut: route.amountOutHuman,
    executable: route.executable,
    priceImpactPct: route.priceImpact?.combinedImpactPct ?? "N/A",
    feeBps: route.priceImpact?.totalFeeBps ?? 0,
  };
}

interface ArbOpportunity {
  pair: string;
  tokenX: string;
  tokenY: string;
  amountIn: string;
  sdkAmountOut: string;
  hodlmmAmountOut: string;
  spreadPct: string;
  bestSource: "sdk" | "hodlmm";
  estimatedFeeBps: number;
  netSpreadPct: string;
  sdkRoute: string;
  hodlmmPool: string;
  priceImpact: { sdk: string; hodlmm: string };
}

function calculateSpread(
  sdkRoutes: UnifiedBitflowRouteQuote[],
  hodlmmRoutes: UnifiedBitflowRouteQuote[],
  tokenX: string,
  tokenY: string,
  amountIn: string
): ArbOpportunity | null {
  const bestSdk = sdkRoutes[0];
  const bestHodlmm = hodlmmRoutes[0];

  if (!bestSdk || !bestHodlmm) return null;

  const sdkOut = parseFloat(bestSdk.amountOutHuman);
  const hodlmmOut = parseFloat(bestHodlmm.amountOutHuman);

  if (sdkOut <= 0 || hodlmmOut <= 0) return null;

  const maxOut = Math.max(sdkOut, hodlmmOut);
  const minOut = Math.min(sdkOut, hodlmmOut);
  const spreadPct = ((maxOut - minOut) / minOut) * 100;

  const bestSource = hodlmmOut > sdkOut ? "hodlmm" : "sdk";
  const avgFeeBps = Math.round(
    ((bestSdk.priceImpact?.totalFeeBps ?? 0) +
      (bestHodlmm.priceImpact?.totalFeeBps ?? 0)) /
      2
  );
  const netSpreadPct = Math.max(0, spreadPct - avgFeeBps / 100);

  // Extract labels
  const sdkLabel = bestSdk.label || bestSdk.poolContracts?.[0] || "sdk";
  const hodlmmLabel = bestHodlmm.label || bestHodlmm.poolContracts?.[0] || "hodlmm";

  // Extract token symbols from IDs
  const xSymbol = tokenX.replace("token-", "").replace("-auto", "").toUpperCase();
  const ySymbol = tokenY.replace("token-", "").replace("-auto", "").toUpperCase();

  return {
    pair: `${xSymbol}/${ySymbol}`,
    tokenX,
    tokenY,
    amountIn,
    sdkAmountOut: bestSdk.amountOutHuman,
    hodlmmAmountOut: bestHodlmm.amountOutHuman,
    spreadPct: spreadPct.toFixed(2),
    bestSource,
    estimatedFeeBps: avgFeeBps,
    netSpreadPct: netSpreadPct.toFixed(2),
    sdkRoute: sdkLabel,
    hodlmmPool: hodlmmLabel,
    priceImpact: {
      sdk: bestSdk.priceImpact?.combinedImpactPct ?? "N/A",
      hodlmm: bestHodlmm.priceImpact?.combinedImpactPct ?? "N/A",
    },
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("bitflow-arb-scanner")
  .description("Arbitrage scanner for Bitflow DEX — SDK vs HODLMM spread detection");

// ─── scan ───────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description("Scan all trading pairs for SDK vs HODLMM arbitrage opportunities")
  .option("--min-spread <percent>", "Minimum spread % to report", DEFAULT_MIN_SPREAD.toString())
  .option("--amount <decimal>", "Trade size for quote comparison", DEFAULT_AMOUNT)
  .option("--top <number>", "Return top N opportunities", DEFAULT_TOP.toString())
  .action(async (options) => {
    try {
      ensureMainnet();
      const service = getBitflowService(NETWORK);
      const minSpread = parseFloat(options.minSpread);
      const amount = options.amount;
      const top = parseInt(options.top, 10);

      // Get all available tokens
      const tokens = await service.getAvailableTokens();
      const tokenIds = tokens.map((t) => t.id);

      const opportunities: ArbOpportunity[] = [];
      const scannedPairs = new Set<string>();

      // Scan each token pair
      for (const tokenX of tokenIds) {
        let targets: string[];
        try {
          targets = await service.getPossibleSwapTargets(tokenX);
        } catch {
          continue;
        }

        for (const tokenY of targets) {
          const pairKey = [tokenX, tokenY].sort().join("|");
          if (scannedPairs.has(pairKey)) continue;
          scannedPairs.add(pairKey);

          try {
            const routes = await service.getUnifiedRouteQuotes(tokenX, tokenY, amount);

            const sdkRoutes = routes.filter((r) => r.source === "sdk");
            const hodlmmRoutes = routes.filter((r) => r.source === "hodlmm");

            if (sdkRoutes.length === 0 || hodlmmRoutes.length === 0) continue;

            const opp = calculateSpread(sdkRoutes, hodlmmRoutes, tokenX, tokenY, amount);
            if (opp && parseFloat(opp.spreadPct) >= minSpread) {
              opportunities.push(opp);
            }
          } catch {
            // Skip pairs that fail to quote
            continue;
          }
        }
      }

      // Sort by spread descending, take top N
      opportunities.sort((a, b) => parseFloat(b.spreadPct) - parseFloat(a.spreadPct));
      const topOpps = opportunities.slice(0, top);

      printJson({
        network: NETWORK,
        scanTime: new Date().toISOString(),
        tradeAmount: amount,
        minSpreadPct: minSpread,
        opportunityCount: topOpps.length,
        totalPairsScanned: scannedPairs.size,
        opportunities: topOpps,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── scan-pair ──────────────────────────────────────────────────────────────

program
  .command("scan-pair")
  .description("Deep route comparison for a specific token pair")
  .requiredOption("--token-x <tokenId>", "Input token ID")
  .requiredOption("--token-y <tokenId>", "Output token ID")
  .requiredOption("--amount-in <decimal>", "Amount of input token")
  .action(async (options) => {
    try {
      ensureMainnet();
      const service = getBitflowService(NETWORK);
      const { tokenX, tokenY, amountIn } = options;

      const routes = await service.getUnifiedRouteQuotes(tokenX, tokenY, amountIn);

      if (routes.length === 0) {
        printJson({
          network: NETWORK,
          error: "no routes found",
          tokenX,
          tokenY,
          amountIn,
        });
        return;
      }

      const routeBreakdowns = routes.map(routeToBreakdown);

      // Sort by output descending
      const sorted = [...routes].sort(
        (a, b) => parseFloat(b.amountOutHuman) - parseFloat(a.amountOutHuman)
      );
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];

      const bestOut = parseFloat(best.amountOutHuman);
      const worstOut = parseFloat(worst.amountOutHuman);
      const spreadPct = worstOut > 0 ? ((bestOut - worstOut) / worstOut) * 100 : 0;
      const avgFeeBps = Math.round(
        routes.reduce((sum, r) => sum + (r.priceImpact?.totalFeeBps ?? 0), 0) / routes.length
      );
      const netSpreadPct = Math.max(0, spreadPct - avgFeeBps / 100);

      const xSymbol = tokenX.replace("token-", "").replace("-auto", "").toUpperCase();
      const ySymbol = tokenY.replace("token-", "").replace("-auto", "").toUpperCase();

      printJson({
        network: NETWORK,
        pair: `${xSymbol}/${ySymbol}`,
        tokenX,
        tokenY,
        amountIn,
        routes: routeBreakdowns,
        bestRoute: {
          source: best.source,
          amountOut: best.amountOutHuman,
        },
        worstRoute: {
          source: worst.source,
          amountOut: worst.amountOutHuman,
        },
        spreadPct: spreadPct.toFixed(2),
        netSpreadPct: netSpreadPct.toFixed(2),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── scan-pools ─────────────────────────────────────────────────────────────

program
  .command("scan-pools")
  .description("Scan HODLMM pools for internal bin pricing inefficiencies")
  .option("--suggested", "Only scan suggested/featured pools")
  .option("--min-spread <percent>", "Minimum spread % to report", "0.5")
  .action(async (options) => {
    try {
      ensureMainnet();
      const service = getBitflowService(NETWORK);
      const minSpread = parseFloat(options.minSpread);

      const pools = await service.getHodlmmPools(
        options.suggested ? { suggested: true } : undefined
      );

      const opportunities: Array<{
        poolId: string;
        tokenX: string;
        tokenY: string;
        activeBin: number;
        binStep: number;
        spreadPct: string;
        description: string;
      }> = [];

      for (const pool of pools) {
        try {
          const binsResponse = await service.getHodlmmPoolBins(pool.pool_id);
          if (!binsResponse?.bins || binsResponse.bins.length < 3) continue;

          const activeBinId = binsResponse.active_bin_id;
          const bins = binsResponse.bins;

          // Find active bin and nearby bins
          const activeBin = bins.find((b: any) => b.bin_id === activeBinId);
          if (!activeBin) continue;

          // Calculate price deviation: compare active bin price to weighted average of nearby bins
          const nearbyBins = bins.filter((b: any) => {
            const diff = Math.abs(b.bin_id - activeBinId);
            return diff > 0 && diff <= 3;
          });

          if (nearbyBins.length === 0) continue;

          const activeBinPrice = parseFloat(activeBin.price || "0");
          if (activeBinPrice <= 0) continue;

          // Weighted average price of nearby bins by liquidity
          let totalLiquidity = 0;
          let weightedPriceSum = 0;

          for (const bin of nearbyBins) {
            const price = parseFloat(bin.price || "0");
            const liq =
              parseFloat(bin.reserve_x || "0") + parseFloat(bin.reserve_y || "0");
            if (price > 0 && liq > 0) {
              weightedPriceSum += price * liq;
              totalLiquidity += liq;
            }
          }

          if (totalLiquidity <= 0) continue;

          const avgNearbyPrice = weightedPriceSum / totalLiquidity;
          const deviation =
            Math.abs(activeBinPrice - avgNearbyPrice) / avgNearbyPrice * 100;

          if (deviation >= minSpread) {
            opportunities.push({
              poolId: pool.pool_id,
              tokenX: pool.token_x,
              tokenY: pool.token_y,
              activeBin: activeBinId,
              binStep: pool.bin_step,
              spreadPct: deviation.toFixed(2),
              description:
                activeBinPrice > avgNearbyPrice
                  ? "Active bin price above nearby bin weighted average"
                  : "Active bin price below nearby bin weighted average",
            });
          }
        } catch {
          continue;
        }
      }

      opportunities.sort(
        (a, b) => parseFloat(b.spreadPct) - parseFloat(a.spreadPct)
      );

      printJson({
        network: NETWORK,
        poolCount: pools.length,
        opportunityCount: opportunities.length,
        minSpreadPct: minSpread,
        opportunities,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── watchlist ──────────────────────────────────────────────────────────────

program
  .command("watchlist")
  .description("Monitor specific pairs for actionable arbitrage spreads")
  .requiredOption("--pairs <json>", "JSON array of [tokenX, tokenY] pairs")
  .option("--amount <decimal>", "Trade size for quotes", DEFAULT_AMOUNT)
  .option("--min-spread <percent>", "Minimum spread % to alert", "0.5")
  .action(async (options) => {
    try {
      ensureMainnet();
      const service = getBitflowService(NETWORK);
      const minSpread = parseFloat(options.minSpread);
      const amount = options.amount;

      let pairs: [string, string][];
      try {
        pairs = JSON.parse(options.pairs);
      } catch {
        throw new Error("--pairs must be a valid JSON array of [tokenX, tokenY] pairs");
      }

      if (!Array.isArray(pairs) || pairs.length === 0) {
        throw new Error("--pairs must be a non-empty array");
      }

      const alerts: Array<{
        pair: string;
        spreadPct: string;
        bestSource: string;
        amountIn: string;
        sdkOut: string;
        hodlmmOut: string;
      }> = [];

      for (const [tokenX, tokenY] of pairs) {
        try {
          const routes = await service.getUnifiedRouteQuotes(tokenX, tokenY, amount);

          const sdkRoutes = routes.filter((r) => r.source === "sdk");
          const hodlmmRoutes = routes.filter((r) => r.source === "hodlmm");

          if (sdkRoutes.length === 0 || hodlmmRoutes.length === 0) continue;

          const opp = calculateSpread(sdkRoutes, hodlmmRoutes, tokenX, tokenY, amount);
          if (opp && parseFloat(opp.spreadPct) >= minSpread) {
            const xSymbol = tokenX.replace("token-", "").replace("-auto", "").toUpperCase();
            const ySymbol = tokenY.replace("token-", "").replace("-auto", "").toUpperCase();
            alerts.push({
              pair: `${xSymbol}/${ySymbol}`,
              spreadPct: opp.spreadPct,
              bestSource: opp.bestSource,
              amountIn: amount,
              sdkOut: opp.sdkAmountOut,
              hodlmmOut: opp.hodlmmAmountOut,
            });
          }
        } catch {
          continue;
        }
      }

      alerts.sort((a, b) => parseFloat(b.spreadPct) - parseFloat(a.spreadPct));

      printJson({
        network: NETWORK,
        scannedAt: new Date().toISOString(),
        pairsScanned: pairs.length,
        alertCount: alerts.length,
        minSpreadPct: minSpread,
        alerts,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── Run ────────────────────────────────────────────────────────────────────

program.parse();
