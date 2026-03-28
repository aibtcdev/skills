#!/usr/bin/env bun
/**
 * Hermetica Monitor — USDh peg health, oracle price, reserve backing, and APY
 * Read-only. No wallet required. Mainnet only.
 *
 * Usage: bun run hermetica-monitor/hermetica-monitor.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { callReadOnlyFunction, cvToValue, principalCV } from "@stacks/transactions";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// Contract addresses
const USDH_TOKEN = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1";
const USDH_ORACLE = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.usdh-oracle-v1-0";
const USDH_DECIMALS = 8;
const ORACLE_DECIMALS = 8;
const HIRO_API = "https://api.hiro.so";
const ZEST_API = "https://app.zestprotocol.com/api";

function parseContract(id: string): { address: string; name: string } {
  const [address, name] = id.split(".");
  return { address, name };
}

async function readOraclePrice(): Promise<{ raw: bigint; price: number } | null> {
  try {
    const { address, name } = parseContract(USDH_ORACLE);
    const result = await callReadOnlyFunction({
      contractAddress: address,
      contractName: name,
      functionName: "get-price",
      functionArgs: [],
      network: NETWORK as any,
      senderAddress: address,
    });
    const val = cvToValue(result);
    if (val === null || val === undefined) return null;
    const raw = BigInt(typeof val === "object" && "value" in val ? (val as any).value : val);
    const price = Number(raw) / Math.pow(10, ORACLE_DECIMALS);
    return { raw, price };
  } catch {
    return null;
  }
}

async function readTotalSupply(): Promise<{ raw: bigint; formatted: number } | null> {
  try {
    const { address, name } = parseContract(USDH_TOKEN);
    const result = await callReadOnlyFunction({
      contractAddress: address,
      contractName: name,
      functionName: "get-total-supply",
      functionArgs: [],
      network: NETWORK as any,
      senderAddress: address,
    });
    const val = cvToValue(result);
    if (val === null || val === undefined) return null;
    const raw = BigInt(typeof val === "object" && "value" in val ? (val as any).value : val);
    const formatted = Number(raw) / Math.pow(10, USDH_DECIMALS);
    return { raw, formatted };
  } catch {
    return null;
  }
}

async function fetchZestApy(): Promise<{ supplyApy: number; borrowApy: number; utilization: number } | null> {
  try {
    const res = await fetch(`${ZEST_API}/markets`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const markets = Array.isArray(data) ? data : (data.markets ?? data.data ?? []);
    const usdh = markets.find((m: any) =>
      (m.symbol ?? "").toUpperCase() === "USDH" ||
      (m.asset ?? "").toLowerCase().includes("usdh")
    );
    if (!usdh) return null;
    return {
      supplyApy: parseFloat((usdh.supplyApy ?? usdh.supply_apy ?? 0).toString()),
      borrowApy: parseFloat((usdh.borrowApy ?? usdh.borrow_apy ?? 0).toString()),
      utilization: parseFloat((usdh.utilization ?? 0).toString()),
    };
  } catch {
    return null;
  }
}

function calcRiskFlags(deviationPct: number, supplyFormatted: number): string[] {
  const flags: string[] = [];
  if (deviationPct > 3) flags.push("depeg-critical");
  else if (deviationPct > 1) flags.push("depeg-warning");
  if (supplyFormatted > 0 && supplyFormatted < 10_000) flags.push("low-supply");
  return flags;
}

const program = new Command();

program
  .name("hermetica-monitor")
  .description("Monitor Hermetica Protocol USDh peg health, oracle price, reserves, and APY")
  .version("1.0.0");

// ─── get-oracle-price ────────────────────────────────────────────────────────
program
  .command("get-oracle-price")
  .description("Read raw USDh oracle price from on-chain price feed")
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Hermetica is mainnet-only." });
        return;
      }
      const oracle = await readOraclePrice();
      if (!oracle) {
        printJson({ error: "oracle-stale", message: "Failed to read oracle price" });
        return;
      }
      printJson({
        network: NETWORK,
        contract: USDH_ORACLE,
        rawPrice: oracle.raw.toString(),
        price: oracle.price,
        decimals: ORACLE_DECIMALS,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-peg-status ──────────────────────────────────────────────────────────
program
  .command("get-peg-status")
  .description("Check USDh peg deviation from $1.00")
  .option("--threshold <percent>", "Alert threshold %", parseFloat, 1.0)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Hermetica is mainnet-only." });
        return;
      }
      const oracle = await readOraclePrice();
      if (!oracle) {
        printJson({
          network: NETWORK,
          symbol: "USDH",
          status: "unknown",
          alert: true,
          flags: ["oracle-stale"],
          fetchedAt: new Date().toISOString(),
        });
        return;
      }
      const deviationPct = Math.abs(oracle.price - 1.0) * 100;
      const alert = deviationPct > opts.threshold;
      const status = deviationPct > 3 ? "critical" : deviationPct > 1 ? "warning" : "healthy";
      printJson({
        network: NETWORK,
        symbol: "USDH",
        oraclePrice: oracle.price,
        targetPrice: 1.0,
        deviationPct: parseFloat(deviationPct.toFixed(4)),
        threshold: opts.threshold,
        status,
        alert,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-reserve-health ──────────────────────────────────────────────────────
program
  .command("get-reserve-health")
  .description("Query USDh total supply and on-chain reserve data")
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Hermetica is mainnet-only." });
        return;
      }
      const supply = await readTotalSupply();

      // Fetch sBTC balance of USDh token contract as a proxy for on-chain reserves
      const [usdhAddr] = USDH_TOKEN.split(".");
      let sbtcBalance = "0";
      try {
        const res = await fetch(
          `${HIRO_API}/extended/v1/address/${usdhAddr}/balances`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (res.ok) {
          const data = await res.json() as any;
          const sbtcKey = Object.keys(data?.fungible_tokens ?? {}).find(k =>
            k.toLowerCase().includes("sbtc")
          );
          if (sbtcKey) sbtcBalance = data.fungible_tokens[sbtcKey].balance ?? "0";
        }
      } catch { /* ignore */ }

      printJson({
        network: NETWORK,
        usdhContract: USDH_TOKEN,
        usdhTotalSupply: supply?.raw.toString() ?? "unavailable",
        usdhTotalSupplyFormatted: supply?.formatted ?? null,
        reserveAssets: [
          {
            symbol: "sBTC",
            balance: sbtcBalance,
            balanceFormatted: parseInt(sbtcBalance) / 1e8,
          },
        ],
        collateralizationNote:
          "On-chain reserve data only. Full backing includes off-chain BTC delta-neutral positions. See app.hermetica.fi/transparency for full reserves.",
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── get-apy ────────────────────────────────────────────────────────────────
program
  .command("get-apy")
  .description("Fetch current USDh yield rate from Zest Protocol lending market")
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Hermetica is mainnet-only." });
        return;
      }
      const apy = await fetchZestApy();
      if (!apy) {
        printJson({
          network: NETWORK,
          source: "zest-protocol",
          asset: "USDH",
          supplyApy: null,
          borrowApy: null,
          utilization: null,
          note: "Zest API unavailable or USDh market not found",
          fetchedAt: new Date().toISOString(),
        });
        return;
      }
      printJson({
        network: NETWORK,
        source: "zest-protocol",
        asset: "USDH",
        supplyApy: apy.supplyApy,
        borrowApy: apy.borrowApy,
        utilization: apy.utilization,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

// ─── full-report ─────────────────────────────────────────────────────────────
program
  .command("full-report")
  .description("Aggregate all Hermetica health metrics with risk assessment")
  .option("--depeg-threshold <percent>", "Depeg alert threshold %", parseFloat, 1.0)
  .action(async (opts) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Hermetica is mainnet-only." });
        return;
      }

      const [oracle, supply, apy] = await Promise.all([
        readOraclePrice(),
        readTotalSupply(),
        fetchZestApy(),
      ]);

      const oraclePrice = oracle?.price ?? null;
      const deviationPct = oraclePrice !== null
        ? parseFloat((Math.abs(oraclePrice - 1.0) * 100).toFixed(4))
        : null;

      const riskFlags: string[] = [];
      if (oracle === null) riskFlags.push("oracle-stale");
      else if (deviationPct !== null) riskFlags.push(...calcRiskFlags(deviationPct, supply?.formatted ?? 0));

      const pegStatus = oracle === null
        ? "unknown"
        : deviationPct! > 3 ? "critical"
        : deviationPct! > 1 ? "warning"
        : "healthy";

      const overallHealth = riskFlags.includes("depeg-critical") ? "red"
        : riskFlags.includes("depeg-warning") ? "yellow"
        : riskFlags.includes("oracle-stale") ? "yellow"
        : "green";

      let recommendation = "";
      if (overallHealth === "red") {
        recommendation = `USDh is critically depegged (${deviationPct}% deviation). Reduce exposure immediately via defi skill (zest-withdraw).`;
      } else if (overallHealth === "yellow") {
        recommendation = `USDh shows minor deviation or data issue (${deviationPct ?? "unknown"}%). Monitor closely.`;
      } else {
        const apyStr = apy ? `Yield at ${apy.supplyApy}% APY via Zest.` : "APY data unavailable.";
        recommendation = `USDh is healthy. ${apyStr}`;
      }

      printJson({
        network: NETWORK,
        protocol: "Hermetica",
        oraclePrice,
        deviationPct,
        pegStatus,
        supplyApy: apy?.supplyApy ?? null,
        borrowApy: apy?.borrowApy ?? null,
        usdhTotalSupplyFormatted: supply?.formatted ?? null,
        riskFlags,
        overallHealth,
        recommendation,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
