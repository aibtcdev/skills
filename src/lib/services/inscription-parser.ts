/**
 * Inscription Parser Service
 *
 * Wrapper around micro-ordinals library for parsing inscriptions from
 * Bitcoin transaction witness data and scripts.
 *
 * micro-ordinals API:
 * - parseWitness(witness: Bytes[]): Inscription[] | undefined
 * - parseInscriptions(script: ScriptType, strict?: boolean): Inscription[] | undefined
 *
 * Reference: https://github.com/paulmillr/micro-ordinals
 */

import {
  parseWitness as microOrdinalsParseWitness,
  type Inscription,
} from "micro-ordinals";
import type { Network } from "../config/networks.js";
import { getMempoolApiUrl } from "./mempool-api.js";

/**
 * Transaction data from mempool.space API
 */
interface MempoolTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    prevout: {
      scriptpubkey: string;
      scriptpubkey_asm: string;
      scriptpubkey_type: string;
      scriptpubkey_address: string;
      value: number;
    };
    scriptsig: string;
    scriptsig_asm: string;
    witness: string[];
    is_coinbase: boolean;
    sequence: number;
  }>;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_asm: string;
    scriptpubkey_type: string;
    scriptpubkey_address?: string;
    value: number;
  }>;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/**
 * Parsed inscription with metadata
 */
export interface ParsedInscription {
  /**
   * Content type (e.g., "text/plain", "image/png")
   */
  contentType?: string;
  /**
   * Inscription body as bytes
   */
  body: Uint8Array;
  /**
   * Inscription body as UTF-8 string (if text content)
   */
  bodyText?: string;
  /**
   * Inscription body as base64 (for binary content)
   */
  bodyBase64: string;
  /**
   * Whether this is a cursed inscription
   */
  cursed?: boolean;
  /**
   * Pointer tag (if present)
   */
  pointer?: bigint;
  /**
   * Metaprotocol (if present)
   */
  metaprotocol?: string;
  /**
   * Content encoding (if present, e.g., "br" for Brotli)
   */
  contentEncoding?: string;
  /**
   * Metadata (if present)
   */
  metadata?: any;
  /**
   * Rune tag (if present)
   */
  rune?: bigint;
  /**
   * Note tag (if present)
   */
  note?: string;
  /**
   * All tags from the inscription (raw, may contain Coder objects)
   */
  rawTags: Inscription["tags"];
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64 string
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Use Buffer for Node.js environment
  return Buffer.from(bytes).toString("base64");
}

/**
 * Try to decode bytes as UTF-8 text
 */
function tryDecodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Parse and enhance inscription data from micro-ordinals
 */
function enhanceInscription(inscription: Inscription): ParsedInscription {
  const bodyBase64 = bytesToBase64(inscription.body);
  const bodyText = tryDecodeText(inscription.body);

  return {
    contentType: inscription.tags.contentType,
    body: inscription.body,
    bodyText,
    bodyBase64,
    cursed: inscription.cursed,
    pointer: inscription.tags.pointer,
    metaprotocol: inscription.tags.metaprotocol,
    contentEncoding: inscription.tags.contentEncoding,
    metadata: inscription.tags.metadata,
    rune: inscription.tags.rune,
    note: inscription.tags.note,
    rawTags: inscription.tags,
  };
}

/**
 * Inscription Parser Service
 */
export class InscriptionParser {
  private readonly network: Network;
  private readonly mempoolApiUrl: string;

  constructor(network: Network) {
    this.network = network;
    this.mempoolApiUrl = getMempoolApiUrl(network);
  }

  /**
   * Parse inscriptions from transaction witness data
   *
   * This is the primary method for extracting inscriptions from reveal transactions.
   * The witness data is typically in the first input of a reveal transaction.
   *
   * @param witness - Array of hex-encoded witness elements
   * @returns Array of parsed inscriptions, or undefined if no inscriptions found
   *
   * @example
   * ```typescript
   * const parser = new InscriptionParser('mainnet');
   * const inscriptions = parser.parseWitness(tx.vin[0].witness);
   * if (inscriptions) {
   *   console.log(`Found ${inscriptions.length} inscriptions`);
   * }
   * ```
   */
  parseWitness(witness: string[]): ParsedInscription[] | undefined {
    // Convert hex strings to Uint8Array
    const witnessBytes = witness.map((hex) => hexToBytes(hex));

    // Parse inscriptions using micro-ordinals
    const inscriptions = microOrdinalsParseWitness(witnessBytes);

    if (!inscriptions || inscriptions.length === 0) {
      return undefined;
    }

    // Enhance inscriptions with additional metadata
    return inscriptions.map(enhanceInscription);
  }

  /**
   * Fetch a transaction and parse inscriptions from its witness data
   *
   * This is a convenience method that fetches a transaction from mempool.space
   * and extracts inscriptions from the first input's witness data (typical for
   * reveal transactions).
   *
   * @param txid - Transaction ID
   * @returns Array of parsed inscriptions, or undefined if no inscriptions found
   * @throws Error if transaction fetch fails
   *
   * @example
   * ```typescript
   * const parser = new InscriptionParser('mainnet');
   * const inscriptions = await parser.getInscriptionsFromTx(revealTxid);
   * if (inscriptions) {
   *   inscriptions.forEach(i => {
   *     console.log(`Type: ${i.contentType}, Size: ${i.body.length} bytes`);
   *   });
   * }
   * ```
   */
  async getInscriptionsFromTx(
    txid: string
  ): Promise<ParsedInscription[] | undefined> {
    try {
      // Fetch transaction from mempool.space
      const response = await fetch(`${this.mempoolApiUrl}/tx/${txid}`);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Failed to fetch transaction ${txid}: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const tx = (await response.json()) as MempoolTransaction;

      // Check if transaction has inputs with witness data
      if (!tx.vin || tx.vin.length === 0) {
        return undefined;
      }

      // Try to parse witness data from first input (typical for reveal txs)
      const firstInput = tx.vin[0];
      if (!firstInput.witness || firstInput.witness.length === 0) {
        return undefined;
      }

      // Parse inscriptions from witness
      return this.parseWitness(firstInput.witness);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(
        `Failed to get inscriptions from transaction: ${String(error)}`
      );
    }
  }

}

/**
 * Create an inscription parser for the given network
 */
export function createInscriptionParser(network: Network): InscriptionParser {
  return new InscriptionParser(network);
}
