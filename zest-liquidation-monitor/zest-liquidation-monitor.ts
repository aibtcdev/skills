#!/usr/bin/env bun
/**
 * Zest Liquidation Monitor — borrow position health factor and liquidation risk
 * Read-only. No wallet required. Mainnet only.
 *
 * Usage: bun run zest-liquidation-monitor/zest-liquidation-monitor.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getZestService } from "../src/lib/services/defi.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// Liquidation thresholds by asset symbol (Zest Protocol defaults)
const LIQUIDATION_THRESHOLDS: Record<string, number> = {
  sBTC: 0.75,
  sbtc: 0.75,
  STX: 0.65,
  stx: 0.65,
  USDH: 0.80,
  usdh: 0.80,
  aeUSDC: 0.80,
  aeusdc: 0.80,
  stSTX: 0.65,
  ststx: 0.65,
};

const DEFAULT_LT = 0.75;
const WARN_THRESHOLD_DEFAULT = 1.5;

function getLiquidationThreshold(asset: string): number {
  return LIQUIDATION_THRESHOLDS[asset] ?? DEFAULT_LT;
}

function calcHealthFactor(supplied: string, borrowed: string, lt: number): number | null {
  const s = parseFloat(supplied);
  const b = parseFloat(borrowed);
  if (b <= 0) return null; // no borrow = no liquidation risk
  // NOTE: getUserPosition returns raw token amounts for a single asset.
  // supplied and borrowed are always the same asset (e.g. both sBTC in raw satoshis,
  // or both USDH in micro-units), so decimal places cancel out and the ratio is correct.
  // This skill does NOT aggregate cross-asset positions — each check is per-asset.
  return (s * lt) / b;
}

function getRiskLevel(hf: number | null): string {
  if (hf === null) return "none";
  if (hf < 1.0) return "liquidatable";
  if (hf < 1.1) return "critical";
  if (hf < 1.5) return "warning";
  if (hf < 2.0) return "moderate";
  return "safe";
}

function isAlert(hf: number | null, threshold: number): boolean {
  if (hf === null) return false;
  return hf < threshold;
}

function getAssetDecimals(asset: string): number {
  const lower = asset.toLowerCase();
  if (lower === "sbtc") return 8;
  if (lower === "ststx") return 6;
  return 6;
}

const VALID_ASSETS = ["sBTC", "STX", "USDH", "aeUSDC", "stSTX"];

function validateAddress(address: string): boolean {
  return address.startsWith("SP") || address.startsWith("SM");
}

const program = new Command();

program
  .name("zest-liquidation-monitor")
  .description("Monitor Zest Protocol borrow positions for liquidation risk")
  .version("1.0.0");

// ─── check-position ──────────────────────────────────────────────────────────
program
  .command("check-position")
  .description("Check a specific Zest position for liquidation risk")
  .requiredOption("--address <stacksAddress>", "Stacks address to check")
  .requiredOption("--asset <symbol>", "Asset symbol (sBTC, STX, USDH, aeUSDC, stSTX)")
  .option("--warn-threshold <number>", "Health factor warning threshold", parseFloat, WARN_THRESHOLD_DEFAULT)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Zest Protocol is mainnet-only." });
        return;
      }
      if (!validateAddress(opts.address)) {
        printJson({ error: "Invalid Stacks address. Must start with SP or SM." });
        return;
      }
      if (!VALID_ASSETS.includes(opts.asset)) {
        printJson({ error: `Unknown asset: ${opts.asset}`, validAssets: VALID_ASSETS });
        return;
      }

      const zest = getZestService();
      const position = await zest.getUserPosition(opts.asset, opts.address);

      if (!position) {
        printJson({
          network: NETWORK,
          address: opts.address,
          asset: opts.asset,
          supplied: "0",
          borrowed: "0",
          riskLevel: "none",
          alert: false,
          fetchedAt: new Date().toISOString(),
        });
        return;
      }

      const lt = getLiquidationThreshold(opts.asset);
      const decimals = getAssetDecimals(opts.asset);
      const hf = calcHealthFactor(position.supplied, position.borrowed, lt);
      const riskLevel = getRiskLevel(hf);
      const alert = isAlert(hf, opts.warnThreshold);

      printJson({
        network: NETWORK,
        address: opts.address,
        asset: opts.asset,
        supplied: position.supplied,
        suppliedFormatted: parseFloat(position.supplied) / Math.pow(10, decimals),
        borrowed: position.borrowed,
        borrowedFormatted: parseFloat(position.borrowed) / Math.pow(10, decimals),
        liquidationThreshold: lt,
        estimatedLtv: parseFloat(position.borrowed) > 0
          ? parseFloat((parseFloat(position.borrowed) / parseFloat(position.supplied)).toFixed(4))
          : 0,
        healthFactor: hf !== null ? parseFloat(hf.toFixed(4)) : null,
        riskLevel,
        alert,
        warnThreshold: opts.warnThreshold,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── scan-address ────────────────────────────────────────────────────────────
program
  .command("scan-address")
  .description("Scan all Zest assets for a given address and surface at-risk positions")
  .requiredOption("--address <stacksAddress>", "Stacks address to scan")
  .option("--warn-threshold <number>", "Health factor warning threshold", parseFloat, WARN_THRESHOLD_DEFAULT)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Zest Protocol is mainnet-only." });
        return;
      }
      if (!validateAddress(opts.address)) {
        printJson({ error: "Invalid Stacks address. Must start with SP or SM." });
        return;
      }

      const zest = getZestService();
      const results = await Promise.all(
        VALID_ASSETS.map(async (asset) => {
          try {
            const position = await zest.getUserPosition(asset, opts.address);
            if (!position || (position.supplied === "0" && position.borrowed === "0")) {
              return null;
            }
            const lt = getLiquidationThreshold(asset);
            const decimals = getAssetDecimals(asset);
            const hf = calcHealthFactor(position.supplied, position.borrowed, lt);
            return {
              asset,
              supplied: position.supplied,
              suppliedFormatted: parseFloat(position.supplied) / Math.pow(10, decimals),
              borrowed: position.borrowed,
              borrowedFormatted: parseFloat(position.borrowed) / Math.pow(10, decimals),
              healthFactor: hf !== null ? parseFloat(hf.toFixed(4)) : null,
              riskLevel: getRiskLevel(hf),
              alert: isAlert(hf, opts.warnThreshold),
            };
          } catch {
            return null;
          }
        })
      );

      const positions = results.filter(Boolean) as NonNullable<typeof results[0]>[];
      const atRiskCount = positions.filter(p => p.alert).length;
      const criticalCount = positions.filter(p => p.riskLevel === "critical" || p.riskLevel === "liquidatable").length;

      printJson({
        network: NETWORK,
        address: opts.address,
        positionCount: positions.length,
        atRiskCount,
        criticalCount,
        positions,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-market-info ─────────────────────────────────────────────────────────
program
  .command("get-market-info")
  .description("Fetch market-wide metrics for a Zest asset")
  .requiredOption("--asset <symbol>", "Asset symbol (sBTC, STX, USDH, aeUSDC, stSTX)")
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Zest Protocol is mainnet-only." });
        return;
      }

      if (!VALID_ASSETS.includes(opts.asset)) {
        printJson({ error: `Unknown asset: ${opts.asset}`, validAssets: VALID_ASSETS });
        return;
      }

      const zest = getZestService();
      const market = await zest.getMarketInfo(opts.asset);

      if (!market) {
        printJson({
          error: "Asset not found or market data unavailable",
          validAssets: VALID_ASSETS,
        });
        return;
      }

      printJson({
        network: NETWORK,
        asset: opts.asset,
        totalSupply: market.totalSupply,
        totalBorrow: market.totalBorrow,
        supplyRate: market.supplyRate,
        borrowRate: market.borrowRate,
        utilizationRate: market.utilizationRate,
        liquidationThreshold: getLiquidationThreshold(opts.asset),
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── liquidation-price ───────────────────────────────────────────────────────
program
  .command("liquidation-price")
  .description("Calculate the collateral price at which a borrow position would be liquidated")
  .requiredOption("--address <stacksAddress>", "Stacks address")
  .requiredOption("--asset <symbol>", "Asset symbol")
  .requiredOption("--collateral-price <number>", "Current collateral price in USD", parseFloat)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Zest Protocol is mainnet-only." });
        return;
      }
      if (!validateAddress(opts.address)) {
        printJson({ error: "Invalid Stacks address. Must start with SP or SM." });
        return;
      }
      if (opts.collateralPrice <= 0) {
        printJson({ error: "--collateral-price must be greater than 0" });
        return;
      }

      const zest = getZestService();
      const position = await zest.getUserPosition(opts.asset, opts.address);

      if (!position || position.borrowed === "0" || parseFloat(position.borrowed) === 0) {
        printJson({
          network: NETWORK,
          address: opts.address,
          asset: opts.asset,
          message: "No active borrow position — no liquidation risk.",
          liquidationPrice: null,
          fetchedAt: new Date().toISOString(),
        });
        return;
      }

      const lt = getLiquidationThreshold(opts.asset);
      const supplied = parseFloat(position.supplied);
      const borrowed = parseFloat(position.borrowed);

      // liquidationPrice = (borrowed / (supplied * lt)) * currentPrice
      const liquidationPrice = parseFloat(
        ((borrowed / (supplied * lt)) * opts.collateralPrice).toFixed(2)
      );
      const priceDropToLiquidation = parseFloat((opts.collateralPrice - liquidationPrice).toFixed(2));
      const dropPct = parseFloat(((priceDropToLiquidation / opts.collateralPrice) * 100).toFixed(2));

      printJson({
        network: NETWORK,
        address: opts.address,
        asset: opts.asset,
        currentPrice: opts.collateralPrice,
        liquidationPrice,
        priceDropToLiquidation,
        dropPct,
        safetyMargin: `${dropPct}%`,
        liquidationThreshold: lt,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
