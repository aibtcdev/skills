import { getHiroApi } from "../services/hiro-api.js";
import { getContracts } from "../config/contracts.js";
import type { Network } from "../config/networks.js";

/**
 * Get sBTC balance for a given Stacks address.
 *
 * Looks up the sBTC token in the account's fungible token balances.
 * Uses the correct sBTC contract for the specified network.
 *
 * @param address - Stacks address to check
 * @param network - Network to query (mainnet or testnet)
 * @returns Balance in satoshis (1 sBTC = 100,000,000 sats)
 */
export async function getSbtcBalance(address: string, network: Network): Promise<bigint> {
  const hiro = getHiroApi(network);
  const balances = await hiro.getAccountBalances(address);

  // Use network-specific sBTC token contract
  const sbtcToken = getContracts(network).SBTC_TOKEN;
  const sbtcKey = Object.keys(balances.fungible_tokens || {}).find((key) =>
    key.startsWith(sbtcToken)
  );

  if (sbtcKey && balances.fungible_tokens[sbtcKey]) {
    return BigInt(balances.fungible_tokens[sbtcKey].balance);
  }

  return 0n;
}
