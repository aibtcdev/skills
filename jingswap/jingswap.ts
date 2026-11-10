#!/usr/bin/env bun
/**
 * Jingswap skill CLI
 * Blind batch auction for STX/sBTC on Stacks
 *
 * Usage: bun run jingswap/jingswap.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  uintCV,
  bufferCV,
  contractPrincipalCV,
  PostConditionMode,
  Pc,
} from "@stacks/transactions";
import { getAccount, getWalletAddress } from "@aibtc/skills/src/lib/services/x402.service.js";
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

interface MarketConfig {
  contractName: string;
  tokenBSymbol: string;
  tokenBDecimals: number;
  tokenBContract?: string;
  tokenBAsset?: string;
  depositFn: string;
  cancelFn: string;
  priceUnit: string;
}

const MARKETS: Record<string, MarketConfig> = {
  "sbtc-stx": {
    contractName: "sbtc-stx-jing",
    tokenBSymbol: "STX",
    tokenBDecimals: 6,
    depositFn: "deposit-stx",
    cancelFn: "cancel-stx-deposit",
    priceUnit: "STX/BTC",
  },
  "sbtc-usdcx": {
    contractName: "sbtc-usdcx-jing",
    tokenBSymbol: "USDCx",
    tokenBDecimals: 6,
    tokenBContract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    tokenBAsset: "usdcx-token",
    depositFn: "deposit-usdcx",
    cancelFn: "cancel-usdcx-deposit",
    priceUnit: "USDCx/BTC",
  },
};

const DEFAULT_MARKET = "sbtc-stx";

function getMarket(market?: string): MarketConfig {
  const key = market || DEFAULT_MARKET;
  const config = MARKETS[key];
  if (!config) throw new Error(`Unknown market "${key}". Available: ${Object.keys(MARKETS).join(", ")}`);
  return config;
}

function apiContractParam(market: MarketConfig): string {
  return market.contractName === "sbtc-stx-jing" ? "" : `?contract=${market.contractName}`;
}

const PYTH_CONTRACTS = {
  storage: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "pyth-storage-v4" },
  decoder: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "pyth-pnau-decoder-v3" },
  wormhole: { address: "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y", name: "wormhole-core-v4" },
};

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

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

async function assertDepositPhase(market: MarketConfig): Promise<any> {
  const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(market)}`);
  if (data.phase !== 0) {
    const phases = ["deposit", "buffer", "settle"];
    throw new Error(
      `Cannot deposit/cancel — auction is in ${phases[data.phase] || "unknown"} phase (must be deposit)`
    );
  }
  return data;
}

async function assertSettlePhase(market: MarketConfig): Promise<any> {
  const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(market)}`);
  if (data.phase === 0) {
    throw new Error("Cannot settle/cancel-cycle — auction is still in deposit phase");
  }
  if (data.phase === 1) {
    const BUFFER_BLOCKS = 30;
    const blocksIntoBuffer = data.blocksElapsed - 150;
    const blocksRemaining = Math.max(0, BUFFER_BLOCKS - blocksIntoBuffer);
    throw new Error(
      `Cannot settle — auction is in buffer phase. Wait ${blocksRemaining} more blocks (~${blocksRemaining * 2}s) before settling.`
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("jingswap")
  .description(
    "Jingswap blind batch auction — deposit/cancel STX and sBTC, " +
      "close deposits, settle with oracle prices, query cycle state and history."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// Read commands
// ---------------------------------------------------------------------------

program
  .command("cycle-state")
  .description("Get current auction cycle state (phase, blocks, totals, minimums)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);
      printJson({
        ...data,
        _hint: {
          phases: "0=deposit (min 150 blocks ~5min), 1=buffer (~1min), 2=settle",
          blockTime: "~2 seconds per Stacks block (Nakamoto)",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("depositors")
  .description("Get quote-token and sBTC depositors for a cycle")
  .requiredOption("--cycle <number>", "Cycle number")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { cycle: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/depositors/${opts.cycle}${apiContractParam(m)}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("user-deposit")
  .description("Get a user's deposit amounts for a cycle")
  .requiredOption("--cycle <number>", "Cycle number")
  .requiredOption("--address <stx_address>", "Stacks address")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { cycle: string; address: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(
        `/api/auction/deposit/${opts.cycle}/${opts.address}${apiContractParam(m)}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("settlement")
  .description("Get settlement details for a completed cycle")
  .requiredOption("--cycle <number>", "Cycle number")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { cycle: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/settlement/${opts.cycle}${apiContractParam(m)}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cycles-history")
  .description("Get full history of all auction cycles")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycles-history${apiContractParam(m)}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("user-activity")
  .description("Get a user's auction activity (deposits, cancellations, fills)")
  .requiredOption("--address <stx_address>", "Stacks address")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { address: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/activity/${opts.address}${apiContractParam(m)}`);
      printJson({
        ...data,
        _hint: {
          "distribute-stx-depositor":
            "stxAmount = unswapped STX rolled to next cycle, sbtcAmount = sBTC received",
          "distribute-sbtc-depositor":
            "sbtcAmount = unswapped sats rolled to next cycle, stxAmount = STX received",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("prices")
  .description("Get oracle and DEX prices (Pyth, XYK, DLMM)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const [pyth, dex] = await Promise.all([
        jingswapGet(`/api/auction/pyth-prices${apiContractParam(m)}`),
        jingswapGet(`/api/auction/dex-price${apiContractParam(m)}`),
      ]);
      const xykStxPerBtc =
        dex.xykBalances && dex.xykBalances.xBalance > 0
          ? (dex.xykBalances.yBalance / dex.xykBalances.xBalance / 1e6) * 1e8
          : null;
      const dlmmStxPerBtc =
        dex.dlmmPrice && dex.dlmmPrice > 0
          ? 1 / (dex.dlmmPrice * 1e-10)
          : null;
      printJson({
        pyth,
        dex: {
          ...dex,
          xykStxPerBtc: xykStxPerBtc ? Math.round(xykStxPerBtc * 100) / 100 : null,
          dlmmStxPerBtc: dlmmStxPerBtc ? Math.round(dlmmStxPerBtc * 100) / 100 : null,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — deposit phase
// ---------------------------------------------------------------------------

program
  .command("deposit-stx")
  .description("Deposit quote token (STX or USDCx depending on market) into current auction cycle (deposit phase only)")
  .requiredOption("--amount <value>", "Amount to deposit (in human units)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { amount: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const account = await getAccount();
      const microAmount = BigInt(Math.floor(parseFloat(opts.amount) * 10 ** m.tokenBDecimals));

      const postConditions = m.tokenBContract && m.tokenBAsset
        ? [
            Pc.principal(account.address)
              .willSendEq(microAmount)
              .ft(m.tokenBContract as `${string}.${string}`, m.tokenBAsset),
          ]
        : [Pc.principal(account.address).willSendEq(microAmount).ustx()];

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: m.depositFn,
        functionArgs: [uintCV(microAmount)],
        postConditionMode: PostConditionMode.Deny,
        postConditions,
      });

      printJson({
        success: true,
        txid: result.txid,
        action: m.depositFn,
        amount: `${opts.amount} ${m.tokenBSymbol}`,
        market: m.contractName,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("deposit-sbtc")
  .description("Deposit sBTC in satoshis into current auction cycle (deposit phase only)")
  .requiredOption("--amount <sats>", "Amount of sBTC in satoshis")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { amount: string; market?: string }) => {
    try {
      const m = getMarket(opts.market);
      await assertDepositPhase(m);
      const account = await getAccount();
      const sats = BigInt(parseInt(opts.amount, 10));

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "deposit-sbtc",
        functionArgs: [uintCV(sats)],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          Pc.principal(account.address)
            .willSendEq(sats)
            .ft(SBTC_CONTRACT, "sbtc-token"),
        ],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "deposit-sbtc",
        amount: `${opts.amount} sats`,
        market: m.contractName,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel-stx")
  .description("Cancel your quote-token deposit and get a refund (deposit phase only)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
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
        market: m.contractName,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel-sbtc")
  .description("Cancel your sBTC deposit and get a refund (deposit phase only)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
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
        market: m.contractName,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Write commands — settlement phase
// ---------------------------------------------------------------------------

program
  .command("close-deposits")
  .description("Close deposit phase (requires 150+ blocks elapsed, both sides above minimum)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await jingswapGet(`/api/auction/cycle-state${apiContractParam(m)}`);
      if (data.phase !== 0) throw new Error("Not in deposit phase");
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "close-deposits",
        functionArgs: [],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "close-deposits",
        market: m.contractName,
        cycle: data.currentCycle,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("settle")
  .description("Settle with stored Pyth prices (free but usually stale — prefer settle-with-refresh)")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await assertSettlePhase(m);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "settle",
        functionArgs: [],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "settle",
        market: m.contractName,
        cycle: data.currentCycle,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("settle-with-refresh")
  .description("Settle with fresh Pyth VAAs (~2 uSTX) — recommended settlement method")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await assertSettlePhase(m);
      const vaas = await jingswapGet("/api/auction/pyth-vaas");
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: CONTRACT_ADDRESS,
        contractName: m.contractName,
        functionName: "settle-with-refresh",
        functionArgs: [
          bufferCV(Buffer.from(vaas.btcVaaHex, "hex")),
          bufferCV(Buffer.from(vaas.stxVaaHex, "hex")),
          contractPrincipalCV(PYTH_CONTRACTS.storage.address, PYTH_CONTRACTS.storage.name),
          contractPrincipalCV(PYTH_CONTRACTS.decoder.address, PYTH_CONTRACTS.decoder.name),
          contractPrincipalCV(PYTH_CONTRACTS.wormhole.address, PYTH_CONTRACTS.wormhole.name),
        ],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        action: "settle-with-refresh",
        market: m.contractName,
        cycle: data.currentCycle,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("cancel-cycle")
  .description("Cancel cycle if settlement failed after 530 blocks (~17.5 min). Rolls deposits to next cycle.")
  .option("--market <pair>", "Market: sbtc-stx (default) or sbtc-usdcx")
  .action(async (opts: { market?: string }) => {
    try {
      const m = getMarket(opts.market);
      const data = await assertSettlePhase(m);
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
        market: m.contractName,
        cycle: data.currentCycle,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
