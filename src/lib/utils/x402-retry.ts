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
  generatePaymentIdentifier,
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
import {
  classifyCanonicalPaymentOutcome,
  extractCanonicalPaymentTrackingHint,
  fetchCanonicalPaymentStatus,
  isInFlightPaymentStatus,
  normalizeCallerFacingPaymentStatus,
  resolveCanonicalCheckStatusUrl,
  type CanonicalPaymentAction,
} from "../services/x402.service.js";
import { type Network, getInboxBase, getStacksNetwork } from "../config/networks.js";
import { getContracts, parseContractId } from "../config/contracts.js";
import {
  emitPaymentDiagnostic,
  usedCallerFacingCompatShim,
} from "./x402-diagnostics.js";
import { createFungiblePostCondition } from "../transactions/post-conditions.js";
import type { TrackedPaymentState } from "@aibtc/tx-schemas/core/enums";
import type { TerminalReason } from "@aibtc/tx-schemas/terminal-reasons";

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
  /**
   * Whether the payment flow was accepted by the relay. This is always `true`
   * when the result is returned (errors throw instead). It does NOT indicate
   * message delivery — use `messageDelivered` for delivery confirmation.
   */
  success: true;
  status: number;
  responseData: Record<string, unknown>;
  settlementTxid?: string;
  paymentId?: string;
  paymentStatus?: TrackedPaymentState;
  terminalReason?: TerminalReason;
  paymentAction?: CanonicalPaymentAction;
  checkUrl?: string;
  paymentSignature?: string;
  recovered?: boolean;
  messageDelivered?: boolean;
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
  diagnosticTool?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default delay when no retryAfter hint is provided. */
const DEFAULT_RETRY_DELAY_MS = 2_000;
/** Cap retryAfter to avoid blocking too long (seconds). */
const MAX_RETRY_AFTER_CAP_S = 60;
/** Keep retry-loop canonical polling bounded so a slow status endpoint does not stall retries. */
const RETRY_LOOP_CANONICAL_POLL_TIMEOUT_MS = 5_000;

// ============================================================================
// Retry Classifier
// ============================================================================

/**
 * Classify a response as retryable and extract retry timing.
 *
 * Handles legacy transport errors as a fallback when canonical payment-status
 * polling is unavailable:
 * - SENDER_NONCE_DUPLICATE: rebuild/re-sign with a fresh sender nonce
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
    const bodyCode =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>)["code"] : undefined;
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    if (!bodyCode && /already exists|duplicate/i.test(bodyStr)) {
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

      // Sender nonce duplicate is sender-owned recovery, not relay-side dedup.
      // Operational experience shows duplicates are always sender-originated
      // (stale local nonce cache), so delayMs=0 and relaySideConflict=false
      // is correct — the fix is a fresh sender nonce, not waiting on the relay.
      if (code === "SENDER_NONCE_DUPLICATE") {
        return { retryable: true, delayMs: 0, relaySideConflict: false };
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

function buildInboxSubmitResult(
  fields: Omit<InboxSubmitResult, "success">
): InboxSubmitResult {
  return {
    success: true,
    ...fields,
  };
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
  paymentStatus?: TrackedPaymentState;
  compatShimUsed?: boolean;
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
  const compatShimUsed = usedCallerFacingCompatShim(inboxRecord["paymentStatus"]);
  const paymentStatus = normalizeCallerFacingPaymentStatus(inboxRecord["paymentStatus"]);

  return {
    paymentId,
    paymentStatus,
    compatShimUsed,
  };
}

export function resolveInboxPaymentTracking(
  responseData: Record<string, unknown>,
  fallbackPaymentIdentifier: string,
  settlementTxid?: string
): {
  paymentId?: string;
  paymentStatus?: TrackedPaymentState;
  nonceReference: string;
  compatShimUsed: boolean;
} {
  const {
    paymentId: inboxPaymentId,
    paymentStatus: inboxPaymentStatus,
    compatShimUsed,
  } =
    extractInboxPaymentMetadata(responseData);
  const paymentId = inboxPaymentId ?? fallbackPaymentIdentifier;

  return {
    paymentId,
    paymentStatus: inboxPaymentStatus,
    // The nonce tracker stores either the confirmed settlement txid or a synthetic
    // pending:<paymentId> reference until the relay returns a real txid.
    nonceReference:
      settlementTxid ??
      (isInFlightPaymentStatus(inboxPaymentStatus) && paymentId
        ? `pending:${paymentId}`
        : ""),
    compatShimUsed: compatShimUsed ?? false,
  };
}

async function getCanonicalPaymentAssessment(
  paymentId: string,
  inboxUrl: string,
  checkStatusUrl?: string
): Promise<{
  paymentStatus: TrackedPaymentState;
  terminalReason?: TerminalReason;
  paymentAction: CanonicalPaymentAction;
  guidance: string;
  checkUrl?: string;
  settlementTxid?: string;
}> {
  const baseUrl = new URL(inboxUrl).origin;
  const canonical = await fetchCanonicalPaymentStatus(
    paymentId,
    baseUrl,
    {
      checkStatusUrl,
      localStatusRouteBaseUrl: baseUrl,
      timeoutMs: RETRY_LOOP_CANONICAL_POLL_TIMEOUT_MS,
    }
  );
  if (!canonical) {
    throw new Error("canonical payment status unavailable");
  }

  const outcome = classifyCanonicalPaymentOutcome(
    canonical.status,
    canonical.terminalReason
  );

  return {
    paymentStatus: canonical.status,
    terminalReason: canonical.terminalReason,
    paymentAction: outcome.action,
    guidance: outcome.guidance,
    checkUrl: resolveCanonicalCheckStatusUrl(
      baseUrl,
      paymentId,
      canonical.checkStatusUrl
    ),
    settlementTxid: canonical.txid,
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
  const url = `${getInboxBase()}/${recipientBtcAddress}`;
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
 * - canonical in-flight states by polling the same paymentId without rebuild/re-sign
 * - sender nonce failures by rebuilding and re-signing with a fresh sender nonce
 * - relay/sponsor/settlement failures with bounded tool-policy retry
 * - replaced/not_found by stopping the old payment flow
 * - txid recovery as a fallback only when canonical polling is unavailable
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
    diagnosticTool = "x402.send-inbox-message",
  } = options;

  const amount = BigInt(accept.amount);

  let lastError = "";
  let lastPaymentSignature: string | null = null;

  // Track relay txids across failed attempts for auto-recovery.
  const seenRelayTxids = new Set<string>();

  // Cache first attempt's tx + idempotency key for reuse on relay-side conflicts.
  let cachedTxHex: string | null = null;
  let cachedPaymentIdentifier: string | null = null;
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
    let paymentIdentifier: string;

    if (cachedTxHex && cachedPaymentIdentifier && cachedNonce !== null) {
      // Relay-side conflict: resubmit the same tx for dedup
      nonce = cachedNonce;
      txHex = cachedTxHex;
      paymentIdentifier = cachedPaymentIdentifier;
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
      paymentIdentifier = generatePaymentIdentifier();
      emitPaymentDiagnostic({
        event: "payment.accepted",
        tool: diagnosticTool,
        paymentId: paymentIdentifier,
        action: "submit_paid_request",
      });

      // Cache for potential reuse on relay-side conflicts
      cachedTxHex = txHex;
      cachedPaymentIdentifier = paymentIdentifier;
      cachedNonce = nonce;
    }

    // Encode PaymentPayloadV2 with payment-identifier extension
    const paymentSignature = encodePaymentPayload({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: accept,
      payload: { transaction: txHex },
      extensions: buildPaymentIdentifierExtension(paymentIdentifier),
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

    // Success: 200/201 means the inbox accepted the request. Caller-facing
    // state still comes from canonical payment-status polling when available.
    if (finalRes.status === 201 || finalRes.status === 200) {
      const settlement = decodePaymentResponse(
        finalRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE)
      );
      const txid = settlement?.transaction;
      const {
        paymentId: resolvedPaymentId,
        paymentStatus: inboxPaymentStatus,
        nonceReference,
        compatShimUsed,
      } = resolveInboxPaymentTracking(parsed, paymentIdentifier, txid);
      const trackingHint = extractCanonicalPaymentTrackingHint(parsed);
      const canonicalAssessment = resolvedPaymentId
        ? await getCanonicalPaymentAssessment(
            resolvedPaymentId,
            inboxUrl,
            trackingHint.checkStatusUrl
          ).catch(() => null)
        : null;
      const paymentStatus = canonicalAssessment?.paymentStatus ?? inboxPaymentStatus;
      const terminalReason = canonicalAssessment?.terminalReason;
      const paymentAction =
        canonicalAssessment?.paymentAction ??
        (paymentStatus
          ? classifyCanonicalPaymentOutcome(paymentStatus, terminalReason).action
          : undefined);
      const checkUrl = canonicalAssessment?.checkUrl ?? trackingHint.checkStatusUrl;
      const effectiveNonceReference =
        txid ??
        (isInFlightPaymentStatus(paymentStatus) && resolvedPaymentId
          ? `pending:${resolvedPaymentId}`
          : nonceReference);
      if (canonicalAssessment) {
        emitPaymentDiagnostic({
          event: canonicalAssessment.paymentAction === "poll" ? "payment.poll" : "payment.finalized",
          tool: diagnosticTool,
          paymentId: resolvedPaymentId,
          status: canonicalAssessment.paymentStatus,
          terminalReason: canonicalAssessment.terminalReason,
          action: canonicalAssessment.paymentAction,
          checkStatusUrl: canonicalAssessment.checkUrl,
          compatShimUsed,
        });
      } else {
        emitPaymentDiagnostic({
          event: "payment.fallback_used",
          tool: diagnosticTool,
          paymentId: resolvedPaymentId,
          status: paymentStatus,
          action: "canonical_status_unavailable_after_paid_response",
          checkStatusUrl: checkUrl,
          compatShimUsed,
        });
      }

      // Advance shared nonce tracker on success
      await advanceNonceCache(account.address, nonce, effectiveNonceReference);

      return buildInboxSubmitResult({
        status: finalRes.status,
        responseData: parsed,
        settlementTxid: canonicalAssessment?.settlementTxid ?? txid ?? undefined,
        paymentId: resolvedPaymentId,
        paymentStatus,
        terminalReason,
        paymentAction,
        checkUrl,
        paymentSignature,
        messageDelivered: paymentStatus === "confirmed",
      });
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

    // Prefer relay-owned paymentId from the inbox response envelope, then
    // fall back to the canonical tracking hint, then to locally generated id.
    const inboxMeta = extractInboxPaymentMetadata(
      parsed as Record<string, unknown>
    );
    const trackingHint = extractCanonicalPaymentTrackingHint(parsed);
    const canonicalPaymentId =
      inboxMeta.paymentId ?? trackingHint.paymentId ?? paymentIdentifier;
    const canonicalAssessment = canonicalPaymentId
      ? await getCanonicalPaymentAssessment(
          canonicalPaymentId,
          inboxUrl,
          trackingHint.checkStatusUrl
        ).catch(() => null)
      : null;
    const resolvedCheckUrl = canonicalAssessment?.checkUrl ?? trackingHint.checkStatusUrl;

    if (canonicalAssessment?.paymentAction === "poll") {
      emitPaymentDiagnostic({
        event: "payment.poll",
        tool: diagnosticTool,
        paymentId: canonicalPaymentId,
        status: canonicalAssessment.paymentStatus,
        terminalReason: canonicalAssessment.terminalReason,
        action: canonicalAssessment.paymentAction,
        checkStatusUrl: resolvedCheckUrl,
      });
      await advanceNonceCache(account.address, nonce, `pending:${canonicalPaymentId}`);
      return buildInboxSubmitResult({
        status: finalRes.status,
        responseData: parsed,
        settlementTxid: canonicalAssessment.settlementTxid,
        paymentId: canonicalPaymentId,
        paymentStatus: canonicalAssessment.paymentStatus,
        terminalReason: canonicalAssessment.terminalReason,
        paymentAction: canonicalAssessment.paymentAction,
        checkUrl: resolvedCheckUrl,
        paymentSignature,
        messageDelivered: false,
      });
    }

    if (canonicalAssessment?.paymentAction === "success") {
      emitPaymentDiagnostic({
        event: "payment.finalized",
        tool: diagnosticTool,
        paymentId: canonicalPaymentId,
        status: canonicalAssessment.paymentStatus,
        terminalReason: canonicalAssessment.terminalReason,
        action: canonicalAssessment.paymentAction,
        checkStatusUrl: resolvedCheckUrl,
      });
      await advanceNonceCache(
        account.address,
        nonce,
        canonicalAssessment.settlementTxid ?? ""
      );
      return buildInboxSubmitResult({
        status: finalRes.status,
        responseData: parsed,
        settlementTxid: canonicalAssessment.settlementTxid,
        paymentId: canonicalPaymentId,
        paymentStatus: canonicalAssessment.paymentStatus,
        terminalReason: canonicalAssessment.terminalReason,
        paymentAction: canonicalAssessment.paymentAction,
        checkUrl: resolvedCheckUrl,
        paymentSignature,
        messageDelivered: true,
      });
    }

    // Classify the transport fallback and extract retry timing
    const retryAfterHeader = finalRes.headers.get("retry-after");
    const retry = classifyRetryableError(finalRes.status, parsed, retryAfterHeader);
    emitPaymentDiagnostic({
      event: "payment.retry_decision",
      tool: diagnosticTool,
      paymentId: canonicalPaymentId,
      status: canonicalAssessment?.paymentStatus,
      terminalReason: canonicalAssessment?.terminalReason,
      action: canonicalAssessment?.paymentAction ??
        (retry.retryable
          ? retry.relaySideConflict
            ? "transport_retry_same_payment"
            : "transport_retry_new_payment"
          : "transport_stop"),
      checkStatusUrl: resolvedCheckUrl,
    });

    if (canonicalAssessment?.paymentAction === "rebuild_resign" && attempt < maxAttempts - 1) {
      nextRetryDelayMs = 0;
      cachedTxHex = null;
      cachedPaymentIdentifier = null;
      cachedNonce = null;
      await advanceNonceCache(account.address, nonce);
      lastError = `${finalRes.status}: ${responseData}`;
      continue;
    }

    if (canonicalAssessment?.paymentAction === "bounded_retry" && attempt < maxAttempts - 1) {
      nextRetryDelayMs = Math.max(retry.delayMs, DEFAULT_RETRY_DELAY_MS);
      cachedTxHex = null;
      cachedPaymentIdentifier = null;
      cachedNonce = null;
      await advanceNonceCache(account.address, nonce);
      lastError = `${finalRes.status}: ${responseData}`;
      continue;
    }

    // "restart" means the payment identity expired — use retry budget to
    // rebuild with a fresh nonce/signature instead of throwing immediately.
    if (canonicalAssessment?.paymentAction === "restart" && attempt < maxAttempts - 1) {
      nextRetryDelayMs = 0;
      cachedTxHex = null;
      cachedPaymentIdentifier = null;
      cachedNonce = null;
      await advanceNonceCache(account.address, nonce);
      lastError = `${finalRes.status}: ${responseData}`;
      continue;
    }

    if (
      canonicalAssessment &&
      (canonicalAssessment.paymentAction === "stop" ||
        canonicalAssessment.paymentAction === "restart")
    ) {
      emitPaymentDiagnostic({
        event: "payment.finalized",
        tool: diagnosticTool,
        paymentId: canonicalPaymentId,
        status: canonicalAssessment.paymentStatus,
        terminalReason: canonicalAssessment.terminalReason,
        action: canonicalAssessment.paymentAction,
        checkStatusUrl: resolvedCheckUrl,
      });
      throw new Error(
        `Message delivery failed (${finalRes.status}): ${responseData}\n\n` +
          `${canonicalAssessment.guidance}\n` +
          `paymentId: ${canonicalPaymentId}\n` +
          `checkUrl: ${resolvedCheckUrl}`
      );
    }

    if (retry.retryable && attempt < maxAttempts - 1) {
      if (!canonicalAssessment) {
        emitPaymentDiagnostic({
          event: "payment.fallback_used",
          tool: diagnosticTool,
          paymentId: paymentIdentifier,
          action: retry.relaySideConflict
            ? "transport_retry_classifier_same_payment"
            : "transport_retry_classifier_new_payment",
          checkStatusUrl: resolvedCheckUrl,
        });
      }
      console.error(
        `[x402-retry] Retryable error on attempt ${attempt + 1}: status=${finalRes.status} relaySide=${retry.relaySideConflict} delayMs=${retry.delayMs} body=${responseData}`
      );

      nextRetryDelayMs = retry.delayMs;

      if (retry.relaySideConflict) {
        // Keep cached tx/idempotency key so the relay can dedup on resubmit.
      } else {
        // Sender-side conflict: need a fresh tx with new nonce
        cachedTxHex = null;
        cachedPaymentIdentifier = null;
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
      emitPaymentDiagnostic({
        event: "payment.fallback_used",
        tool: diagnosticTool,
        paymentId: paymentIdentifier,
        action: "txid_recovery_from_payment_signature",
        checkStatusUrl: resolvedCheckUrl,
      });
      const confirmation = await pollTransactionConfirmation(txid, network);
      throw new Error(
        `${errorBase}\n\nPayment transaction was signed and broadcast was attempted, but canonical payment status was unavailable. ` +
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
        emitPaymentDiagnostic({
          event: "payment.fallback_used",
          tool: diagnosticTool,
          action: "relay_txid_auto_recovery_resubmission",
        });
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
          return buildInboxSubmitResult({
            status: result.status,
            responseData: parsed,
            settlementTxid: seenTxid,
            recovered: true,
            paymentStatus: "confirmed",
            paymentAction: "success",
            messageDelivered: true,
          });
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
