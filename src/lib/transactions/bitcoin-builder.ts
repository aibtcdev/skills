/**
 * Bitcoin transaction building and signing
 *
 * Uses @scure/btc-signer for P2WPKH (native SegWit) transactions.
 * Follows Leather/Xverse wallet patterns.
 */

import * as btc from "@scure/btc-signer";
import type { Network } from "../config/networks.js";
import {
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
  DUST_THRESHOLD,
} from "../config/bitcoin-constants.js";
import type { UTXO } from "../services/mempool-api.js";

/**
 * Options for building a Bitcoin transaction
 */
export interface BuildBtcTransactionOptions {
  /**
   * UTXOs to spend from
   */
  utxos: UTXO[];
  /**
   * Recipient Bitcoin address (bc1q... or tb1q...)
   */
  recipient: string;
  /**
   * Amount to send in satoshis
   */
  amount: number;
  /**
   * Fee rate in sat/vB
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
 * Result from building a Bitcoin transaction
 */
export interface BuildBtcTransactionResult {
  /**
   * Unsigned transaction object (ready for signing)
   */
  tx: btc.Transaction;
  /**
   * Fee paid in satoshis
   */
  fee: number;
  /**
   * Change amount in satoshis (0 if no change output)
   */
  change: number;
  /**
   * Transaction size estimate in virtual bytes
   */
  vsize: number;
  /**
   * UTXOs used as inputs
   */
  inputUtxos: UTXO[];
}

/**
 * Result from signing a Bitcoin transaction
 */
export interface SignBtcTransactionResult {
  /**
   * Signed transaction as hex string (ready for broadcast)
   */
  txHex: string;
  /**
   * Transaction ID
   */
  txid: string;
  /**
   * Transaction size in virtual bytes
   */
  vsize: number;
}

/**
 * Estimate the size of a P2WPKH transaction in virtual bytes
 *
 * Formula: overhead + (inputs * input_size) + (outputs * output_size)
 *
 * @param inputCount - Number of inputs
 * @param outputCount - Number of outputs
 * @returns Estimated size in virtual bytes
 *
 * @example
 * ```typescript
 * // 1 input, 2 outputs (recipient + change)
 * const vsize = estimateTxSize(1, 2);
 * console.log(vsize); // ~140.5 vB
 * ```
 */
export function estimateTxSize(inputCount: number, outputCount: number): number {
  if (inputCount < 1) {
    throw new Error("Transaction must have at least 1 input");
  }
  if (outputCount < 1) {
    throw new Error("Transaction must have at least 1 output");
  }

  const inputsSize = inputCount * P2WPKH_INPUT_VBYTES;
  const outputsSize = outputCount * P2WPKH_OUTPUT_VBYTES;

  return TX_OVERHEAD_VBYTES + inputsSize + outputsSize;
}

/**
 * Get the @scure/btc-signer network object for a network name
 */
function getBtcNetwork(network: Network): typeof btc.NETWORK {
  return network === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
}

/**
 * Build an unsigned Bitcoin transaction
 *
 * Creates a P2WPKH transaction with:
 * - Selected UTXOs as inputs
 * - Recipient output
 * - Change output (if above dust threshold)
 *
 * @param options - Transaction building options
 * @returns Unsigned transaction and metadata
 * @throws Error if insufficient funds or invalid parameters
 *
 * @example
 * ```typescript
 * const result = buildBtcTransaction({
 *   utxos: [...],
 *   recipient: "bc1q...",
 *   amount: 50000,
 *   feeRate: 10,
 *   senderPubKey: pubKeyBytes,
 *   senderAddress: "bc1q...",
 *   network: "mainnet",
 * });
 * ```
 */
export function buildBtcTransaction(
  options: BuildBtcTransactionOptions
): BuildBtcTransactionResult {
  const { utxos, recipient, amount, feeRate, senderPubKey, senderAddress, network } =
    options;

  // Validate inputs
  if (utxos.length === 0) {
    throw new Error("No UTXOs provided");
  }
  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }
  if (amount < DUST_THRESHOLD) {
    throw new Error(`Amount ${amount} is below dust threshold (${DUST_THRESHOLD} sats)`);
  }
  if (feeRate <= 0) {
    throw new Error("Fee rate must be positive");
  }

  // Sort UTXOs by value descending for better coin selection
  const sortedUtxos = [...utxos]
    .filter((utxo) => utxo.status.confirmed) // Only use confirmed UTXOs
    .sort((a, b) => b.value - a.value);

  if (sortedUtxos.length === 0) {
    throw new Error("No confirmed UTXOs available");
  }

  // Calculate total available
  const totalAvailable = sortedUtxos.reduce((sum, utxo) => sum + utxo.value, 0);

  // Estimate transaction size with change output
  const estimatedVsize = estimateTxSize(sortedUtxos.length, 2);
  const estimatedFee = Math.ceil(estimatedVsize * feeRate);

  // Check if we have enough funds
  const requiredTotal = amount + estimatedFee;
  if (totalAvailable < requiredTotal) {
    throw new Error(
      `Insufficient funds: have ${totalAvailable} sats, need ${requiredTotal} sats (${amount} + ${estimatedFee} fee)`
    );
  }

  // Select UTXOs using simple accumulator
  let selectedTotal = 0;
  const selectedUtxos: UTXO[] = [];

  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    selectedTotal += utxo.value;

    // Check if we have enough (with potential change)
    const vsizeWithChange = estimateTxSize(selectedUtxos.length, 2);
    const feeWithChange = Math.ceil(vsizeWithChange * feeRate);
    const neededWithChange = amount + feeWithChange;

    if (selectedTotal >= neededWithChange) {
      break;
    }
  }

  // Final calculation
  const finalVsizeWithChange = estimateTxSize(selectedUtxos.length, 2);
  const finalFeeWithChange = Math.ceil(finalVsizeWithChange * feeRate);
  const changeAmount = selectedTotal - amount - finalFeeWithChange;

  // Determine if we should include a change output
  const hasChange = changeAmount >= DUST_THRESHOLD;
  const outputCount = hasChange ? 2 : 1;

  // Recalculate fee if no change output
  const finalVsize = estimateTxSize(selectedUtxos.length, outputCount);
  const finalFee = hasChange
    ? finalFeeWithChange
    : Math.ceil(finalVsize * feeRate);

  const finalChange = hasChange ? changeAmount : 0;

  // Verify we still have enough
  if (selectedTotal < amount + finalFee) {
    throw new Error(
      `Insufficient funds after UTXO selection: have ${selectedTotal} sats, need ${amount + finalFee} sats`
    );
  }

  // Build the transaction
  const btcNetwork = getBtcNetwork(network);
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

  // Add recipient output
  tx.addOutputAddress(recipient, BigInt(amount), btcNetwork);

  // Add change output if above dust
  if (hasChange) {
    tx.addOutputAddress(senderAddress, BigInt(finalChange), btcNetwork);
  }

  return {
    tx,
    fee: finalFee,
    change: finalChange,
    vsize: finalVsize,
    inputUtxos: selectedUtxos,
  };
}

/**
 * Sign a Bitcoin transaction with a private key
 *
 * Signs all inputs and finalizes the transaction for broadcast.
 *
 * SECURITY: The private key should be a Uint8Array from the wallet session.
 * Never serialize the private key to WIF/hex.
 *
 * @param tx - Unsigned transaction from buildBtcTransaction
 * @param privateKey - Private key as Uint8Array (32 bytes)
 * @returns Signed transaction hex and metadata
 *
 * @example
 * ```typescript
 * const { tx } = buildBtcTransaction({...});
 * const result = signBtcTransaction(tx, privateKeyBytes);
 * console.log(result.txHex); // Ready for broadcast
 * console.log(result.txid);  // Transaction ID
 * ```
 */
export function signBtcTransaction(
  tx: btc.Transaction,
  privateKey: Uint8Array
): SignBtcTransactionResult {
  if (privateKey.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }

  // Sign all inputs
  tx.sign(privateKey);

  // Finalize the transaction
  tx.finalize();

  // Get the signed transaction hex
  const txHex = tx.hex;

  // Get the transaction ID
  const txid = tx.id;

  // Get actual vsize from the finalized transaction
  const vsize = tx.vsize;

  return {
    txHex,
    txid,
    vsize,
  };
}

/**
 * Build and sign a Bitcoin transaction in one step
 *
 * Convenience function that combines buildBtcTransaction and signBtcTransaction.
 *
 * @param options - Transaction building options
 * @param privateKey - Private key as Uint8Array (32 bytes)
 * @returns Signed transaction ready for broadcast
 *
 * @example
 * ```typescript
 * const result = buildAndSignBtcTransaction(
 *   { utxos, recipient, amount, feeRate, senderPubKey, senderAddress, network },
 *   privateKey
 * );
 * // Broadcast result.txHex
 * ```
 */
export function buildAndSignBtcTransaction(
  options: BuildBtcTransactionOptions,
  privateKey: Uint8Array
): SignBtcTransactionResult & { fee: number; change: number } {
  const buildResult = buildBtcTransaction(options);
  const signResult = signBtcTransaction(buildResult.tx, privateKey);

  return {
    ...signResult,
    fee: buildResult.fee,
    change: buildResult.change,
  };
}
