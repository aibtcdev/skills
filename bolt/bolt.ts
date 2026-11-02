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
  deserializeTransaction,
  validateStacksAddress,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { hashMessage } from "@stacks/encryption";
import { bytesToHex } from "@stacks/common";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { advanceNonce } from "../src/lib/services/nonce-tracker.js";
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
/** How long one request to Bolt may take before it counts as unanswered. */
const BOLT_TIMEOUT_MS = 30_000;
/** Without --max-fee the fee follows a higher minimum from Bolt up to this multiple of the first fee. */
const DEFAULT_MAX_FEE_MULTIPLE = 10n;

/** Path segment the v1 credit routes use for the sBTC credit ledger. */
const CREDIT_TOKEN = "sbtc-token";
/** Smallest fee Bolt accepts for a credit-sponsored call, in sats. */
const MIN_CREDIT_FEE = 10n;
/** Above 500 bytes the minimum grows by 1 sat per 50 bytes of transaction. */
const CREDIT_BYTES_PER_SAT = 50n;

export function minCreditFee(serializedTx: string): bigint {
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
    minFee: 10_000n,
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

/** A mainnet address (SP... or SM...), optionally followed by .contract-name when `contract` is true. */
export function assertMainnetPrincipal(value: string, flag: string, contract = false): void {
  const [address = "", name, ...rest] = value.split(".");
  // validateStacksAddress checks the c32 checksum (any length, testnet too): the SP/SM prefix keeps it to mainnet.
  // The contract name only has to be present: Clarity allows `_`, and the network checks the rest.
  const addressOk = /^S[PM]/.test(address) && validateStacksAddress(address);
  const ok = name === undefined ? addressOk : contract && rest.length === 0 && addressOk && name.length > 0;
  if (!ok) {
    throw new AibtcError(
      `${flag} must be a mainnet Stacks ${contract ? "address or contract principal" : "address"} (SP… or SM…)`,
      "BOLT_INVALID_ARGUMENT",
      { [flag]: value }
    );
  }
}

/** `--post-condition-mode`: allow or deny, in any case. */
export function parsePostConditionMode(value: string): PostConditionMode {
  switch (value.toLowerCase()) {
    case "allow":
      return PostConditionMode.Allow;
    case "deny":
      return PostConditionMode.Deny;
    default:
      throw new AibtcError("--post-condition-mode must be allow or deny", "BOLT_INVALID_ARGUMENT", {
        "--post-condition-mode": value,
      });
  }
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
    "Nothing was charged. The network refused the transaction; the message names its reason: fix that, then run the command again.",
  BOLT_UNRECOGNIZED:
    "Bolt's answer was not recognised, so the outcome is unknown and so is whether anything was charged. Check the address's recent transactions with the query skill and credit-balance or credit-ledger before running the command again.",
  BOLT_TEMPORARILY_UNAVAILABLE: "Nothing was charged. Try again later.",
  BOLT_INVALID_NONCE:
    "A transaction with this nonce from this address is pending or already used. Wait for the address's pending transactions to confirm, then run the command again.",
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
  [/Invalid nonce/i, "BOLT_INVALID_NONCE"],
  [/Insufficient sponsor credit/i, "BOLT_INSUFFICIENT_CREDIT"],
  [/not sponsored on credit/i, "BOLT_CONTRACT_NOT_ON_CREDIT"],
  [/minimum required fee/i, "BOLT_FEE_TOO_LOW"],
  [/Insufficient .*balance/i, "BOLT_INSUFFICIENT_BALANCE"],
  [
    /serializedTx|not sponsored$|Only contract calls|signature|Invalid fee|not allowed|not supported|Post condition|too large/i,
    "BOLT_INVALID_TRANSACTION",
  ],
  // Last: "Try again" and "Nothing was charged" also close the specific refusals above.
  [/Try again|Nothing was charged/i, "BOLT_TEMPORARILY_UNAVAILABLE"],
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
export function boltError(status: number, message: string, body: BoltErrorBody = {}): AibtcError {
  const known =
    (body.code !== undefined ? BY_BOLT_CODE[body.code] : undefined) ??
    BY_MESSAGE.find(([pattern]) => pattern.test(message))?.[1] ??
    (body.code !== undefined ? BY_BROAD_BOLT_CODE[body.code] : undefined) ??
    (status === 429 ? "BOLT_RATE_LIMITED" : undefined);
  const code = known ?? "BOLT_UNRECOGNIZED";
  const details = {
    status,
    ...(body.code !== undefined && { boltCode: body.code }),
    ...(body.txid !== undefined && { txid: body.txid }),
    ...(body.status !== undefined && { withdrawal: body.status }),
    ...(body.minimumFee !== undefined && { minimumFee: body.minimumFee }),
    ...(body.feeTxid !== undefined && { feeTxid: body.feeTxid }),
    ...(body.credit !== undefined && { credit: body.credit }),
  };
  let suggestion = SUGGESTIONS[code];
  if (code === "BOLT_WITHDRAWAL_REPEATED") {
    suggestion = repeatedWithdrawalSuggestion(body);
  } else if (/feeSignature/.test(message)) {
    suggestion =
      "Nothing was charged. The fee is signed by the wallet that signed the transaction: --serialized-tx takes only a transaction the active wallet signed.";
  }
  return new AibtcError(message, code, details, suggestion, BOLT_DOCS);
}

/** No answer from Bolt: timeout, dropped connection, or a reply that is not Bolt's (a proxy's error page). */
class BoltNoAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoltNoAnswer";
  }
}

/** Whether a parsed body looks like one of Bolt's own answers: a string `code` or a `message`. */
function isBoltBody(body: unknown): body is BoltErrorBody & { message?: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const { code, message } = body as { code?: unknown; message?: unknown };
  return typeof code === "string" || typeof message === "string" || Array.isArray(message);
}

/**
 * One request to Bolt. Throws BoltNoAnswer when there is no answer from Bolt,
 * and a mapped AibtcError when Bolt answered with a refusal (any status).
 */
async function boltRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${BOLT_API}${path}`, { ...init, signal: AbortSignal.timeout(BOLT_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    throw new BoltNoAnswer(`No answer from Bolt (${error instanceof Error ? error.message : String(error)})`);
  }
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    if (!isBoltBody(body)) {
      // A 4xx page that is not Bolt's JSON (a proxy or firewall refusing: 403, 413, 429...) never reached Bolt.
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        throw new AibtcError(
          `HTTP ${response.status} without a Bolt error body: a proxy or firewall answered. Nothing reached Bolt; nothing was sent or charged`,
          "BOLT_TEMPORARILY_UNAVAILABLE",
          { status: response.status },
          "Nothing was sent or charged. Try again later.",
          BOLT_DOCS
        );
      }
      // A 5xx page (a proxy's 502/504) or a 408 says nothing about whether Bolt got the request.
      throw new BoltNoAnswer(`Bolt answered HTTP ${response.status} without a Bolt error body`);
    }
    const { message: raw, reason } = body;
    const text = Array.isArray(raw)
      ? raw.join("; ")
      : typeof raw === "string"
        ? raw
        : `Bolt answered HTTP ${response.status}`;
    // A refused transfer names the network's reason in a field of its own.
    const message = typeof reason === "string" && !text.includes(reason) ? `${text} (${reason})` : text;
    throw boltError(response.status, message, body);
  }
  return body as T;
}

/** A read whose answer is unusable: nothing was sent, so nothing was charged. */
function unreadableAnswer(message: string, details?: Record<string, unknown>): AibtcError {
  return new AibtcError(
    `${message}. Nothing was sent or charged`,
    "BOLT_TEMPORARILY_UNAVAILABLE",
    details,
    "Nothing was sent or charged. Try again later.",
    BOLT_DOCS
  );
}

/**
 * A request that changes nothing (GET, or a check): no answer is a temporary
 * failure, and so is a 2xx whose body is not a JSON object.
 */
export async function boltRead<T extends object>(path: string, init?: RequestInit): Promise<T> {
  let answer: unknown;
  try {
    answer = await boltRequest<unknown>(path, init);
  } catch (error) {
    if (!(error instanceof BoltNoAnswer)) throw error;
    throw new AibtcError(
      `${error.message}. Nothing was sent or charged`,
      "BOLT_TEMPORARILY_UNAVAILABLE",
      undefined,
      "Nothing was sent or charged. Try again later.",
      BOLT_DOCS
    );
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw unreadableAnswer("Bolt answered success but the reply is empty or not a JSON object");
  }
  return answer as T;
}

function postInit(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function boltPost<T>(path: string, body: unknown): Promise<T> {
  return boltRequest<T>(path, postInit(body));
}

/** A POST that only asks (a check route): nothing is signed over, paid or broadcast, so reads' rules apply. */
export function boltCheck<T extends object>(path: string, body: unknown): Promise<T> {
  return boltRead<T>(path, postInit(body));
}

/** The advice every "may have gone out" error gives first. */
const CHECK_BEFORE_SIGNING_AGAIN =
  "Do not sign again: check the address's recent transactions with the query skill";

/** Who sent a write and with which nonce, so an unconfirmed one can be looked up. */
export interface WriteContext {
  sender: string;
  /** Nonce of the signed transaction (of the payment, for `call`). Absent for a withdrawal. */
  nonce?: bigint;
  /** The operation is on the credit ledger: `credit-ledger --nonce` can find it. */
  credit?: boolean;
}

/** The write may have reached Bolt, and nothing says whether it did. Never sign again. */
function sentUnconfirmed(
  ctx: WriteContext,
  message: string,
  extra: Record<string, unknown> = {},
  suggestion?: string
): AibtcError {
  const lookup = ctx.credit
    ? ctx.nonce !== undefined
      ? `, and credit-ledger --nonce ${ctx.nonce}`
      : ", and credit-ledger"
    : "";
  return new AibtcError(
    message,
    "BOLT_SENT_UNCONFIRMED",
    { sender: ctx.sender, ...(ctx.nonce !== undefined && { nonce: ctx.nonce.toString() }), ...extra },
    suggestion ??
      `Bolt may have received it. ${CHECK_BEFORE_SIGNING_AGAIN}${lookup} before running the command again.`,
    BOLT_DOCS
  );
}

type PostOutcome = { answer: unknown } | { refusal: AibtcError } | { noAnswer: BoltNoAnswer };

async function tryPost(path: string, body: unknown): Promise<PostOutcome> {
  try {
    return { answer: await boltPost<unknown>(path, body) };
  } catch (error) {
    if (error instanceof BoltNoAnswer) return { noAnswer: error };
    if (error instanceof AibtcError) return { refusal: error };
    throw error;
  }
}

/** The transactions Bolt already broadcast for this nonce, when a nonce refusal names them. */
function broadcastFromNonceRefusal(refusal: AibtcError): { txid: string; feeTxid?: string } | undefined {
  if (refusal.code !== "BOLT_INVALID_NONCE") return undefined;
  const { txid, feeTxid } = (refusal.details ?? {}) as { txid?: unknown; feeTxid?: unknown };
  if (typeof txid !== "string") return undefined;
  return { txid, ...(typeof feeTxid === "string" && { feeTxid }) };
}

/**
 * A nonce refusal turned into BOLT_SENT_UNCONFIRMED, never into BOLT_INVALID_NONCE
 * (that one may make signAndSend sign again): when it names the transaction Bolt
 * already broadcast, and when the first attempt got no answer and its nonce is now taken.
 */
function unconfirmedFromNonceRefusal(refusal: AibtcError, ctx: WriteContext, resent: boolean): AibtcError | undefined {
  if (refusal.code !== "BOLT_INVALID_NONCE") return undefined;
  const broadcast = broadcastFromNonceRefusal(refusal);
  if (broadcast) {
    return sentUnconfirmed(
      ctx,
      refusal.message,
      broadcast,
      `Bolt already broadcast a transaction with this nonce (txid ${broadcast.txid}). If it is this operation it is done; otherwise wait for it to confirm and run the command again.`
    );
  }
  if (!resent) return undefined;
  return sentUnconfirmed(
    ctx,
    refusal.message,
    {},
    `The first attempt got no answer and its nonce is now taken: it was most likely broadcast. ${CHECK_BEFORE_SIGNING_AGAIN} before running the command again.`
  );
}

/**
 * POST a signed write. When no answer arrives (timeout, dropped connection, a
 * reply that is not Bolt's) nobody knows whether Bolt received it, so the very
 * same body is sent once more: Bolt runs a signed request once, and the repeat
 * either goes through or says what became of the first. `recover` turns that
 * answer into the result of the first attempt when it names its transaction.
 * Still no answer, or a 2xx that does not name the transaction, is
 * BOLT_SENT_UNCONFIRMED.
 *
 * Never sign again here: a re-signed transaction carries a new nonce and would
 * run the operation a second time.
 *
 * Once the same body has been sent again, any refusal `recover` does not turn
 * into a result is BOLT_SENT_UNCONFIRMED too (details.refusal keeps its code and
 * message): the first attempt may have gone out.
 *
 * A txid in the result (answered or recovered) is recorded in the local nonce
 * tracker under `ctx.nonce`, when the write has one.
 */
export async function boltWrite<T extends { txid: string }>(
  path: string,
  body: unknown,
  ctx: WriteContext,
  recover?: (refusal: AibtcError) => T | undefined
): Promise<T> {
  const result = await postWrite(path, body, ctx, recover);
  await trackWrite(ctx, result);
  return result;
}

async function postWrite<T extends { txid: string }>(
  path: string,
  body: unknown,
  ctx: WriteContext,
  recover?: (refusal: AibtcError) => T | undefined
): Promise<T> {
  let outcome = await tryPost(path, body);
  const first = outcome;
  const resent = "noAnswer" in first;
  if (resent) {
    outcome = await tryPost(path, body);
    if ("noAnswer" in outcome) {
      throw sentUnconfirmed(
        ctx,
        `No answer from Bolt to the request (${first.noAnswer.message}) or to the same request sent again (${outcome.noAnswer.message})`
      );
    }
  }
  if ("refusal" in outcome) {
    const refusal = outcome.refusal;
    if (resent) {
      const recovered = recover?.(refusal);
      if (recovered !== undefined) return recovered;
    }
    const unconfirmed = unconfirmedFromNonceRefusal(refusal, ctx, resent);
    if (unconfirmed) throw unconfirmed;
    if (!resent) throw refusal;
    // The first attempt got no answer and may have been broadcast: whatever the repeat was refused for
    // (a rate limit, a balance the first attempt already spent...), the operation may be done.
    throw sentUnconfirmed(ctx, refusal.message, { refusal: { code: refusal.code, message: refusal.message } });
  }
  const answer = (outcome as { answer: unknown }).answer;
  if (typeof answer !== "object" || answer === null || typeof (answer as { txid?: unknown }).txid !== "string") {
    throw sentUnconfirmed(
      ctx,
      "Bolt answered success but the reply names no transaction (empty or not JSON), so whether it was sent is unknown"
    );
  }
  return answer as T;
}

/**
 * The nonce to sign with: Hiro's possible_next_nonce, nothing else. A local
 * tracker ahead of Hiro may hold nonces other processes took and never used,
 * which would leave a gap and stall every later transaction.
 */
export function nonceFromHiro(possibleNext: unknown): bigint {
  if (typeof possibleNext !== "number" || !Number.isSafeInteger(possibleNext) || possibleNext < 0) {
    throw new AibtcError(
      "Could not read the next nonce of the address",
      "BOLT_TEMPORARILY_UNAVAILABLE",
      undefined,
      "Nothing was sent. Try again later."
    );
  }
  return BigInt(possibleNext);
}

/** Next nonce for the account, counting its pending transactions. */
async function nextNonce(address: string): Promise<bigint> {
  const info = await getHiroApi(NETWORK).getNonceInfo(address);
  return nonceFromHiro(info.possible_next_nonce);
}

/**
 * Tell the local nonce tracker a nonce went out in a transaction Bolt broadcast
 * (not through acquireNonce), so other processes sharing it do not reuse it.
 * A tracker failure never fails the command.
 */
async function trackNonce(address: string, nonce: bigint, txid: string): Promise<void> {
  try {
    await advanceNonce(address, Number(nonce), txid);
  } catch {
    // Best effort: the next nonce is read from Hiro anyway.
  }
}

/**
 * Record what a write sent: `ctx.nonce` -> txid; a call paid in the same request
 * (it answers `feeTxid` too) sent the payment at that nonce and the call at the next.
 */
async function trackWrite(ctx: WriteContext, answer: { txid: string; feeTxid?: unknown }): Promise<void> {
  if (ctx.nonce === undefined) return;
  if (typeof answer.feeTxid === "string") {
    await trackNonce(ctx.sender, ctx.nonce, answer.feeTxid);
    await trackNonce(ctx.sender, ctx.nonce + 1n, answer.txid);
  } else {
    await trackNonce(ctx.sender, ctx.nonce, answer.txid);
  }
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

/**
 * The nonce to sign with instead, when Bolt's refusal names one. Never when the
 * refusal names a transaction Bolt already broadcast with that nonce.
 */
export function nonceFromRefusal(error: unknown): bigint | undefined {
  if (!(error instanceof AibtcError) || error.code !== "BOLT_INVALID_NONCE") return undefined;
  if (typeof (error.details as { txid?: unknown } | undefined)?.txid === "string") return undefined;
  const pending = error.message.match(/nonce (\d+) from \S+ is already pending/);
  if (pending) return BigInt(pending[1]) + 1n;
  const stale = error.message.match(/transaction has (\d+), the next nonce for \S+ is (\d+)/);
  if (stale && BigInt(stale[1]) < BigInt(stale[2])) return BigInt(stale[2]);
  return undefined;
}

/** The minimum fee to pay instead, when Bolt's refusal names one. */
export function minimumFeeFromRefusal(error: unknown): bigint | undefined {
  if (!(error instanceof AibtcError) || error.code !== "BOLT_FEE_TOO_LOW") return undefined;
  const fromBody = (error.details as { minimumFee?: unknown } | undefined)?.minimumFee;
  if (typeof fromBody === "number" && Number.isSafeInteger(fromBody)) return BigInt(fromBody);
  const minimum = error.message.match(/minimum required fee: (\d+)/);
  return minimum ? BigInt(minimum[1]) : undefined;
}

/**
 * Whether a fee refusal is worth one resend at the minimum Bolt names.
 * Returns the fee to resend with, or undefined to rethrow the refusal.
 * Throws BOLT_FEE_TOO_LOW when the minimum is above the ceiling (`maxFee`, or
 * 10 times `firstFee`). A fee the caller chose (`userFee`) is never changed.
 */
export function feeToResend(
  refusal: unknown,
  opts: { userFee: boolean; sentFee: bigint; firstFee: bigint; maxFee?: bigint }
): bigint | undefined {
  if (opts.userFee) return undefined;
  const minimum = minimumFeeFromRefusal(refusal);
  if (minimum === undefined || minimum <= opts.sentFee) return undefined;
  const maxFee = opts.maxFee ?? DEFAULT_MAX_FEE_MULTIPLE * opts.firstFee;
  if (minimum > maxFee) {
    throw new AibtcError(
      `Bolt's minimum fee ${minimum} is above the ceiling of ${maxFee}`,
      "BOLT_FEE_TOO_LOW",
      { minimumFee: Number(minimum), maxFee: Number(maxFee) },
      `Nothing was charged. Run again with --fee ${minimum} or a higher --max-fee.`,
      BOLT_DOCS
    );
  }
  return minimum;
}

/** `--max-fee` is the most the command may spend: a first fee above it is refused before anything is signed or sent. */
export function assertFirstFeeWithinMax(fee: bigint, maxFee: bigint | undefined): void {
  if (maxFee !== undefined && fee > maxFee) {
    throw new AibtcError(
      `fee ${fee} is above --max-fee ${maxFee}`,
      "BOLT_INVALID_ARGUMENT",
      { fee: fee.toString(), maxFee: maxFee.toString() },
      "Nothing was signed or sent. Raise --max-fee or lower --fee.",
      BOLT_DOCS
    );
  }
}

/** `--max-fee`, when given. */
function parseMaxFee(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : parseAmount(value, "--max-fee");
}

/**
 * Sign and send. With `autoResign` (routes whose nonce refusals name Bolt's own
 * broadcast, so a re-sign cannot repeat the operation) a refusal that names
 * another nonce is answered by signing again with it, once. Otherwise a nonce
 * refusal ends the command: the pending transaction may be an earlier attempt of
 * this same operation. `credit` marks the operation as one on the credit ledger
 * (the lookup hint of a BOLT_SENT_UNCONFIRMED). `sign` is injectable for tests.
 */
export async function signAndSend<T>(
  spec: CallSpec,
  send: (serializedTx: string, ctx: WriteContext) => Promise<T>,
  opts: { autoResign?: boolean; credit?: boolean; sign?: typeof signSponsored } = {}
): Promise<{ result: T; sender: string; nonce: bigint }> {
  const sign = opts.sign ?? signSponsored;
  const first = await sign(spec);
  const attempt = async (signed: { serializedTx: string; sender: string; nonce: bigint }) => ({
    result: await send(signed.serializedTx, { sender: signed.sender, nonce: signed.nonce, credit: opts.credit }),
    sender: signed.sender,
    nonce: signed.nonce,
  });
  try {
    return await attempt(first);
  } catch (error) {
    if (!(error instanceof AibtcError) || error.code !== "BOLT_INVALID_NONCE") throw error;
    if (!opts.autoResign) {
      throw new AibtcError(
        error.message,
        "BOLT_INVALID_NONCE",
        error.details,
        "A transaction with this nonce from this address is pending or already used, possibly an earlier attempt of this same payment. Check the address's recent transactions with the query skill and run the command again only if it is not there.",
        BOLT_DOCS
      );
    }
    const retryNonce = nonceFromRefusal(error);
    if (retryNonce === undefined) throw error;
    return attempt(await sign(spec, retryNonce));
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

/** A post condition amount: a string of digits or a non-negative safe integer. */
function postConditionAmount(amount: string | number): bigint {
  const ok = typeof amount === "string" ? /^\d+$/.test(amount) : Number.isSafeInteger(amount) && amount >= 0;
  if (!ok) {
    throw new AibtcError(
      "A post condition amount must be a non-negative integer (digits only)",
      "BOLT_INVALID_ARGUMENT",
      { amount }
    );
  }
  return BigInt(amount);
}

/** Post conditions in the same JSON shape the contract skill takes (stx, ft). */
export function parsePostCondition(pc: unknown): PostCondition {
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
    return createStxPostCondition(principal, conditionCode as Code, postConditionAmount(amount));
  }
  if (type === "ft" && typeof asset === "string" && typeof assetName === "string") {
    return createFungiblePostCondition(principal, asset, assetName, conditionCode as Code, postConditionAmount(amount));
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
      const health = await boltRead<{ status: string }>("/health");
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
  .option("--fee <units>", "Fee paid to Bolt in the same token (default: the minimum, 10 sats or 10,000 micro-USDCx)")
  .option("--memo <text>", "Optional memo, up to 34 bytes")
  .action(async (opts: { token: string; recipient: string; amount: string; fee?: string; memo?: string }) => {
    try {
      requireMainnet();
      const key = opts.token.toLowerCase() as TokenKey;
      const token = TOKENS[key];
      if (!token) {
        throw new AibtcError("--token must be sbtc or usdcx", "BOLT_INVALID_ARGUMENT");
      }
      assertMainnetPrincipal(opts.recipient, "--recipient", true);
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
        (serializedTx, ctx) => boltWrite<{ txid: string }>(`/v2/transaction/transfer?token=${key}`, { serializedTx }, ctx)
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
  const broadcast = broadcastFromNonceRefusal(refusal);
  return broadcast?.feeTxid === undefined ? undefined : { txid: broadcast.txid, feeTxid: broadcast.feeTxid };
}

/** The call on credit Bolt already broadcast for this nonce, when a nonce refusal names it. */
function creditCallFromNonceRefusal(refusal: AibtcError): { txid: string } | undefined {
  const broadcast = broadcastFromNonceRefusal(refusal);
  return broadcast && { txid: broadcast.txid };
}

/** One attempt of `call`: `result` when the pair was sent, `checked` when it was only checked. */
type PaidCallAttempt = { nonce: bigint; total: bigint } & (
  | { checked: { minimumFee?: number }; result?: undefined }
  | { result: { txid: string; feeTxid: string }; checked?: undefined }
);

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
  .option("--max-fee <sats>", "The most this command may pay: a higher first fee is refused, and so is a higher minimum from Bolt (default ceiling for the latter: 10 times the first fee)")
  .option("--check", "Ask Bolt whether it would accept this call, without sending it: nothing is paid or broadcast")
  .action(
    async (opts: {
      contract: string;
      function: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      fee?: string;
      maxFee?: string;
      check?: boolean;
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
          postConditionMode: parsePostConditionMode(opts.postConditionMode),
        };
        const chosenFee = opts.fee ? parseAmount(opts.fee, "--fee") : undefined;
        const maxFee = parseMaxFee(opts.maxFee);
        const sender = await getWalletAddress();

        // The payment takes the next nonce and the call the one after it: Bolt
        // broadcasts them in that order.
        let attemptedTotal = 0n;
        let firstTotal: bigint | undefined;
        const send = async (nonce: bigint, fee: bigint | undefined): Promise<PaidCallAttempt> => {
          const call = await signSponsored(spec, nonce + 1n);
          const total = fee ?? PAID_CALL_MULTIPLE * minCreditFee(call.serializedTx);
          if (firstTotal === undefined) assertFirstFeeWithinMax(total, maxFee);
          attemptedTotal = total;
          firstTotal ??= total;
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
          const body = { feeTx: payment.serializedTx, serializedTx: call.serializedTx };
          if (opts.check) {
            // Same checks as the request, up to the point where the payment would go out.
            const checked = await boltCheck<{ minimumFee?: number }>("/v2/transaction/call/check?token=sbtc", body);
            return { checked, nonce, total };
          }
          const result = await boltWrite<{ txid: string; feeTxid: string }>(
            "/v2/transaction/call?token=sbtc",
            body,
            { sender, nonce, credit: true },
            paidCallFromNonceRefusal
          );
          return { result, nonce, total };
        };

        // One correction, as elsewhere: the nonce Bolt names, or (when the
        // caller did not choose the fee) the minimum it names, within the ceiling.
        let nonce = await nextNonce(sender);
        let sent: PaidCallAttempt;
        try {
          sent = await send(nonce, chosenFee);
        } catch (error) {
          // Bolt's nonce here is the payment's: it refers to the first of the two transactions.
          const retryNonce = nonceFromRefusal(error);
          const minimum = feeToResend(error, {
            userFee: chosenFee !== undefined,
            sentFee: attemptedTotal,
            firstFee: firstTotal ?? attemptedTotal,
            maxFee,
          });
          if (retryNonce === undefined && minimum === undefined) throw error;
          nonce = retryNonce ?? nonce;
          sent = await send(nonce, minimum ?? chosenFee);
        }

        if (sent.checked) {
          printJson({
            success: true,
            checked: true,
            sent: false,
            contract: opts.contract,
            function: opts.function,
            fee: sent.total.toString(),
            ...(sent.checked.minimumFee !== undefined && { minimumFee: String(sent.checked.minimumFee) }),
            unit: "sats",
            nonce: (sent.nonce + 1n).toString(),
            feeNonce: sent.nonce.toString(),
            network: NETWORK,
          });
          return;
        }

        const result = sent.result;
        printJson({
          success: true,
          txid: result.txid,
          feeTxid: result.feeTxid,
          contract: opts.contract,
          function: opts.function,
          feePaid: sent.total.toString(),
          unit: "sats",
          nonce: (sent.nonce + 1n).toString(),
          feeNonce: sent.nonce.toString(),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// credit-balance
// ---------------------------------------------------------------------------

/** The balance in a credit-balance answer; a missing or malformed one is an error, not a crash. */
export function parseCreditBalance(result: unknown): bigint {
  const raw = (result as { balance?: unknown } | undefined)?.balance;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw);
  throw new AibtcError(
    "Bolt's answer carries no valid credit balance. Nothing was sent or charged",
    "BOLT_TEMPORARILY_UNAVAILABLE",
    { balance: raw },
    "Nothing was sent or charged. Try again later.",
    BOLT_DOCS
  );
}

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
      assertMainnetPrincipal(address, "--address");
      const result = await boltRead<{ balance?: unknown }>(
        `/v1/sponsor/${CREDIT_TOKEN}/balance/${encodeURIComponent(address)}`
      );
      const balance = parseCreditBalance(result);
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
// credit-ledger
// ---------------------------------------------------------------------------

interface CreditLedgerEntry {
  type: "deposit" | "call" | "withdrawal" | "paid_call";
  amount: string;
  status: string;
  change?: string;
  txid?: string;
  feeTxid?: string;
  nonce?: number;
  at?: string;
}

program
  .command("credit-ledger")
  .description(
    "List what Bolt holds and did for an address, newest first: every credit deposit, sponsored call and withdrawal, and every call paid in the request, with its txid and what it did to the credit. Use --nonce or --hash to find a call whose answer was lost."
  )
  .option("--address <address>", "Stacks address to list (uses active wallet if omitted)")
  .option("--limit <n>", "Entries to return, 1 to 100 (default 50)")
  .option("--before <time>", "Only entries older than this ISO time: pass the `at` of the last entry to read on")
  .option("--nonce <n>", "Only the call signed with this nonce")
  .option("--hash <sha256>", "Only the call with these bytes: the SHA-256 of its serialized transaction, as hex")
  .action(async (opts: { address?: string; limit?: string; before?: string; nonce?: string; hash?: string }) => {
    try {
      requireMainnet();
      const address = opts.address ?? (await getWalletAddress());
      const invalid = (flag: string, expected: string) =>
        new AibtcError(`${flag} must be ${expected}`, "BOLT_INVALID_ARGUMENT");
      assertMainnetPrincipal(address, "--address");
      const query = new URLSearchParams();
      if (opts.limit !== undefined) {
        if (!/^([1-9]\d?|100)$/.test(opts.limit)) throw invalid("--limit", "an integer from 1 to 100");
        query.set("limit", opts.limit);
      }
      if (opts.before !== undefined) {
        const before = new Date(opts.before);
        if (Number.isNaN(before.getTime())) throw invalid("--before", "an ISO 8601 time");
        query.set("before", before.toISOString());
      }
      if (opts.nonce !== undefined) {
        if (!/^(0|[1-9]\d*)$/.test(opts.nonce)) throw invalid("--nonce", "a non-negative integer");
        query.set("nonce", opts.nonce);
      }
      if (opts.hash !== undefined) {
        const hash = opts.hash.replace(/^0x/, "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hash)) throw invalid("--hash", "64 hex characters");
        query.set("hash", hash);
      }
      const suffix = query.size > 0 ? `?${query}` : "";
      const result = await boltRead<{ balance: string; entries?: CreditLedgerEntry[] }>(
        `/v1/sponsor/${CREDIT_TOKEN}/ledger/${encodeURIComponent(address)}${suffix}`
      );
      if (!Array.isArray(result.entries)) {
        throw unreadableAnswer("Bolt's ledger answer carries no entries list");
      }
      printJson({
        address,
        network: NETWORK,
        credit: { sats: result.balance },
        entries: result.entries.map((entry) => ({
          ...entry,
          ...(entry.txid && { explorerUrl: getExplorerTxUrl(entry.txid, NETWORK) }),
          ...(entry.feeTxid && { feeExplorerUrl: getExplorerTxUrl(entry.feeTxid, NETWORK) }),
        })),
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
        (serializedTx, ctx) => boltWrite<{ txid: string }>(`/v1/transaction/${CREDIT_TOKEN}`, { serializedTx }, ctx)
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

/** The repeat of a request Bolt already paid names its payout, not the split. */
function paidWithdrawalFromRefusal(refusal: AibtcError, amount: bigint): { txid: string; amount: string } | undefined {
  const { withdrawal, txid } = (refusal.details ?? {}) as { withdrawal?: unknown; txid?: unknown };
  const paid = withdrawal === "sent" || withdrawal === "confirmed";
  return refusal.code === "BOLT_WITHDRAWAL_REPEATED" && paid && typeof txid === "string"
    ? { txid, amount: amount.toString() }
    : undefined;
}

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
        { sender: account.address, credit: true },
        (refusal) => paidWithdrawalFromRefusal(refusal, amount)
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

/** What Bolt answers to a call on credit: `txid` when sent, `minimumFee` when only checked. */
interface CreditCallAnswer {
  txid?: string;
  minimumFee?: number;
}

/** A call on credit is either sent (with its txid) or only checked. */
type CreditCallOutcome = { sent: CreditCallAnswer & { txid: string } } | { checked: CreditCallAnswer };

/** The origin nonce of a signed transaction, or undefined when the hex does not decode. */
export function originNonce(serializedTx: string): bigint | undefined {
  try {
    const nonce = (deserializeTransaction(serializedTx).auth.spendingCondition as { nonce?: unknown }).nonce;
    return typeof nonce === "bigint" ? nonce : undefined;
  } catch {
    return undefined;
  }
}

program
  .command("sponsor-call")
  .description(
    "Have Bolt sponsor any contract call, paid from prepaid sBTC credit. Pass --contract/--function/--args to build and sign it here, or --serialized-tx for one this wallet already signed as sponsored. Add --check to learn whether Bolt would accept it, without sending. Requires an unlocked wallet."
  )
  .option("--contract <contractId>", "Full contract ID in ADDRESS.contract-name format")
  .option("--function <functionName>", "Public function name to call")
  .option("--args <json>", 'Function arguments as JSON array. Typed: [{"type":"uint","value":100}]', "[]")
  .option("--post-condition-mode <mode>", "'deny' (default) blocks unexpected transfers; 'allow' permits any", "deny")
  .option("--post-conditions <json>", "Post conditions as JSON array (stx and ft). See SKILL.md for format.")
  .option("--serialized-tx <hex>", "Hex of a contract call already signed with sponsored: true and fee 0")
  .option("--fee <sats>", "Credit to spend on this call, in sats (default: the minimum for its size, from 10)")
  .option("--max-fee <sats>", "The most this command may spend: a higher first fee is refused, and so is a higher minimum from Bolt (default ceiling for the latter: 10 times the first fee)")
  .option("--check", "Ask Bolt whether it would accept this call, without sending it: nothing is debited or broadcast")
  .action(
    async (opts: {
      contract?: string;
      function?: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      serializedTx?: string;
      fee?: string;
      maxFee?: string;
      check?: boolean;
    }) => {
      try {
        requireMainnet();
        const chosenFee = opts.fee ? parseAmount(opts.fee, "--fee") : undefined;
        const maxFee = parseMaxFee(opts.maxFee);
        let fee = chosenFee;
        let firstFee: bigint | undefined;

        // The fee is not inside the signed transaction, so the wallet that signed
        // it also signs the fee for it: nobody else can choose what the call costs.
        const post = async (serializedTx: string, ctx: WriteContext): Promise<CreditCallOutcome> => {
          const account = await getAccount();
          const sha256 = createHash("sha256").update(Buffer.from(serializedTx, "hex")).digest("hex");
          const feeSignature = signMessageHashRsv({
            messageHash: bytesToHex(hashMessage(`Bolt credit call | ${sha256} | ${fee}`)),
            privateKey: account.privateKey,
          });
          const body = { serializedTx, fee: fee!.toString(), feeSignature };
          if (opts.check) {
            // Same checks as the call, up to the point where it would be charged.
            return { checked: await boltCheck<CreditCallAnswer>(`/v1/sponsor/${CREDIT_TOKEN}/transaction/check`, body) };
          }
          return {
            sent: await boltWrite<CreditCallAnswer & { txid: string }>(
              `/v1/sponsor/${CREDIT_TOKEN}/transaction`,
              body,
              ctx,
              creditCallFromNonceRefusal
            ),
          };
        };
        // Without --fee the command pays the minimum, so when Bolt names a
        // higher one it pays that instead, once, up to the ceiling. A fee the
        // caller chose stands.
        const send = async (serializedTx: string, ctx: WriteContext) => {
          fee ??= minCreditFee(serializedTx);
          if (firstFee === undefined) assertFirstFeeWithinMax(fee, maxFee);
          firstFee ??= fee;
          try {
            return await post(serializedTx, ctx);
          } catch (error) {
            const minimum = feeToResend(error, { userFee: chosenFee !== undefined, sentFee: fee, firstFee, maxFee });
            if (minimum === undefined) throw error;
            fee = minimum;
            return post(serializedTx, ctx);
          }
        };

        let result: CreditCallOutcome;
        let nonce: string | undefined;
        if (opts.serializedTx) {
          if (opts.contract || opts.function) {
            throw new AibtcError(
              "Use either --serialized-tx or --contract/--function, not both",
              "BOLT_INVALID_ARGUMENT"
            );
          }
          const sender = await getWalletAddress();
          const serializedTx = opts.serializedTx.replace(/^0x/, "");
          // The nonce names the call in credit-ledger --nonce and in the tracker when the answer is lost.
          const signedNonce = originNonce(serializedTx);
          result = await send(serializedTx, { sender, credit: true, ...(signedNonce !== undefined && { nonce: signedNonce }) });
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
              postConditionMode: parsePostConditionMode(opts.postConditionMode),
            },
            send,
            { autoResign: true, credit: true }
          );
          result = sent.result;
          nonce = sent.nonce.toString();
        }

        if ("checked" in result) {
          printJson({
            success: true,
            checked: true,
            sent: false,
            ...(opts.contract && { contract: opts.contract, function: opts.function }),
            fee: fee!.toString(),
            ...(result.checked.minimumFee !== undefined && { minimumFee: String(result.checked.minimumFee) }),
            unit: "sats",
            ...(nonce !== undefined && { nonce }),
            network: NETWORK,
          });
          return;
        }

        const { sent: answer } = result;
        printJson({
          success: true,
          txid: answer.txid,
          ...(opts.contract && { contract: opts.contract, function: opts.function }),
          creditSpent: fee!.toString(),
          unit: "sats",
          ...(nonce !== undefined && { nonce }),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(answer.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

if (import.meta.main) program.parse(process.argv);
