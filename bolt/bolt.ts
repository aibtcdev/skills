#!/usr/bin/env bun
/**
 * Bolt skill CLI
 * Gasless Stacks transactions through Bolt Protocol (boltproto.org): the
 * wallet signs a sponsored transaction, Bolt pays the STX fee and broadcasts,
 * and the wallet pays Bolt in sBTC or USDCx instead.
 *
 * Usage: bun run bolt/bolt.ts <subcommand> [options]
 */

import { createHash } from "node:crypto";
import { Command } from "commander";
import {
  makeContractCall,
  signMessageHashRsv,
  Cl,
  PostConditionMode,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { parseArgToClarityValue } from "../src/lib/transactions/clarity-values.js";
import {
  createFungiblePostCondition,
  createStxPostCondition,
} from "../src/lib/transactions/post-conditions.js";
import { AibtcError } from "../src/lib/utils/errors.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOLT_API = "https://boltproto.org/api";
const BOLT_DOCS = "https://boltproto.org/llms-full.txt";
const BOLT_DEPLOYER = "SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ";

/** Path segment the v1 credit routes use for the sBTC credit ledger. */
const CREDIT_TOKEN = "sbtc-token";
/** Smallest fee Bolt accepts for a credit-sponsored call, in sats. */
const MIN_CREDIT_FEE = 10n;
/** Above 500 bytes the minimum grows by 1 sat per 50 bytes of transaction. */
const CREDIT_BYTES_PER_SAT = 50n;

function minCreditFee(serializedTx: string): bigint {
  const bytes = BigInt(Math.ceil(serializedTx.length / 2));
  const bySize = (bytes + CREDIT_BYTES_PER_SAT - 1n) / CREDIT_BYTES_PER_SAT;
  return bySize > MIN_CREDIT_FEE ? bySize : MIN_CREDIT_FEE;
}
/** A call paid in the same request pays for two transactions: twice the credit fee. */
const PAID_CALL_MULTIPLE = 2n;
const MEMO_MAX_BYTES = 34;

type TokenKey = "sbtc" | "usdcx";

const TOKENS: Record<
  TokenKey,
  {
    symbol: string;
    unit: string;
    boltContract: string;
    assetContract: string;
    assetName: string;
    minFee: bigint;
  }
> = {
  sbtc: {
    symbol: "sBTC",
    unit: "sats",
    boltContract: "boltproto-sbtc-v2",
    assetContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    assetName: "sbtc-token",
    minFee: 10n,
  },
  usdcx: {
    symbol: "USDCx",
    unit: "micro-USDCx",
    boltContract: "boltproto-usdcx-v1",
    assetContract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    assetName: "usdcx-token",
    minFee: 100n,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireMainnet(): void {
  if (NETWORK !== "mainnet") {
    throw new AibtcError(
      "Bolt Protocol is a mainnet service; this skill has no testnet endpoint.",
      "BOLT_MAINNET_ONLY",
      { network: NETWORK },
      "Run with NETWORK=mainnet"
    );
  }
}

function parseAmount(value: string, flag: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new AibtcError(
      `${flag} must be a positive integer in the token's smallest unit`,
      "BOLT_INVALID_ARGUMENT",
      { [flag]: value }
    );
  }
  return BigInt(value);
}

function memoArg(memo: string | undefined): ClarityValue {
  if (!memo) return Cl.none();
  if (new TextEncoder().encode(memo).length > MEMO_MAX_BYTES) {
    throw new AibtcError(
      `--memo is limited to ${MEMO_MAX_BYTES} bytes`,
      "BOLT_INVALID_ARGUMENT"
    );
  }
  return Cl.some(Cl.bufferFromUtf8(memo));
}

/** What Bolt's error body carries besides `message`. Older answers have none of it. */
interface BoltErrorBody {
  /** Stable refusal code; see the Errors section of the API guide. */
  code?: string;
  /** The Stacks node's own rejection code. */
  reason?: string;
  /** The call Bolt already broadcast for this nonce, or the payout of a withdrawal. */
  txid?: string;
  /** Outcome of the original withdrawal request, on a repeated one. */
  status?: string;
  minimumFee?: number;
  /** Payment transaction of a call paid in the same request. */
  feeTxid?: string;
  /** Sats that become prepaid credit when the payment was sent and the call was not. */
  credit?: number;
}

/** What to tell the agent, per skill error code. */
const SUGGESTIONS: Record<string, string> = {
  BOLT_REFUND_FAILED: "The amount was debited and not returned. Do not send again; Bolt was notified.",
  BOLT_WITHDRAWAL_UNKNOWN:
    "Do not send again. Bolt was notified; run credit-balance later to see the outcome.",
  BOLT_CALL_UNKNOWN:
    "The fee was debited and Bolt could not confirm the broadcast. Do not run the command again: look the txid up first. Bolt was notified.",
  BOLT_WITHDRAWAL_REPEATED:
    "This withdrawal request was already used. Run credit-balance; run the command again only if the credit is still there.",
  BOLT_INVALID_ARGUMENT:
    "Nothing was withdrawn. Check --amount and that the active wallet owns the credit.",
  BOLT_REJECTED:
    "Nothing was charged. The message names the network's reason: fix that, then run the command again.",
  BOLT_TEMPORARILY_UNAVAILABLE: "Nothing was charged. Try again later.",
  BOLT_INVALID_NONCE:
    "Wait for this address's pending transactions to confirm, then run the command again.",
  BOLT_INSUFFICIENT_CREDIT:
    "Not enough credit. For sponsor-call: run credit-deposit, wait for it to confirm, then credit-balance. For credit-withdraw: lower --amount.",
  BOLT_CONTRACT_NOT_ON_CREDIT:
    "Bolt's own contracts cannot be called through sponsor-call. Use the transfer subcommand.",
  BOLT_FEE_TOO_LOW: "Nothing was charged. Raise --fee to the minimum in the message.",
  BOLT_INSUFFICIENT_BALANCE: "The wallet needs amount + fee of the token. Fund it or lower --amount.",
  BOLT_INVALID_TRANSACTION:
    "Nothing was charged. Fix the transaction: it must be a contract call signed with sponsored: true and fee 0.",
  BOLT_RATE_LIMITED: "Too many requests. Wait before sending again.",
  BOLT_CREDIT_ONLY:
    "Bolt takes only prepaid credit from this address. Run credit-deposit, wait for it to confirm, then sponsor-call.",
  BOLT_CALL_NOT_SENT:
    "The payment was sent and the call was not. Do not run the command again as is: fix what the message names. The fee of the call (details.credit) becomes prepaid credit once the payment (details.feeTxid) confirms; spend it with sponsor-call or take it back with credit-withdraw.",
};

/** Suggestion when nothing above applies: an answer with no known code or wording. */
const UNRECOGNIZED_REFUSAL =
  "The network refused the transaction. When the message names a reason, fix that before sending again.";

/** Bolt's `code` -> skill error code, where one decides the other. */
const BY_BOLT_CODE: Record<string, string> = {
  FEE_TOO_LOW: "BOLT_FEE_TOO_LOW",
  INVALID_SIGNATURE: "BOLT_INVALID_ARGUMENT",
  NONCE_PENDING: "BOLT_INVALID_NONCE",
  NONCE_MISMATCH: "BOLT_INVALID_NONCE",
  INSUFFICIENT_CREDIT: "BOLT_INSUFFICIENT_CREDIT",
  NODE_REJECTED: "BOLT_REJECTED",
  RETRY_SAME: "BOLT_TEMPORARILY_UNAVAILABLE",
  UNAVAILABLE: "BOLT_TEMPORARILY_UNAVAILABLE",
  NOT_REFUNDED: "BOLT_REFUND_FAILED",
  ALREADY_PROCESSED: "BOLT_WITHDRAWAL_REPEATED",
  INSUFFICIENT_BALANCE: "BOLT_INSUFFICIENT_BALANCE",
  CREDIT_ONLY: "BOLT_CREDIT_ONLY",
  CALL_NOT_SENT: "BOLT_CALL_NOT_SENT",
};

/** Bolt codes too broad to decide alone: used only when the message says no more. */
const BY_BROAD_BOLT_CODE: Record<string, string> = {
  INVALID_REQUEST: "BOLT_INVALID_ARGUMENT",
  SIGNATURE_EXPIRED: "BOLT_INVALID_ARGUMENT",
  INVALID_TRANSACTION: "BOLT_INVALID_TRANSACTION",
  STATUS_UNKNOWN: "BOLT_CALL_UNKNOWN",
};

/** By message text: answers without a `code`, and what a broad code does not tell apart. */
const BY_MESSAGE: Array<[RegExp, string]> = [
  [/could not be (returned|restored)/i, "BOLT_REFUND_FAILED"],
  [/Withdrawal status unknown/i, "BOLT_WITHDRAWAL_UNKNOWN"],
  [/Transaction status unknown/i, "BOLT_CALL_UNKNOWN"],
  [/Withdrawal already processed/i, "BOLT_WITHDRAWAL_REPEATED"],
  [
    /Invalid signature|signedAt|Unsupported token|Invalid address|greater than the withdrawal fee/i,
    "BOLT_INVALID_ARGUMENT",
  ],
  [/rejected by the network/i, "BOLT_REJECTED"],
  [/Try again|Nothing was charged/i, "BOLT_TEMPORARILY_UNAVAILABLE"],
  [/Invalid nonce/i, "BOLT_INVALID_NONCE"],
  [/Insufficient sponsor credit/i, "BOLT_INSUFFICIENT_CREDIT"],
  [/not sponsored on credit/i, "BOLT_CONTRACT_NOT_ON_CREDIT"],
  [/minimum required fee/i, "BOLT_FEE_TOO_LOW"],
  [/Insufficient .*balance/i, "BOLT_INSUFFICIENT_BALANCE"],
  [
    /serializedTx|not sponsored$|Only contract calls|signature|Invalid fee|not allowed|not supported|Post condition|too large/i,
    "BOLT_INVALID_TRANSACTION",
  ],
];

/** What a repeated withdrawal request says about the original one. */
function repeatedWithdrawalSuggestion(body: BoltErrorBody): string {
  switch (body.status) {
    case "sent":
    case "confirmed":
      return `That request was already paid (${body.status}): txid ${body.txid}. Do not withdraw again for it.`;
    case "not_paid":
      return "That request was refused or refunded and the credit is in the balance. Run the command again to sign a new one.";
    case "pending":
      return "That request was received moments ago and has no outcome yet. Run credit-balance shortly; do not sign a new one meanwhile.";
    case "unknown":
      return "Bolt could not establish the outcome of that request and was notified. Do not sign a new one; run credit-balance later.";
    default:
      return SUGGESTIONS.BOLT_WITHDRAWAL_REPEATED;
  }
}

/** Map a Bolt error response to a structured error an agent can act on. */
function boltError(status: number, message: string, body: BoltErrorBody = {}): AibtcError {
  const known =
    (body.code !== undefined ? BY_BOLT_CODE[body.code] : undefined) ??
    BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1] ??
    (body.code !== undefined ? BY_BROAD_BOLT_CODE[body.code] : undefined) ??
    (status === 429 ? "BOLT_RATE_LIMITED" : undefined);
  const code = known ?? "BOLT_REJECTED";
  const details = {
    status,
    ...(body.code !== undefined && { boltCode: body.code }),
    ...(body.txid !== undefined && { txid: body.txid }),
    ...(body.status !== undefined && { withdrawal: body.status }),
    ...(body.minimumFee !== undefined && { minimumFee: body.minimumFee }),
    ...(body.feeTxid !== undefined && { feeTxid: body.feeTxid }),
    ...(body.credit !== undefined && { credit: body.credit }),
  };
  let suggestion = known === undefined ? UNRECOGNIZED_REFUSAL : SUGGESTIONS[code];
  if (code === "BOLT_WITHDRAWAL_REPEATED") {
    suggestion = repeatedWithdrawalSuggestion(body);
  } else if (/feeSignature/.test(message)) {
    suggestion =
      "Nothing was charged. The fee is signed by the wallet that signed the transaction: --serialized-tx takes only a transaction the active wallet signed.";
  } else if (code === "BOLT_INVALID_NONCE" && body.txid !== undefined) {
    suggestion = `Bolt already broadcast a call with this nonce: txid ${body.txid}. If it is the call you meant, it is done; do not send it again.`;
  }
  return new AibtcError(message, code, details, suggestion, BOLT_DOCS);
}

async function boltRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BOLT_API}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const errorBody = (body ?? {}) as BoltErrorBody & { message?: unknown };
    const { message: raw, reason } = errorBody;
    const text = Array.isArray(raw)
      ? raw.join("; ")
      : typeof raw === "string"
        ? raw
        : `Bolt answered HTTP ${response.status}`;
    // A refused transfer names the network's reason in a field of its own.
    const message = typeof reason === "string" && !text.includes(reason) ? `${text} (${reason})` : text;
    throw boltError(response.status, message, errorBody);
  }
  return body as T;
}

function boltPost<T>(path: string, body: unknown): Promise<T> {
  return boltRequest<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * POST a signed write. When no answer arrives (timeout, dropped connection)
 * nobody knows whether Bolt received it, so the very same body is sent once
 * more: Bolt runs a signed request once, and the repeat either goes through or
 * says what became of the first. `recover` turns that answer into the result
 * of the first attempt when it names its transaction.
 *
 * Never sign again here: a re-signed transaction carries a new nonce and would
 * run the operation a second time.
 */
async function boltWrite<T>(
  path: string,
  body: unknown,
  recover: (refusal: AibtcError) => T | undefined
): Promise<T> {
  try {
    return await boltPost<T>(path, body);
  } catch (first) {
    if (first instanceof AibtcError) throw first; // Bolt answered: nothing to recover.
    let refusal: AibtcError;
    try {
      return await boltPost<T>(path, body);
    } catch (second) {
      if (!(second instanceof AibtcError)) throw second; // Still no answer.
      refusal = second;
    }
    const recovered = recover(refusal);
    if (recovered !== undefined) return recovered;
    if (refusal.code === "BOLT_INVALID_NONCE") {
      // Not BOLT_INVALID_NONCE on purpose: that one makes signAndSend sign again.
      throw new AibtcError(
        refusal.message,
        "BOLT_SENT_UNCONFIRMED",
        refusal.details,
        "The first attempt got no answer and its nonce is now taken: it was most likely broadcast. Check the address's recent transactions before running the command again.",
        BOLT_DOCS
      );
    }
    throw refusal;
  }
}

/** The call Bolt already broadcast for this nonce, when a nonce refusal names it. */
function broadcastFromNonceRefusal(refusal: AibtcError): { txid: string } | undefined {
  const txid = (refusal.details as { txid?: unknown } | undefined)?.txid;
  return refusal.code === "BOLT_INVALID_NONCE" && typeof txid === "string" ? { txid } : undefined;
}

/** Next nonce for the account, counting its pending transactions. */
async function nextNonce(address: string): Promise<bigint> {
  const info = await getHiroApi(NETWORK).getNonceInfo(address);
  const executed = info.last_executed_tx_nonce as number | null;
  const confirmedNext = executed === null ? 0 : executed + 1;
  const mempool = info.last_mempool_tx_nonce;
  return BigInt(mempool !== null && mempool >= confirmedNext ? mempool + 1 : confirmedNext);
}

interface CallSpec {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: PostConditionMode;
}

/** Build and sign a sponsored contract call. Nothing is broadcast here. */
async function signSponsored(
  spec: CallSpec,
  nonceOverride?: bigint
): Promise<{ serializedTx: string; sender: string; nonce: bigint }> {
  const account = await getAccount();
  const nonce = nonceOverride ?? (await nextNonce(account.address));
  const transaction = await makeContractCall({
    ...spec,
    senderKey: account.privateKey,
    network: NETWORK,
    sponsored: true,
    fee: 0n,
    nonce,
  });
  return { serializedTx: transaction.serialize(), sender: account.address, nonce };
}

/** The nonce to sign with instead, when Bolt's refusal names one. */
function nonceFromRefusal(error: unknown): bigint | undefined {
  if (!(error instanceof AibtcError) || error.code !== "BOLT_INVALID_NONCE") return undefined;
  const pending = error.message.match(/nonce (\d+) from \S+ is already pending/);
  if (pending) return BigInt(pending[1]) + 1n;
  const stale = error.message.match(/transaction has (\d+), the next nonce for \S+ is (\d+)/);
  if (stale && BigInt(stale[1]) < BigInt(stale[2])) return BigInt(stale[2]);
  return undefined;
}

/** The minimum fee to pay instead, when Bolt's refusal names one. */
function minimumFeeFromRefusal(error: unknown): bigint | undefined {
  if (!(error instanceof AibtcError) || error.code !== "BOLT_FEE_TOO_LOW") return undefined;
  const fromBody = (error.details as { minimumFee?: unknown } | undefined)?.minimumFee;
  if (typeof fromBody === "number" && Number.isSafeInteger(fromBody)) return BigInt(fromBody);
  const minimum = error.message.match(/minimum required fee: (\d+)/);
  return minimum ? BigInt(minimum[1]) : undefined;
}

/** Sign and send; if Bolt names a different nonce, sign again with it, once. */
async function signAndSend<T>(
  spec: CallSpec,
  send: (serializedTx: string) => Promise<T>
): Promise<{ result: T; sender: string; nonce: bigint }> {
  const first = await signSponsored(spec);
  try {
    return { result: await send(first.serializedTx), sender: first.sender, nonce: first.nonce };
  } catch (error) {
    const retryNonce = nonceFromRefusal(error);
    if (retryNonce === undefined) throw error;
    const second = await signSponsored(spec, retryNonce);
    return { result: await send(second.serializedTx), sender: second.sender, nonce: second.nonce };
  }
}

function parseJsonArray(value: string, flag: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (e) {
    throw new AibtcError(
      `Invalid ${flag} JSON: ${e instanceof Error ? e.message : String(e)}`,
      "BOLT_INVALID_ARGUMENT"
    );
  }
}

/** Post conditions in the same JSON shape the contract skill takes (stx, ft). */
function parsePostCondition(pc: unknown): PostCondition {
  const { type, principal, conditionCode, amount, asset, assetName } = (pc ?? {}) as Record<string, unknown>;
  const codes = ["eq", "gt", "gte", "lt", "lte"] as const;
  type Code = (typeof codes)[number];
  if (
    typeof principal !== "string" ||
    (typeof amount !== "string" && typeof amount !== "number") ||
    !codes.includes(conditionCode as Code)
  ) {
    throw new AibtcError(
      "Each post condition needs principal, amount and conditionCode (eq|gt|gte|lt|lte)",
      "BOLT_INVALID_ARGUMENT"
    );
  }
  if (type === "stx") {
    return createStxPostCondition(principal, conditionCode as Code, BigInt(amount));
  }
  if (type === "ft" && typeof asset === "string" && typeof assetName === "string") {
    return createFungiblePostCondition(principal, asset, assetName, conditionCode as Code, BigInt(amount));
  }
  throw new AibtcError(
    "Post condition type must be 'stx' or 'ft' (ft also needs asset and assetName)",
    "BOLT_INVALID_ARGUMENT"
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("bolt")
  .description(
    "Bolt Protocol: gasless sBTC/USDCx transfers and prepaid gas credit for any contract call on Stacks, with no STX in the wallet"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Check that Bolt is up and show endpoints, contracts and minimum fees. No wallet needed.")
  .action(async () => {
    try {
      requireMainnet();
      const health = await boltRequest<{ status: string }>("/health");
      printJson({
        network: NETWORK,
        endpoint: BOLT_API,
        status: health.status,
        docs: BOLT_DOCS,
        transfer: Object.fromEntries(
          (Object.keys(TOKENS) as TokenKey[]).map((key) => [
            key,
            {
              contract: `${BOLT_DEPLOYER}.${TOKENS[key].boltContract}`,
              minFee: TOKENS[key].minFee.toString(),
              unit: TOKENS[key].unit,
            },
          ])
        ),
        call: {
          token: "sBTC",
          minFee: (PAID_CALL_MULTIPLE * MIN_CREDIT_FEE).toString(),
          unit: "sats",
          note: "A contract call paid in the same request: no deposit, no balance kept at Bolt.",
        },
        credit: {
          token: "sBTC",
          contract: `${BOLT_DEPLOYER}.${TOKENS.sbtc.boltContract}`,
          minFeePerCall: MIN_CREDIT_FEE.toString(),
          unit: "sats",
          note: "Prepaid credit is funded and spent in sBTC only. There is no USDCx credit; USDCx is supported by transfer.",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description(
    "Send sBTC or USDCx to a Stacks address with no STX: the fee is paid in the token itself, inside the same transaction. Requires an unlocked wallet."
  )
  .requiredOption("--token <token>", "sbtc or usdcx")
  .requiredOption("--recipient <address>", "Stacks address to send to")
  .requiredOption("--amount <units>", "Amount in the smallest unit: sats for sBTC, micro-USDCx for USDCx")
  .option("--fee <units>", "Fee paid to Bolt in the same token (default: the minimum, 10 sats or 100 micro-USDCx)")
  .option("--memo <text>", "Optional memo, up to 34 bytes")
  .action(async (opts: { token: string; recipient: string; amount: string; fee?: string; memo?: string }) => {
    try {
      requireMainnet();
      const key = opts.token.toLowerCase() as TokenKey;
      const token = TOKENS[key];
      if (!token) {
        throw new AibtcError("--token must be sbtc or usdcx", "BOLT_INVALID_ARGUMENT");
      }
      const amount = parseAmount(opts.amount, "--amount");
      const fee = opts.fee ? parseAmount(opts.fee, "--fee") : token.minFee;
      const sender = await getWalletAddress();

      const { result, nonce } = await signAndSend(
        {
          contractAddress: BOLT_DEPLOYER,
          contractName: token.boltContract,
          functionName: "transfer-stacks-to-stacks",
          functionArgs: [Cl.uint(amount), Cl.principal(opts.recipient), memoArg(opts.memo), Cl.uint(fee)],
          postConditions: [
            createFungiblePostCondition(sender, token.assetContract, token.assetName, "eq", amount + fee),
          ],
          postConditionMode: PostConditionMode.Deny,
        },
        (serializedTx) =>
          boltWrite<{ txid: string }>(
            `/v2/transaction/transfer?token=${key}`,
            { serializedTx },
            broadcastFromNonceRefusal
          )
      );

      printJson({
        success: true,
        txid: result.txid,
        from: sender,
        recipient: opts.recipient,
        token: token.symbol,
        amount: amount.toString(),
        fee: fee.toString(),
        unit: token.unit,
        nonce: nonce.toString(),
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

/** Both transactions Bolt already broadcast for this nonce, when a nonce refusal names them. */
function paidCallFromNonceRefusal(refusal: AibtcError): { txid: string; feeTxid: string } | undefined {
  const { txid, feeTxid } = (refusal.details ?? {}) as { txid?: unknown; feeTxid?: unknown };
  return refusal.code === "BOLT_INVALID_NONCE" && typeof txid === "string" && typeof feeTxid === "string"
    ? { txid, feeTxid }
    : undefined;
}

program
  .command("call")
  .description(
    "Call any contract without STX and without prepaid credit: the fee is paid in sBTC by a payment transaction sent in the same request. From 20 sats. Requires an unlocked wallet holding the fee in sBTC."
  )
  .requiredOption("--contract <contractId>", "Full contract ID in ADDRESS.contract-name format")
  .requiredOption("--function <functionName>", "Public function name to call")
  .option("--args <json>", 'Function arguments as JSON array. Typed: [{"type":"uint","value":100}]', "[]")
  .option("--post-condition-mode <mode>", "'deny' (default) blocks unexpected transfers; 'allow' permits any", "deny")
  .option("--post-conditions <json>", "Post conditions as JSON array (stx and ft). See SKILL.md for format.")
  .option("--fee <sats>", "Total to pay, in sats (default: the minimum, twice what the call costs on credit, from 20)")
  .action(
    async (opts: {
      contract: string;
      function: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      fee?: string;
    }) => {
      try {
        requireMainnet();
        const [contractAddress, contractName] = opts.contract.split(".");
        if (!contractAddress || !contractName) {
          throw new AibtcError("Provide --contract as ADDRESS.contract-name", "BOLT_INVALID_ARGUMENT");
        }
        if (contractAddress === BOLT_DEPLOYER && contractName.startsWith("boltproto-")) {
          throw new AibtcError(
            "Bolt's own contracts cannot be called this way",
            "BOLT_INVALID_ARGUMENT",
            undefined,
            "Use the transfer subcommand.",
            BOLT_DOCS
          );
        }
        const spec: CallSpec = {
          contractAddress,
          contractName,
          functionName: opts.function,
          functionArgs: parseJsonArray(opts.args, "--args").map(parseArgToClarityValue),
          postConditions: opts.postConditions
            ? parseJsonArray(opts.postConditions, "--post-conditions").map(parsePostCondition)
            : [],
          postConditionMode: opts.postConditionMode === "allow" ? PostConditionMode.Allow : PostConditionMode.Deny,
        };
        const chosenFee = opts.fee ? parseAmount(opts.fee, "--fee") : undefined;
        const sender = await getWalletAddress();

        // The payment takes the next nonce and the call the one after it: Bolt
        // broadcasts them in that order.
        const send = async (nonce: bigint, fee: bigint | undefined) => {
          const call = await signSponsored(spec, nonce + 1n);
          const total = fee ?? PAID_CALL_MULTIPLE * minCreditFee(call.serializedTx);
          const payment = await signSponsored(
            {
              contractAddress: BOLT_DEPLOYER,
              contractName: TOKENS.sbtc.boltContract,
              functionName: "pay-fee",
              functionArgs: [Cl.uint(total)],
              postConditions: [
                createFungiblePostCondition(sender, TOKENS.sbtc.assetContract, TOKENS.sbtc.assetName, "eq", total),
              ],
              postConditionMode: PostConditionMode.Deny,
            },
            nonce
          );
          const result = await boltWrite<{ txid: string; feeTxid: string }>(
            "/v2/transaction/call?token=sbtc",
            { feeTx: payment.serializedTx, serializedTx: call.serializedTx },
            paidCallFromNonceRefusal
          );
          return { result, nonce, total };
        };

        // One correction, as elsewhere: the nonce Bolt names, or (when the
        // caller did not choose the fee) the minimum it names.
        let nonce = await nextNonce(sender);
        let sent: Awaited<ReturnType<typeof send>>;
        try {
          sent = await send(nonce, chosenFee);
        } catch (error) {
          const retryNonce = nonceFromRefusal(error);
          const minimum = chosenFee === undefined ? minimumFeeFromRefusal(error) : undefined;
          if (retryNonce === undefined && minimum === undefined) throw error;
          nonce = retryNonce ?? nonce;
          sent = await send(nonce, minimum ?? chosenFee);
        }

        printJson({
          success: true,
          txid: sent.result.txid,
          feeTxid: sent.result.feeTxid,
          contract: opts.contract,
          function: opts.function,
          feePaid: sent.total.toString(),
          unit: "sats",
          nonce: (sent.nonce + 1n).toString(),
          feeNonce: sent.nonce.toString(),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(sent.result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// credit-balance
// ---------------------------------------------------------------------------

program
  .command("credit-balance")
  .description(
    "Read the prepaid gas credit of an address, in sats. Run it after a credit-deposit confirms; the credit is available after that."
  )
  .option("--address <address>", "Stacks address to check (uses active wallet if omitted)")
  .action(async (opts: { address?: string }) => {
    try {
      requireMainnet();
      const address = opts.address ?? (await getWalletAddress());
      const result = await boltRequest<{ balance: string }>(`/v1/sponsor/${CREDIT_TOKEN}/balance/${address}`);
      const balance = BigInt(result.balance);
      printJson({
        address,
        network: NETWORK,
        credit: { sats: balance.toString(), callsAtMinimumFee: (balance / MIN_CREDIT_FEE).toString() },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// credit-deposit
// ---------------------------------------------------------------------------

program
  .command("credit-deposit")
  .description(
    "Deposit sBTC as prepaid gas credit (sBTC only; there is no USDCx credit). The deposit is itself gasless. Unused credit can be taken back with credit-withdraw. Requires an unlocked wallet."
  )
  .requiredOption("--amount <sats>", "Credit to add, in sats")
  .option("--fee <sats>", "Fee for the deposit itself, in sats (default: 10)")
  .action(async (opts: { amount: string; fee?: string }) => {
    try {
      requireMainnet();
      const amount = parseAmount(opts.amount, "--amount");
      const fee = opts.fee ? parseAmount(opts.fee, "--fee") : TOKENS.sbtc.minFee;
      const sender = await getWalletAddress();

      const { result, nonce } = await signAndSend(
        {
          contractAddress: BOLT_DEPLOYER,
          contractName: TOKENS.sbtc.boltContract,
          functionName: "deposit-fee-fund",
          functionArgs: [Cl.uint(amount), Cl.uint(fee)],
          postConditions: [
            createFungiblePostCondition(sender, TOKENS.sbtc.assetContract, TOKENS.sbtc.assetName, "eq", amount + fee),
          ],
          postConditionMode: PostConditionMode.Deny,
        },
        (serializedTx) =>
          boltWrite<{ txid: string }>(
            `/v1/transaction/${CREDIT_TOKEN}`,
            { serializedTx },
            broadcastFromNonceRefusal
          )
      );

      printJson({
        success: true,
        txid: result.txid,
        address: sender,
        creditAdded: amount.toString(),
        fee: fee.toString(),
        unit: "sats",
        nonce: nonce.toString(),
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        next: "Wait for the transaction to confirm, then run credit-balance. The credit is available after that.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// credit-withdraw
// ---------------------------------------------------------------------------

program
  .command("credit-withdraw")
  .description(
    "Take unused prepaid credit back as sBTC, to the wallet that owns it. Bolt keeps a 10-sat fee and sends the rest. Needs no STX. Requires an unlocked wallet."
  )
  .requiredOption("--amount <sats>", "Credit to withdraw, in sats (more than the 10-sat fee)")
  .action(async (opts: { amount: string }) => {
    try {
      requireMainnet();
      const amount = parseAmount(opts.amount, "--amount");
      const account = await getAccount();
      const signedAt = new Date().toISOString();
      // Bolt pays the credit back to the address that signed this text, and to no other.
      const message = `Bolt credit withdrawal | ${account.address} | ${amount} | ${signedAt}`;
      const signature = signMessageHashRsv({
        messageHash: bytesToHex(hashMessage(message)),
        privateKey: account.privateKey,
      });
      const result = await boltWrite<{ txid: string; amount: string; fee?: number; received?: string }>(
        `/v1/sponsor/${CREDIT_TOKEN}/withdraw`,
        { address: account.address, amount: amount.toString(), signedAt, signature },
        // The repeat of a request Bolt already paid names its payout, not the split.
        (refusal) => {
          const { withdrawal, txid } = (refusal.details ?? {}) as { withdrawal?: unknown; txid?: unknown };
          const paid = withdrawal === "sent" || withdrawal === "confirmed";
          return refusal.code === "BOLT_WITHDRAWAL_REPEATED" && paid && typeof txid === "string"
            ? { txid, amount: amount.toString() }
            : undefined;
        }
      );
      printJson({
        success: true,
        txid: result.txid,
        address: account.address,
        creditWithdrawn: String(result.amount),
        ...(result.fee !== undefined && { fee: String(result.fee) }),
        ...(result.received !== undefined && { received: String(result.received) }),
        unit: "sats",
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// sponsor-call
// ---------------------------------------------------------------------------

program
  .command("sponsor-call")
  .description(
    "Have Bolt sponsor any contract call, paid from prepaid sBTC credit. Pass --contract/--function/--args to build and sign it here, or --serialized-tx for one this wallet already signed as sponsored. Requires an unlocked wallet."
  )
  .option("--contract <contractId>", "Full contract ID in ADDRESS.contract-name format")
  .option("--function <functionName>", "Public function name to call")
  .option("--args <json>", 'Function arguments as JSON array. Typed: [{"type":"uint","value":100}]', "[]")
  .option("--post-condition-mode <mode>", "'deny' (default) blocks unexpected transfers; 'allow' permits any", "deny")
  .option("--post-conditions <json>", "Post conditions as JSON array (stx and ft). See SKILL.md for format.")
  .option("--serialized-tx <hex>", "Hex of a contract call already signed with sponsored: true and fee 0")
  .option("--fee <sats>", "Credit to spend on this call, in sats (default: the minimum for its size, from 10)")
  .action(
    async (opts: {
      contract?: string;
      function?: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      serializedTx?: string;
      fee?: string;
    }) => {
      try {
        requireMainnet();
        const chosenFee = opts.fee ? parseAmount(opts.fee, "--fee") : undefined;
        let fee = chosenFee;

        // The fee is not inside the signed transaction, so the wallet that signed
        // it also signs the fee for it: nobody else can choose what the call costs.
        const post = async (serializedTx: string) => {
          const account = await getAccount();
          const sha256 = createHash("sha256").update(Buffer.from(serializedTx, "hex")).digest("hex");
          const feeSignature = signMessageHashRsv({
            messageHash: bytesToHex(hashMessage(`Bolt credit call | ${sha256} | ${fee}`)),
            privateKey: account.privateKey,
          });
          return boltWrite<{ txid: string }>(
            `/v1/sponsor/${CREDIT_TOKEN}/transaction`,
            { serializedTx, fee: fee!.toString(), feeSignature },
            broadcastFromNonceRefusal
          );
        };
        // Without --fee the command pays the minimum, so when Bolt names a
        // higher one it pays that instead, once. A fee the caller chose stands.
        const send = async (serializedTx: string) => {
          fee ??= minCreditFee(serializedTx);
          try {
            return await post(serializedTx);
          } catch (error) {
            const minimum = chosenFee === undefined ? minimumFeeFromRefusal(error) : undefined;
            if (minimum === undefined || minimum <= fee) throw error;
            fee = minimum;
            return post(serializedTx);
          }
        };

        let result: { txid: string };
        let nonce: string | undefined;
        if (opts.serializedTx) {
          if (opts.contract || opts.function) {
            throw new AibtcError(
              "Use either --serialized-tx or --contract/--function, not both",
              "BOLT_INVALID_ARGUMENT"
            );
          }
          result = await send(opts.serializedTx.replace(/^0x/, ""));
        } else {
          const [contractAddress, contractName] = (opts.contract ?? "").split(".");
          if (!contractAddress || !contractName || !opts.function) {
            throw new AibtcError(
              "Provide --contract ADDRESS.contract-name and --function, or --serialized-tx",
              "BOLT_INVALID_ARGUMENT"
            );
          }
          const sent = await signAndSend(
            {
              contractAddress,
              contractName,
              functionName: opts.function,
              functionArgs: parseJsonArray(opts.args, "--args").map(parseArgToClarityValue),
              postConditions: opts.postConditions
                ? parseJsonArray(opts.postConditions, "--post-conditions").map(parsePostCondition)
                : [],
              postConditionMode:
                opts.postConditionMode === "allow" ? PostConditionMode.Allow : PostConditionMode.Deny,
            },
            send
          );
          result = sent.result;
          nonce = sent.nonce.toString();
        }

        printJson({
          success: true,
          txid: result.txid,
          ...(opts.contract && { contract: opts.contract, function: opts.function }),
          creditSpent: fee!.toString(),
          unit: "sats",
          ...(nonce !== undefined && { nonce }),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

program.parse(process.argv);
