#!/usr/bin/env bun
/**
 * Bitflow Yield Tracker — HODLMM pool yield monitoring and comparison
 * Read-only. No wallet required. Mainnet only.
 *
 * Usage: bun run bitflow-yield-tracker/bitflow-yield-tracker.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getBitflowService, type HodlmmPoolInfo } from "../src/lib/services/bitflow.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const APR_SANITY_THRESHOLD = 500; // Flag APRs above 500% as suspicious
const MIN_LIQUIDITY_USD = 10_000; // $10,000 USD (liquidity_in_usd is already in USD)

/** Total fee rate in bps from pool protocol + provider fees */
function poolFeeBps(pool: HodlmmPoolInfo): number {
  return (pool.x_protocol_fee ?? 0) + (pool.x_provider_fee ?? 0) + (pool.x_variable_fee ?? 0);
}

/** Estimate 24h fees from volume and fee rate */
function estimateFees24h(volume24h: string, feeBps: number): number {
  return parseFloat(volume24h) * feeBps / 10_000;
}

function calcApr(fees24h: number, totalLiquidityUsd: number): number {
  if (totalLiquidityUsd <= 0) return 0;
  return (fees24h * 365 / totalLiquidityUsd) * 100;
}

function flagPool(apr: number, totalLiquidityUsd: number): string[] {
  const flags: string[] = [];
  if (apr > APR_SANITY_THRESHOLD) flags.push("high-apr-outlier");
  if (totalLiquidityUsd < MIN_LIQUIDITY_USD) flags.push("low-liquidity");
  return flags;
}

/** Get token pair IDs for getTickerByPair — pool uses snake_case fields */
function poolPairIds(pool: HodlmmPoolInfo): [string, string] {
  return [pool.token_x, pool.token_y];
}

function poolPairLabel(pool: HodlmmPoolInfo): string {
  return `${pool.token_x_symbol ?? pool.token_x}/${pool.token_y_symbol ?? pool.token_y}`;
}

const program = new Command();

program
  .name("bitflow-yield-tracker")
  .description("Track and compare Bitflow HODLMM pool yields")
  .version("1.0.0");

// ─── get-pool-yields ─────────────────────────────────────────────────────────
program
  .command("get-pool-yields")
  .description("Fetch estimated APR and yield metrics for all active HODLMM pools")
  .option("--min-apr <number>", "Filter pools below this APR %", parseFloat)
  .option("--sort-by <field>", "Sort by: apr | volume | fees (default: apr)", "apr")
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only. Switch to mainnet and retry." });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();

      const enriched = await Promise.all(
        pools.map(async (pool) => {
          let volume24h = 0;
          let totalLiquidityUsd = 0;

          try {
            const [tokenX, tokenY] = poolPairIds(pool);
            const ticker = await bitflow.getTickerByPair(tokenX, tokenY);
            volume24h = parseFloat(ticker?.base_volume ?? "0");
            totalLiquidityUsd = parseFloat(ticker?.liquidity_in_usd ?? "0");
          } catch {
            // Ticker unavailable — continue with zeros
          }

          // Note: getHodlmmUserPositionBins requires a userAddress — not called here
          // since get-pool-yields is a market-wide view, not user-specific.

          const feeBps = poolFeeBps(pool);
          const fees24h = estimateFees24h(String(volume24h), feeBps);
          const estimatedApr = calcApr(fees24h, totalLiquidityUsd);
          const flags = flagPool(estimatedApr, totalLiquidityUsd);

          return {
            poolId: pool.pool_id,
            pair: poolPairLabel(pool),
            feeTierBps: feeBps,
            estimatedApr: parseFloat(estimatedApr.toFixed(2)),
            volume24h: String(volume24h),
            fees24hEstimate: parseFloat(fees24h.toFixed(2)),
            totalLiquidityUsd: String(totalLiquidityUsd),
            flags,
          };
        })
      );

      let result = enriched;

      if (opts.minApr !== undefined) {
        result = result.filter((p) => p.estimatedApr >= opts.minApr);
      }

      result.sort((a, b) => {
        if (opts.sortBy === "volume") return parseFloat(b.volume24h) - parseFloat(a.volume24h);
        if (opts.sortBy === "fees") return b.fees24hEstimate - a.fees24hEstimate;
        return b.estimatedApr - a.estimatedApr;
      });

      printJson({
        network: NETWORK,
        count: result.length,
        sortBy: opts.sortBy,
        pools: result,
        note: "APR estimated from 24h volume × pool fee rate / TVL × 365. Actual yield depends on position concentration and bin range coverage.",
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-pool-detail ─────────────────────────────────────────────────────────
program
  .command("get-pool-detail")
  .description("Get detailed yield and bin data for a specific HODLMM pool")
  .requiredOption("--pool-id <contractId>", "Pool contract ID")
  .option("--address <stacksAddress>", "Stacks address for user position bins")
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();
      const pool = pools.find((p) => p.pool_id === opts.poolId);
      if (!pool) {
        printJson({ error: "Pool not found", poolId: opts.poolId });
        return;
      }

      let volume24h = 0;
      let totalLiquidityUsd = 0;
      try {
        const [tokenX, tokenY] = poolPairIds(pool);
        const ticker = await bitflow.getTickerByPair(tokenX, tokenY);
        volume24h = parseFloat(ticker?.base_volume ?? "0");
        totalLiquidityUsd = parseFloat(ticker?.liquidity_in_usd ?? "0");
      } catch { /* ignore */ }

      const feeBps = poolFeeBps(pool);
      const fees24h = estimateFees24h(String(volume24h), feeBps);
      const estimatedApr = parseFloat(calcApr(fees24h, totalLiquidityUsd).toFixed(2));
      const flags = flagPool(estimatedApr, totalLiquidityUsd);

      const bins = await bitflow.getHodlmmPoolBins(opts.poolId);
      const activeBin = bins?.active_bin_id ?? null;
      const binList = Array.isArray(bins?.bins) ? bins.bins : [];

      let priceRange = null;
      if (binList.length > 0) {
        const prices = binList.map((b) => parseFloat(b.price ?? "0")).filter(Boolean);
        if (prices.length > 0) {
          priceRange = { low: Math.min(...prices), high: Math.max(...prices) };
        }
      }

      const result: Record<string, unknown> = {
        network: NETWORK,
        poolId: pool.pool_id,
        pair: poolPairLabel(pool),
        binStep: pool.bin_step,
        feeTierBps: feeBps,
        activeBin,
        estimatedApr,
        volume24h: String(volume24h),
        fees24hEstimate: parseFloat(fees24h.toFixed(2)),
        totalLiquidityUsd: String(totalLiquidityUsd),
        priceRange,
        activeBinCount: binList.length,
        flags,
        fetchedAt: new Date().toISOString(),
      };

      if (opts.address) {
        try {
          const userBins = await bitflow.getHodlmmUserPositionBins(opts.address, opts.poolId);
          result.userPosition = {
            address: opts.address,
            binCount: Array.isArray(userBins?.bins) ? userBins.bins.length : 0,
          };
        } catch {
          result.userPosition = { address: opts.address, error: "Could not fetch user position" };
        }
      }

      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// ─── compare-pools ───────────────────────────────────────────────────────────
program
  .command("compare-pools")
  .description("Compare top N HODLMM pools by estimated APR")
  .option("--top <number>", "Number of top pools to show (default: 5)", parseInt, 5)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();

      const enriched = await Promise.all(
        pools.map(async (pool) => {
          let volume24h = 0;
          let totalLiquidityUsd = 0;
          try {
            const [tokenX, tokenY] = poolPairIds(pool);
            const ticker = await bitflow.getTickerByPair(tokenX, tokenY);
            volume24h = parseFloat(ticker?.base_volume ?? "0");
            totalLiquidityUsd = parseFloat(ticker?.liquidity_in_usd ?? "0");
          } catch { /* ignore */ }

          const feeBps = poolFeeBps(pool);
          const fees24h = estimateFees24h(String(volume24h), feeBps);
          const estimatedApr = parseFloat(calcApr(fees24h, totalLiquidityUsd).toFixed(2));

          return {
            poolId: pool.pool_id,
            pair: poolPairLabel(pool),
            feeTierBps: feeBps,
            estimatedApr,
            volume24h: String(volume24h),
            totalLiquidityUsd: String(totalLiquidityUsd),
            flags: flagPool(estimatedApr, totalLiquidityUsd),
          };
        })
      );

      const sorted = enriched
        .sort((a, b) => b.estimatedApr - a.estimatedApr)
        .slice(0, opts.top)
        .map((pool, i) => ({
          rank: i + 1,
          ...pool,
          recommendation:
            i === 0 ? "highest yield" :
            parseFloat(pool.volume24h) > 100_000 ? "high volume" :
            pool.flags.includes("low-liquidity") ? "low liquidity — use caution" :
            "monitor",
        }));

      printJson({
        network: NETWORK,
        topN: opts.top,
        pools: sorted,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-fee-estimate ────────────────────────────────────────────────────────
program
  .command("get-fee-estimate")
  .description("Estimate fees earned for a liquidity position over N days")
  .requiredOption("--pool-id <contractId>", "Pool contract ID")
  .requiredOption("--amount-usd <number>", "Position size in USD", parseFloat)
  .option("--days <number>", "Projection period in days (default: 30)", parseInt, 30)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();
      const pool = pools.find((p) => p.pool_id === opts.poolId);
      if (!pool) {
        printJson({ error: "Pool not found", poolId: opts.poolId });
        return;
      }

      let volume24h = 0;
      let totalLiquidityUsd = 0;
      try {
        const [tokenX, tokenY] = poolPairIds(pool);
        const ticker = await bitflow.getTickerByPair(tokenX, tokenY);
        volume24h = parseFloat(ticker?.base_volume ?? "0");
        totalLiquidityUsd = parseFloat(ticker?.liquidity_in_usd ?? "0");
      } catch { /* ignore */ }

      const feeBps = poolFeeBps(pool);
      const fees24h = estimateFees24h(String(volume24h), feeBps);
      const estimatedApr = calcApr(fees24h, totalLiquidityUsd);
      const dailyRate = estimatedApr / 365 / 100;
      const estimatedFeesUsd = parseFloat((opts.amountUsd * dailyRate * opts.days).toFixed(4));

      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        pair: poolPairLabel(pool),
        inputAmountUsd: opts.amountUsd,
        projectionDays: opts.days,
        estimatedFeesUsd,
        estimatedApr: parseFloat(estimatedApr.toFixed(2)),
        feeTierBps: feeBps,
        assumptions: "APR estimated from 24h volume × fee rate / TVL × 365. Actual yield depends on price staying within active bin range and position concentration.",
        flags: flagPool(estimatedApr, totalLiquidityUsd),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
