/**
 * Ordinal Indexer Service
 *
 * Combines Hiro Ordinals API with mempool.space to classify UTXOs:
 * - Cardinal: Safe to spend (no inscriptions)
 * - Ordinal: Contains inscriptions (must not spend accidentally)
 *
 * Uses free APIs:
 * - Hiro Ordinals API: https://api.hiro.so/ordinals/v1/inscriptions?address={address}
 * - mempool.space API: via MempoolApi service
 */

import type { Network } from "../config/networks.js";
import type { UTXO } from "./mempool-api.js";
import { MempoolApi } from "./mempool-api.js";
import { HiroApiRateLimitError } from "./hiro-api.js";

/**
 * Inscription data from Hiro Ordinals API
 */
export interface Inscription {
  /**
   * Inscription ID (txid + inscription number)
   */
  id: string;
  /**
   * Inscription number (global ordinal)
   */
  number: number;
  /**
   * Content type (e.g., "text/plain", "image/png")
   */
  content_type: string;
  /**
   * Content length in bytes
   */
  content_length: number;
  /**
   * Genesis transaction ID
   */
  genesis_tx_id: string;
  /**
   * Genesis block height
   */
  genesis_block_height: number;
  /**
   * Genesis block hash
   */
  genesis_block_hash: string;
  /**
   * Genesis timestamp
   */
  genesis_timestamp: number;
  /**
   * Location of the inscription (txid:vout:offset)
   */
  location: string;
  /**
   * Output reference (txid:vout) - this is what we use to match UTXOs
   */
  output: string;
  /**
   * Current owner address
   */
  address: string;
  /**
   * Offset within the output
   */
  offset: string;
}

/**
 * Hiro Ordinals API response
 */
interface HiroInscriptionsResponse {
  limit: number;
  offset: number;
  total: number;
  results: Inscription[];
}

/**
 * Classified UTXOs
 */
export interface ClassifiedUtxos {
  /**
   * Cardinal UTXOs - safe to spend (no inscriptions)
   */
  cardinal: UTXO[];
  /**
   * Ordinal UTXOs - contain inscriptions (do not spend)
   */
  ordinal: UTXO[];
}

const HIRO_ORDINALS_API_URL = "https://api.hiro.so/ordinals/v1";

/**
 * Ordinal Indexer Service
 *
 * Note: Hiro Ordinals API only supports mainnet. On testnet, all UTXOs are
 * treated as cardinal (safe to spend) since we cannot index inscriptions.
 */
export class OrdinalIndexer {
  private readonly network: Network;
  private readonly mempoolApi: MempoolApi;
  private readonly isMainnet: boolean;

  constructor(network: Network) {
    this.network = network;
    this.mempoolApi = new MempoolApi(network);
    this.isMainnet = network === "mainnet";
  }

  /**
   * Get all inscriptions for a Bitcoin address
   *
   * @param address - Bitcoin address (bc1... for mainnet)
   * @returns Array of inscriptions with their output references (empty on testnet)
   * @throws Error if API request fails
   */
  async getInscriptionsForAddress(address: string): Promise<Inscription[]> {
    // Testnet: return empty (Hiro API doesn't index testnet inscriptions)
    if (!this.isMainnet) {
      return [];
    }

    const allInscriptions: Inscription[] = [];
    let offset = 0;
    const limit = 60; // Hiro API default/max per page

    // Fetch all pages
    while (true) {
      const url = `${HIRO_ORDINALS_API_URL}/inscriptions?address=${address}&limit=${limit}&offset=${offset}`;
      const response = await fetch(url);

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterSeconds =
            retryAfter && !isNaN(parseInt(retryAfter, 10)) ? parseInt(retryAfter, 10) : 60;
          throw new HiroApiRateLimitError(
            `Hiro Ordinals API rate limit exceeded. Retry after ${retryAfterSeconds}s`,
            retryAfterSeconds
          );
        }

        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Failed to fetch inscriptions from Hiro API: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as HiroInscriptionsResponse;
      allInscriptions.push(...data.results);

      // Check if we've fetched all inscriptions
      if (offset + data.results.length >= data.total) {
        break;
      }

      offset += limit;
    }

    return allInscriptions;
  }

  /**
   * Classify UTXOs into cardinal (safe to spend) and ordinal (contains inscriptions)
   *
   * @param address - Bitcoin address
   * @returns Classified UTXOs
   * @throws Error if API requests fail
   */
  async classifyUtxos(address: string): Promise<ClassifiedUtxos> {
    // Fetch UTXOs from mempool.space
    const utxos = await this.mempoolApi.getUtxos(address);

    // Fetch inscriptions from Hiro Ordinals API
    const inscriptions = await this.getInscriptionsForAddress(address);

    // Build set of outputs that contain inscriptions
    // Hiro API returns "output" field as "txid:vout"
    const ordinalOutputs = new Set<string>(
      inscriptions.map((inscription) => inscription.output)
    );

    // Classify UTXOs
    const cardinal: UTXO[] = [];
    const ordinal: UTXO[] = [];

    for (const utxo of utxos) {
      const outputRef = `${utxo.txid}:${utxo.vout}`;
      if (ordinalOutputs.has(outputRef)) {
        ordinal.push(utxo);
      } else {
        cardinal.push(utxo);
      }
    }

    return { cardinal, ordinal };
  }

  /**
   * Get cardinal UTXOs (safe to spend - no inscriptions)
   *
   * @param address - Bitcoin address
   * @returns Cardinal UTXOs only
   * @throws Error if API requests fail
   */
  async getCardinalUtxos(address: string): Promise<UTXO[]> {
    const classified = await this.classifyUtxos(address);
    return classified.cardinal;
  }

  /**
   * Get ordinal UTXOs (contain inscriptions - do not spend)
   *
   * @param address - Bitcoin address
   * @returns Ordinal UTXOs only
   * @throws Error if API requests fail
   */
  async getOrdinalUtxos(address: string): Promise<UTXO[]> {
    const classified = await this.classifyUtxos(address);
    return classified.ordinal;
  }

}

/**
 * Create an ordinal indexer for the given network
 */
export function createOrdinalIndexer(network: Network): OrdinalIndexer {
  return new OrdinalIndexer(network);
}
