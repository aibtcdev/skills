#!/usr/bin/env bun
/**
 * Bitflow Yield Tracker — HODLMM pool yield monitoring and comparison
 * Read-only. No wallet required. Mainnet only.
 *
 * Usage: bun run bitflow-yield-tracker/bitflow-yield-tracker.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getBitflowService } from "../src/lib/services/bitflow.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const APR_SANITY_THRESHOLD = 500; // Flag APRs above 500% as suspicious
const MIN_LIQUIDITY_USD = 10_000; // $10,000 USD (ticker?.liquidity is in USD, not micro-units)

function calcApr(fees24h: string, totalLiquidity: string): number {
  const fees = parseFloat(fees24h);
  const liq = parseFloat(totalLiquidity);
  if (liq <= 0) return 0;
  return (fees * 365 / liq) * 100;
}

function flagPool(apr: number, totalLiquidity: string): string[] {
  const flags: string[] = [];
  if (apr > APR_SANITY_THRESHOLD) flags.push("high-apr-outlier");
  if (parseFloat(totalLiquidity) < MIN_LIQUIDITY_USD) flags.push("low-liquidity");
  return flags;
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
        pools.map(async (pool: any) => {
          let fees24h = "0";
          let volume24h = "0";
          let totalLiquidity = "0";

          try {
            const ticker = await bitflow.getTicker(
              pool.tokenXContractAddress + "." + pool.tokenXContractName,
              pool.tokenYContractAddress + "." + pool.tokenYContractName
            );
            fees24h = String(ticker?.fee_volume_24h ?? 0);
            volume24h = String(ticker?.volume_24h ?? 0);
            totalLiquidity = String(ticker?.liquidity ?? 0);
          } catch {
            // Ticker unavailable — continue with zeros
          }

          // Note: bin spread requires a user address (getHodlmmUserPositionBins) and is
          // not available for market-wide pool listing. Omitted here; use get-pool-detail
          // with --address for per-user bin data.

          const estimatedApr = calcApr(fees24h, totalLiquidity);
          const flags = flagPool(estimatedApr, totalLiquidity);

          return {
            poolId: pool.contractId,
            tokenX: pool.tokenXSymbol ?? pool.tokenXContractName,
            tokenY: pool.tokenYSymbol ?? pool.tokenYContractName,
            feeTier: pool.feeTier ?? null,
            estimatedApr: parseFloat(estimatedApr.toFixed(2)),
            volume24h,
            fees24h,
            totalLiquidity,
            flags,
          };
        })
      );

      let result = enriched;

      if (opts.minApr !== undefined) {
        result = result.filter((p) => p.estimatedApr >= opts.minApr);
      }

      const sortKey = opts.sortBy as "apr" | "volume" | "fees";
      result.sort((a, b) => {
        if (sortKey === "volume") return parseFloat(b.volume24h) - parseFloat(a.volume24h);
        if (sortKey === "fees") return parseFloat(b.fees24h) - parseFloat(a.fees24h);
        return b.estimatedApr - a.estimatedApr;
      });

      printJson({
        network: NETWORK,
        sortedBy: sortKey,
        count: result.length,
        pools: result,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-pool-detail ─────────────────────────────────────────────────────────
program
  .command("get-pool-detail")
  .description("Get detailed metrics for a specific HODLMM pool")
  .requiredOption("--pool-id <contractId>", "Pool contract identifier")
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }

      const bitflow = getBitflowService();

      const pools = await bitflow.getHodlmmPools();
      const pool = pools.find((p: any) => p.contractId === opts.poolId);
      if (!pool) {
        printJson({ error: "Pool not found", poolId: opts.poolId });
        return;
      }

      let ticker: any = {};
      try {
        ticker = await bitflow.getTicker(
          pool.tokenXContractAddress + "." + pool.tokenXContractName,
          pool.tokenYContractAddress + "." + pool.tokenYContractName
        );
      } catch { /* ignore */ }

      const bins = await bitflow.getHodlmmPoolBins(opts.poolId);

      const fees24h = String(ticker?.fee_volume_24h ?? 0);
      const volume24h = String(ticker?.volume_24h ?? 0);
      const totalLiquidity = String(ticker?.liquidity ?? 0);
      const estimatedApr = parseFloat(calcApr(fees24h, totalLiquidity).toFixed(2));
      const flags = flagPool(estimatedApr, totalLiquidity);

      const activeBin = bins?.activeBin ?? null;
      const binStep = pool.binStep ?? null;
      const binList = Array.isArray(bins?.bins) ? bins.bins : [];

      let priceRange = null;
      if (binList.length > 0 && binStep) {
        const prices = binList.map((b: any) => b.priceXPerY ?? 0).filter(Boolean);
        if (prices.length > 0) {
          priceRange = { low: Math.min(...prices), high: Math.max(...prices) };
        }
      }

      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        tokenX: pool.tokenXSymbol ?? pool.tokenXContractName,
        tokenY: pool.tokenYSymbol ?? pool.tokenYContractName,
        feeTier: pool.feeTier ?? null,
        binStep,
        activeBin,
        estimatedApr,
        volume24h,
        fees24h,
        totalLiquidity,
        priceRange,
        activeBinCount: binList.length,
        flags,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── compare-pools ────────────────────────────────────────────────────────────
program
  .command("compare-pools")
  .description("Rank and compare all HODLMM pools by yield")
  .option("--top <number>", "Number of top pools to return", parseInt, 5)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();

      const enriched = await Promise.all(
        pools.map(async (pool: any) => {
          let fees24h = "0";
          let volume24h = "0";
          let totalLiquidity = "0";
          try {
            const ticker = await bitflow.getTicker(
              pool.tokenXContractAddress + "." + pool.tokenXContractName,
              pool.tokenYContractAddress + "." + pool.tokenYContractName
            );
            fees24h = String(ticker?.fee_volume_24h ?? 0);
            volume24h = String(ticker?.volume_24h ?? 0);
            totalLiquidity = String(ticker?.liquidity ?? 0);
          } catch { /* ignore */ }

          const estimatedApr = parseFloat(calcApr(fees24h, totalLiquidity).toFixed(2));
          return {
            poolId: pool.contractId,
            pair: `${pool.tokenXSymbol ?? pool.tokenXContractName}/${pool.tokenYSymbol ?? pool.tokenYContractName}`,
            estimatedApr,
            volume24h,
            fees24h,
            totalLiquidity,
            flags: flagPool(estimatedApr, totalLiquidity),
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
            parseFloat(pool.volume24h) > 100_000_000 ? "high volume" :
            "competitive yield",
        }));

      printJson({
        network: NETWORK,
        topN: opts.top,
        ranking: sorted,
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
  .requiredOption("--pool-id <contractId>", "Pool contract identifier")
  .requiredOption("--amount-usd <number>", "Liquidity amount in USD", parseFloat)
  .requiredOption("--days <number>", "Projection period in days", parseInt)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "HODLMM is mainnet-only." });
        return;
      }
      if (opts.days < 1 || opts.days > 365) {
        printJson({ error: "--days must be between 1 and 365" });
        return;
      }
      if (opts.amountUsd <= 0) {
        printJson({ error: "--amount-usd must be greater than 0" });
        return;
      }

      const bitflow = getBitflowService();
      const pools = await bitflow.getHodlmmPools();
      const pool = pools.find((p: any) => p.contractId === opts.poolId);
      if (!pool) {
        printJson({ error: "Pool not found", poolId: opts.poolId });
        return;
      }

      let fees24h = "0";
      let totalLiquidity = "0";
      try {
        const ticker = await bitflow.getTicker(
          pool.tokenXContractAddress + "." + pool.tokenXContractName,
          pool.tokenYContractAddress + "." + pool.tokenYContractName
        );
        fees24h = String(ticker?.fee_volume_24h ?? 0);
        totalLiquidity = String(ticker?.liquidity ?? 0);
      } catch { /* ignore */ }

      const estimatedApr = calcApr(fees24h, totalLiquidity);
      const dailyRate = estimatedApr / 365 / 100;
      const estimatedFeesUsd = parseFloat((opts.amountUsd * dailyRate * opts.days).toFixed(4));

      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        pair: `${pool.tokenXSymbol ?? pool.tokenXContractName}/${pool.tokenYSymbol ?? pool.tokenYContractName}`,
        inputAmountUsd: opts.amountUsd,
        projectionDays: opts.days,
        estimatedFeesUsd,
        estimatedApr: parseFloat(estimatedApr.toFixed(2)),
        assumptions: "Based on trailing 24h fee revenue annualized. Actual yield depends on price staying within active bin range, concentration of your position, and market conditions.",
        flags: flagPool(estimatedApr, totalLiquidity),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
