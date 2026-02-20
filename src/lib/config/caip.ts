/**
 * CAIP-2 Chain Identifiers
 *
 * Chain-agnostic identifiers following the CAIP-2 specification:
 * https://chainagnostic.org/CAIPs/caip-2
 *
 * Format: namespace:reference
 * - Stacks uses "stacks" namespace with chain ID as reference
 * - Bitcoin uses "bip122" namespace with genesis block hash prefix (32 chars)
 */

import type { Network } from "./networks.js";

/**
 * CAIP-2 chain identifier type
 */
export type ChainId = string;

/**
 * Stacks chain IDs
 * - Mainnet: chain ID 1
 * - Testnet: chain ID 2147483648 (0x80000000)
 */
export const STACKS_CHAIN_IDS = {
  mainnet: "stacks:1",
  testnet: "stacks:2147483648",
} as const;

/**
 * Bitcoin chain IDs (BIP122 namespace)
 * Using first 32 characters of genesis block hash as reference
 * - Mainnet: 000000000019d6689c085ae165831e93
 * - Testnet: 000000000933ea01ad0ee984209779ba
 */
export const BITCOIN_CHAIN_IDS = {
  mainnet: "bip122:000000000019d6689c085ae165831e93",
  testnet: "bip122:000000000933ea01ad0ee984209779ba",
} as const;

/**
 * Get Stacks CAIP-2 chain ID for a network
 */
export function getStacksChainId(network: Network): ChainId {
  return STACKS_CHAIN_IDS[network];
}

/**
 * Get Bitcoin CAIP-2 chain ID for a network
 */
export function getBitcoinChainId(network: Network): ChainId {
  return BITCOIN_CHAIN_IDS[network];
}

/**
 * Parse CAIP-2 chain ID into namespace and reference
 */
export function parseChainId(chainId: ChainId): {
  namespace: string;
  reference: string;
} {
  const [namespace, reference] = chainId.split(":");
  if (!namespace || !reference) {
    throw new Error(`Invalid CAIP-2 chain ID: ${chainId}`);
  }
  return { namespace, reference };
}

/**
 * Check if a chain ID is a Stacks chain
 */
export function isStacksChainId(chainId: ChainId): boolean {
  return chainId.startsWith("stacks:");
}

/**
 * Check if a chain ID is a Bitcoin chain
 */
export function isBitcoinChainId(chainId: ChainId): boolean {
  return chainId.startsWith("bip122:");
}

/**
 * Get network from Stacks chain ID
 */
export function getNetworkFromStacksChainId(chainId: ChainId): Network | null {
  if (chainId === STACKS_CHAIN_IDS.mainnet) return "mainnet";
  if (chainId === STACKS_CHAIN_IDS.testnet) return "testnet";
  return null;
}

/**
 * Get network from Bitcoin chain ID
 */
export function getNetworkFromBitcoinChainId(chainId: ChainId): Network | null {
  if (chainId === BITCOIN_CHAIN_IDS.mainnet) return "mainnet";
  if (chainId === BITCOIN_CHAIN_IDS.testnet) return "testnet";
  return null;
}
