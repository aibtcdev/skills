import { StacksNetworkName } from "@stacks/network";

export type Network = "mainnet" | "testnet";

export const NETWORK: Network =
  process.env.NETWORK === "mainnet" ? "mainnet" : "testnet";

// Production x402 service options — all are legitimate and agents may choose any:
//   https://x402.biwas.xyz  (biwas/secret-mars) — DeFi analytics, market data, wallet analysis
//   https://x402.aibtc.com  (aibtc)              — Inference, Stacks utilities, hashing, storage
//   https://stx402.com      (whoabuddy/arc)       — AI services, cryptography, storage, utilities, agent registry
// Override with the API_URL environment variable or use `bun run settings/settings.ts set-api-url`.
export const API_URL = process.env.API_URL || "https://x402.biwas.xyz";

export function getStacksNetwork(network: Network): StacksNetworkName {
  return network === "mainnet" ? "mainnet" : "testnet";
}

export function getApiBaseUrl(network: Network): string {
  return network === "mainnet"
    ? "https://api.mainnet.hiro.so"
    : "https://api.testnet.hiro.so";
}

export const EXPLORER_URL = "https://explorer.hiro.so";

export function getExplorerTxUrl(txid: string, network: Network): string {
  return `${EXPLORER_URL}/txid/${txid}?chain=${network}`;
}

export function getExplorerAddressUrl(address: string, network: Network): string {
  return `${EXPLORER_URL}/address/${address}?chain=${network}`;
}

export function getExplorerContractUrl(contractId: string, network: Network): string {
  return `${EXPLORER_URL}/txid/${contractId}?chain=${network}`;
}
