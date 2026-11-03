/**
 * POST a JSON body to an x402 endpoint that sponsors gas (its 402 names an
 * `extra.feePayer`), paying the sBTC price from the active wallet.
 *
 * Unlike `createApiClient`, every step is visible to the caller, so a caller
 * with its own budget can book the exact price before anything is signed:
 *
 *   probe (free) → beforePay(price) → balance check → book the shared daily
 *   spend ledger → sign → paid request
 *
 * The spend ledger is `~/.aibtc/spend-state.json`, shared with the direct
 * payment path and the aibtc MCP server, so a sponsored payment made here
 * still counts against the wallet's one daily cap. A booking is released only
 * when the signed payment provably never left the process; once the paid
 * request is sent the endpoint may settle it, so the booking stands.
 */

import { NETWORK } from "../config/networks.js";
import { getNetworkFromStacksChainId } from "../config/caip.js";
import type { Account } from "../transactions/builder.js";
import {
  buildPaymentIdentifierExtension,
  decodePaymentRequired,
  decodePaymentResponse,
  derivePaymentIdentifier,
  encodePaymentPayload,
  X402_HEADERS,
  type PaymentRequirementsV2,
} from "../utils/x402-protocol.js";
import { checkSpend, recordSpend, releaseSpend, resolveDirectPaymentPolicy, withDirectPaymentLock } from "./x402-guards.js";
import {
  buildSponsoredSbtcTransfer,
  checkSponsoredPaymentBalance,
  resolveSponsoredPaymentTokenType,
  selectStacksPaymentOption,
} from "./x402.service.js";

const PROBE_TIMEOUT_MS = 30_000;
const PAID_REQUEST_TIMEOUT_MS = 120_000;

export type SponsoredPostResult =
  | { paid: false; status: number; text: string }
  | { paid: true; status: number; text: string; accept: PaymentRequirementsV2; txid?: string };

/** A failure after the signed payment was sent: the endpoint may have settled it. */
export class PaidRequestError extends Error {
  readonly paymentSent = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaidRequestError";
  }
}

export function paymentWasSent(error: unknown): boolean {
  return error instanceof PaidRequestError;
}

export async function postWithSponsoredPayment(options: {
  account: Account;
  url: string;
  body: unknown;
  /** Runs after the probe, before anything is signed. Throw to refuse the price. */
  beforePay?: (accept: PaymentRequirementsV2) => Promise<void>;
}): Promise<SponsoredPostResult> {
  const { account, url, body, beforePay } = options;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

  // A bare POST never charges: read the payment requirements.
  const probe = await fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (probe.status !== 402) {
    const text = await probe.text();
    if (probe.ok) return { paid: false, status: probe.status, text };
    throw new Error(`Expected 402 payment challenge, got ${probe.status}: ${text.slice(0, 300)}`);
  }

  const paymentRequired = decodePaymentRequired(probe.headers.get(X402_HEADERS.PAYMENT_REQUIRED));
  if (!paymentRequired?.accepts?.length) {
    throw new Error("402 response missing or empty payment-required header");
  }
  const accept = selectStacksPaymentOption(paymentRequired.accepts, "sBTC");
  if (!accept) {
    throw new Error(
      `The endpoint offers no sBTC payment on Stacks. Offered: ${paymentRequired.accepts.map((a) => `${a.asset} on ${a.network}`).join(", ")}`
    );
  }
  if (getNetworkFromStacksChainId(accept.network) !== NETWORK) {
    throw new Error(`Network mismatch: endpoint asks for payment on ${accept.network}, wallet is on ${NETWORK}.`);
  }
  // Refuse anything we would not pay exactly as asked (#419).
  if (resolveSponsoredPaymentTokenType(accept.asset, NETWORK) !== "sBTC") {
    throw new Error(`Expected an sBTC price, got asset ${accept.asset}.`);
  }
  if (typeof accept.extra?.feePayer !== "string") {
    throw new Error("The endpoint does not sponsor gas (no extra.feePayer in its 402); refusing to sign a fee-0 transfer it cannot settle.");
  }
  const amount = BigInt(accept.amount);

  if (beforePay) await beforePay(accept);
  await checkSponsoredPaymentBalance(account, "sBTC", amount);

  const policy = resolveDirectPaymentPolicy();
  const spends = [{ unit: "sats" as const, amount }];
  const spendDay = await withDirectPaymentLock(policy, async () => {
    await checkSpend(account.address, spends, policy);
    return recordSpend(account.address, spends, policy);
  });

  let paymentSignature: string;
  try {
    const transaction = await buildSponsoredSbtcTransfer(account, accept.payTo, amount);
    const txHex = "0x" + transaction.serialize();
    paymentSignature = encodePaymentPayload({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: accept,
      payload: { transaction: txHex },
      extensions: buildPaymentIdentifierExtension(derivePaymentIdentifier(txHex, account.privateKey)),
    });
  } catch (error) {
    // Nothing left the process: give today's budget back.
    await releaseSpend(account.address, spends, spendDay, policy);
    throw error;
  }

  const timeoutMs = Math.min(
    PAID_REQUEST_TIMEOUT_MS,
    accept.maxTimeoutSeconds > 0 ? accept.maxTimeoutSeconds * 1000 : PAID_REQUEST_TIMEOUT_MS
  );
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...init.headers, [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature },
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (error) {
    throw new PaidRequestError(
      `Paid request failed after the signed payment was sent (${error instanceof Error ? error.message : String(error)}); it may still settle.`,
      { cause: error }
    );
  }
  if (!res.ok) {
    throw new PaidRequestError(`Paid request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const settlement = decodePaymentResponse(res.headers.get(X402_HEADERS.PAYMENT_RESPONSE));
  return {
    paid: true,
    status: res.status,
    text,
    accept,
    ...(settlement?.transaction && { txid: settlement.transaction }),
  };
}
