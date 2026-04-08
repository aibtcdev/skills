/**
 * Shared retry strategy for Stacks transaction submission.
 *
 * Provides error classification for both the relay /sponsor endpoint and
 * direct Hiro broadcast errors. Used by sponsor-builder.ts and builder.ts
 * to drive retry loops with correct back-off and nonce lifecycle handling.
 *
 * Design:
 * - No external dependencies — pure classification logic
 * - classifyRelayError: for relay /sponsor responses (409, 502, 503, 429, 500)
 * - classifyBroadcastError: for direct Hiro broadcast error strings
 * - sleep: shared utility to avoid importing it everywhere
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Category of error for routing retry logic.
 *
 * - NONCE_CONFLICT: relay sponsor nonce collision — resubmit same serialized tx
 * - BROADCAST_FAILED: relay signed but Hiro rejected — resubmit same serialized tx
 * - NONCE_DO_UNAVAILABLE: transient relay infra — resubmit same serialized tx
 * - RATE_LIMITED: 429 — sleep retryAfter, then resubmit
 * - SENDER_NONCE_CONFLICT: our sender nonce already in mempool — re-acquire and rebuild
 * - SPONSOR_FAILED: relay could not sign sponsorship — non-retryable
 * - TRANSIENT: other transient network error — short sleep, retry
 * - FATAL: non-retryable error
 */
export type RetryCategory =
  | "NONCE_CONFLICT"
  | "BROADCAST_FAILED"
  | "NONCE_DO_UNAVAILABLE"
  | "RATE_LIMITED"
  | "SENDER_NONCE_CONFLICT"
  | "SPONSOR_FAILED"
  | "TRANSIENT"
  | "FATAL";

export interface RetryInfo {
  retryable: boolean;
  delayMs: number;
  /** True when relay's sponsor nonce collided — resubmit same serialized tx hex */
  relaySideConflict: boolean;
  /** True when our sender nonce is stale/duplicated — re-acquire nonce and rebuild tx */
  senderSideConflict: boolean;
  category: RetryCategory;
}

/** Minimal relay response fields needed for classification (avoids circular imports). */
interface RelayErrorBody {
  code?: string;
  retryable?: boolean;
  retryAfter?: number;
  error?: string;
  details?: string;
}

// ---------------------------------------------------------------------------
// Relay error classification
// ---------------------------------------------------------------------------

/**
 * Classify a /sponsor relay error response.
 *
 * The relay sets `code`, `retryable`, and `retryAfter` fields on error
 * responses. HTTP status is optional — the body fields are preferred.
 *
 * @param body    - Parsed relay error response body
 * @param status  - Optional HTTP status code (used when body.code is absent)
 */
export function classifyRelayError(body: RelayErrorBody, status?: number): RetryInfo {
  const code = body.code ?? "";
  const retryAfterMs = body.retryAfter != null ? body.retryAfter * 1000 : 5_000;

  // 409 / NONCE_CONFLICT — relay sponsor nonce collision, resubmit same tx
  if (code === "NONCE_CONFLICT" || status === 409) {
    return {
      retryable: true,
      delayMs: body.retryAfter != null ? body.retryAfter * 1000 : 30_000,
      relaySideConflict: true,
      senderSideConflict: false,
      category: "NONCE_CONFLICT",
    };
  }

  // 502 / BROADCAST_FAILED — relay signed but Hiro rejected broadcast, resubmit same tx
  if (code === "BROADCAST_FAILED" || status === 502) {
    return {
      retryable: true,
      delayMs: retryAfterMs,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "BROADCAST_FAILED",
    };
  }

  // 503 / NONCE_DO_UNAVAILABLE — transient relay infra, resubmit same tx
  if (code === "NONCE_DO_UNAVAILABLE" || status === 503) {
    return {
      retryable: true,
      delayMs: body.retryAfter != null ? body.retryAfter * 1000 : 3_000,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "NONCE_DO_UNAVAILABLE",
    };
  }

  // 429 — rate limited, sleep retryAfter
  if (status === 429) {
    return {
      retryable: true,
      delayMs: retryAfterMs,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "RATE_LIMITED",
    };
  }

  // 500 / SPONSOR_FAILED — relay could not sign, non-retryable
  if (code === "SPONSOR_FAILED" || status === 500) {
    return {
      retryable: false,
      delayMs: 0,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "SPONSOR_FAILED",
    };
  }

  // Check body error text for sender-side nonce errors relayed from Hiro
  const errorText = `${body.error ?? ""} ${body.details ?? ""}`;
  const senderConflict = classifyBroadcastError(errorText);
  if (senderConflict.senderSideConflict) {
    return senderConflict;
  }

  // Honour relay-provided retryable flag as a catch-all
  if (body.retryable) {
    return {
      retryable: true,
      delayMs: retryAfterMs,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "TRANSIENT",
    };
  }

  return {
    retryable: false,
    delayMs: 0,
    relaySideConflict: false,
    senderSideConflict: false,
    category: "FATAL",
  };
}

// ---------------------------------------------------------------------------
// Direct broadcast error classification
// ---------------------------------------------------------------------------

/**
 * Classify a direct Hiro broadcast error message.
 *
 * Returns SENDER_NONCE_CONFLICT when the nonce is already in the mempool
 * (safe to re-acquire and retry). Returns TRANSIENT for network errors.
 * Returns FATAL for all other errors.
 *
 * @param errorMessage - Error string from broadcastTransaction or fetch
 */
export function classifyBroadcastError(errorMessage: string): RetryInfo {
  const msg = errorMessage.toLowerCase();

  // ConflictingNonceInMempool / BadNonce — nonce NOT consumed by Hiro, safe to re-acquire
  if (
    msg.includes("conflictingnonceinthemempool") ||
    msg.includes("conflicting_nonce") ||
    msg.includes("conflictingnonce") ||
    msg.includes("badnonce") ||
    msg.includes("bad_nonce")
  ) {
    return {
      retryable: true,
      delayMs: 0,
      relaySideConflict: false,
      senderSideConflict: true,
      category: "SENDER_NONCE_CONFLICT",
    };
  }

  // Transient network errors — short sleep, retry with same tx
  if (
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed")
  ) {
    return {
      retryable: true,
      delayMs: 5_000,
      relaySideConflict: false,
      senderSideConflict: false,
      category: "TRANSIENT",
    };
  }

  return {
    retryable: false,
    delayMs: 0,
    relaySideConflict: false,
    senderSideConflict: false,
    category: "FATAL",
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
