/**
 * x402 Recovery Utilities
 *
 * Helpers for extracting transaction IDs from payment-signature headers
 * and polling transaction confirmation status.
 *
 * Used by inbox.tools.ts and endpoint.tools.ts to provide txid recovery
 * info when settlement fails after payment was submitted.
 */

import { deserializeTransaction } from "@stacks/transactions";
import { getHiroApi } from "../services/hiro-api.js";
import { type Network, getExplorerTxUrl } from "../config/networks.js";
import { decodePaymentPayload } from "./x402-protocol.js";

// ============================================================================
// Txid Extraction
// ============================================================================

/**
 * Extract the transaction ID from a base64-encoded payment-signature header.
 *
 * The payment-signature header is a base64-encoded JSON PaymentPayloadV2 object
 * whose payload.transaction field contains the signed transaction hex.
 *
 * Returns the txid string (64-char hex, no 0x prefix), or null if extraction fails.
 */
export function extractTxidFromPaymentSignature(
  paymentSignatureHeader: string
): string | null {
  try {
    const payload = decodePaymentPayload(paymentSignatureHeader);
    if (!payload?.payload?.transaction) {
      return null;
    }

    const txHex = payload.payload.transaction;
    // Strip leading 0x if present
    const hexWithout0x = txHex.startsWith("0x") ? txHex.slice(2) : txHex;
    const txBytes = Buffer.from(hexWithout0x, "hex");

    const tx = deserializeTransaction(txBytes);
    return tx.txid();
  } catch {
    return null;
  }
}

// ============================================================================
// Transaction Polling
// ============================================================================

export interface TransactionConfirmationResult {
  txid: string;
  status: string;
  block_height?: number;
  tx_result?: unknown;
  explorer: string;
}

/**
 * Poll transaction status until it leaves the pending/mempool state or timeout is reached.
 *
 * Uses getHiroApi so the configured Hiro API key is included in requests.
 *
 * @param txid - Transaction ID (hex, with or without 0x)
 * @param network - Stacks network
 * @param maxWaitMs - Maximum total time to wait (default: 10000ms)
 * @param intervalMs - Polling interval (default: 2000ms)
 * @returns Transaction confirmation result with status
 */
export async function pollTransactionConfirmation(
  txid: string,
  network: Network,
  maxWaitMs = 10_000,
  intervalMs = 2_000
): Promise<TransactionConfirmationResult> {
  const hiroApi = getHiroApi(network);
  const normalizedTxid = txid.startsWith("0x") ? txid.slice(2) : txid;
  const explorerUrl = getExplorerTxUrl(normalizedTxid, network);

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const status = await hiroApi.getTransactionStatus(normalizedTxid);
      if (status.status !== "pending") {
        return {
          txid: normalizedTxid,
          status: status.status,
          block_height: status.block_height,
          tx_result: status.tx_result,
          explorer: explorerUrl,
        };
      }
    } catch {
      // Transaction not yet indexed — still pending
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }

  return {
    txid: normalizedTxid,
    status: "pending",
    explorer: explorerUrl,
  };
}
