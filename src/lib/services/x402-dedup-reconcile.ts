/**
 * Reconcile an expired duplicate-guard record against the chain (#460).
 *
 * A record outlives the TTL only when its payment's outcome was ambiguous:
 * the paid request failed, timed out, or the process died after the signed
 * bytes left it. Past the TTL the guard used to forget the record, so a retry
 * at minute 16 paid again even when the first payment had landed. Instead
 * the record is checked here, and a new payment is allowed only once the
 * earlier one provably can never settle.
 *
 * The stored txid alone cannot prove that: a transfer can be replaced at the
 * same sender nonce (a re-sign with a higher fee), so the original txid reads
 * "dropped" while the payment landed under another txid. So the rule keys on
 * the sender nonce `n` the payment was signed at, and on the payment's intent
 * (payer, recipient, amount, asset):
 *
 * | Chain state                                          | Verdict               |
 * |------------------------------------------------------|-----------------------|
 * | stored txid `success`                                | paid (refuse)         |
 * | stored txid pending                                  | refuse                |
 * | stored txid `abort_*`                                | clear — n is consumed |
 * |   by this very transaction, so the bytes can never land                     |
 * | stored txid dropped / unknown, then by nonce n:                              |
 * |   a tx at n is pending                               | refuse                |
 * |   n executed by a tx matching the intent, `success`  | paid (refuse)         |
 * |   n executed by a tx matching the intent, `abort_*`  | clear                 |
 * |   n executed by a tx that does not match the intent  | clear — this payment  |
 * |     was signed at n, so it can never land                                   |
 * |   n executed, but no tx at n found yet               | refuse (indexer lag)  |
 * |   n unused and it is the next nonce                  | clear, and the new    |
 * |     payment must be signed at n, so at most one of the two can ever land    |
 * |   n unused behind a nonce gap                        | refuse — the old      |
 * |     payment can still land once the gap fills                               |
 * | any lookup fails, or the record has no nonce         | refuse (fail closed)  |
 *
 * The chain reader is injected so the rule can be tested without a network.
 */

import type { DedupEntry } from "./x402-guards.js";

/** The subset of a Hiro transaction object this rule reads. */
export interface ChainTx {
  tx_id: string;
  tx_status: string;
  tx_type?: string;
  nonce?: number;
  sender_address?: string;
  token_transfer?: { recipient_address?: string; amount?: string };
  contract_call?: {
    contract_id?: string;
    function_name?: string;
    function_args?: Array<{ repr?: string }>;
  };
}

export interface ChainNonceInfo {
  last_executed_tx_nonce: number | null;
  possible_next_nonce: number;
  detected_mempool_nonces?: number[];
}

export interface DedupChainReader {
  /** The transaction, or null when the API has never seen it (404). Throws on any other failure. */
  getTransaction(txid: string): Promise<ChainTx | null>;
  getNonceInfo(address: string): Promise<ChainNonceInfo>;
  /** The transaction `address` sent at `nonce` (confirmed or pending), or null if none is indexed. */
  findTransactionByNonce(address: string, nonce: number): Promise<ChainTx | null>;
}

/** What the earlier payment was meant to do. `asset` is "STX" or the token contract id. */
export interface PaymentIntent {
  payer: string;
  payTo: string;
  amount: bigint;
  asset: string;
}

export type ReconcileVerdict =
  | { action: "paid"; paidTxid: string; reason: string }
  | { action: "refuse"; reason: string }
  /** `requireNonce`: the new payment must be signed at exactly this nonce. */
  | { action: "clear"; reason: string; requireNonce?: bigint };

const normalizeTxid = (txid: string) => txid.toLowerCase().replace(/^0x/, "");

function isAbort(status: string): boolean {
  return status.startsWith("abort_");
}

function isDropped(status: string): boolean {
  return status.startsWith("dropped_");
}

/** True when `tx` moves exactly `intent.amount` of `intent.asset` from the payer to `intent.payTo`. */
export function txMatchesIntent(tx: ChainTx, intent: PaymentIntent): boolean {
  if (tx.sender_address !== undefined && tx.sender_address !== intent.payer) return false;
  if (intent.asset === "STX") {
    const transfer = tx.token_transfer;
    if (tx.tx_type !== "token_transfer" || !transfer) return false;
    try {
      return transfer.recipient_address === intent.payTo && BigInt(transfer.amount ?? "-1") === intent.amount;
    } catch {
      return false;
    }
  }
  const call = tx.contract_call;
  if (tx.tx_type !== "contract_call" || !call) return false;
  if (call.contract_id !== intent.asset || call.function_name !== "transfer") return false;
  const args = call.function_args ?? [];
  return (
    args[0]?.repr === `u${intent.amount}` &&
    args[1]?.repr === `'${intent.payer}` &&
    args[2]?.repr === `'${intent.payTo}`
  );
}

/**
 * Decide what an expired record means. Never throws: a failed lookup is a
 * "refuse" verdict that says why.
 */
export async function reconcileDedupEntry(
  entry: DedupEntry,
  intent: PaymentIntent,
  reader: DedupChainReader
): Promise<ReconcileVerdict> {
  try {
    return await decide(entry, intent, reader);
  } catch (error) {
    return {
      action: "refuse",
      reason:
        `the Stacks API could not be read to check it ` +
        `(${error instanceof Error ? error.message : String(error)}); retry once the API answers`,
    };
  }
}

async function decide(entry: DedupEntry, intent: PaymentIntent, reader: DedupChainReader): Promise<ReconcileVerdict> {
  const txid = entry.txid;
  const tx = await reader.getTransaction(txid);

  if (tx) {
    if (tx.tx_status === "success") {
      return { action: "paid", paidTxid: txid, reason: `transaction ${txid} confirmed` };
    }
    if (tx.tx_status === "pending") {
      return { action: "refuse", reason: `transaction ${txid} is still pending in the mempool` };
    }
    if (isAbort(tx.tx_status)) {
      // Our own transaction consumed nonce n without moving funds, so the
      // signed bytes can never be mined again.
      return {
        action: "clear",
        reason: `transaction ${txid} failed on chain (${tx.tx_status}); no funds moved and it cannot be mined again`,
      };
    }
    if (!isDropped(tx.tx_status)) {
      return { action: "refuse", reason: `transaction ${txid} has an unrecognized status "${tx.tx_status}"` };
    }
  }

  // Dropped, or never seen: only the sender nonce can tell whether the
  // payment (or a replacement of it) landed.
  const nonceText = entry.nonce ?? (typeof tx?.nonce === "number" ? String(tx.nonce) : undefined);
  if (nonceText === undefined) {
    return {
      action: "refuse",
      reason:
        `transaction ${txid} is ${tx ? `dropped (${tx.tx_status})` : "unknown to the Stacks API"} and this ` +
        `record predates nonce tracking, so whether a replacement landed cannot be checked. ` +
        `Verify the wallet's recent transactions by hand, then run: bun run x402/x402.ts clear-dedup --txid ${txid}`,
    };
  }
  const n = Number(nonceText);
  const seen = tx ? `dropped (${tx.tx_status})` : "unknown to the Stacks API";

  const info = await reader.getNonceInfo(intent.payer);
  if ((info.detected_mempool_nonces ?? []).includes(n)) {
    return {
      action: "refuse",
      reason: `transaction ${txid} is ${seen}, but a transaction at its nonce ${n} is pending; retry once it confirms`,
    };
  }

  const lastExecuted = info.last_executed_tx_nonce;
  if (lastExecuted !== null && lastExecuted !== undefined && n <= lastExecuted) {
    const atNonce = await reader.findTransactionByNonce(intent.payer, n);
    if (!atNonce) {
      return {
        action: "refuse",
        reason:
          `transaction ${txid} is ${seen} and nonce ${n} has been used, but the transaction at nonce ${n} ` +
          `is not indexed yet; retry in a few minutes`,
      };
    }
    const filler = normalizeTxid(atNonce.tx_id);
    if (!txMatchesIntent(atNonce, intent)) {
      return {
        action: "clear",
        reason:
          `nonce ${n} was used by an unrelated transaction ${filler}, so the payment signed at that nonce ` +
          `(${txid}) can never be mined`,
      };
    }
    if (atNonce.tx_status === "success") {
      return {
        action: "paid",
        paidTxid: filler,
        reason: filler === txid ? `transaction ${txid} confirmed` : `a replacement payment ${filler} at nonce ${n} confirmed`,
      };
    }
    if (isAbort(atNonce.tx_status)) {
      return {
        action: "clear",
        reason: `the payment at nonce ${n} (${filler}) failed on chain (${atNonce.tx_status}); no funds moved`,
      };
    }
    return {
      action: "refuse",
      reason: `the payment at nonce ${n} (${filler}) has status "${atNonce.tx_status}"; retry once it settles`,
    };
  }

  // Nonce n has not been executed and nothing is pending at it.
  if (info.possible_next_nonce === n) {
    return {
      action: "clear",
      reason:
        `transaction ${txid} is ${seen} and its nonce ${n} is still unused; the new payment is signed at ` +
        `nonce ${n} so at most one of the two can ever be mined`,
      requireNonce: BigInt(n),
    };
  }
  if (info.possible_next_nonce < n) {
    return {
      action: "refuse",
      reason:
        `transaction ${txid} is ${seen} and its nonce ${n} is unused, but nonces ` +
        `${info.possible_next_nonce}..${n - 1} are missing; if the server still holds the signed bytes it can ` +
        `land once that gap fills. Fill the gap (nonce tools) or wait, then retry`,
    };
  }
  return {
    action: "refuse",
    reason:
      `the Stacks API reports next nonce ${info.possible_next_nonce} but no executed or pending ` +
      `transaction at nonce ${n}; retry in a few minutes`,
  };
}
