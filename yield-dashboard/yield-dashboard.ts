#!/usr/bin/env bun
/**
 * Yield Dashboard skill CLI
 * Cross-protocol DeFi yield aggregator for Stacks — read-only, mainnet-only.
 *
 * Aggregates positions and APY data across:
 *   - Zest Protocol (sBTC lending)
 *   - ALEX DEX (AMM LP)
 *   - Bitflow (DEX LP)
 *   - STX Stacking
 *
 * Usage: bun run yield-dashboard/yield-dashboard.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  hexToCV,
  cvToValue,
  contractPrincipalCV,
  standardPrincipalCV,
  uintCV,
  serializeCV,
} from "@stacks/transactions";
import { NETWORK, getApiBaseUrl } from "../src/lib/config/networks.js";
import { getWalletAddress } from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIRO_API = getApiBaseUrl("mainnet");

// Zest V1 (active on mainnet)
const ZEST_POOL_CONTRACT = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N";
const ZEST_POOL_NAME = "pool-borrow-v2-3";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Zest V2 (rewards live, pool-read-supply pending)
const ZEST_V2_DEPLOYER = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG";
const ZEST_V2_POOL_READ = "pool-read-supply";

// ALEX AMM
const ALEX_CONTRACT = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM";
const ALEX_POOL_NAME = "amm-pool-v2-01";
const ALEX_TOKEN_X = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx-v2";
const ALEX_TOKEN_Y =
  "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-abtc";
const ALEX_FACTOR = 100_000_000;

// Bitflow API
const BITFLOW_API = "https://app.bitflow.finance/api";

// Stacking
const POX_CONTRACT = "SP000000000000000000002Q6VF78";
const POX_NAME = "pox-4";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callReadOnly(
  contractAddress: string,
  contractName: string,
  functionName: string,
  args: string[]
): Promise<{ okay: boolean; result: string }> {
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: "SP000000000000000000002Q6VF78",
      arguments: args,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status} for ${functionName}`);
  return res.json();
}

function decodeTupleField(hex: string, field: string): bigint | null {
  try {
    const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
    const cv = hexToCV(raw);
    const decoded = cvToValue(cv, true) as Record<string, unknown>;
    const val = decoded[field];
    if (val === undefined || val === null) return null;
    if (typeof val === "bigint") return val;
    if (typeof val === "number") return BigInt(val);
    return null;
  } catch {
    return null;
  }
}

function encodePrincipal(principal: string): string {
  const [addr, name] = principal.split(".");
  return (
    "0x" +
    Buffer.from(serializeCV(contractPrincipalCV(addr, name))).toString("hex")
  );
}

function encodeUint(n: number): string {
  return "0x" + Buffer.from(serializeCV(uintCV(n))).toString("hex");
}

function formatBtc(sats: number): string {
  return (sats / 1e8).toFixed(8);
}

function formatStx(microStx: number): string {
  return (microStx / 1e6).toFixed(6);
}

// ---------------------------------------------------------------------------
// Protocol Readers
// ---------------------------------------------------------------------------

interface ProtocolPosition {
  protocol: string;
  asset: string;
  valueSats: number;
  valueUnit: "sats" | "microSTX";
  apyPct: number;
  riskScore: number;
  details: Record<string, unknown>;
}

async function readZestPosition(
  walletAddress: string
): Promise<ProtocolPosition> {
  const pos: ProtocolPosition = {
    protocol: "Zest Protocol",
    asset: "sBTC",
    valueSats: 0,
    valueUnit: "sats",
    apyPct: 0,
    riskScore: 20,
    details: {},
  };

  try {
    // Read reserve state for APY
    const principalArg = encodePrincipal(SBTC_TOKEN);
    const res = await callReadOnly(
      ZEST_POOL_CONTRACT,
      ZEST_POOL_NAME,
      "get-reserve-state",
      [principalArg]
    );
    if (res.okay) {
      const liquidityRate = decodeTupleField(res.result, "current-liquidity-rate");
      if (liquidityRate !== null && liquidityRate > 0n) {
        // Ray units: 1e27 = 100%
        pos.apyPct = Number(liquidityRate) / 1e25;
      }
      const borrowsStable =
        decodeTupleField(res.result, "total-borrows-stable") ?? 0n;
      const borrowsVariable =
        decodeTupleField(res.result, "total-borrows-variable") ?? 0n;
      pos.details.totalBorrows = (borrowsStable + borrowsVariable).toString();
    }

    // Check user position via a-token balance
    // The a-token address is in the reserve state tuple
    const hex = res.okay ? res.result : "";
    if (hex) {
      try {
        const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
        const cv = hexToCV(raw);
        const decoded = cvToValue(cv, true) as Record<string, unknown>;
        const aTokenAddr = decoded["a-token-address"];
        if (aTokenAddr && typeof aTokenAddr === "string" && aTokenAddr.includes(".")) {
          const [aTokContract, aTokName] = aTokenAddr.split(".");
          // Get user's a-token balance
          const balRes = await callReadOnly(
            aTokContract,
            aTokName,
            "ft-get-balance",
            [
              "0x" +
                Buffer.from(
                  serializeCV(standardPrincipalCV(walletAddress))
                ).toString("hex"),
            ]
          );
          if (balRes.okay) {
            const balCv = hexToCV(
              balRes.result.startsWith("0x")
                ? balRes.result.slice(2)
                : balRes.result
            );
            const balance = cvToValue(balCv, true);
            pos.valueSats =
              typeof balance === "bigint"
                ? Number(balance)
                : typeof balance === "number"
                  ? balance
                  : 0;
          }
        }
      } catch {
        // Position read failed — APY still valid
      }
    }
  } catch (e) {
    pos.details.error = String(e);
  }

  return pos;
}

async function readAlexPosition(
  _walletAddress: string
): Promise<ProtocolPosition> {
  const pos: ProtocolPosition = {
    protocol: "ALEX DEX",
    asset: "aBTC/STX LP",
    valueSats: 0,
    valueUnit: "sats",
    apyPct: 0,
    riskScore: 50,
    details: {},
  };

  try {
    const args = [
      encodePrincipal(ALEX_TOKEN_X),
      encodePrincipal(ALEX_TOKEN_Y),
      encodeUint(ALEX_FACTOR),
    ];
    const res = await callReadOnly(
      ALEX_CONTRACT,
      ALEX_POOL_NAME,
      "get-pool-details",
      args
    );
    if (res.okay) {
      const balX = decodeTupleField(res.result, "balance-x") ?? 0n;
      const balY = decodeTupleField(res.result, "balance-y") ?? 0n;
      pos.details.poolBalanceX = balX.toString();
      pos.details.poolBalanceY = balY.toString();
      // ALEX typical LP APY estimate from fee revenue
      pos.apyPct = 3.5;
      pos.details.apySource = "static estimate, not live";
    }
  } catch (e) {
    pos.details.error = String(e);
  }

  // TODO: Read user LP token balance for actual position value
  return pos;
}

async function readBitflowPosition(
  _walletAddress: string
): Promise<ProtocolPosition> {
  const pos: ProtocolPosition = {
    protocol: "Bitflow",
    asset: "sBTC",
    valueSats: 0,
    valueUnit: "sats",
    apyPct: 0,
    riskScore: 35,
    details: {},
  };

  try {
    // Use Bitflow public API for pool stats
    const res = await fetch(`${BITFLOW_API}/pools`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const pools = (await res.json()) as Array<{
        token0?: string;
        token1?: string;
        apy?: number;
        tvl?: number;
        [k: string]: unknown;
      }>;
      // Find sBTC pool
      const sbtcPool = pools.find(
        (p) =>
          (p.token0 && p.token0.toLowerCase().includes("sbtc")) ||
          (p.token1 && p.token1.toLowerCase().includes("sbtc"))
      );
      if (sbtcPool) {
        pos.apyPct = sbtcPool.apy ?? 2.8;
        pos.details.tvl = sbtcPool.tvl;
        pos.details.pool = sbtcPool;
      } else {
        pos.apyPct = 2.8;
        pos.details.apySource = "fallback estimate";
      }
    }
  } catch (e) {
    pos.apyPct = 2.8;
    pos.details.error = String(e);
    pos.details.apySource = "fallback estimate (API unavailable)";
  }

  // TODO: Read user Bitflow LP position
  return pos;
}

async function readStackingPosition(
  walletAddress: string
): Promise<ProtocolPosition> {
  const pos: ProtocolPosition = {
    protocol: "STX Stacking",
    asset: "STX",
    valueSats: 0,
    valueUnit: "microSTX",
    apyPct: 0,
    riskScore: 10,
    details: {},
  };

  try {

    const principalArg =
      "0x" +
      Buffer.from(serializeCV(standardPrincipalCV(walletAddress))).toString(
        "hex"
      );
    const res = await callReadOnly(
      POX_CONTRACT,
      POX_NAME,
      "get-stacker-info",
      [principalArg]
    );
    if (res.okay) {
      const raw = res.result.startsWith("0x")
        ? res.result.slice(2)
        : res.result;
      const cv = hexToCV(raw);
      const val = cvToValue(cv, true);
      if (val && typeof val === "object" && "lock-amount" in (val as object)) {
        const lockAmount = (val as Record<string, unknown>)["lock-amount"];
        pos.valueSats =
          typeof lockAmount === "bigint"
            ? Number(lockAmount)
            : typeof lockAmount === "number"
              ? lockAmount
              : 0;
        pos.apyPct = 8.0;
        pos.details.apySource = "static estimate, not live";
        pos.details.stackerInfo = val;
      }
    }
  } catch (e) {
    pos.details.error = String(e);
  }

  return pos;
}

async function getWalletBalances(walletAddress: string) {
  try {
    const res = await fetch(
      `${HIRO_API}/extended/v1/address/${walletAddress}/balances`
    );
    if (!res.ok) return { stxMicroStx: 0, sbtcSats: 0 };
    const data = (await res.json()) as {
      stx?: { balance?: string };
      fungible_tokens?: Record<string, { balance?: string }>;
    };
    const stxMicroStx = parseInt(data.stx?.balance ?? "0", 10);
    const sbtcKey = Object.keys(data.fungible_tokens ?? {}).find((k) =>
      k.toLowerCase().includes("sbtc")
    );
    const sbtcSats = sbtcKey
      ? parseInt(data.fungible_tokens?.[sbtcKey]?.balance ?? "0", 10)
      : 0;
    return { stxMicroStx, sbtcSats };
  } catch {
    return { stxMicroStx: 0, sbtcSats: 0 };
  }
}

async function checkZestV2(): Promise<boolean> {
  try {
    const url = `${HIRO_API}/v2/contracts/interface/${ZEST_V2_DEPLOYER}/${ZEST_V2_POOL_READ}`;
    const res = await fetch(url, { method: "GET" });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("yield-dashboard")
  .description(
    "Cross-protocol DeFi yield dashboard: Zest, ALEX, Bitflow, Stacking. Read-only, mainnet-only."
  )
  .version("0.1.0");

// --- overview ---
program
  .command("overview")
  .description(
    "Portfolio overview: total value, weighted APY, per-protocol breakdown."
  )
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "yield-dashboard is mainnet-only" });
        process.exit(1);
      }

      const walletAddress = await getWalletAddress();
      const [zest, alex, bitflow, stacking, balances, v2Ready] =
        await Promise.all([
          readZestPosition(walletAddress),
          readAlexPosition(walletAddress),
          readBitflowPosition(walletAddress),
          readStackingPosition(walletAddress),
          getWalletBalances(walletAddress),
          checkZestV2(),
        ]);

      const positions = [zest, alex, bitflow, stacking];
      // Separate sats-denominated and microSTX-denominated positions
      const satsPositions = positions.filter((p) => p.valueUnit === "sats");
      const stxPositions = positions.filter((p) => p.valueUnit === "microSTX");
      const totalValueSats = satsPositions.reduce(
        (sum, p) => sum + p.valueSats,
        0
      );
      const totalValueMicroStx = stxPositions.reduce(
        (sum, p) => sum + p.valueSats,
        0
      );
      // Weighted APY only across sats-denominated positions (comparable units)
      const weightedApyPct =
        totalValueSats > 0
          ? satsPositions.reduce(
              (sum, p) => sum + p.apyPct * (p.valueSats / totalValueSats),
              0
            )
          : 0;

      printJson({
        walletAddress,
        totalValueSats,
        totalValueBtc: formatBtc(totalValueSats),
        totalValueMicroStx,
        totalValueStx: totalValueMicroStx / 1_000_000,
        weightedApyPct: Math.round(weightedApyPct * 100) / 100,
        note: "totalValueSats excludes STX stacking (different unit). See totalValueStx separately.",
        protocols: {
          zest: {
            valueSats: zest.valueSats,
            apyPct: zest.apyPct,
          },
          alex: {
            valueSats: alex.valueSats,
            apyPct: alex.apyPct,
          },
          bitflow: {
            valueSats: bitflow.valueSats,
            apyPct: bitflow.apyPct,
          },
          stacking: {
            valueMicroStx: stacking.valueSats,
            valueStx: stacking.valueSats / 1_000_000,
            apyPct: stacking.apyPct,
          },
        },
        walletSbtcSats: balances.sbtcSats,
        walletStxMicroStx: balances.stxMicroStx,
        zestV2Ready: v2Ready,
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- positions ---
program
  .command("positions")
  .description("Detailed per-protocol position data.")
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "yield-dashboard is mainnet-only" });
        process.exit(1);
      }

      const walletAddress = await getWalletAddress();
      const positions = await Promise.all([
        readZestPosition(walletAddress),
        readAlexPosition(walletAddress),
        readBitflowPosition(walletAddress),
        readStackingPosition(walletAddress),
      ]);

      printJson({
        walletAddress,
        positions: positions.map((p) => ({
          protocol: p.protocol,
          asset: p.asset,
          ...(p.valueUnit === "sats"
            ? { valueSats: p.valueSats, valueBtc: formatBtc(p.valueSats) }
            : { valueMicroStx: p.valueSats, valueStx: formatStx(p.valueSats) }),
          apyPct: p.apyPct,
          riskScore: p.riskScore,
          details: p.details,
        })),
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- apy-breakdown ---
program
  .command("apy-breakdown")
  .description("Current APY rates across all protocols (market data only).")
  .action(async () => {
    try {
      // APY breakdown doesn't need wallet — pure market data
      const [zest, alex, bitflow, v2Ready] = await Promise.all([
        readZestPosition("SP000000000000000000002Q6VF78"), // dummy address for APY
        readAlexPosition("SP000000000000000000002Q6VF78"),
        readBitflowPosition("SP000000000000000000002Q6VF78"),
        checkZestV2(),
      ]);

      printJson({
        timestamp: new Date().toISOString(),
        rates: [
          {
            protocol: "Zest Protocol",
            asset: "sBTC",
            supplyApyPct: zest.apyPct,
            riskScore: zest.riskScore,
          },
          {
            protocol: "ALEX DEX",
            asset: "aBTC/STX LP",
            apyPct: alex.apyPct,
            riskScore: alex.riskScore,
          },
          {
            protocol: "Bitflow",
            asset: "sBTC",
            apyPct: bitflow.apyPct,
            riskScore: bitflow.riskScore,
          },
          {
            protocol: "STX Stacking",
            asset: "STX",
            apyPct: 8.0,
            riskScore: 10,
          },
        ],
        zestV2Ready: v2Ready,
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- rebalance ---
program
  .command("rebalance")
  .description("Rebalance suggestions based on risk-adjusted yield.")
  .option(
    "--risk-tolerance <level>",
    "Risk tolerance: low, medium, high",
    "medium"
  )
  .action(async (opts: { riskTolerance: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "yield-dashboard is mainnet-only" });
        process.exit(1);
      }

      const walletAddress = await getWalletAddress();
      const positions = await Promise.all([
        readZestPosition(walletAddress),
        readAlexPosition(walletAddress),
        readBitflowPosition(walletAddress),
        readStackingPosition(walletAddress),
      ]);

      const totalValue = positions.reduce((s, p) => s + p.valueSats, 0);
      const currentAllocation: Record<string, number> = {};
      const keys = ["zest", "alex", "bitflow", "stacking"];
      positions.forEach((p, i) => {
        currentAllocation[keys[i]] =
          totalValue > 0
            ? Math.round((p.valueSats / totalValue) * 100)
            : 0;
      });

      // Target allocations by risk tolerance
      const targets: Record<string, Record<string, number>> = {
        low: { zest: 40, alex: 10, bitflow: 10, stacking: 40 },
        medium: { zest: 45, alex: 20, bitflow: 15, stacking: 20 },
        high: { zest: 50, alex: 30, bitflow: 20, stacking: 0 },
      };
      const riskLevel = opts.riskTolerance.toLowerCase();
      const suggested = targets[riskLevel] ?? targets["medium"];

      // Generate suggestions
      const suggestions: string[] = [];
      for (const key of keys) {
        const diff = suggested[key] - (currentAllocation[key] || 0);
        if (Math.abs(diff) >= 5) {
          const protocol = positions[keys.indexOf(key)].protocol;
          if (diff > 0) {
            suggestions.push(
              `Consider increasing ${protocol} allocation by ~${diff}%`
            );
          } else {
            suggestions.push(
              `Consider reducing ${protocol} allocation by ~${Math.abs(diff)}%`
            );
          }
        }
      }

      if (suggestions.length === 0) {
        suggestions.push(
          "Current allocation is close to optimal for your risk tolerance."
        );
      }

      // Add market-aware notes
      const zestApy = positions[0].apyPct;
      if (zestApy > 6) {
        suggestions.push(
          `Zest APY is elevated at ${zestApy.toFixed(1)}% — good time to increase lending allocation`
        );
      }
      if (riskLevel !== "high") {
        suggestions.push(
          "ALEX LP carries impermanent loss risk if STX/BTC price diverges significantly"
        );
      }

      printJson({
        walletAddress,
        riskTolerance: riskLevel,
        totalValueSats: totalValue,
        currentAllocation,
        suggestedAllocation: suggested,
        suggestions,
        positions: positions.map((p) => ({
          protocol: p.protocol,
          apyPct: p.apyPct,
          riskScore: p.riskScore,
        })),
      });
    } catch (e) {
      handleError(e);
    }
  });

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parse();
