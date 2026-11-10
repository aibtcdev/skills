#!/usr/bin/env bun
/**
 * Jingswap V2 skill CLI
 * Limit-price auction for STX/sBTC on Stacks
 *
 * Usage: bun run jingswap-v2/jingswap-v2.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  uintCV,
  bufferCV,
  contractPrincipalCV,
  PostConditionMode,
  Pc,
} from "@stacks/transactions";
import { getAccount } from "@aibtc/skills/src/lib/services/x402.service.js";
import { NETWORK, getExplorerTxUrl } from "@aibtc/skills/src/lib/config/networks.js";
import { callContract } from "@aibtc/skills/src/lib/transactions/builder.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JINGSWAP_API =
  process.env.JINGSWAP_API_URL || "https://faktory-dao-backend.vercel.app";
const JINGSWAP_API_KEY =
  process.env.JINGSWAP_API_KEY ||
  "jc_b058d7f2e0976bd4ee34be3e5c7ba7ebe45289c55d3f5e45f666ebc14b7ebfd0";

const CONTRACT_ADDRESS = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const SBTC_CONTRACT =
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token" as `${string}.${string}`;
const PRICE_PRECISION = 100_000_000;

interface MarketConfigV2 {
  contractName: string;
  slug: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  depositFn: string;
  cancelFn: string;
  premiumBps: number;
  premiumLabel: string;
}

const MARKETS: Record<string, MarketConfigV2> = {
  "sbtc-stx-market": {
    contractName: "sbtc-stx-0-jing-v2",
    slug: "sbtc-stx-market",
    tokenBSymbol: "STX",
    tokenBDecimals: 6,
    depositFn: "deposit-stx",
    cancelFn: "cancel-stx-deposit",
    premiumBps: 0,
    premiumLabel: "Market Price (0%)",
  },
  "sbtc-stx-20bp-stx-premium": {
    contractName: "sbtc-stx-20-jing-v2",
    slug: "sbtc-stx-20bp-stx-premium",
    tokenBSymbol: "STX",
    tokenBDecimals: 6,
    depositFn: "deposit-stx",
    cancelFn: "cancel-stx-deposit",
    premiumBps: 20,
    premiumLabel: "0.20% STX Bonus",
  },
};

const DEFAULT_MARKET = "sbtc-stx-market";

function getMarket(market?: string): MarketConfigV2 {
  const key = market || DEFAULT_MARKET;
  const config = MARKETS[key];
  if (!config)
    throw new Error(
      `Unknown v2 market "${key}". Available: ${Object.keys(MARKETS).join(", ")}`
    );
  return config;
}

function apiContractParam(m: MarketConfigV2): string {
  return `?contract=${m.contractName}`;
}

const PYTH_CONTRACTS = {
  storage: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "pyth-storage-v4" },
  decoder: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "pyth-pnau-decoder-v3" },
  wormhole: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "wormhole-core-v4" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function satsPerStxToRaw(satsPerStx: number): bigint {
  if (satsPerStx <= 0) throw new Error("Limit price must be positive");
  return BigInt(Math.floor(1e16 / satsPerStx));
}

function rawToSatsPerStx(raw: number): number {
  return raw > 0 ? Math.round(1e16 / raw) : 0;
}

function defaultLimitSatsPerStx(oracleSatsPerStx: number, side: "stx" | "sbtc"): number {
  if (side === "stx") return Math.floor(oracleSatsPerStx * 0.8);
  return Math.ceil(oracleSatsPerStx * 1.2);
}

async function jingswapGet(path: string): Promise<any> {
  const res = await fetch(`${JINGSWAP_API}${path}`, {
    headers: { "x-api-key": JINGSWAP_API_KEY },
  });
  if (!res.ok)
    throw new Error(`Jingswap API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.message || "API returned failure");
  return json.data;
}

async function assertDepositPhase(m: MarketConfigV2): Promise<any> {
  const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);
  if (data.phase !== 0) {
    throw new Error(`Cannot deposit/cancel — auction is in phase ${data.phase} (must be deposit phase 0)`);
  }
  return data;
}

async function getOracleSatsPerStx(m: MarketConfigV2): Promise<number> {
  const pyth = await jingswapGet(`/api/auction/pyth-prices${apiContractParam(m)}`);
  const stxUsd = pyth.stxUsd.price;
  const btcUsd = pyth.btcUsd.price;
  if (!stxUsd || !btcUsd || stxUsd <= 0) throw new Error("Oracle prices unavailable");
  return Math.round(1e8 / (btcUsd / stxUsd));
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("jingswap-v2")
  .description(
    "Jingswap V2 limit-price auction — deposit with limits, bundled settlement, " +
      "limit management, query cycle state and clearing preview."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// Read commands
// ---------------------------------------------------------------------------

program
  .command("cycle-state")
  .description("Get current V2 cycle state (2-phase: deposit → settle, no buffer)")
  .option("--market <pair>", `Market: sbtc-stx-market (default) or sbtc-stx-20bp-stx-premium`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);
      printJson({
        ...data,
        premium: m.premiumLabel,
        _hint: {
          phases: "0=deposit (10 blocks ~20s), 2=settle (no buffer in v2)",
          depositMinBlocks: "10 blocks (~20 seconds)",
          cancelThreshold: "42 blocks (~84 seconds) after close",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("user-deposit")
  .description("Get deposit amounts and limit prices for a user")
  .requiredOption("--cycle <number>", "Cycle number")
  .requiredOption("--address <stx_address>", "Stacks address")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { cycle: string; address: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(
        `/api/auction/deposit/${opts.cycle}/${opts.address}${apiContractParam(m)}`
      );
      printJson({
        ...data,
        stxLimitSatsPerStx: data.stxLimit ? rawToSatsPerStx(data.stxLimit) : null,
        sbtcLimitSatsPerStx: data.sbtcLimit ? rawToSatsPerStx(data.sbtcLimit) : null,
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("clearing-preview")
  .description("Simulate settlement at current oracle — shows what clears vs rolls")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const pyth = await jingswapGet(`/api/auction/pyth-prices${apiContractParam(m)}`);
      const stxUsd = pyth.stxUsd.price;
      const btcUsd = pyth.btcUsd.price;
      if (!stxUsd || !btcUsd || stxUsd <= 0) throw new Error("Oracle prices unavailable");
      const oracleRaw = Math.floor((btcUsd / stxUsd) * PRICE_PRECISION);
      const data = await jingswapGet(
        `/api/auction/clearing-preview${apiContractParam(m)}&oraclePrice=${oracleRaw}`
      );
      printJson({
        ...data,
        oracleSatsPerStx: rawToSatsPerStx(oracleRaw),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("prices")
  .description("Get oracle prices with default limit suggestions")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const pyth = await jingswapGet(`/api/auction/pyth-prices${apiContractParam(m)}`);
      const stxUsd = pyth.stxUsd.price;
      const btcUsd = pyth.btcUsd.price;
      const stxPerBtc = stxUsd > 0 ? btcUsd / stxUsd : 0;
      const satsPerStx = stxPerBtc > 0 ? Math.round(1e8 / stxPerBtc) : 0;
      printJson({
        premium: m.premiumLabel,
        oracleSatsPerStx: satsPerStx,
        oracleStxPerBtc: Math.round(stxPerBtc * 100) / 100,
        btcUsd,
        stxUsd,
        defaultStxFloor: defaultLimitSatsPerStx(satsPerStx, "stx"),
        defaultSbtcCeiling: defaultLimitSatsPerStx(satsPerStx, "sbtc"),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — deposits with limit prices
// ---------------------------------------------------------------------------

program
  .command("deposit-stx")
  .description("Deposit STX with limit price (sats/STX floor). Omit --limit for 20% in-the-money default.")
  .requiredOption("--amount <value>", "Amount of STX (human units)")
  .option("--limit <sats>", "Limit price in sats/STX (floor)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { amount: string; limit?: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);

      let limitSats: number;
      if (opts.limit) {
        limitSats = parseInt(opts.limit);
        if (limitSats <= 0) throw new Error("Limit must be positive");
      } else {
        const oracleSats = await getOracleSatsPerStx(m);
        limitSats = defaultLimitSatsPerStx(oracleSats, "stx");
      }
      const limitRaw = satsPerStxToRaw(limitSats);

      const account = await getAccount();
      const micro = BigInt(Math.floor(parseFloat(opts.amount) * 10 ** m.tokenBDecimals));

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: m.depositFn,
        functionArgs: [uintCV(micro), uintCV(limitRaw)],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [Pc.principal(account.address).willSendEq(micro).ustx()],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: m.depositFn,
        amount: `${opts.amount} STX`,
        limitSatsPerStx: limitSats,
        premium: m.premiumLabel,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("deposit-sbtc")
  .description("Deposit sBTC (satoshis) with limit price (sats/STX ceiling). Omit --limit for 20% in-the-money default.")
  .requiredOption("--amount <value>", "Amount of sBTC in satoshis")
  .option("--limit <sats>", "Limit price in sats/STX (ceiling)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { amount: string; limit?: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);

      let limitSats: number;
      if (opts.limit) {
        limitSats = parseInt(opts.limit);
        if (limitSats <= 0) throw new Error("Limit must be positive");
      } else {
        const oracleSats = await getOracleSatsPerStx(m);
        limitSats = defaultLimitSatsPerStx(oracleSats, "sbtc");
      }
      const limitRaw = satsPerStxToRaw(limitSats);

      const account = await getAccount();
      const sats = BigInt(parseInt(opts.amount));

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "deposit-sbtc",
        functionArgs: [uintCV(sats), uintCV(limitRaw)],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          Pc.principal(account.address).willSendEq(sats).ft(SBTC_CONTRACT, "sbtc-token"),
        ],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "deposit-sbtc",
        amount: `${opts.amount} sats`,
        limitSatsPerStx: limitSats,
        premium: m.premiumLabel,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — limit management
// ---------------------------------------------------------------------------

program
  .command("set-stx-limit")
  .description("Update STX-side limit price without re-depositing (deposit phase only)")
  .requiredOption("--limit <sats>", "New limit in sats/STX (floor)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { limit: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const limitSats = parseInt(opts.limit);
      if (limitSats <= 0) throw new Error("Limit must be positive");
      const limitRaw = satsPerStxToRaw(limitSats);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "set-stx-limit",
        functionArgs: [uintCV(limitRaw)],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "set-stx-limit",
        limitSatsPerStx: limitSats,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("set-sbtc-limit")
  .description("Update sBTC-side limit price without re-depositing (deposit phase only)")
  .requiredOption("--limit <sats>", "New limit in sats/STX (ceiling)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { limit: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const limitSats = parseInt(opts.limit);
      if (limitSats <= 0) throw new Error("Limit must be positive");
      const limitRaw = satsPerStxToRaw(limitSats);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "set-sbtc-limit",
        functionArgs: [uintCV(limitRaw)],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "set-sbtc-limit",
        limitSatsPerStx: limitSats,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — cancel deposits
// ---------------------------------------------------------------------------

program
  .command("cancel-stx")
  .description("Cancel STX deposit for full refund (deposit phase only)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: m.cancelFn,
        functionArgs: [],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: m.cancelFn,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel-sbtc")
  .description("Cancel sBTC deposit for full refund (deposit phase only)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "cancel-sbtc-deposit",
        functionArgs: [],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "cancel-sbtc-deposit",
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — settlement (bundled, no separate close-deposits)
// ---------------------------------------------------------------------------

program
  .command("close-and-settle")
  .description("Close deposits and settle atomically with fresh Pyth prices (single tx, reverts on failure)")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);

      if (data.phase === 0 && data.blocksElapsed < 10) {
        throw new Error(
          `Cannot settle — deposit phase needs 10 blocks minimum, currently at ${data.blocksElapsed}`
        );
      }

      // Fetch fresh Pyth VAAs
      const vaas = await jingswapGet(`/api/auction/pyth-vaas${apiContractParam(m)}`);
      const btcVaaBuffer = bufferCV(Buffer.from(vaas.btcVaaHex, "hex"));
      const stxVaaBuffer = bufferCV(Buffer.from(vaas.stxVaaHex, "hex"));

      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "close-and-settle-with-refresh",
        functionArgs: [
          btcVaaBuffer,
          stxVaaBuffer,
          contractPrincipalCV(PYTH_CONTRACTS.storage.address, PYTH_CONTRACTS.storage.name),
          contractPrincipalCV(PYTH_CONTRACTS.decoder.address, PYTH_CONTRACTS.decoder.name),
          contractPrincipalCV(PYTH_CONTRACTS.wormhole.address, PYTH_CONTRACTS.wormhole.name),
        ],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
        fee: BigInt(50000),
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "close-and-settle-with-refresh",
        premium: m.premiumLabel,
        cycle: data.currentCycle,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel-cycle")
  .description("Cancel cycle if settlement failed — callable 42 blocks (~84s) after close")
  .option("--market <pair>", `Market (default: sbtc-stx-market)`)
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);
      if (data.phase === 0) {
        throw new Error("Cannot cancel cycle — auction is still in deposit phase");
      }
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "cancel-cycle",
        functionArgs: [],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "cancel-cycle",
        cycle: data.currentCycle,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
program.parse();
