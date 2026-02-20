/**
 * mempool.space API client for Bitcoin UTXO and fee data
 *
 * Public API endpoints (no authentication required):
 * - Mainnet: https://mempool.space/api
 * - Testnet: https://mempool.space/testnet/api
 *
 * Documentation: https://mempool.space/docs/api
 */

import type { Network } from "../config/networks.js";

/**
 * UTXO (Unspent Transaction Output) from mempool.space API
 */
export interface UTXO {
  /**
   * Transaction ID containing this UTXO
   */
  txid: string;
  /**
   * Output index within the transaction
   */
  vout: number;
  /**
   * UTXO status (confirmed or unconfirmed)
   */
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  /**
   * Value in satoshis
   */
  value: number;
}

/**
 * Fee estimates from mempool.space API (sat/vB)
 */
export interface FeeEstimates {
  /**
   * Fee rate for fastest confirmation (~10 min)
   */
  fastestFee: number;
  /**
   * Fee rate for fast confirmation (~30 min)
   */
  halfHourFee: number;
  /**
   * Fee rate for standard confirmation (~1 hour)
   */
  hourFee: number;
  /**
   * Fee rate for economy confirmation (~24 hours)
   */
  economyFee: number;
  /**
   * Minimum relay fee rate
   */
  minimumFee: number;
}

/**
 * Simplified fee tiers for user selection
 */
export interface FeeTiers {
  /**
   * Fast: ~10 minute confirmation
   */
  fast: number;
  /**
   * Medium: ~30 minute confirmation
   */
  medium: number;
  /**
   * Slow: ~1 hour confirmation
   */
  slow: number;
}

/**
 * Get the mempool.space API base URL for a network
 */
export function getMempoolApiUrl(network: Network): string {
  return network === "mainnet"
    ? "https://mempool.space/api"
    : "https://mempool.space/testnet/api";
}

/**
 * Get the mempool.space explorer URL for a network
 */
export function getMempoolExplorerUrl(network: Network): string {
  return network === "mainnet"
    ? "https://mempool.space"
    : "https://mempool.space/testnet";
}

/**
 * Get transaction explorer URL
 */
export function getMempoolTxUrl(txid: string, network: Network): string {
  return `${getMempoolExplorerUrl(network)}/tx/${txid}`;
}

/**
 * Get address explorer URL
 */
export function getMempoolAddressUrl(address: string, network: Network): string {
  return `${getMempoolExplorerUrl(network)}/address/${address}`;
}

/**
 * mempool.space API client
 */
export class MempoolApi {
  private readonly baseUrl: string;
  private readonly network: Network;

  constructor(network: Network) {
    this.network = network;
    this.baseUrl = getMempoolApiUrl(network);
  }

  /**
   * Get UTXOs for a Bitcoin address
   *
   * @param address - Bitcoin address (bc1... for mainnet, tb1... for testnet)
   * @returns Array of UTXOs with txid, vout, value, and confirmation status
   * @throws Error if API request fails
   *
   * @example
   * ```typescript
   * const api = new MempoolApi('mainnet');
   * const utxos = await api.getUtxos('bc1q...');
   * const total = utxos.reduce((sum, u) => sum + u.value, 0);
   * ```
   */
  async getUtxos(address: string): Promise<UTXO[]> {
    const response = await fetch(`${this.baseUrl}/address/${address}/utxo`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to fetch UTXOs for ${address}: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const utxos = await response.json();
    return utxos as UTXO[];
  }

  /**
   * Get current recommended fee estimates
   *
   * @returns Fee estimates in sat/vB for different confirmation targets
   * @throws Error if API request fails
   *
   * @example
   * ```typescript
   * const api = new MempoolApi('mainnet');
   * const fees = await api.getFeeEstimates();
   * console.log(`Fast fee: ${fees.fastestFee} sat/vB`);
   * ```
   */
  async getFeeEstimates(): Promise<FeeEstimates> {
    const response = await fetch(`${this.baseUrl}/v1/fees/recommended`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to fetch fee estimates: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const fees = await response.json();
    return fees as FeeEstimates;
  }

  /**
   * Get simplified fee tiers for user selection
   *
   * Maps mempool.space fee estimates to fast/medium/slow tiers:
   * - Fast: fastestFee (~10 min)
   * - Medium: halfHourFee (~30 min)
   * - Slow: hourFee (~1 hour)
   *
   * @returns Fee tiers in sat/vB
   * @throws Error if API request fails
   */
  async getFeeTiers(): Promise<FeeTiers> {
    const estimates = await this.getFeeEstimates();
    return {
      fast: estimates.fastestFee,
      medium: estimates.halfHourFee,
      slow: estimates.hourFee,
    };
  }

  /**
   * Get balance for a Bitcoin address (sum of UTXOs)
   *
   * @param address - Bitcoin address
   * @returns Balance in satoshis
   * @throws Error if API request fails
   */
  async getBalance(address: string): Promise<number> {
    const utxos = await this.getUtxos(address);
    return utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  }

  /**
   * Get confirmed balance for a Bitcoin address
   *
   * @param address - Bitcoin address
   * @returns Confirmed balance in satoshis (excludes unconfirmed UTXOs)
   * @throws Error if API request fails
   */
  async getConfirmedBalance(address: string): Promise<number> {
    const utxos = await this.getUtxos(address);
    return utxos
      .filter((utxo) => utxo.status.confirmed)
      .reduce((sum, utxo) => sum + utxo.value, 0);
  }

  /**
   * Broadcast a signed transaction to the Bitcoin network
   *
   * @param txHex - Signed transaction as hex string
   * @returns Transaction ID (txid)
   * @throws Error if broadcast fails
   *
   * @example
   * ```typescript
   * const api = new MempoolApi('mainnet');
   * const txid = await api.broadcastTransaction(signedTxHex);
   * console.log(`Broadcast: ${getMempoolTxUrl(txid, 'mainnet')}`);
   * ```
   */
  async broadcastTransaction(txHex: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/tx`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: txHex,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to broadcast transaction: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    // Response is the txid as plain text
    const txid = await response.text();
    return txid.trim();
  }

  /**
   * Get raw transaction hex by txid
   *
   * @param txid - Transaction ID
   * @returns Transaction as hex string
   * @throws Error if API request fails
   *
   * @example
   * ```typescript
   * const api = new MempoolApi('mainnet');
   * const txHex = await api.getTxHex('abc123...');
   * ```
   */
  async getTxHex(txid: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/tx/${txid}/hex`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `Failed to fetch transaction hex for ${txid}: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const txHex = await response.text();
    return txHex.trim();
  }

  /**
   * Get the network this client is configured for
   */
  getNetwork(): Network {
    return this.network;
  }
}

/**
 * Create a mempool.space API client for the given network
 */
export function createMempoolApi(network: Network): MempoolApi {
  return new MempoolApi(network);
}
