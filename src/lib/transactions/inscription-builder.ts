/**
 * Inscription transaction building
 *
 * Implements the commit/reveal pattern for Bitcoin inscriptions using micro-ordinals.
 * Uses @scure/btc-signer for Taproot (P2TR) transactions.
 *
 * Reference: https://github.com/paulmillr/micro-ordinals
 */

import * as btc from "@scure/btc-signer";
import { p2tr_ord_reveal } from "micro-ordinals";
import type { Network } from "../config/networks.js";
import {
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  P2TR_OUTPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
  DUST_THRESHOLD,
  P2TR_INPUT_BASE_VBYTES,
} from "../config/bitcoin-constants.js";
import type { UTXO } from "../services/mempool-api.js";

/**
 * Inscription data structure
 */
export interface InscriptionData {
  /**
   * Content type (MIME type, e.g., "text/plain", "image/png")
   */
  contentType: string;
  /**
   * Content body as Uint8Array
   */
  body: Uint8Array;
}

/**
 * Options for building a commit transaction
 */
export interface BuildCommitTransactionOptions {
  /**
   * UTXOs to fund the commit transaction
   */
  utxos: UTXO[];
  /**
   * Inscription data to commit
   */
  inscription: InscriptionData;
  /**
   * Fee rate in sat/vB for the commit transaction
   */
  feeRate: number;
  /**
   * Sender's public key (compressed, 33 bytes)
   */
  senderPubKey: Uint8Array;
  /**
   * Sender's address for change output
   */
  senderAddress: string;
  /**
   * Network (mainnet or testnet)
   */
  network: Network;
}

/**
 * Result from building a commit transaction
 */
export interface BuildCommitTransactionResult {
  /**
   * Unsigned commit transaction object (ready for signing)
   */
  tx: btc.Transaction;
  /**
   * Fee paid in satoshis
   */
  fee: number;
  /**
   * Taproot reveal address (where commit tx sends funds)
   */
  revealAddress: string;
  /**
   * Amount sent to reveal address (in satoshis)
   */
  revealAmount: number;
  /**
   * Taproot P2TR output for reveal transaction
   */
  revealScript: ReturnType<typeof btc.p2tr>;
}

/**
 * Options for building a reveal transaction
 */
export interface BuildRevealTransactionOptions {
  /**
   * Commit transaction ID
   */
  commitTxid: string;
  /**
   * Output index in commit transaction (usually 0)
   */
  commitVout: number;
  /**
   * Amount in the commit output (satoshis)
   */
  commitAmount: number;
  /**
   * Taproot P2TR output from commit transaction
   */
  revealScript: ReturnType<typeof btc.p2tr>;
  /**
   * Recipient address for the inscription (Taproot address to receive)
   */
  recipientAddress: string;
  /**
   * Fee rate in sat/vB for the reveal transaction
   */
  feeRate: number;
  /**
   * Network (mainnet or testnet)
   */
  network: Network;
}

/**
 * Result from building a reveal transaction
 */
export interface BuildRevealTransactionResult {
  /**
   * Unsigned reveal transaction object (ready for signing)
   */
  tx: btc.Transaction;
  /**
   * Fee paid in satoshis
   */
  fee: number;
  /**
   * Amount sent to recipient (in satoshis)
   */
  outputAmount: number;
}


/**
 * Get the @scure/btc-signer network object for a network name
 */
function getBtcNetwork(network: Network): typeof btc.NETWORK {
  return network === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
}

/**
 * Build a commit transaction for an inscription
 *
 * The commit transaction sends funds to a Taproot address derived from the
 * inscription reveal script. This locks the funds until the reveal transaction
 * is broadcast.
 *
 * @param options - Commit transaction building options
 * @returns Unsigned commit transaction and reveal script
 * @throws Error if insufficient funds or invalid parameters
 *
 * @example
 * ```typescript
 * const inscription = {
 *   contentType: "text/plain",
 *   body: new TextEncoder().encode("Hello, Ordinals!"),
 *   compress: true,
 * };
 *
 * const result = buildCommitTransaction({
 *   utxos: [...],
 *   inscription,
 *   feeRate: 10,
 *   senderPubKey: pubKeyBytes,
 *   senderAddress: "bc1q...",
 *   network: "mainnet",
 * });
 * ```
 */
export function buildCommitTransaction(
  options: BuildCommitTransactionOptions
): BuildCommitTransactionResult {
  const { utxos, inscription, feeRate, senderPubKey, senderAddress, network } =
    options;

  // Validate inputs
  if (utxos.length === 0) {
    throw new Error("No UTXOs provided");
  }
  if (feeRate <= 0) {
    throw new Error("Fee rate must be positive");
  }
  if (!inscription.contentType) {
    throw new Error("Content type is required");
  }
  if (!inscription.body || inscription.body.length === 0) {
    throw new Error("Content body is required");
  }
  if (senderPubKey.length !== 33) {
    throw new Error("Sender public key must be 33 bytes (compressed)");
  }

  // Sort UTXOs by value descending for better coin selection
  const sortedUtxos = [...utxos]
    .filter((utxo) => utxo.status.confirmed)
    .sort((a, b) => b.value - a.value);

  if (sortedUtxos.length === 0) {
    throw new Error("No confirmed UTXOs available");
  }

  // Create inscription reveal script using micro-ordinals
  // p2tr_ord_reveal returns { type: 'tr', script: Uint8Array }
  const btcNetwork = getBtcNetwork(network);
  const inscriptionData = {
    tags: { contentType: inscription.contentType },
    body: inscription.body,
  };

  // Convert compressed pubkey (33 bytes) to x-only pubkey (32 bytes) for Taproot
  // Compressed format: 1 byte prefix (02/03) + 32 bytes x-coordinate
  const xOnlyPubkey = senderPubKey.slice(1);

  const revealScriptData = p2tr_ord_reveal(xOnlyPubkey, [inscriptionData]);

  // Create P2TR output from the reveal script
  // For script path spending, we use the internal pubkey and the script tree
  const p2trReveal = btc.p2tr(xOnlyPubkey, revealScriptData, btcNetwork);

  if (!p2trReveal.address) {
    throw new Error("Failed to generate reveal address");
  }

  // Estimate reveal transaction size to determine commit amount
  // Reveal tx: 1 input (Taproot with inscription witness) + 1 output (recipient)
  // The witness includes the inscription data plus script & control-block overhead
  const revealInputSize = P2TR_INPUT_BASE_VBYTES; // Taproot input base size (vbytes)
  const WITNESS_OVERHEAD_VBYTES = 80; // Control block + script + protocol framing
  const revealWitnessSize =
    Math.ceil((inscription.body.length / 4) * 1.25) + WITNESS_OVERHEAD_VBYTES;
  const revealTxSize = TX_OVERHEAD_VBYTES + revealInputSize + revealWitnessSize + P2TR_OUTPUT_VBYTES;
  const revealFee = Math.ceil(revealTxSize * feeRate);

  // Amount to send to reveal address (must cover reveal fee + dust for output)
  const revealAmount = revealFee + DUST_THRESHOLD + 1000; // Extra padding for reveal output

  // Calculate total available
  const totalAvailable = sortedUtxos.reduce((sum, utxo) => sum + utxo.value, 0);

  // Estimate commit transaction size with change output
  const estimatedVsize =
    TX_OVERHEAD_VBYTES +
    sortedUtxos.length * P2WPKH_INPUT_VBYTES +
    P2TR_OUTPUT_VBYTES + // Reveal output
    P2WPKH_OUTPUT_VBYTES; // Change output

  const estimatedFee = Math.ceil(estimatedVsize * feeRate);

  // Check if we have enough funds
  const requiredTotal = revealAmount + estimatedFee;
  if (totalAvailable < requiredTotal) {
    throw new Error(
      `Insufficient funds: have ${totalAvailable} sats, need ${requiredTotal} sats (${revealAmount} reveal + ${estimatedFee} commit fee)`
    );
  }

  // Select UTXOs using simple accumulator
  let selectedTotal = 0;
  const selectedUtxos: UTXO[] = [];

  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    selectedTotal += utxo.value;

    if (selectedTotal >= requiredTotal) {
      break;
    }
  }

  // Final calculation
  const finalVsize =
    TX_OVERHEAD_VBYTES +
    selectedUtxos.length * P2WPKH_INPUT_VBYTES +
    P2TR_OUTPUT_VBYTES +
    P2WPKH_OUTPUT_VBYTES;

  const finalFee = Math.ceil(finalVsize * feeRate);
  const changeAmount = selectedTotal - revealAmount - finalFee;

  // Verify we still have enough
  if (selectedTotal < revealAmount + finalFee) {
    throw new Error(
      `Insufficient funds after UTXO selection: have ${selectedTotal} sats, need ${revealAmount + finalFee} sats`
    );
  }

  // Check if change is above dust
  if (changeAmount < DUST_THRESHOLD) {
    throw new Error(
      `Change amount ${changeAmount} is below dust threshold (${DUST_THRESHOLD} sats). Need more UTXOs or lower fee rate.`
    );
  }

  // Build the commit transaction
  const tx = new btc.Transaction();

  // Create sender's P2WPKH script for inputs
  const senderP2wpkh = btc.p2wpkh(senderPubKey, btcNetwork);

  // Add inputs
  for (const utxo of selectedUtxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: senderP2wpkh.script,
        amount: BigInt(utxo.value),
      },
    });
  }

  // Add reveal output (Taproot address from reveal script)
  tx.addOutputAddress(p2trReveal.address, BigInt(revealAmount), btcNetwork);

  // Add change output
  tx.addOutputAddress(senderAddress, BigInt(changeAmount), btcNetwork);

  return {
    tx,
    fee: finalFee,
    revealAddress: p2trReveal.address,
    revealAmount,
    revealScript: p2trReveal,
  };
}

/**
 * Build a reveal transaction for an inscription
 *
 * The reveal transaction spends the commit output and includes the inscription
 * data in the witness. This creates the inscription on-chain.
 *
 * @param options - Reveal transaction building options
 * @returns Unsigned reveal transaction
 * @throws Error if invalid parameters
 *
 * @example
 * ```typescript
 * const result = buildRevealTransaction({
 *   commitTxid: "abc123...",
 *   commitVout: 0,
 *   commitAmount: 10000,
 *   revealScript: revealScriptFromCommit,
 *   recipientAddress: "bc1p...",
 *   feeRate: 10,
 *   network: "mainnet",
 * });
 * ```
 */
export function buildRevealTransaction(
  options: BuildRevealTransactionOptions
): BuildRevealTransactionResult {
  const {
    commitTxid,
    commitVout,
    commitAmount,
    revealScript,
    recipientAddress,
    feeRate,
    network,
  } = options;

  // Validate inputs
  if (!commitTxid || commitTxid.length !== 64) {
    throw new Error("Invalid commit transaction ID");
  }
  if (commitVout < 0) {
    throw new Error("Invalid commit output index");
  }
  if (commitAmount <= 0) {
    throw new Error("Commit amount must be positive");
  }
  if (feeRate <= 0) {
    throw new Error("Fee rate must be positive");
  }

  // Estimate reveal transaction size
  // 1 input (Taproot with inscription witness) + 1 output (recipient)
  const revealInputSize = P2TR_INPUT_BASE_VBYTES;
  const revealWitnessSize = Math.ceil(
    (revealScript.script?.byteLength || 0) / 4
  );
  const revealTxSize =
    TX_OVERHEAD_VBYTES + revealInputSize + revealWitnessSize + P2TR_OUTPUT_VBYTES;
  const revealFee = Math.ceil(revealTxSize * feeRate);

  // Calculate output amount
  const outputAmount = commitAmount - revealFee;

  if (outputAmount < DUST_THRESHOLD) {
    throw new Error(
      `Output amount ${outputAmount} is below dust threshold (${DUST_THRESHOLD} sats)`
    );
  }

  // Build the reveal transaction
  const btcNetwork = getBtcNetwork(network);
  const tx = new btc.Transaction();

  // Add input spending from commit transaction
  // For Taproot script path spending, we need to provide the witness data
  tx.addInput({
    txid: commitTxid,
    index: commitVout,
    witnessUtxo: {
      script: revealScript.script,
      amount: BigInt(commitAmount),
    },
    // Include taproot script path info for script-path spending
    ...revealScript.tapLeafScript,
  });

  // Add output to recipient (Taproot address)
  tx.addOutputAddress(recipientAddress, BigInt(outputAmount), btcNetwork);

  return {
    tx,
    fee: revealFee,
    outputAmount,
  };
}
