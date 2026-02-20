/**
 * sBTC Deposit Service
 *
 * Handles Bitcoin → sBTC deposits using the sbtc library
 *
 * Flow:
 * 1. Generate a deposit address (with reclaim script for recovery)
 * 2. Build and sign a Bitcoin transaction to deposit BTC
 * 3. Broadcast the transaction and notify the sBTC system
 * 4. sBTC tokens are minted on Stacks L2 after confirmation
 *
 * @example
 * ```typescript
 * const service = getSbtcDepositService('mainnet');
 *
 * // Step 1: Get signers public key and build deposit address
 * const signersPublicKey = await service.getSignersPublicKey();
 * const depositAddressInfo = await service.buildDepositAddress(
 *   'SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK', // Stacks address
 *   'abc123...', // Reclaim public key (32-byte x-only)
 *   80000, // Max signer fee
 *   950 // Reclaim lock time (blocks)
 * );
 *
 * // Step 2: Build deposit transaction
 * const depositResult = await service.buildDepositTransaction(
 *   100000, // Amount in sats
 *   'SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK',
 *   'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
 *   'abc123...', // Reclaim public key (32-byte x-only)
 *   10 // Fee rate sat/vB
 * );
 *
 * // Step 3: Sign the transaction with user's private key
 * // (signing logic handled by caller)
 *
 * // Step 4: Broadcast and notify
 * const { txid, notification } = await service.broadcastAndNotify(
 *   signedTxHex,
 *   depositResult.depositScript,
 *   depositResult.reclaimScript,
 *   0 // vout
 * );
 *
 * // Step 5: Poll for completion
 * const finalStatus = await service.pollDepositStatus(txid, 0);
 *
 * // OR use the high-level helper that chains all steps:
 * const result = await service.deposit(
 *   100000,
 *   'SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK',
 *   'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
 *   '03abc123...',
 *   10,
 *   async (txHex) => {
 *     // Sign transaction and return signed hex
 *     return signedTxHex;
 *   }
 * );
 * ```
 */

import {
  SbtcApiClientMainnet,
  SbtcApiClientTestnet,
  type UtxoWithTx,
  MAINNET,
  TESTNET,
  buildSbtcDepositAddress,
  sbtcDepositHelper,
} from "sbtc";
import type { BitcoinNetwork } from "sbtc";
import type { Network } from "../config/networks.js";
import { getContracts, parseContractId } from "../config/contracts.js";
import { MempoolApi } from "./mempool-api.js";
import type { UTXO } from "./mempool-api.js";
import { OrdinalIndexer } from "./ordinal-indexer.js";

/**
 * Result from generating a deposit address
 */
export interface DepositAddressResult {
  /**
   * Bitcoin Taproot address to send BTC to
   */
  depositAddress: string;
  /**
   * Deposit script (hex) - proves deposit to sBTC system
   */
  depositScript: string;
  /**
   * Reclaim script (hex) - allows recovery if deposit fails
   */
  reclaimScript: string;
  /**
   * Max fee the sBTC system will charge (satoshis)
   */
  maxFee: number;
  /**
   * Lock time for the deposit (blocks)
   */
  lockTime: number;
}

/**
 * Result from building a deposit transaction
 */
export interface DepositTransactionResult {
  /**
   * Signed transaction hex
   */
  txHex: string;
  /**
   * Transaction ID
   */
  txid: string;
  /**
   * Deposit amount in satoshis
   */
  amount: number;
  /**
   * Output index containing the deposit
   */
  vout: number;
}

/**
 * Complete deposit result (transaction + scripts)
 */
export interface DepositResult extends DepositTransactionResult {
  depositScript: string;
  reclaimScript: string;
}

/**
 * sBTC Deposit Service
 */
export class SbtcDepositService {
  private readonly apiClient: SbtcApiClientMainnet | SbtcApiClientTestnet;
  private readonly mempoolApi: MempoolApi;
  private readonly network: Network;

  constructor(network: Network) {
    this.network = network;
    this.apiClient =
      network === "mainnet"
        ? new SbtcApiClientMainnet()
        : new SbtcApiClientTestnet();
    this.mempoolApi = new MempoolApi(network);
  }

  /**
   * Get Bitcoin network constants for the configured network
   */
  private getBitcoinNetwork(): BitcoinNetwork {
    return this.network === "mainnet" ? MAINNET : TESTNET;
  }

  /**
   * Convert MempoolApi UTXOs to sbtc's UtxoWithTx format
   *
   * The sbtc package requires UTXOs with raw transaction hex attached.
   * This method fetches the tx hex for each UTXO via mempool.space API.
   */
  private async convertUtxos(utxos: UTXO[]): Promise<UtxoWithTx[]> {
    return Promise.all(
      utxos.map(async (utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        status: {
          confirmed: utxo.status.confirmed,
          block_height: utxo.status.block_height ?? 0,
        },
        tx: await this.mempoolApi.getTxHex(utxo.txid),
      }))
    );
  }

  /**
   * Get the signers aggregate public key from the sBTC registry contract
   *
   * The signers public key is used to build the deposit address script.
   * This is fetched from the sbtc-registry contract on Stacks L2.
   */
  async getSignersPublicKey(): Promise<string> {
    const contracts = getContracts(this.network);
    // sbtc library expects just the deployer address, not the full contract ID
    // (it hardcodes contractName: 'sbtc-registry' internally)
    const { address: registryDeployer } = parseContractId(contracts.SBTC_REGISTRY);
    return await this.apiClient.fetchSignersPublicKey(registryDeployer);
  }

  /**
   * Build a Taproot deposit address for sBTC deposits
   *
   * The deposit address contains two spending paths:
   * 1. Deposit script - sBTC signers can spend to mint sBTC on Stacks
   * 2. Reclaim script - User can reclaim BTC after lockTime if deposit fails
   *
   * @param stacksAddress - Stacks L2 address to receive sBTC (SP... or ST...)
   * @param reclaimPublicKey - Public key for reclaim path (hex, 32-byte x-only Taproot internal public key)
   * @param maxSignerFee - Max fee sBTC system can charge in satoshis (default: 80000)
   * @param reclaimLockTime - Block height when reclaim becomes available (default: 950 blocks)
   * @returns Deposit address and scripts
   */
  async buildDepositAddress(
    stacksAddress: string,
    reclaimPublicKey: string,
    maxSignerFee?: number,
    reclaimLockTime?: number
  ): Promise<DepositAddressResult> {
    const signersPublicKey = await this.getSignersPublicKey();
    const network = this.getBitcoinNetwork();

    const result = buildSbtcDepositAddress({
      network,
      stacksAddress,
      signersPublicKey,
      reclaimPublicKey,
      maxSignerFee,
      reclaimLockTime,
    });

    return {
      depositAddress: result.address,
      depositScript: result.depositScript,
      reclaimScript: result.reclaimScript,
      maxFee: maxSignerFee ?? 80000,
      lockTime: reclaimLockTime ?? 950,
    };
  }

  /**
   * Build an sBTC deposit transaction, optionally signed
   *
   * This method:
   * 1. Fetches UTXOs for the Bitcoin address
   * 2. Builds a deposit address with deposit/reclaim scripts
   * 3. Constructs a transaction that sends BTC to the deposit address
   * 4. If `privateKey` is provided, signs and finalizes the transaction
   * 5. Returns the transaction hex (signed or unsigned), txid, and deposit details
   *
   * @param amountSats - Amount to deposit in satoshis
   * @param stacksAddress - Stacks L2 address to receive sBTC
   * @param bitcoinAddress - Bitcoin L1 address to send from (for UTXOs and change)
   * @param reclaimPublicKey - Public key for reclaim path (hex, 32-byte x-only Taproot internal public key)
   * @param feeRate - Fee rate in sat/vB
   * @param maxSignerFee - Max fee sBTC system can charge (default: 80000 sats)
   * @param reclaimLockTime - Block height when reclaim becomes available (default: 950)
   * @param privateKey - Optional BTC private key (Uint8Array) to sign the transaction.
   *                     When provided, signs using the sbtc package's internal @scure/btc-signer
   *                     to avoid version mismatch issues. The inputs are P2WPKH from the user's address.
   * @param includeOrdinals - Include UTXOs with inscriptions (default: false for safety).
   *                          WARNING: Setting this to true may destroy valuable inscriptions!
   * @returns Transaction hex (signed if privateKey provided), txid, and deposit details
   */
  async buildDepositTransaction(
    amountSats: number,
    stacksAddress: string,
    bitcoinAddress: string,
    reclaimPublicKey: string,
    feeRate: number,
    maxSignerFee?: number,
    reclaimLockTime?: number,
    privateKey?: Uint8Array,
    includeOrdinals?: boolean
  ): Promise<DepositResult> {
    try {
      // Fetch UTXOs - use cardinal UTXOs by default for safety
      let utxos: UTXO[];

      if (includeOrdinals) {
        // Power user mode: use all UTXOs
        utxos = await this.mempoolApi.getUtxos(bitcoinAddress);
      } else {
        // Safe mode: only use cardinal UTXOs (no inscriptions)
        // On testnet, Hiro API is not available, so fall back to all UTXOs
        if (this.network === "testnet") {
          utxos = await this.mempoolApi.getUtxos(bitcoinAddress);
        } else {
          const indexer = new OrdinalIndexer(this.network);
          utxos = await indexer.getCardinalUtxos(bitcoinAddress);
        }
      }

      if (utxos.length === 0) {
        const errorMsg = includeOrdinals
          ? `No UTXOs found for address ${bitcoinAddress}`
          : `No cardinal (non-inscription) UTXOs available for deposit. ` +
            `You may have ordinal UTXOs (containing inscriptions). ` +
            `Use includeOrdinals=true to override ordinal safety (WARNING: may destroy inscriptions).`;
        throw new Error(errorMsg);
      }

      // Convert to sbtc's UtxoWithTx format (with tx hex)
      const utxosWithTx = await this.convertUtxos(utxos);

      // Get signers public key from registry contract
      const signersPublicKey = await this.getSignersPublicKey();

      // Build deposit transaction using sbtcDepositHelper
      const network = this.getBitcoinNetwork();
      const result = await sbtcDepositHelper({
        network,
        amountSats,
        stacksAddress,
        bitcoinChangeAddress: bitcoinAddress,
        signersPublicKey,
        reclaimPublicKey,
        feeRate,
        utxos: utxosWithTx,
        maxSignerFee,
        reclaimLockTime,
      });

      // Sign transaction if private key provided
      // Uses the sbtc package's internal @scure/btc-signer to avoid version mismatch
      if (privateKey) {
        result.transaction.sign(privateKey);
        result.transaction.finalize();
      }

      // Extract transaction hex and id after potential signing
      const txHex = result.transaction.hex;
      const txid = result.transaction.id;

      return {
        txHex,
        txid,
        amount: amountSats,
        vout: 0, // Deposit output is always at index 0
        depositScript: result.depositScript,
        reclaimScript: result.reclaimScript,
      };
    } catch (error) {
      // Handle @scure/btc-signer version mismatch errors
      if (error instanceof Error && error.message.includes("@scure/btc-signer")) {
        throw new Error(
          `sBTC deposit transaction failed: ${error.message}. ` +
            "This may be due to a version mismatch in @scure/btc-signer dependencies."
        );
      }
      throw error;
    }
  }

  /**
   * Get deposit status from Emily API
   *
   * @param txid - Bitcoin transaction ID
   * @param vout - Output index (optional, defaults to 0)
   * @returns Deposit status and details
   */
  async getDepositStatus(txid: string, vout?: number): Promise<unknown> {
    if (vout !== undefined) {
      return await this.apiClient.fetchDeposit({ txid, vout });
    }
    return await this.apiClient.fetchDeposit(txid);
  }

  /**
   * Broadcast signed transaction and notify Emily API
   *
   * This method:
   * 1. Broadcasts the signed Bitcoin transaction to the mempool
   * 2. Notifies the Emily API about the deposit (required for sBTC minting)
   *
   * @param signedTxHex - Signed transaction hex string
   * @param depositScript - Deposit script hex (from buildDepositTransaction)
   * @param reclaimScript - Reclaim script hex (from buildDepositTransaction)
   * @param vout - Output index containing the deposit (default: 0)
   * @returns Transaction ID and notification response
   */
  async broadcastAndNotify(
    signedTxHex: string,
    depositScript: string,
    reclaimScript: string,
    vout?: number
  ): Promise<{ txid: string; notification: unknown }> {
    // Broadcast transaction to Bitcoin network
    const txid = await this.mempoolApi.broadcastTransaction(signedTxHex);

    // Notify Emily API about the deposit
    const notification = await this.apiClient.notifySbtc({
      depositScript,
      reclaimScript,
      vout: vout ?? 0,
      transaction: signedTxHex,
    });

    return { txid, notification };
  }

  /**
   * Poll Emily API for deposit status until completed or timeout
   *
   * Terminal states:
   * - "completed" - Deposit successful, sBTC minted
   * - "failed" - Deposit failed
   *
   * @param txid - Bitcoin transaction ID
   * @param vout - Output index (default: 0)
   * @param pollIntervalMs - Polling interval in milliseconds (default: 30000 / 30 seconds)
   * @param timeoutMs - Max wait time in milliseconds (default: 7200000 / 2 hours)
   * @returns Final deposit status
   * @throws Error if deposit fails or polling times out
   */
  async pollDepositStatus(
    txid: string,
    vout?: number,
    pollIntervalMs: number = 30000,
    timeoutMs: number = 7200000
  ): Promise<unknown> {
    const startTime = Date.now();
    const voutIndex = vout ?? 0;

    while (true) {
      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `Polling timeout after ${timeoutMs}ms for deposit ${txid}:${voutIndex}. ` +
            `Check status manually or try again later.`
        );
      }

      try {
        // Fetch deposit status
        const status = (await this.apiClient.fetchDeposit({
          txid,
          vout: voutIndex,
        })) as any;

        // Check for terminal states
        if (status.status === "completed") {
          return status;
        }

        if (status.status === "failed") {
          throw new Error(
            `Deposit failed: ${status.statusMessage || "Unknown error"}`
          );
        }

        // Continue polling for pending/processing states
      } catch (error) {
        // On fetch errors (404, network issues), wait and retry
        // Don't throw immediately - the deposit might not be indexed yet
        if (
          error instanceof Error &&
          (error.message.includes("404") || error.message.includes("fetch"))
        ) {
          // Continue polling
        } else {
          throw error;
        }
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * High-level deposit helper that chains all steps
   *
   * This method:
   * 1. Builds the deposit transaction
   * 2. Calls the provided signTransaction callback to sign it
   * 3. Broadcasts the signed transaction and notifies Emily API
   *
   * @param amountSats - Amount to deposit in satoshis
   * @param stacksAddress - Stacks L2 address to receive sBTC
   * @param bitcoinAddress - Bitcoin L1 address to send from
   * @param reclaimPublicKey - Public key for reclaim path (hex, 32-byte x-only Taproot internal public key)
   * @param feeRate - Fee rate in sat/vB
   * @param signTransaction - Callback function to sign the transaction hex
   * @param maxSignerFee - Max fee sBTC system can charge (default: 80000 sats)
   * @param reclaimLockTime - Block height when reclaim becomes available (default: 950)
   * @param includeOrdinals - Include UTXOs with inscriptions (default: false for safety)
   * @returns Broadcast result with txid and notification
   */
  async deposit(
    amountSats: number,
    stacksAddress: string,
    bitcoinAddress: string,
    reclaimPublicKey: string,
    feeRate: number,
    signTransaction: (txHex: string) => Promise<string>,
    maxSignerFee?: number,
    reclaimLockTime?: number,
    includeOrdinals?: boolean
  ): Promise<{ txid: string; notification: unknown }> {
    // Step 1: Build deposit transaction
    const depositResult = await this.buildDepositTransaction(
      amountSats,
      stacksAddress,
      bitcoinAddress,
      reclaimPublicKey,
      feeRate,
      maxSignerFee,
      reclaimLockTime,
      undefined, // privateKey - not used in this flow (external signing callback)
      includeOrdinals
    );

    // Step 2: Sign transaction via callback
    const signedTxHex = await signTransaction(depositResult.txHex);

    // Step 3: Broadcast and notify
    return await this.broadcastAndNotify(
      signedTxHex,
      depositResult.depositScript,
      depositResult.reclaimScript,
      depositResult.vout
    );
  }
}

/**
 * Get singleton sBTC deposit service instance
 */
let sbtcDepositService: SbtcDepositService | null = null;

export function getSbtcDepositService(network: Network): SbtcDepositService {
  if (!sbtcDepositService || sbtcDepositService["network"] !== network) {
    sbtcDepositService = new SbtcDepositService(network);
  }
  return sbtcDepositService;
}
