import type { Network } from "./networks.js";

/**
 * Get the sponsor relay URL for a given network
 */
export function getSponsorRelayUrl(network: Network): string {
  return network === "mainnet"
    ? "https://x402-relay.aibtc.com"
    : "https://x402-relay.aibtc.dev";
}

/**
 * Get sponsor API key from environment
 * Falls back to per-wallet API key in services layer
 */
export function getSponsorApiKey(): string | undefined {
  return process.env.SPONSOR_API_KEY;
}
