#!/usr/bin/env bun
/**
 * competition-swap.ts — Execute STX→sBTC swap for AIBTC trading competition
 * Signs from SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW (registered agent address).
 * Bypasses broken SDK gateway; calls xyk-swap-helper-v-1-3 directly.
 *
 * Usage: bun run competition-swap.ts [--amount <stx>] [--slippage <pct>]
 */

import {
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  contractPrincipalCV,
  noneCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set" }));
  process.exit(1);
}

// Parse optional CLI overrides
const args = process.argv.slice(2);
const amountArg = args[args.indexOf("--amount") + 1];
const slippageArg = args[args.indexOf("--slippage") + 1];

const amountStx = amountArg ? parseFloat(amountArg) : 5.0;
const slippagePct = slippageArg ? parseFloat(slippageArg) : 2.0;

// Quote from MCP bitflow_get_quote: 5 STX → ~1596 sats sBTC (updated 2026-05-15)
// Scale proportionally if different amount
const expectedSatsAt5Stx = 1596;
const expectedSats = Math.floor((expectedSatsAt5Stx * amountStx) / 5.0);
const minReceived = BigInt(Math.floor(expectedSats * (1 - slippagePct / 100)));
const amountUstx = BigInt(Math.round(amountStx * 1_000_000));

console.log(JSON.stringify({
  step: "params",
  amountStx,
  amountUstx: amountUstx.toString(),
  expectedSats,
  minReceived: minReceived.toString(),
  slippagePct,
}));

function split(contractId: string): [string, string] {
  const dot = contractId.indexOf(".");
  return [contractId.slice(0, dot), contractId.slice(dot + 1)];
}

const [stxAddr, stxName] = split("SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2");
const [sbtcAddr, sbtcName] = split("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token");
const [poolAddr, poolName] = split("SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1");

console.log(JSON.stringify({ step: "building_tx" }));

const transaction = await makeContractCall({
  contractAddress: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  contractName: "xyk-swap-helper-v-1-3",
  functionName: "swap-helper-a",
  functionArgs: [
    uintCV(amountUstx),
    uintCV(minReceived),
    noneCV(),
    tupleCV({
      a: contractPrincipalCV(stxAddr, stxName),
      b: contractPrincipalCV(sbtcAddr, sbtcName),
    }),
    tupleCV({
      a: contractPrincipalCV(poolAddr, poolName),
    }),
  ],
  senderKey: PRIVATE_KEY,
  network: STACKS_MAINNET,
  postConditions: [],
  postConditionMode: PostConditionMode.Allow,
});

console.log(JSON.stringify({ step: "broadcasting" }));

const result = await broadcastTransaction({ transaction, network: STACKS_MAINNET });

if ("error" in result) {
  console.error(JSON.stringify({ error: result.error, reason: result.reason, detail: (result as any).reason_data }));
  process.exit(1);
}

console.log(JSON.stringify({
  step: "done",
  txid: result.txid,
  txid_prefixed: `0x${result.txid}`,
  explorer: `https://explorer.hiro.so/txid/0x${result.txid}?chain=mainnet`,
}));
