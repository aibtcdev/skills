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
  type StacksTransactionWire,
} from "@stacks/transactions";
import { createFungiblePostCondition } from "../transactions/post-conditions.js";
import {
  checkDedup,
  checkSpend,
  clearDedup,
  DuplicatePaymentError,
  generateDedupKey as generatePaymentRequestKey,
  recordDedup,
  recordSpend,
  releaseSpend,
  resolveDirectPaymentPolicy,
  SpendLimitError,
  withDirectPaymentLock,
  type DirectPaymentPolicy,
  type SpendUnit,
} from "./x402-guards.js";
import {
  decodePaymentRequired,
  decodePaymentPayload,
  encodePaymentPayload,
  buildPaymentIdentifierExtension,
  derivePaymentIdentifier,
  X402_HEADERS,
  type PaymentRequirementsV2,
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

// Legacy in-memory dedup cache behind the deprecated exports at the bottom of
// this file. Direct mode uses the persisted guard in ./x402-guards.ts instead.
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

// ============================================================================
// Payment mode (X402_PAYMENT_MODE)
// ============================================================================

/**
 * How the payment transaction is built.
 *
 * - `sponsored` (default): fee 0, sponsored flag set, the server or the aibtc
 *   relay co-signs and pays gas. Unchanged from every earlier release.
 * - `direct`: a standard fee-paying transfer signed by the sender alone. Works
 *   against servers that verify + broadcast payments themselves and reject
 *   sponsored bytes (`422 sponsored_unsupported`). The wallet must hold STX
 *   for gas. Only this mode applies the caps, asset allowlist and pre-flight
 *   checks below — the sponsored path is byte-for-byte what it was.
 */
export type X402PaymentMode = "sponsored" | "direct";

const PAYMENT_MODES: ReadonlySet<string> = new Set(["sponsored", "direct"]);

export function resolvePaymentMode(raw = process.env.X402_PAYMENT_MODE): X402PaymentMode {
  const value = (raw ?? "").trim().toLowerCase() || "sponsored";
  if (!PAYMENT_MODES.has(value)) {
    throw new Error(
      `Invalid X402_PAYMENT_MODE "${raw}". Allowed values: sponsored (default), direct.`
    );
  }
  return value as X402PaymentMode;
}

export { resolveDirectPaymentPolicy, DuplicatePaymentError, SpendLimitError, type DirectPaymentPolicy };

// ============================================================================
// Payment asset selection
// ============================================================================

/**
 * Which of a 402 challenge's Stacks options to pay with.
 *
 * A server may advertise several `accepts` entries on the same network, e.g.
 * 100 sats of sBTC first and 300000 µSTX second (the Vibewatch Stacks Vibe
 * Index does). The engine's historical rule is "first `stacks:` option", so
 * a wallet holding only STX would have signed an sBTC transfer it could not
 * fund. `preferredAsset` picks by asset instead; the default is unchanged.
 */
export type X402PaymentAsset = "sBTC" | "STX";

const PAYMENT_ASSETS: ReadonlySet<string> = new Set(["sBTC", "STX"]);

export interface CreateApiClientOptions {
  /** Pay with this asset when the challenge offers it; unset = first Stacks option. */
  preferredAsset?: X402PaymentAsset;
}

export function resolvePreferredAsset(raw: string | undefined): X402PaymentAsset | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const canonical = value.toLowerCase() === "sbtc" ? "sBTC" : value.toUpperCase() === "STX" ? "STX" : value;
  if (!PAYMENT_ASSETS.has(canonical)) {
    throw new Error(`Invalid preferred payment asset "${raw}". Allowed values: sBTC, STX.`);
  }
  return canonical as X402PaymentAsset;
}

/**
 * Pick the challenge option to pay. Without a preference: the first
 * `stacks:` option (the rule every earlier release used). With one: the first
 * `stacks:` option whose asset is that token — native `STX` literally, sBTC
 * by the same contract-id test the transaction builders use. Returns null
 * when no Stacks option exists, or none carries the preferred asset; the
 * caller reports what was offered.
 */
export function selectStacksPaymentOption(
  accepts: readonly PaymentRequirementsV2[],
  preferredAsset?: X402PaymentAsset
): PaymentRequirementsV2 | null {
  const stacksOptions = accepts.filter((opt) => typeof opt.network === "string" && opt.network.startsWith("stacks:"));
  if (!preferredAsset) return stacksOptions[0] ?? null;
  const matches = (opt: PaymentRequirementsV2) => {
    if (typeof opt.asset !== "string") return false;
    return preferredAsset === "STX"
      ? /^stx$/i.test(opt.asset)
      : detectTokenType(opt.asset) === "sBTC";
  };
  return stacksOptions.find(matches) ?? null;
}

/** Fee clamps by transaction type (micro-STX), mirrored from utils/fee.ts. */
const DIRECT_FEE_CLAMPS = {
  contract_call: { floor: 3000n, ceiling: 100_000n },
  token_transfer: { floor: 180n, ceiling: 3000n },
} as const;

/** Hard upper bound on the paid replay when the 402 does not say otherwise. */
const DEFAULT_PAID_REQUEST_TIMEOUT_MS = 120_000;
/** How long to poll Hiro for the txid after a paid 2xx with no canonical status. */
const DIRECT_CONFIRMATION_POLL_MS = 10_000;

export type DirectPaymentAsset =
  | { kind: "STX" }
  | { kind: "sBTC"; contractId: string; assetName: "sbtc-token" };

/**
 * Exact allowlist of assets a direct payment will sign for. Anything that is
 * not native STX or the canonical sBTC token for the wallet's network is
 * rejected before any network call — a 402 must never be able to route the
 * sender's key at an arbitrary contract.
 */
export function resolveDirectPaymentAsset(asset: string, network: Network): DirectPaymentAsset {
  // No normalization: the challenge terms go into the payment header verbatim,
  // so anything that needs trimming to match is refused rather than reshaped.
  // The native token symbol alone is matched case-insensitively, as
  // detectTokenType does for the sponsored path.
  const raw = typeof asset === "string" ? asset : "";
  if (/^stx$/i.test(raw)) {
    return { kind: "STX" };
  }
  const canonical = getContracts(network).SBTC_TOKEN;
  if (raw === canonical || raw === `${canonical}::sbtc-token`) {
    return { kind: "sBTC", contractId: canonical, assetName: "sbtc-token" };
  }
  throw new Error(
    `Direct x402 payment refused: endpoint asks for asset "${raw || "(empty)"}" but this client ` +
      `only signs native STX or the canonical sBTC token ${canonical} on ${network}.`
  );
}

export function parseDirectPaymentAmount(
  amount: string,
  asset: DirectPaymentAsset,
  policy: DirectPaymentPolicy
): bigint {
  const raw = typeof amount === "string" ? amount : "";
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `Direct x402 payment refused: amount must be a positive integer in atomic units, got "${amount}".`
    );
  }
  const value = BigInt(raw);
  const isSbtc = asset.kind === "sBTC";
  const capEnv = isSbtc ? "X402_MAX_SATS_PER_PAYMENT" : "X402_MAX_USTX_PER_PAYMENT";
  const cap = isSbtc ? policy.maxSatsPerPayment : policy.maxUstxPerPayment;
  if (value > cap) {
    throw new Error(
      `Direct x402 payment refused: ${value} ${isSbtc ? "sats" : "uSTX"} exceeds the per-payment cap of ` +
        `${cap}. If this cost is expected, raise ${capEnv}.`
    );
  }
  return value;
}

/**
 * Fail-closed fee for a direct payment: the medium mempool tier, clamped to
 * the per-type range and to X402_MAX_FEE_USTX. If Hiro cannot be reached no
 * fee is guessed — the payment is refused rather than signed with a number
 * that may never confirm.
 */
async function resolveDirectPaymentFee(
  network: Network,
  txType: keyof typeof DIRECT_FEE_CLAMPS,
  policy: DirectPaymentPolicy
): Promise<bigint> {
  let medium: number;
  try {
    const fees = await getHiroApi(network).getMempoolFees();
    medium = fees[txType].medium_priority;
  } catch (error) {
    throw new Error(
      `Direct x402 payment refused: could not fetch mempool fees from the Stacks API ` +
        `(${error instanceof Error ? error.message : String(error)}).`
    );
  }
  if (!Number.isFinite(medium) || medium < 0) {
    throw new Error(`Direct x402 payment refused: Stacks API returned an unusable ${txType} fee (${medium}).`);
  }
  const clamps = DIRECT_FEE_CLAMPS[txType];
  const configuredCeiling = policy.maxFeeUstx;
  if (configuredCeiling < clamps.floor) {
    // A cap under the floor is a refusal, not a request to sign at the floor.
    throw new Error(
      `Direct x402 payment refused: X402_MAX_FEE_USTX=${configuredCeiling} is below the minimum ` +
        `${txType} fee of ${clamps.floor} µSTX. Raise the cap or use X402_PAYMENT_MODE=sponsored.`
    );
  }
  const ceiling = configuredCeiling < clamps.ceiling ? configuredCeiling : clamps.ceiling;
  const raw = BigInt(Math.ceil(medium));
  if (raw < clamps.floor) return clamps.floor;
  if (raw > ceiling) return ceiling;
  return raw;
}

export interface DirectPaymentBuild {
  transaction: StacksTransactionWire;
  txid: string;
  fee: bigint;
  nonce: bigint;
  asset: DirectPaymentAsset;
  amount: bigint;
  /** What was booked on the daily ledger, and on which UTC day, so it can be released. */
  spends: Array<{ unit: SpendUnit; amount: bigint }>;
  spendDay: string;
}

/**
 * Failures that happen before a single request byte reaches the server: the
 * name did not resolve, the connection was refused, or TLS verification
 * failed (headers, including the payment, are only sent after the handshake).
 * Anything else — a reset, a timeout, an HTTP status — may have reached the
 * server and stays ambiguous.
 */
const NOT_SENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function requestWasNeverSent(error: unknown): boolean {
  const e = error as { response?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  if (!e || e.response) return false;
  const code = typeof e.code === "string" ? e.code : typeof e.cause?.code === "string" ? e.cause.code : "";
  return NOT_SENT_ERROR_CODES.has(code);
}

/**
 * Sponsored payments: refuse before signing when the wallet cannot cover the
 * price in the chosen asset. The relay pays gas, so no STX is needed for an
 * sBTC price. Without this check an unfunded wallet signs a transfer that only
 * fails at settlement. Unlike direct mode this fails open: if the Stacks API
 * cannot be read, the payment proceeds and settlement stays the backstop.
 */
export async function checkSponsoredPaymentBalance(
  account: Account,
  tokenType: "STX" | "sBTC",
  amount: bigint
): Promise<void> {
  let balances;
  try {
    balances = await getHiroApi(account.network).getAccountBalances(account.address);
  } catch {
    return;
  }
  const key = `${getContracts(account.network).SBTC_TOKEN}::sbtc-token`;
  const raw = tokenType === "sBTC" ? balances.fungible_tokens?.[key]?.balance : balances.stx?.balance;
  const balance = BigInt(raw ?? "0");
  if (balance >= amount) return;
  const shortfall = amount - balance;
  const format = tokenType === "sBTC" ? formatSbtc : formatStx;
  throw new InsufficientBalanceError(
    `Insufficient ${tokenType} for a sponsored x402 payment: need ${format(amount.toString())}, ` +
      `have ${format(balance.toString())} (shortfall: ${format(shortfall.toString())}). Nothing was signed.`,
    tokenType,
    balance.toString(),
    amount.toString(),
    shortfall.toString()
  );
}

/**
 * Build (sign, do not broadcast) a standard fee-paying transfer for a 402
 * challenge. Validates asset and amount, checks balances, fetches a
 * mempool-aware nonce, and pins the exact sBTC amount with a deny-mode
 * post-condition. Every step fails closed.
 */
export async function buildDirectPaymentTransaction(
  account: Account,
  option: { asset: string; amount: string; payTo: string; maxTimeoutSeconds?: number },
  policy: DirectPaymentPolicy,
  /** Request identity for the cross-process duplicate guard; omit to skip it (unit tests only). */
  requestKey?: string
): Promise<DirectPaymentBuild> {
  const asset = resolveDirectPaymentAsset(option.asset, account.network);
  const amount = parseDirectPaymentAmount(option.amount, asset, policy);
  const payTo = typeof option.payTo === "string" ? option.payTo : "";
  if (!/^S[PTMN][0-9A-Z]{28,41}$/.test(payTo)) {
    throw new Error(`Direct x402 payment refused: payTo "${option.payTo}" is not a standard Stacks principal.`);
  }
  if (
    option.maxTimeoutSeconds !== undefined &&
    !(typeof option.maxTimeoutSeconds === "number" && Number.isFinite(option.maxTimeoutSeconds) && option.maxTimeoutSeconds > 0)
  ) {
    throw new Error(
      `Direct x402 payment refused: maxTimeoutSeconds "${String(option.maxTimeoutSeconds)}" is not a positive number.`
    );
  }

  // Everything from the duplicate check to the ledger write happens under one
  // cross-process lock, so two direct clients racing on the same wallet
  // cannot both see "no prior payment / budget available" and sign twice.
  return withDirectPaymentLock(policy, async () => {
  // Same request, same payer, same terms, signed within the TTL: refuse with
  // the earlier txid. This is what stops "retry after an ambiguous failure"
  // from paying twice — the per-instance guard cannot, since callers build a
  // client per invocation.
  if (requestKey) {
    const prior = await checkDedup(requestKey, policy);
    if (prior) {
      const ageSeconds = Math.round((Date.now() - prior.timestamp) / 1000);
      throw new DuplicatePaymentError(
        `Direct x402 payment refused: an identical request was already paid ${ageSeconds}s ago ` +
          `(txid ${prior.txid}). Check that transaction before paying again; the guard clears after ` +
          `${Math.round(policy.dedupTtlMs / 1000)}s (X402_DEDUP_TTL_SECONDS).`,
        prior.txid,
        Date.now() - prior.timestamp
      );
    }
  }

  const txType = asset.kind === "sBTC" ? "contract_call" : "token_transfer";
  const fee = await resolveDirectPaymentFee(account.network, txType, policy);

  // Cumulative rail: today's ledger for this wallet must have room for the
  // price and the gas before anything is signed.
  const spends: Array<{ unit: SpendUnit; amount: bigint }> =
    asset.kind === "sBTC"
      ? [
          { unit: "sats", amount },
          { unit: "ustx", amount: fee },
        ]
      : [{ unit: "ustx", amount: amount + fee }];
  await checkSpend(account.address, spends, policy);

  const hiroApi = getHiroApi(account.network);
  let balances;
  try {
    balances = await hiroApi.getAccountBalances(account.address);
  } catch (error) {
    throw new Error(
      `Direct x402 payment refused: could not read the wallet balance from the Stacks API ` +
        `(${error instanceof Error ? error.message : String(error)}).`
    );
  }
  const stxBalance = BigInt(balances.stx?.balance ?? "0");
  const stxRequired = asset.kind === "STX" ? amount + fee : fee;
  if (stxBalance < stxRequired) {
    const shortfall = stxRequired - stxBalance;
    throw new InsufficientBalanceError(
      `Insufficient STX for a direct x402 payment: need ${formatStx(stxRequired.toString())} ` +
        `(${asset.kind === "STX" ? `${formatStx(amount.toString())} payment + ` : ""}${formatStx(fee.toString())} gas), ` +
        `have ${formatStx(stxBalance.toString())} (shortfall: ${formatStx(shortfall.toString())}). ` +
        `Direct payments need STX for gas even when the price is in sBTC.`,
      "STX",
      stxBalance.toString(),
      stxRequired.toString(),
      shortfall.toString()
    );
  }
  if (asset.kind === "sBTC") {
    const key = `${asset.contractId}::${asset.assetName}`;
    const sbtcBalance = BigInt(balances.fungible_tokens?.[key]?.balance ?? "0");
    if (sbtcBalance < amount) {
      const shortfall = amount - sbtcBalance;
      throw new InsufficientBalanceError(
        `Insufficient sBTC for a direct x402 payment: need ${formatSbtc(amount.toString())}, ` +
          `have ${formatSbtc(sbtcBalance.toString())} (shortfall: ${formatSbtc(shortfall.toString())}).`,
        "sBTC",
        sbtcBalance.toString(),
        amount.toString(),
        shortfall.toString()
      );
    }
  }

  // Mempool-aware nonce, fetched explicitly so a Stacks API failure refuses
  // the payment instead of silently falling back to the confirmed nonce.
  let nonce: bigint;
  try {
    const info = await hiroApi.getNonceInfo(account.address);
    nonce = BigInt(info.possible_next_nonce);
  } catch (error) {
    throw new Error(
      `Direct x402 payment refused: could not fetch the account nonce from the Stacks API ` +
        `(${error instanceof Error ? error.message : String(error)}).`
    );
  }

  const networkName = getStacksNetwork(account.network);
  let transaction: StacksTransactionWire;
  if (asset.kind === "sBTC") {
    const { address: contractAddress, name: contractName } = parseContractId(asset.contractId);
    transaction = await makeContractCall({
      contractAddress,
      contractName,
      functionName: "transfer",
      functionArgs: [uintCV(amount), principalCV(account.address), principalCV(payTo), noneCV()],
      senderKey: account.privateKey,
      network: networkName,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [
        createFungiblePostCondition(account.address, asset.contractId, asset.assetName, "eq", amount),
      ],
      fee,
      nonce,
    });
  } else {
    transaction = await makeSTXTokenTransfer({
      recipient: payTo,
      amount,
      senderKey: account.privateKey,
      network: networkName,
      memo: "",
      fee,
      nonce,
    });
  }

  // Record BEFORE the bytes leave the process: a crash between signing and the
  // paid request must still leave a trace, because the server may broadcast.
  const txid = transaction.txid();
  if (requestKey) await recordDedup(requestKey, txid, policy);
  const spendDay = await recordSpend(account.address, spends, policy);

  return { transaction, txid, fee, nonce, asset, amount, spends, spendDay };
  });
}

export type X402SettlementState = "submitted" | "confirmed" | "failed";

/** Direct-mode metadata attached to the paid response (or the error). */
export interface DirectPaymentMetadata {
  mode?: X402PaymentMode;
  txid?: string;
  txStatus?: string;
  settlementState?: X402SettlementState;
}

export function getDirectPaymentMetadata(target: unknown): DirectPaymentMetadata {
  const source = asMetadataTarget(target);
  return {
    mode: source.x402PaymentMode as X402PaymentMode | undefined,
    txid: typeof source.x402Txid === "string" ? source.x402Txid : undefined,
    txStatus: typeof source.x402TxStatus === "string" ? source.x402TxStatus : undefined,
    settlementState: source.x402SettlementState as X402SettlementState | undefined,
  };
}

function describeHttpFailure(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  if (!response) {
    return error instanceof Error ? error.message : String(error);
  }
  let body: string;
  try {
    body = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  } catch {
    body = String(response.data);
  }
  if (body.length > 2048) body = `${body.slice(0, 2048)}…`;
  return `HTTP ${response.status}: ${body}`;
}

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
export async function createApiClient(
  baseUrl?: string,
  diagnosticTool = "x402.api-client",
  options: CreateApiClientOptions = {}
): Promise<AxiosInstance> {
  const url = baseUrl || API_URL;
  // Resolved once per client so a bad value fails here, not mid-payment —
  // the mode, the preferred asset and, in direct mode, every cap, fee and
  // ledger setting.
  const paymentMode = resolvePaymentMode();
  const preferredAsset = resolvePreferredAsset(options.preferredAsset);
  const directPolicy = paymentMode === "direct" ? resolveDirectPaymentPolicy() : null;

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

        // Select the Stacks payment option: the first one by default, or the
        // first carrying the caller's preferred asset.
        const selectedOption = selectStacksPaymentOption(paymentRequired.accepts, preferredAsset);

        if (!selectedOption) {
          if (preferredAsset && paymentRequired.accepts.some((opt) => opt.network?.startsWith("stacks:"))) {
            const assets = paymentRequired.accepts
              .filter((opt) => opt.network?.startsWith("stacks:"))
              .map((opt) => opt.asset)
              .join(", ");
            return Promise.reject(
              new Error(
                `The endpoint does not accept ${preferredAsset} on Stacks. Offered assets: ${assets}. ` +
                  `Pay with one of those or drop the asset preference.`
              )
            );
          }
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

        let transaction: StacksTransactionWire;
        let directBuild: DirectPaymentBuild | null = null;
        let directRequestKey: string | null = null;
        if (paymentMode === "direct") {
          // The generic mismatch guard above lets an unparseable chain id through
          // (null !== network is skipped). Direct mode signs a real chain-bound
          // transaction, so the challenge must name this wallet's network exactly.
          if (paymentNetwork !== account.network) {
            return Promise.reject(
              new Error(
                `Direct x402 payment refused: endpoint network "${selectedOption.network}" is not ` +
                  `the wallet's network (${account.network}).`
              )
            );
          }
          // Standard fee-paying transfer; validation, caps, balance checks and
          // the duplicate/spend rails all live in the builder and fail closed.
          const requestConfig = error.config ?? {};
          const rawHeaders = requestConfig.headers as { toJSON?: () => Record<string, unknown> } | Record<string, unknown> | undefined;
          const requestKey = generatePaymentRequestKey({
            method: String(requestConfig.method ?? "get"),
            url: new URL(String(requestConfig.url ?? ""), requestConfig.baseURL ?? url).toString(),
            params: requestConfig.params,
            data: typeof requestConfig.data === "string" ? safeJsonTransform(requestConfig.data) : requestConfig.data,
            headers:
              rawHeaders && typeof (rawHeaders as { toJSON?: unknown }).toJSON === "function"
                ? (rawHeaders as { toJSON: () => Record<string, unknown> }).toJSON()
                : (rawHeaders as Record<string, unknown> | undefined),
            payer: account.address,
            payTo: selectedOption.payTo,
            amount: selectedOption.amount,
            asset: selectedOption.asset,
          });
          directBuild = await buildDirectPaymentTransaction(
            account,
            selectedOption,
            directPolicy as DirectPaymentPolicy,
            requestKey
          );
          directRequestKey = requestKey;
          transaction = directBuild.transaction;
        } else {
        // Build a sponsored signed transaction (relay pays gas; fee: 0n)
        const tokenType = detectTokenType(selectedOption.asset);
        const amount = BigInt(selectedOption.amount);
        const networkName = getStacksNetwork(account.network);
        await checkSponsoredPaymentBalance(account, tokenType, amount);

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
        }

        const txHex = "0x" + transaction.serialize();

        const paymentIdentifier = derivePaymentIdentifier(txHex);
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
        if (directBuild) {
          // Honour the 402's maxTimeoutSeconds: a paid replay that outlives it
          // is ambiguous (the server may still broadcast), never "safe to retry".
          const advertisedMs =
            typeof selectedOption.maxTimeoutSeconds === "number" && selectedOption.maxTimeoutSeconds > 0
              ? selectedOption.maxTimeoutSeconds * 1000
              : DEFAULT_PAID_REQUEST_TIMEOUT_MS;
          originalRequest.timeout = Math.min(
            originalRequest.timeout || DEFAULT_PAID_REQUEST_TIMEOUT_MS,
            advertisedMs
          );
        }

        let paidResponse;
        try {
          paidResponse = await axiosInstance.request(originalRequest);
        } catch (requestError) {
          const detail = describeHttpFailure(requestError);
          if (directBuild && directRequestKey && requestWasNeverSent(requestError)) {
            // The server was never reached, so the signed transfer never left
            // the process and cannot be broadcast. Undo the guard records so a
            // retry is not refused and today's budget is not consumed.
            const build = directBuild;
            const policy = directPolicy as DirectPaymentPolicy;
            let released = true;
            try {
              await clearDedup(directRequestKey, build.txid, policy);
              await releaseSpend(account.address, build.spends, build.spendDay, policy);
            } catch {
              released = false;
            }
            return Promise.reject(
              new Error(
                `x402 payment failed: the paid request never reached the server (${detail}). ` +
                  `Nothing was sent or paid; the signed transfer ${build.txid} was discarded.` +
                  (released
                    ? ""
                    : ` The duplicate guard / spend ledger could not be updated, so an immediate retry may be refused.`)
              )
            );
          }
          // The signed transfer has left the process. Whether the server broadcast
          // it is unknown from here, so say so and hand back the txid instead of
          // hiding the server's answer (skills #417).
          // Sponsored keeps its historical "x402 payment failed: …" prefix; only
          // the detail after it changes (server status + body instead of the bare
          // axios message). Direct gets an explicit ambiguity message + txid.
          const failure = new Error(
            directBuild
              ? `x402 paid request failed after the signed transfer was sent (${detail}). ` +
                `Settlement is ambiguous: check txid ${directBuild.txid} on the explorer before paying again.`
              : `x402 payment failed: ${detail}`
          );
          if (directBuild) {
            const meta = asMetadataTarget(failure);
            meta.x402PaymentMode = paymentMode;
            meta.x402Txid = directBuild.txid;
            meta.x402SettlementState = "submitted";
          }
          return Promise.reject(failure);
        }
        if (directBuild) {
          const meta = asMetadataTarget(paidResponse);
          meta.x402PaymentMode = paymentMode;
          meta.x402Txid = directBuild.txid;
          meta.x402SettlementState = "submitted";
        }
        // A 2xx means the server received the payment and delivered: the
        // outcome is no longer ambiguous, so an identical request from here on
        // is a new purchase, not a retry. Keep the record only when the
        // canonical status says the payment failed (below).
        const settleDedup = async () => {
          if (!directBuild || !directRequestKey) return;
          try {
            await clearDedup(directRequestKey, directBuild.txid, directPolicy as DirectPaymentPolicy);
          } catch {
            // Leaving the record only makes the guard stricter for its TTL.
          }
        };
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
          if (directBuild) {
            // A 2xx is delivery, not settlement. Look at the chain briefly and
            // report what it says; "pending" stays "submitted".
            const confirmation = await pollTransactionConfirmation(
              directBuild.txid,
              account.network,
              DIRECT_CONFIRMATION_POLL_MS
            );
            const meta = asMetadataTarget(paidResponse);
            meta.x402TxStatus = confirmation.status;
            meta.x402SettlementState =
              confirmation.status === "success"
                ? "confirmed"
                : confirmation.status === "pending"
                  ? "submitted"
                  : "failed";
          }
          await settleDedup();
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
          await settleDedup();
          return paidResponse;
        }

        const canonicalError = new Error(
          "x402 payment failed after the paid request returned. " +
            formatCanonicalPaymentStatusForError(paymentStatusBaseUrl, canonicalStatus, outcome) +
            (directBuild ? `\ndirectTxid: ${directBuild.txid}` : "")
        );
        attachCanonicalPaymentMetadata(
          asMetadataTarget(canonicalError),
          paymentStatusBaseUrl,
          canonicalStatus,
          outcome
        );
        if (directBuild) {
          // The signed transfer already left the process; keep its identity on
          // the error even when the canonical status omits a txid.
          const meta = asMetadataTarget(canonicalError);
          meta.x402PaymentMode = paymentMode;
          meta.x402Txid = directBuild.txid;
          meta.x402SettlementState = "submitted";
        }
        return Promise.reject(
          canonicalError
        );
      } catch (paymentError) {
        if (
          paymentError instanceof InsufficientBalanceError ||
          paymentError instanceof DuplicatePaymentError ||
          paymentError instanceof SpendLimitError ||
          (paymentError instanceof Error &&
            (asMetadataTarget(paymentError).x402PaymentStatus ||
              asMetadataTarget(paymentError).x402PaymentId ||
              asMetadataTarget(paymentError).x402Txid))
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
 * @deprecated In-memory and unused by the payment flow. Direct-mode payments
 * use the persisted guard in ./x402-guards.ts (`generateDedupKey` there).
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
 * @deprecated See `generateDedupKey`.
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
 * @deprecated See `generateDedupKey`.
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
