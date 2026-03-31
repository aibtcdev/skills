/**
 * x402 Inbox Retry Logic
 *
 * Handles nonce conflicts, relay errors, and payment retry for send-inbox-message.
 * Ported from aibtc-mcp-server inbox.tools.ts (PR #415) to address the nonce
 * handling improvements described in landing-page#522.
 *
 * @see https://github.com/aibtcdev/landing-page/issues/522
 * @see https://github.com/aibtcdev/aibtc-mcp-server/issues/413
 */

import {
  makeContractCall,
  uintCV,
  principalCV,
  noneCV,
  someCV,
  bufferCV,
} from "@stacks/transactions";
import {
  encodePaymentPayload,
  decodePaymentResponse,
  generatePaymentId,
  buildPaymentIdentifierExtension,
  X402_HEADERS,
  type PaymentRequiredV2,
  type PaymentRequirementsV2,
} from "./x402-protocol.js";
import {
  extractTxidFromPaymentSignature,
  pollTransactionConfirmation,
} from "./x402-recovery.js";
import { getHiroApi } from "../services/hiro-api.js";
import {
  getTrackedNonce,
  recordNonceUsed,
  reconcileWithChain,
} from "../services/nonce-tracker.js";
import { type Network, getStacksNetwork, getExplorerTxUrl } from "../config/networks.js";
import { getContracts, parseContractId } from "../config/contracts.js";
import { createFungiblePostCondition } from "../transactions/post-conditions.js";

// ============================================================================
// Types
// ============================================================================

export interface RetryInfo {
  retryable: boolean;
  /** Delay in ms before next retry. Honors relay's retryAfter when present. */
  delayMs: number;
  /** Whether the error is a relay-side nonce conflict (safe to reuse same tx). */
  relaySideConflict: boolean;
}

export interface InboxSubmitResult {
  success: boolean;
  status: number;
  responseData: Record<string, unknown>;
  settlementTxid?: string;
  paymentId?: string;
  paymentStatus?: "confirmed" | "pending" | "failed";
  paymentSignature?: string;
  recovered?: boolean;
}

export interface InboxRetryOptions {
  inboxUrl: string;
  body: Record<string, unknown>;
  paymentRequired: PaymentRequiredV2;
  accept: PaymentRequirementsV2;
  account: { address: string; privateKey: string };
  network: Network;
  contentHash?: string;
  maxAttempts?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default delay when no retryAfter hint is provided. */
const DEFAULT_RETRY_DELAY_MS = 2_000;
/** Cap retryAfter to avoid blocking too long (seconds). */
const MAX_RETRY_AFTER_CAP_S = 60;
/** Inbox API base URL. */
const INBOX_BASE = "https://aibtc.com/api/inbox";

// ============================================================================
// Retry Classifier
// ============================================================================

/**
 * Classify a response as retryable and extract retry timing.
 *
 * Handles the error codes from landing-page#522:
 * - SENDER_NONCE_DUPLICATE: wait 30s, retry same tx
 * - SENDER_NONCE_STALE: re-fetch nonce, re-sign
 * - SENDER_NONCE_GAP: re-fetch nonce, re-sign
 * - NONCE_CONFLICT: relay-side, retry after Retry-After header
 * - 502/503: relay transient errors
 */
export function classifyRetryableError(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null
): RetryInfo {
  const NOT_RETRYABLE: RetryInfo = { retryable: false, delayMs: 0, relaySideConflict: false };

  // Duplicate-message 409 from the inbox API must NOT be retried —
  // the message was already delivered and retrying would re-pay.
  if (status === 409) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    if (/already exists|duplicate/i.test(bodyStr)) {
      return NOT_RETRYABLE;
    }
  }

  // Parse retryAfter from body or HTTP header
  let retryAfterMs = DEFAULT_RETRY_DELAY_MS;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const rawRetryAfter = typeof b["retryAfter"] === "number" ? b["retryAfter"] : 0;
    if (rawRetryAfter > 0) {
      retryAfterMs = Math.min(rawRetryAfter, MAX_RETRY_AFTER_CAP_S) * 1000;
    }
  }
  // HTTP Retry-After header (seconds) takes precedence if body didn't have one
  if (retryAfterHeader && retryAfterMs === DEFAULT_RETRY_DELAY_MS) {
    const headerSeconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(headerSeconds) && headerSeconds > 0) {
      retryAfterMs = Math.min(headerSeconds, MAX_RETRY_AFTER_CAP_S) * 1000;
    }
  }

  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;

    // New 409 codes from landing-page#522
    if (status === 409) {
      const code = b["code"] as string | undefined;

      // SENDER_NONCE_DUPLICATE: payment already in-flight, wait and retry same tx
      if (code === "SENDER_NONCE_DUPLICATE") {
        return { retryable: true, delayMs: 30_000, relaySideConflict: true };
      }

      // SENDER_NONCE_STALE: nonce already confirmed, need fresh nonce + re-sign
      if (code === "SENDER_NONCE_STALE") {
        return { retryable: true, delayMs: 0, relaySideConflict: false };
      }

      // SENDER_NONCE_GAP: nonce skips ahead, need fresh nonce + re-sign
      if (code === "SENDER_NONCE_GAP") {
        return { retryable: true, delayMs: 0, relaySideConflict: false };
      }

      // NONCE_CONFLICT: sponsor nonce collision, safe to resubmit same tx
      if (code === "NONCE_CONFLICT") {
        return { retryable: true, delayMs: retryAfterMs, relaySideConflict: true };
      }
    }

    // Relay returns retryable: true for SETTLEMENT_BROADCAST_FAILED
    if (b["retryable"] === true) {
      return { retryable: true, delayMs: retryAfterMs, relaySideConflict: false };
    }
  }

  // Sender-side nonce conflict from the Stacks node (not relay) — needs fresh tx.
  if (typeof body === "string") {
    if (body.includes("ConflictingNonceInMempool") || body.includes("BadNonce")) {
      return { retryable: true, delayMs: DEFAULT_RETRY_DELAY_MS, relaySideConflict: false };
    }
  }

  // 502/503 relay errors
  if (status === 502) {
    return { retryable: true, delayMs: 10_000, relaySideConflict: false };
  }
  if (status === 503) {
    return { retryable: true, delayMs: 60_000, relaySideConflict: false };
  }

  return NOT_RETRYABLE;
}

// ============================================================================
// Helpers
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next safe nonce for a sender address.
 * Checks shared nonce tracker first (no network), then reconciles with chain.
 */
async function getNextNonce(address: string, network: Network): Promise<number> {
  // 1. Check shared tracker (fast, no network)
  const localNext = await getTrackedNonce(address);

  // 2. Fetch chain state for reconciliation
  const hiroApi = getHiroApi(network);
  const accountInfo = await hiroApi.getAccountInfo(address);
  const confirmedNonce = accountInfo.nonce;

  let highestMempoolNonce = -1;
  try {
    const mempool = await hiroApi.getMempoolTransactions({
      sender_address: address,
      limit: 50,
    });
    for (const tx of mempool.results) {
      if (tx.nonce > highestMempoolNonce) {
        highestMempoolNonce = tx.nonce;
      }
    }
  } catch {
    // Non-fatal: fall back to confirmed nonce only
  }

  const chainNext = Math.max(confirmedNonce, highestMempoolNonce + 1);

  // 3. Reconcile tracker with chain state
  await reconcileWithChain(address, chainNext);

  // 4. Return max(chain, local) — same logic as MCP server
  return Math.max(chainNext, localNext ?? 0);
}

/**
 * Record that we used a nonce so subsequent calls use a higher value.
 */
async function advanceNonceCache(address: string, usedNonce: number, txid = ""): Promise<void> {
  await recordNonceUsed(address, usedNonce, txid);
}

export function extractInboxPaymentMetadata(responseData: Record<string, unknown>): {
  paymentId?: string;
  paymentStatus?: "confirmed" | "pending" | "failed";
} {
  const inbox = responseData["inbox"];
  if (!inbox || typeof inbox !== "object" || Array.isArray(inbox)) {
    return {};
  }

  const inboxRecord = inbox as Record<string, unknown>;

  const paymentId =
    typeof inboxRecord["paymentId"] === "string" && inboxRecord["paymentId"].length > 0
      ? inboxRecord["paymentId"]
      : undefined;
  const paymentStatus = inboxRecord["paymentStatus"];

  return {
    paymentId,
    paymentStatus:
      paymentStatus === "confirmed" ||
      paymentStatus === "pending" ||
      paymentStatus === "failed"
        ? paymentStatus
        : undefined,
  };
}

export function resolveInboxPaymentTracking(
  responseData: Record<string, unknown>,
  fallbackPaymentId: string,
  settlementTxid?: string
): {
  paymentId?: string;
  paymentStatus?: "confirmed" | "pending" | "failed";
  nonceReference: string;
} {
  const { paymentId: inboxPaymentId, paymentStatus: inboxPaymentStatus } =
    extractInboxPaymentMetadata(responseData);
  const paymentId = inboxPaymentId ?? fallbackPaymentId;

  return {
    paymentId,
    paymentStatus: inboxPaymentStatus,
    // The nonce tracker stores either the confirmed settlement txid or a synthetic
    // pending:<paymentId> reference until the relay returns a real txid.
    nonceReference:
      settlementTxid ??
      (inboxPaymentStatus === "pending" && paymentId ? `pending:${paymentId}` : ""),
  };
}

/**
 * Build a sponsored sBTC transfer transaction (signed, not broadcast).
 * Explicit nonce avoids ConflictingNonceInMempool.
 */
async function buildSponsoredSbtcTransfer(
  senderKey: string,
  senderAddress: string,
  recipient: string,
  amount: bigint,
  nonce: bigint,
  network: Network,
  memo?: string
): Promise<string> {
  const contracts = getContracts(network);
  const { address: contractAddress, name: contractName } = parseContractId(
    contracts.SBTC_TOKEN
  );
  const networkName = getStacksNetwork(network);

  const postCondition = createFungiblePostCondition(
    senderAddress,
    contracts.SBTC_TOKEN,
    "sbtc-token",
    "eq",
    amount
  );

  // Encode memo as (optional (buff 34)): some(buff) if provided, none() otherwise.
  const memoArg = memo
    ? someCV(bufferCV(Buffer.from(memo).slice(0, 34)))
    : noneCV();

  const transaction = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "transfer",
    functionArgs: [
      uintCV(amount),
      principalCV(senderAddress),
      principalCV(recipient),
      memoArg,
    ],
    senderKey,
    network: networkName,
    postConditions: [postCondition],
    sponsored: true,
    fee: 0n,
    nonce,
  });

  // serialize() returns hex string (no 0x prefix) in @stacks/transactions v7+
  return "0x" + transaction.serialize();
}

/**
 * POST a message to the inbox using a confirmed txid as payment proof.
 * Used for auto-recovery after settlement failure when payment confirmed on-chain.
 */
async function submitWithPaymentTxid(
  recipientBtcAddress: string,
  recipientStxAddress: string,
  content: string,
  txid: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${INBOX_BASE}/${recipientBtcAddress}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      toBtcAddress: recipientBtcAddress,
      toStxAddress: recipientStxAddress,
      content,
      paymentTxid: txid,
    }),
  });
  const body = await res.text();
  const ok = res.status === 200 || res.status === 201 || res.status === 409;
  return { ok, status: res.status, body };
}

// ============================================================================
// Main Retry Loop
// ============================================================================

/**
 * Execute an inbox message send with full retry logic.
 *
 * Handles:
 * - 201 with paymentStatus: "pending" as success
 * - 409 SENDER_NONCE_DUPLICATE: wait 30s, retry same signed tx
 * - 409 SENDER_NONCE_STALE/GAP: re-fetch nonce, re-sign, resubmit
 * - 409 NONCE_CONFLICT: retry after Retry-After header
 * - 502/503: retry with backoff (10s/60s)
 * - Auto-recovery: polls relay txids after max retries
 *
 * @see https://github.com/aibtcdev/landing-page/issues/522
 */
export async function executeInboxWithRetry(
  options: InboxRetryOptions
): Promise<InboxSubmitResult> {
  const {
    inboxUrl,
    body,
    paymentRequired,
    accept,
    account,
    network,
    contentHash,
    maxAttempts = 3,
  } = options;

  const amount = BigInt(accept.amount);

  let lastError = "";
  let lastPaymentSignature: string | null = null;

  // Track relay txids across failed attempts for auto-recovery.
  const seenRelayTxids = new Set<string>();

  // Cache first attempt's tx + paymentId for reuse on relay-side conflicts.
  let cachedTxHex: string | null = null;
  let cachedPaymentId: string | null = null;
  let cachedNonce: number | null = null;
  let nextRetryDelayMs = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0 && nextRetryDelayMs > 0) {
      console.error(
        `[x402-retry] Retry attempt ${attempt}/${maxAttempts - 1} after ${nextRetryDelayMs}ms`
      );
      await sleep(nextRetryDelayMs);
    }

    // Build or reuse transaction
    let nonce: number;
    let txHex: string;
    let paymentId: string;

    if (cachedTxHex && cachedPaymentId && cachedNonce !== null) {
      // Relay-side conflict: resubmit the same tx for dedup
      nonce = cachedNonce;
      txHex = cachedTxHex;
      paymentId = cachedPaymentId;
      console.error(
        `[x402-retry] Reusing cached tx (nonce=${nonce}) for relay-side dedup`
      );
    } else {
      // Fresh tx: sender-side conflict or first attempt
      nonce = await getNextNonce(account.address, network);
      txHex = await buildSponsoredSbtcTransfer(
        account.privateKey,
        account.address,
        accept.payTo,
        amount,
        BigInt(nonce),
        network,
        contentHash
      );
      paymentId = generatePaymentId();

      // Cache for potential reuse on relay-side conflicts
      cachedTxHex = txHex;
      cachedPaymentId = paymentId;
      cachedNonce = nonce;
    }

    // Encode PaymentPayloadV2 with payment-identifier extension
    const paymentSignature = encodePaymentPayload({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: accept,
      payload: { transaction: txHex },
      extensions: buildPaymentIdentifierExtension(paymentId),
    });
    lastPaymentSignature = paymentSignature;

    // Send with payment header
    const finalRes = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
      },
      body: JSON.stringify(body),
    });

    const responseData = await finalRes.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(responseData);
    } catch {
      parsed = { raw: responseData };
    }

    // Success: 200/201 (paymentStatus "pending" counts as success per landing-page#522)
    if (finalRes.status === 201 || finalRes.status === 200) {
      const settlement = decodePaymentResponse(
        finalRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE)
      );
      const txid = settlement?.transaction;
      const {
        paymentId: resolvedPaymentId,
        paymentStatus: inboxPaymentStatus,
        nonceReference,
      } = resolveInboxPaymentTracking(parsed, paymentId, txid);

      // Advance shared nonce tracker on success
      await advanceNonceCache(account.address, nonce, nonceReference);

      return {
        success: true,
        status: finalRes.status,
        responseData: parsed,
        settlementTxid: txid ?? undefined,
        paymentId: resolvedPaymentId,
        paymentStatus: inboxPaymentStatus,
        paymentSignature,
      };
    }

    // Extract relay txid from payment-response header (forwarded even on failure)
    const failedTxid = decodePaymentResponse(
      finalRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE)
    )?.transaction;
    if (failedTxid && seenRelayTxids.has(failedTxid)) {
      console.error(
        `[x402-retry] Stale dedup: relay returned previously-seen txid ${failedTxid} on attempt ${attempt + 1}`
      );
    } else if (failedTxid) {
      seenRelayTxids.add(failedTxid);
    }

    // Classify the error and extract retry timing
    const retryAfterHeader = finalRes.headers.get("retry-after");
    const retry = classifyRetryableError(finalRes.status, parsed, retryAfterHeader);

    if (retry.retryable && attempt < maxAttempts - 1) {
      console.error(
        `[x402-retry] Retryable error on attempt ${attempt + 1}: status=${finalRes.status} relaySide=${retry.relaySideConflict} delayMs=${retry.delayMs} body=${responseData}`
      );

      nextRetryDelayMs = retry.delayMs;

      if (retry.relaySideConflict) {
        // Keep cached tx/paymentId — relay will dedup on resubmit
      } else {
        // Sender-side conflict: need a fresh tx with new nonce
        cachedTxHex = null;
        cachedPaymentId = null;
        cachedNonce = null;
        // Advance nonce cache so the next attempt uses a strictly higher nonce
        await advanceNonceCache(account.address, nonce);
      }

      lastError = `${finalRes.status}: ${responseData}`;
      continue;
    }

    // Non-retryable or last attempt — build error with txid recovery info
    const txid = lastPaymentSignature
      ? extractTxidFromPaymentSignature(lastPaymentSignature)
      : null;

    const errorBase = `Message delivery failed (${finalRes.status}): ${responseData}`;
    if (txid && !retry.retryable) {
      const confirmation = await pollTransactionConfirmation(txid, network);
      throw new Error(
        `${errorBase}\n\nPayment transaction was submitted but settlement failed. ` +
        `Transaction recovery info:\n  txid: ${confirmation.txid}\n  status: ${confirmation.status}\n  explorer: ${confirmation.explorer}`
      );
    }

    lastError = `${finalRes.status}: ${responseData}`;
  }

  // Retries exhausted -- check if any relay txid confirmed on-chain and
  // resubmit with the confirmed txid as payment proof (auto-recovery).
  if (seenRelayTxids.size > 0) {
    const recipientBtcAddress = body["toBtcAddress"] as string;
    const recipientStxAddress = body["toStxAddress"] as string;
    const content = body["content"] as string;

    console.error(
      `[x402-retry] Checking on-chain status of ${seenRelayTxids.size} seen txid(s) before giving up.`
    );
    for (const seenTxid of seenRelayTxids) {
      try {
        const confirmation = await pollTransactionConfirmation(seenTxid, network, 5_000);
        if (confirmation.status !== "success" && confirmation.status !== "confirmed") {
          continue;
        }
        console.error(
          `[x402-retry] Auto-recovery: txid ${seenTxid} confirmed on-chain. Resubmitting.`
        );
        const result = await submitWithPaymentTxid(
          recipientBtcAddress, recipientStxAddress, content, seenTxid
        );
        if (result.ok) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(result.body);
          } catch {
            parsed = { raw: result.body };
          }
          return {
            success: true,
            status: result.status,
            responseData: parsed,
            settlementTxid: seenTxid,
            recovered: true,
          };
        }
        console.error(
          `[x402-retry] Auto-recovery resubmission failed for txid ${seenTxid}: ${result.status} ${result.body}`
        );
      } catch {
        // Non-fatal: move on to the next txid
      }
    }
  }

  // Include all seen txids in the error for diagnostics
  const txidSummary = seenRelayTxids.size > 0
    ? `\n\nSeen relay txids (all failed or pending):\n${[...seenRelayTxids].map((id) => `  ${id}`).join("\n")}`
    : "";

  throw new Error(
    `Message delivery failed after ${maxAttempts} attempts. Last error: ${lastError}${txidSummary}`
  );
}
