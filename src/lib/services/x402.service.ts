import axios, { type AxiosInstance } from "axios";
import {
  HttpPaymentStatusResponseSchema,
  type HttpPaymentStatusResponse,
} from "@aibtc/tx-schemas/http/schemas";
import {
  IN_FLIGHT_STATES,
  type TrackedPaymentState,
} from "@aibtc/tx-schemas/core/enums";
import { type TerminalReason } from "@aibtc/tx-schemas/terminal-reasons";
import {
  makeSTXTokenTransfer,
  makeContractCall,
  uintCV,
  principalCV,
  noneCV,
  PostConditionMode,
} from "@stacks/transactions";
import {
  decodePaymentRequired,
  decodePaymentPayload,
  encodePaymentPayload,
  buildPaymentIdentifierExtension,
  generatePaymentIdentifier,
  X402_HEADERS,
} from "../utils/x402-protocol.js";
import {
  extractTxidFromPaymentSignature,
  pollTransactionConfirmation,
} from "../utils/x402-recovery.js";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { NETWORK, API_URL, getStacksNetwork, type Network } from "../config/networks.js";
import { getNetworkFromStacksChainId } from "../config/caip.js";
import type { Account } from "../transactions/builder.js";
import { getWalletManager } from "./wallet-manager.js";
import { formatStx, formatSbtc } from "../utils/formatting.js";
import { getSbtcService } from "./sbtc.service.js";
import { getHiroApi } from "./hiro-api.js";
import { createHash } from "node:crypto";
import { InsufficientBalanceError } from "../utils/errors.js";
import { getContracts, parseContractId } from "../config/contracts.js";
import { emitPaymentDiagnostic } from "../utils/x402-diagnostics.js";

// Track payment attempts per client instance (auto-cleanup via WeakMap)
const paymentAttempts: WeakMap<AxiosInstance, number> = new WeakMap();

// Transaction deduplication cache: {dedupKey -> {txid, timestamp}}
const dedupCache: Map<string, { txid: string; timestamp: number }> = new Map();

// Cleanup expired dedup entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of dedupCache) {
    if (now - value.timestamp > 60000) {
      dedupCache.delete(key);
    }
  }
}, 300000).unref();

/**
 * Safe JSON transform - parses string responses without throwing
 */
function safeJsonTransform(data: unknown): unknown {
  if (typeof data !== "string") {
    return data;
  }
  const trimmed = data.trim();
  if (!trimmed) {
    return data;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return data;
  }
}

const CALLER_FACING_PAYMENT_STATES = new Set<TrackedPaymentState>([
  "queued",
  "broadcasting",
  "mempool",
  "confirmed",
  "failed",
  "replaced",
  "not_found",
]);

const IN_FLIGHT_PAYMENT_STATES = new Set<TrackedPaymentState>(IN_FLIGHT_STATES);
const SENDER_REBUILD_REASONS = new Set<TerminalReason>([
  "sender_nonce_stale",
  "sender_nonce_gap",
  "sender_nonce_duplicate",
]);
const BOUNDED_RETRY_REASONS = new Set<TerminalReason>([
  "queue_unavailable",
  "sponsor_failure",
  "internal_error",
  "broadcast_failure",
  "chain_abort",
]);

export type CanonicalPaymentAction =
  | "poll"
  | "success"
  | "rebuild_resign"
  | "bounded_retry"
  | "stop"
  | "restart";

export interface CanonicalPaymentOutcome {
  status: TrackedPaymentState;
  terminalReason?: TerminalReason;
  action: CanonicalPaymentAction;
  shouldPollSamePayment: boolean;
  shouldRebuildResign: boolean;
  shouldRetryNewPayment: boolean;
  stopPollingOldPayment: boolean;
  guidance: string;
}

export function normalizeCallerFacingPaymentStatus(
  status: unknown
): TrackedPaymentState | undefined {
  if (typeof status !== "string") {
    return undefined;
  }

  if (status === "pending" || status === "submitted") {
    return "queued";
  }

  if (CALLER_FACING_PAYMENT_STATES.has(status as TrackedPaymentState)) {
    return status as TrackedPaymentState;
  }

  return undefined;
}

export function isInFlightPaymentStatus(
  status: TrackedPaymentState | undefined
): status is TrackedPaymentState {
  return Boolean(status && IN_FLIGHT_PAYMENT_STATES.has(status));
}

/**
 * Local compatibility helper for inbox or other explicitly bounded first-party
 * flows. This is not a generic caller-facing x402 contract.
 *
 * The relay exposes payment status at `/payment/{paymentId}` (verified against
 * x402-relay v1.32.x). The previous `/api/payment-status/{paymentId}` path
 * 404s on the live relay; when the relay response omits `checkStatusUrl`,
 * the fallback was synthesizing `{status: "not_found", terminalReason:
 * "unknown_payment_identity"}` from those 404s, which the retry loop
 * interpreted as a terminal payment-identity failure and burned the retry
 * budget chasing phantom IDs.
 */
export function buildPaymentStatusCheckUrl(baseUrl: string, paymentId: string): string {
  const origin = new URL(baseUrl).origin;
  return `${origin}/payment/${encodeURIComponent(paymentId)}`;
}

/**
 * Resolve the canonical check-status URL for a payment.
 *
 * Currently a pass-through that returns the upstream-provided URL as-is.
 * The unused `_baseUrl` and `_paymentId` params are retained for forward
 * compatibility: when the relay omits `checkStatusUrl`, a future version
 * can construct a fallback via `buildPaymentStatusCheckUrl`.
 */
export function resolveCanonicalCheckStatusUrl(
  _baseUrl: string,
  _paymentId: string,
  checkStatusUrl?: string
): string | undefined {
  return checkStatusUrl;
}

export interface CanonicalPaymentStatusFetchOptions {
  checkStatusUrl?: string;
  /**
   * Explicit first-party compatibility fallback for flows like inbox.
   * Generic x402 clients must not assume this route exists.
   */
  localStatusRouteBaseUrl?: string;
  /** Optional per-call timeout override, capped to avoid long polling stalls. */
  timeoutMs?: number;
}

export interface CanonicalPaymentTrackingHint {
  paymentId?: string;
  checkStatusUrl?: string;
}

// Axios responses and Error objects are used as carriers for dynamic x402*
// metadata fields (x402PaymentStatus, x402PaymentId, etc.) that don't exist
// on the static types. This cast centralizes the type widening.
function asMetadataTarget(target: unknown): Record<string, unknown> {
  return target as Record<string, unknown>;
}

function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractCanonicalPaymentTrackingHint(value: unknown): CanonicalPaymentTrackingHint {
  const visit = (candidate: unknown): CanonicalPaymentTrackingHint | null => {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const record = candidate as Record<string, unknown>;
    const paymentId =
      extractStringField(record, "paymentId") ??
      extractStringField(record, "payment_id");
    const checkStatusUrl =
      extractStringField(record, "checkStatusUrl") ??
      extractStringField(record, "check_status_url") ??
      extractStringField(record, "checkUrl") ??
      extractStringField(record, "check_url") ??
      extractStringField(record, "statusUrl") ??
      extractStringField(record, "status_url");

    if (paymentId || checkStatusUrl) {
      return { paymentId, checkStatusUrl };
    }

    for (const nested of Object.values(record)) {
      const nestedMatch = visit(nested);
      if (nestedMatch?.paymentId || nestedMatch?.checkStatusUrl) {
        return nestedMatch;
      }
    }

    return null;
  };

  return visit(value) ?? {};
}

export function extractPaymentIdentifierFromPaymentSignature(
  paymentSignatureHeader: string
): string | null {
  try {
    const payload = decodePaymentPayload(paymentSignatureHeader);
    const maybeId = payload?.extensions?.["payment-identifier"];
    if (
      typeof maybeId === "object" &&
      maybeId !== null &&
      "info" in maybeId &&
      typeof maybeId.info === "object" &&
      maybeId.info !== null &&
      "id" in maybeId.info &&
      typeof maybeId.info.id === "string" &&
      maybeId.info.id.length > 0
    ) {
      return maybeId.info.id;
    }
  } catch {
    // best-effort extraction only
  }

  return null;
}

export interface CanonicalPaymentMetadata {
  paymentStatus?: HttpPaymentStatusResponse;
  paymentDecision?: CanonicalPaymentOutcome;
  paymentId?: string;
  checkUrl?: string;
}

export function getCanonicalPaymentMetadata(target: unknown): CanonicalPaymentMetadata {
  const source = asMetadataTarget(target);
  return {
    paymentStatus: source.x402PaymentStatus as HttpPaymentStatusResponse | undefined,
    paymentDecision: source.x402PaymentDecision as CanonicalPaymentOutcome | undefined,
    paymentId: typeof source.x402PaymentId === "string" ? source.x402PaymentId : undefined,
    checkUrl: typeof source.x402CheckUrl === "string" ? source.x402CheckUrl : undefined,
  };
}

function resolvePaymentStatusBaseUrl(
  requestConfig: { baseURL?: string; url?: string } | undefined,
  fallbackBaseUrl: string
): string {
  if (requestConfig?.baseURL) {
    return requestConfig.baseURL;
  }

  if (requestConfig?.url) {
    try {
      return new URL(requestConfig.url, fallbackBaseUrl).origin;
    } catch {
      // ignore malformed request URLs and fall back
    }
  }

  return fallbackBaseUrl;
}

function formatCanonicalPaymentStatusForError(
  baseUrl: string,
  canonicalStatus: HttpPaymentStatusResponse,
  outcome: CanonicalPaymentOutcome
): string {
  return (
    `${outcome.guidance}\n` +
    `status: ${canonicalStatus.status}\n` +
    `terminalReason: ${canonicalStatus.terminalReason ?? "none"}\n` +
    `paymentId: ${canonicalStatus.paymentId}\n` +
    `checkUrl: ${resolveCanonicalCheckStatusUrl(
      baseUrl,
      canonicalStatus.paymentId,
      canonicalStatus.checkStatusUrl
    ) ?? "unavailable"}`
  );
}

function attachCanonicalPaymentMetadata(
  target: Record<string, unknown>,
  baseUrl: string,
  canonicalStatus: HttpPaymentStatusResponse,
  outcome: CanonicalPaymentOutcome
): void {
  target.x402PaymentStatus = canonicalStatus;
  target.x402PaymentDecision = outcome;
  target.x402PaymentId = canonicalStatus.paymentId;
  const checkUrl = resolveCanonicalCheckStatusUrl(
    baseUrl,
    canonicalStatus.paymentId,
    canonicalStatus.checkStatusUrl
  );
  if (checkUrl) {
    target.x402CheckUrl = checkUrl;
  }
}

async function fetchCanonicalPaymentStatusFromHint(
  paymentStatusBaseUrl: string,
  clientPaymentIdentifier: string | null,
  trackingHint: CanonicalPaymentTrackingHint
): Promise<HttpPaymentStatusResponse | null> {
  if (!trackingHint.checkStatusUrl) {
    return null;
  }

  const paymentId = trackingHint.paymentId ?? clientPaymentIdentifier;
  if (!paymentId) {
    return null;
  }

  return fetchCanonicalPaymentStatus(paymentId, paymentStatusBaseUrl, {
    checkStatusUrl: trackingHint.checkStatusUrl,
  });
}

export async function fetchCanonicalPaymentStatus(
  paymentId: string,
  baseUrl: string,
  options: CanonicalPaymentStatusFetchOptions = {}
): Promise<HttpPaymentStatusResponse | null> {
  const controller = new AbortController();
  // Single-shot fetch with a hard timeout cap. No exponential backoff is used
  // because this is a status probe, not a retry loop — the caller (retry loop
  // in x402-retry.ts) already has its own bounded retry with delay logic.
  // 15s is generous for a single GET to a status endpoint.
  const cappedTimeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? 15_000),
    15_000
  );
  const timeout = setTimeout(() => controller.abort(), cappedTimeoutMs);

  try {
    const url = options.checkStatusUrl ??
      (options.localStatusRouteBaseUrl
        ? buildPaymentStatusCheckUrl(options.localStatusRouteBaseUrl, paymentId)
        : null);
    if (!url) {
      return null;
    }
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        paymentId,
        status: "not_found",
        terminalReason: "unknown_payment_identity",
      };
    }

    if (!response.ok) {
      return null;
    }

    const body = safeJsonTransform(await response.text());
    const parsed = HttpPaymentStatusResponseSchema.safeParse(body);
    if (!parsed.success) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function classifyCanonicalPaymentOutcome(
  status: TrackedPaymentState,
  terminalReason?: TerminalReason
): CanonicalPaymentOutcome {
  if (IN_FLIGHT_PAYMENT_STATES.has(status)) {
    return {
      status,
      terminalReason,
      action: "poll",
      shouldPollSamePayment: true,
      shouldRebuildResign: false,
      shouldRetryNewPayment: false,
      stopPollingOldPayment: false,
      guidance: "Payment is still in flight. Keep polling this paymentId and do not rebuild or re-sign.",
    };
  }

  if (status === "confirmed") {
    return {
      status,
      terminalReason,
      action: "success",
      shouldPollSamePayment: false,
      shouldRebuildResign: false,
      shouldRetryNewPayment: false,
      stopPollingOldPayment: true,
      guidance: "Payment confirmed successfully.",
    };
  }

  if (status === "failed" && terminalReason && SENDER_REBUILD_REASONS.has(terminalReason)) {
    return {
      status,
      terminalReason,
      action: "rebuild_resign",
      shouldPollSamePayment: false,
      shouldRebuildResign: true,
      shouldRetryNewPayment: false,
      stopPollingOldPayment: true,
      guidance: "Payment failed because the sender nonce is stale, missing, or duplicated. Rebuild and re-sign with a fresh sender nonce.",
    };
  }

  if (status === "failed" && terminalReason && BOUNDED_RETRY_REASONS.has(terminalReason)) {
    return {
      status,
      terminalReason,
      action: "bounded_retry",
      shouldPollSamePayment: false,
      shouldRebuildResign: false,
      shouldRetryNewPayment: true,
      stopPollingOldPayment: true,
      guidance: "Payment failed because of relay, sponsor, or settlement handling. Retry only within tool policy and do not treat this as sender nonce recovery.",
    };
  }

  if (status === "replaced") {
    return {
      status,
      terminalReason,
      action: "stop",
      shouldPollSamePayment: false,
      shouldRebuildResign: false,
      shouldRetryNewPayment: false,
      stopPollingOldPayment: true,
      guidance: "This payment was replaced. Stop polling the old paymentId and decide explicitly whether to start a new payment flow.",
    };
  }

  if (status === "not_found") {
    return {
      status,
      terminalReason,
      action: "restart",
      shouldPollSamePayment: false,
      shouldRebuildResign: false,
      shouldRetryNewPayment: false,
      stopPollingOldPayment: true,
      guidance: "This payment identity is gone or expired. Stop polling the old paymentId and only restart if the higher-level action still needs to pay.",
    };
  }

  return {
    status,
    terminalReason,
    action: "stop",
    shouldPollSamePayment: false,
    shouldRebuildResign: false,
    shouldRetryNewPayment: false,
    stopPollingOldPayment: true,
    guidance:
      status === "failed"
        ? "Payment failed with a terminal outcome that should not be treated as sender nonce recovery."
        : "Stop the old payment flow and inspect the terminal payment status.",
  };
}

/**
 * Create a plain axios instance with JSON parsing for both success and error responses.
 * Used as the base for both payment-wrapped clients and probe requests.
 * Timeout is 120 seconds to accommodate sBTC contract-call settlements which can take 60+ seconds.
 */
function createBaseAxiosInstance(baseURL?: string): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 120000,
    transformResponse: [safeJsonTransform],
  });

  // Ensure error response bodies (especially 402 payloads) are also parsed as JSON
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error?.response?.data) {
        error.response.data = safeJsonTransform(error.response.data);
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * Convert mnemonic to account
 */
export async function mnemonicToAccount(
  mnemonic: string,
  network: Network
): Promise<Account> {
  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });

  const account = wallet.accounts[0];
  const address = getStxAddress(account, network);

  return {
    address,
    privateKey: account.stxPrivateKey,
    network,
  };
}

/**
 * Create an API client with x402 payment interceptor.
 * Creates a fresh client instance per call with max-1-payment-attempt guard.
 */
export async function createApiClient(baseUrl?: string, diagnosticTool = "x402.api-client"): Promise<AxiosInstance> {
  const url = baseUrl || API_URL;

  // Get account (from managed wallet or env mnemonic)
  const account = await getAccount();
  const axiosInstance = createBaseAxiosInstance(url);

  // Interceptor 1 (FIFO): max-1-payment-attempt guard.
  // On the first 402, increments the counter and re-rejects so Interceptor 2 can handle it.
  // On a second 402 (would-be retry loop), rejects with a user-facing error.
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
      // Only intercept 402 payment errors
      if (error.response?.status !== 402) {
        return Promise.reject(error);
      }

      // Check attempt counter
      const attempts = paymentAttempts.get(axiosInstance) || 0;

      if (attempts >= 1) {
        const paymentSignature = error.config?.headers?.[X402_HEADERS.PAYMENT_SIGNATURE];
        const clientPaymentIdentifier =
          typeof paymentSignature === "string"
            ? extractPaymentIdentifierFromPaymentSignature(paymentSignature)
            : null;
        const paymentStatusBaseUrl = resolvePaymentStatusBaseUrl(error.config, url);
        const canonicalStatus = await fetchCanonicalPaymentStatusFromHint(
          paymentStatusBaseUrl,
          clientPaymentIdentifier,
          extractCanonicalPaymentTrackingHint(error.response?.data)
        );

        if (canonicalStatus) {
          const outcome = classifyCanonicalPaymentOutcome(
            canonicalStatus.status,
            canonicalStatus.terminalReason
          );
          emitPaymentDiagnostic({
            event: "payment.finalized",
            tool: diagnosticTool,
            paymentId: canonicalStatus.paymentId,
            status: canonicalStatus.status,
            terminalReason: canonicalStatus.terminalReason,
            action: outcome.action,
            checkStatusUrl: canonicalStatus.checkStatusUrl,
          });
          const retryError = new Error(
            `Payment retry limit exceeded (max 1 attempt).\n` +
              `${formatCanonicalPaymentStatusForError(paymentStatusBaseUrl, canonicalStatus, outcome)}`
          );
          attachCanonicalPaymentMetadata(
            asMetadataTarget(retryError),
            paymentStatusBaseUrl,
            canonicalStatus,
            outcome
          );
          asMetadataTarget(retryError).config = error.config as unknown;
          return Promise.reject(retryError);
        }

        const txid =
          typeof paymentSignature === "string"
            ? extractTxidFromPaymentSignature(paymentSignature)
            : null;
        if (txid) {
          emitPaymentDiagnostic({
            event: "payment.fallback_used",
            tool: diagnosticTool,
            paymentId: clientPaymentIdentifier,
            action: "txid_recovery_from_payment_signature",
          });
          const confirmation = await pollTransactionConfirmation(txid, account.network);
          return Promise.reject(
            new Error(
              "Payment retry limit exceeded (max 1 attempt). " +
                "Canonical payment status was unavailable, so txid recovery was used as backup.\n" +
                `txid: ${confirmation.txid}\n` +
                `status: ${confirmation.status}\n` +
                `explorer: ${confirmation.explorer}`
            )
          );
        }

        return Promise.reject(
          new Error(
            "Payment retry limit exceeded (max 1 attempt). " +
              "This endpoint may have payment or settlement issues, and canonical payment status was unavailable."
          )
        );
      }

      // Increment counter and pass through to the native payment interceptor
      paymentAttempts.set(axiosInstance, attempts + 1);
      return Promise.reject(error);
    }
  );

  // Interceptor 2 (FIFO): native x402 payment handler.
  // Decodes payment requirements, builds a sponsored signed transaction, encodes the
  // PaymentPayloadV2 into the payment-signature header, and retries the original request.
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status !== 402) {
        return Promise.reject(error);
      }

      try {
        // Decode payment requirements from header
        const headerValue = error.response?.headers?.[X402_HEADERS.PAYMENT_REQUIRED];
        const paymentRequired = decodePaymentRequired(headerValue);

        if (!paymentRequired || !paymentRequired.accepts || paymentRequired.accepts.length === 0) {
          return Promise.reject(
            new Error("Invalid x402 402 response: missing or empty payment-required header")
          );
        }

        // Select first Stacks-compatible payment option
        const selectedOption = paymentRequired.accepts.find(
          (opt) => opt.network?.startsWith("stacks:")
        );

        if (!selectedOption) {
          const networks = paymentRequired.accepts.map((a) => a.network).join(", ");
          return Promise.reject(
            new Error(`No compatible Stacks payment option found. Available networks: ${networks}`)
          );
        }

        // Verify the payment network matches our configured network
        const paymentNetwork = getNetworkFromStacksChainId(selectedOption.network);
        if (paymentNetwork && paymentNetwork !== account.network) {
          return Promise.reject(
            new Error(
              `Network mismatch: endpoint requires ${paymentNetwork} but wallet is configured for ${account.network}. ` +
              `Switch to a ${paymentNetwork} wallet or use a ${account.network} endpoint.`
            )
          );
        }

        // Build a sponsored signed transaction (relay pays gas; fee: 0n)
        const tokenType = detectTokenType(selectedOption.asset);
        const amount = BigInt(selectedOption.amount);
        const networkName = getStacksNetwork(account.network);

        let transaction;
        if (tokenType === "sBTC") {
          const contracts = getContracts(account.network);
          const { address: contractAddress, name: contractName } = parseContractId(
            contracts.SBTC_TOKEN
          );

          transaction = await makeContractCall({
            contractAddress,
            contractName,
            functionName: "transfer",
            functionArgs: [
              uintCV(amount),
              principalCV(account.address),
              principalCV(selectedOption.payTo),
              noneCV(),
            ],
            senderKey: account.privateKey,
            network: networkName,
            postConditionMode: PostConditionMode.Allow,
            sponsored: true,
            fee: 0n,
          });
        } else {
          transaction = await makeSTXTokenTransfer({
            recipient: selectedOption.payTo,
            amount,
            senderKey: account.privateKey,
            network: networkName,
            memo: "",
            sponsored: true,
            fee: 0n,
          });
        }

        const txHex = "0x" + transaction.serialize();

        const paymentIdentifier = generatePaymentIdentifier();
        emitPaymentDiagnostic({
          event: "payment.accepted",
          tool: diagnosticTool,
          paymentId: paymentIdentifier,
          action: "submit_paid_request",
        });

        // Encode PaymentPayloadV2 into payment-signature header
        const encodedPayload = encodePaymentPayload({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted: selectedOption,
          payload: { transaction: txHex },
          extensions: buildPaymentIdentifierExtension(paymentIdentifier),
        });

        // Retry the original request with the payment header
        const originalRequest = error.config;
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers[X402_HEADERS.PAYMENT_SIGNATURE] = encodedPayload;

        const paidResponse = await axiosInstance.request(originalRequest);
        const paymentStatusBaseUrl = resolvePaymentStatusBaseUrl(
          originalRequest,
          paymentRequired.resource?.url ?? url
        );
        const canonicalStatus = await fetchCanonicalPaymentStatusFromHint(
          paymentStatusBaseUrl,
          paymentIdentifier,
          extractCanonicalPaymentTrackingHint(paidResponse.data)
        );

        if (!canonicalStatus) {
          emitPaymentDiagnostic({
            event: "payment.fallback_used",
            tool: diagnosticTool,
            paymentId: paymentIdentifier,
            action: "canonical_status_unavailable_after_paid_response",
          });
          return paidResponse;
        }

        const outcome = classifyCanonicalPaymentOutcome(
          canonicalStatus.status,
          canonicalStatus.terminalReason
        );
        emitPaymentDiagnostic({
          event: outcome.action === "poll" ? "payment.poll" : "payment.finalized",
          tool: diagnosticTool,
          paymentId: canonicalStatus.paymentId,
          status: canonicalStatus.status,
          terminalReason: canonicalStatus.terminalReason,
          action: outcome.action,
          checkStatusUrl: canonicalStatus.checkStatusUrl,
        });
        attachCanonicalPaymentMetadata(
          asMetadataTarget(paidResponse),
          paymentStatusBaseUrl,
          canonicalStatus,
          outcome
        );

        if (outcome.action === "success" || outcome.action === "poll") {
          return paidResponse;
        }

        const canonicalError = new Error(
          "x402 payment failed after the paid request returned. " +
            formatCanonicalPaymentStatusForError(paymentStatusBaseUrl, canonicalStatus, outcome)
        );
        attachCanonicalPaymentMetadata(
          asMetadataTarget(canonicalError),
          paymentStatusBaseUrl,
          canonicalStatus,
          outcome
        );
        return Promise.reject(
          canonicalError
        );
      } catch (paymentError) {
        if (
          paymentError instanceof Error &&
          (asMetadataTarget(paymentError).x402PaymentStatus ||
            asMetadataTarget(paymentError).x402PaymentId)
        ) {
          return Promise.reject(paymentError);
        }
        return Promise.reject(
          new Error(
            `x402 payment failed: ${paymentError instanceof Error ? paymentError.message : String(paymentError)}`
          )
        );
      }
    }
  );

  return axiosInstance;
}

/**
 * Create a plain axios client without payment interceptor.
 * Used for known-free endpoints where 402 responses should fail, not auto-pay.
 */
export function createPlainClient(baseUrl?: string): AxiosInstance {
  return createBaseAxiosInstance(baseUrl);
}

/**
 * Get wallet address - checks managed wallet first, then env mnemonic
 */
export async function getWalletAddress(): Promise<string> {
  const account = await getAccount();
  return account.address;
}

/**
 * Get account - checks managed wallet first, then env mnemonic.
 * If no in-process session exists, attempts to restore a persisted session
 * from disk (written by a previous `wallet unlock` process) before falling
 * back to CLIENT_MNEMONIC.
 */
export async function getAccount(): Promise<Account> {
  const walletManager = getWalletManager();

  // 1. Check in-process session (fastest path)
  const sessionAccount = walletManager.getActiveAccount();
  if (sessionAccount) {
    return sessionAccount;
  }

  // 2. Attempt to restore session from disk (cross-process persistence)
  try {
    const { readAppConfig } = await import("../utils/storage.js");
    const config = await readAppConfig();
    if (config.activeWalletId) {
      const restored = await walletManager.restoreSessionFromDisk(config.activeWalletId);
      if (restored) {
        return restored;
      }
    }
  } catch {
    // Non-fatal — fall through to CLIENT_MNEMONIC
  }

  // 3. Fall back to environment mnemonic
  const mnemonic = process.env.CLIENT_MNEMONIC || "";
  if (!mnemonic) {
    throw new Error(
      "No wallet available. Either unlock a managed wallet " +
        "(bun run wallet/wallet.ts unlock --password <password>) " +
        "or set CLIENT_MNEMONIC environment variable."
    );
  }
  return mnemonicToAccount(mnemonic, NETWORK);
}

/**
 * Probe result types
 */
export type ProbeResultFree = {
  type: 'free';
  data: unknown;
};

export type ProbeResultPaymentRequired = {
  type: 'payment_required';
  amount: string;
  asset: string;
  recipient: string;
  network: string;
  endpoint: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  maxTimeoutSeconds?: number;
};

export type ProbeResult = ProbeResultFree | ProbeResultPaymentRequired;

/**
 * Detect token type from asset identifier
 * @param asset - Full contract identifier or token name
 * @returns 'STX' for native STX, 'sBTC' for sBTC token
 */
export function detectTokenType(asset: string): 'STX' | 'sBTC' {
  const assetLower = asset.trim().toLowerCase();
  // Treat as sBTC if:
  // - exactly "sbtc" (token name only)
  // - contract identifier contains "sbtc-token" (e.g. "SM3....sbtc-token" or "SM3....sbtc-token::sbtc-token")
  // - full qualifier ending with "::token-sbtc" (legacy format)
  if (assetLower === 'sbtc' || assetLower.includes('sbtc-token') || assetLower.endsWith('::token-sbtc')) {
    return 'sBTC';
  }
  return 'STX';
}

/**
 * Format payment amount into human-readable string with token symbol
 * @param amount - Raw amount string (microSTX or satoshis)
 * @param asset - Token asset identifier
 * @returns Formatted string like "0.000001 sBTC" or "0.001 STX"
 */
export function formatPaymentAmount(amount: string, asset: string): string {
  const tokenType = detectTokenType(asset);
  if (tokenType === 'sBTC') {
    return formatSbtc(amount);
  }
  return formatStx(amount);
}

/**
 * Probe an endpoint without payment interceptor
 * Returns either free response data or payment requirements
 */
export async function probeEndpoint(options: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  params?: Record<string, string>;
  data?: Record<string, unknown>;
}): Promise<ProbeResult> {
  const { method, url, params, data } = options;
  const axiosInstance = createBaseAxiosInstance();

  try {
    const response = await axiosInstance.request({ method, url, params, data });

    // 200 response - free endpoint
    return {
      type: 'free',
      data: response.data,
    };
  } catch (error) {
    const axiosError = error as { response?: { status?: number; data?: unknown; headers?: Record<string, string> } };

    // 402 Payment Required - parse payment info
    if (axiosError.response?.status === 402) {
      // Try to parse v2 payment-required header first
      const headerValue = axiosError.response.headers?.[X402_HEADERS.PAYMENT_REQUIRED];
      const paymentRequired = decodePaymentRequired(headerValue);

      // If v2 header is successfully parsed, use it
      if (paymentRequired?.accepts?.length) {
        const acceptedPayment = paymentRequired.accepts[0];

        // Convert CAIP-2 network identifier to human-readable format
        const network = getNetworkFromStacksChainId(acceptedPayment.network) ?? NETWORK;

        return {
          type: 'payment_required',
          amount: acceptedPayment.amount,
          asset: acceptedPayment.asset,
          recipient: acceptedPayment.payTo,
          network,
          endpoint: url,
          resource: paymentRequired.resource,
          maxTimeoutSeconds: acceptedPayment.maxTimeoutSeconds,
        };
      }

      // Fall back to v1 body parsing
      const paymentData = axiosError.response.data as {
        amount?: string;
        asset?: string;
        recipient?: string;
        network?: string;
      };

      if (!paymentData.amount || !paymentData.asset || !paymentData.recipient || !paymentData.network) {
        const headerDebug = headerValue !== undefined && headerValue !== null
          ? `present (length=${String(headerValue).length})`
          : 'missing';
        throw new Error(
          `Invalid 402 response from ${url}: missing payment fields in both v2 header and v1 body. ` +
          `v2 header: ${headerDebug}; v1 body keys: ${Object.keys(paymentData as object).join(', ') || 'none'}`
        );
      }

      return {
        type: 'payment_required',
        amount: paymentData.amount,
        asset: paymentData.asset,
        recipient: paymentData.recipient,
        network: paymentData.network,
        endpoint: url,
      };
    }

    // Other errors - propagate
    if (axiosError.response) {
      throw new Error(
        `HTTP ${axiosError.response.status} from ${url}: ${JSON.stringify(axiosError.response.data)}`
      );
    }

    throw error;
  }
}

/**
 * Generate a stable deduplication key for a request
 */
export function generateDedupKey(
  method: string,
  url: string,
  params?: Record<string, string>,
  data?: Record<string, unknown>
): string {
  const payload = JSON.stringify({ method, url, params, data });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Check if a request was recently processed (within 60s)
 * @returns txid if duplicate found, null otherwise
 */
export function checkDedupCache(key: string): string | null {
  const cached = dedupCache.get(key);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (now - cached.timestamp > 60000) {
    dedupCache.delete(key);
    return null;
  }
  return cached.txid;
}

/**
 * Record a transaction in the dedup cache
 */
export function recordTransaction(key: string, txid: string): void {
  dedupCache.set(key, { txid, timestamp: Date.now() });
}

/**
 * Check if account has sufficient balance to pay for x402 endpoint.
 * @throws InsufficientBalanceError if balance is too low
 */
export async function checkSufficientBalance(
  account: Account,
  amount: string,
  asset: string
): Promise<void> {
  const tokenType = detectTokenType(asset);
  const requiredAmount = BigInt(amount);

  if (tokenType === 'sBTC') {
    const sbtcService = getSbtcService(account.network);
    const balanceInfo = await sbtcService.getBalance(account.address);
    const balance = BigInt(balanceInfo.balance);

    if (balance < requiredAmount) {
      const shortfall = requiredAmount - balance;
      throw new InsufficientBalanceError(
        `Insufficient sBTC balance: need ${formatSbtc(amount)}, have ${formatSbtc(balanceInfo.balance)} (shortfall: ${formatSbtc(shortfall.toString())}). ` +
        `Deposit more sBTC via the bridge at https://bridge.stx.eco or use a different wallet.`,
        'sBTC',
        balanceInfo.balance,
        amount,
        shortfall.toString()
      );
    }

    // sBTC transfers are contract calls that also require STX for gas fees
    const hiroApiForSbtc = getHiroApi(account.network);
    const stxInfoForSbtc = await hiroApiForSbtc.getStxBalance(account.address);
    const stxBalanceForSbtc = BigInt(stxInfoForSbtc.balance);
    const sbtcFees = await hiroApiForSbtc.getMempoolFees();
    const estimatedSbtcFee = BigInt(sbtcFees.contract_call.high_priority);

    if (stxBalanceForSbtc < estimatedSbtcFee) {
      const stxShortfall = estimatedSbtcFee - stxBalanceForSbtc;
      throw new InsufficientBalanceError(
        `Insufficient STX balance to cover sBTC transfer fee: need ${formatStx(estimatedSbtcFee.toString())} estimated fee, ` +
        `have ${formatStx(stxInfoForSbtc.balance)} (shortfall: ${formatStx(stxShortfall.toString())}). ` +
        `Deposit more STX or use a different wallet.`,
        'STX',
        stxInfoForSbtc.balance,
        estimatedSbtcFee.toString(),
        stxShortfall.toString()
      );
    }

    return;
  }

  // STX: include estimated fee in the required amount
  const hiroApi = getHiroApi(account.network);
  const balanceInfo = await hiroApi.getStxBalance(account.address);
  const balance = BigInt(balanceInfo.balance);

  const mempoolFees = await hiroApi.getMempoolFees();
  const estimatedFee = BigInt(mempoolFees.contract_call.high_priority);
  const totalRequired = requiredAmount + estimatedFee;

  if (balance >= totalRequired) return;

  const shortfall = totalRequired - balance;
  throw new InsufficientBalanceError(
    `Insufficient STX balance: need ${formatStx(totalRequired.toString())} (${formatStx(amount)} payment + ${formatStx(estimatedFee.toString())} estimated fee), ` +
    `have ${formatStx(balanceInfo.balance)} (shortfall: ${formatStx(shortfall.toString())}). ` +
    `Deposit more STX or use a different wallet.`,
    'STX',
    balanceInfo.balance,
    totalRequired.toString(),
    shortfall.toString()
  );
}

export { NETWORK, API_URL };
