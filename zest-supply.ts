#!/usr/bin/env bun
/**
 * zest-supply.ts — Supply sBTC to Zest Protocol from SP3GX... address
 *
 * Usage:
 *   bun run zest-supply.ts --amount 62081           # dry-run (shows tx params, no broadcast)
 *   bun run zest-supply.ts --amount 62081 --confirm  # broadcast for real
 *
 * Uses CLIENT_PRIVATE_KEY from .env — signs from SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
 * which holds the sBTC. Bypasses MCP wallet address gap issue.
 *
 * Contract calls verified from mainnet tx 0x8f9eed21...
 */

import {
  makeContractCall,
  uintCV,
  principalCV,
  contractPrincipalCV,
  noneCV,
  PostConditionMode,
  Pc,
  broadcastTransaction,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Config ──────────────────────────────────────────────────────────────────

const SENDER = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const HIRO_API = "https://api.hiro.so";

// Zest Protocol v2 contracts (verified from mainnet supply tx 0x8f9eed21)
const BORROW_HELPER   = { addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N", name: "borrow-helper-v2-1-7" };
const ZSBTC           = { addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N", name: "zsbtc-v2-0" };
const POOL_RESERVE    = { addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N", name: "pool-0-reserve-v2-0" };
const SBTC            = { addr: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", name: "sbtc-token" };
const INCENTIVES      = { addr: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N", name: "incentives-v2-2" };

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const amountIdx = args.indexOf("--amount");
const confirm = args.includes("--confirm");

if (amountIdx === -1 || !args[amountIdx + 1]) {
  console.error("Usage: bun run zest-supply.ts --amount <sats> [--confirm]");
  console.error("  Without --confirm: dry-run only (shows params, no broadcast)");
  process.exit(1);
}

const amountSats = parseInt(args[amountIdx + 1], 10);
if (isNaN(amountSats) || amountSats <= 0) {
  console.error("Invalid --amount value. Must be a positive integer (sats).");
  process.exit(1);
}

// ── Private key ─────────────────────────────────────────────────────────────

const rawKey = process.env.CLIENT_PRIVATE_KEY;
if (!rawKey) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set in environment" }));
  process.exit(1);
}
// Ensure compressed format (66 chars = 64 hex + "01")
const privateKey = rawKey.length === 64 ? rawKey + "01" : rawKey;

// ── Pre-flight balance checks ───────────────────────────────────────────────

async function getBalances(): Promise<{ stx: number; sbtc: number; nonce: number }> {
  const [balRes, nonceRes] = await Promise.all([
    fetch(`${HIRO_API}/extended/v1/address/${SENDER}/balances`),
    fetch(`${HIRO_API}/v2/accounts/${SENDER}?proof=0`),
  ]);
  if (!balRes.ok) throw new Error(`Hiro balances API: ${balRes.status}`);
  if (!nonceRes.ok) throw new Error(`Hiro accounts API: ${nonceRes.status}`);

  const balData = await balRes.json();
  const nonceData = await nonceRes.json();

  const stx = parseInt(balData.stx?.balance ?? "0", 10);
  const ftKey = `${SBTC.addr}.${SBTC.name}::sbtc-token`;
  const sbtc = parseInt(balData.fungible_tokens?.[ftKey]?.balance ?? "0", 10);
  const nonce = nonceData.nonce ?? 0;

  return { stx, sbtc, nonce };
}

// ── Main ────────────────────────────────────────────────────────────────────

const { stx, sbtc, nonce } = await getBalances();
const FEE = 50_000n; // 0.05 STX — sufficient for borrow-helper call

console.log(JSON.stringify({
  preflight: {
    sender: SENDER,
    stx_ustx: stx,
    sbtc_sats: sbtc,
    nonce,
    supply_amount_sats: amountSats,
    fee_ustx: Number(FEE),
    sbtc_after_supply: sbtc - amountSats,
    stx_after_fee: stx - Number(FEE),
  }
}, null, 2));

// Safety checks
if (sbtc < amountSats) {
  console.error(JSON.stringify({ error: `Insufficient sBTC: have ${sbtc} sats, need ${amountSats} sats` }));
  process.exit(1);
}
if (stx < Number(FEE) + 100_000) {
  console.error(JSON.stringify({ error: `Insufficient STX for gas: have ${stx} uSTX, need ${Number(FEE) + 100_000} uSTX` }));
  process.exit(1);
}
if (sbtc - amountSats < 1_000) {
  console.error(JSON.stringify({ error: `Supply would leave <1000 sats liquid (${sbtc - amountSats} remaining). Reduce amount.` }));
  process.exit(1);
}

if (!confirm) {
  console.log(JSON.stringify({
    status: "dry_run",
    message: "Dry-run complete. Add --confirm to broadcast.",
    would_call: {
      contract: `${BORROW_HELPER.addr}.${BORROW_HELPER.name}`,
      function: "supply",
      args: [
        `lp: ${ZSBTC.addr}.${ZSBTC.name}`,
        `pool-reserve: ${POOL_RESERVE.addr}.${POOL_RESERVE.name}`,
        `asset: ${SBTC.addr}.${SBTC.name}`,
        `amount: u${amountSats}`,
        `owner: ${SENDER}`,
        `referral: none`,
        `incentives: ${INCENTIVES.addr}.${INCENTIVES.name}`,
      ],
    },
  }, null, 2));
  process.exit(0);
}

// ── Build and broadcast ─────────────────────────────────────────────────────

console.log("Building Zest supply transaction...");

const tx = await makeContractCall({
  network: STACKS_MAINNET,
  contractAddress: BORROW_HELPER.addr,
  contractName: BORROW_HELPER.name,
  functionName: "supply",
  functionArgs: [
    contractPrincipalCV(ZSBTC.addr, ZSBTC.name),
    contractPrincipalCV(POOL_RESERVE.addr, POOL_RESERVE.name),
    contractPrincipalCV(SBTC.addr, SBTC.name),
    uintCV(amountSats),
    principalCV(SENDER),
    noneCV(),
    contractPrincipalCV(INCENTIVES.addr, INCENTIVES.name),
  ],
  senderKey: privateKey,
  fee: FEE,
  nonce: BigInt(nonce),
  postConditionMode: PostConditionMode.Deny,
  postConditions: [
    // Sender transfers exactly amountSats sbtc-token
    Pc.principal(SENDER)
      .willSendEq(BigInt(amountSats))
      .ft(`${SBTC.addr}.${SBTC.name}`, "sbtc-token"),
  ],
});

console.log("Broadcasting transaction...");

const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });

console.log(JSON.stringify({
  status: "broadcast",
  txid: result.txid ?? result,
  sender: SENDER,
  amount_sats: amountSats,
  nonce,
  fee_ustx: Number(FEE),
  explorer: `https://explorer.hiro.so/txid/${result.txid}?chain=mainnet`,
}, null, 2));
