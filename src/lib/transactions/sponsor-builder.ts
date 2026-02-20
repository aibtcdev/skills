import {
  makeSTXTokenTransfer,
  makeContractCall,
  PostConditionMode,
} from "@stacks/transactions";
import { getStacksNetwork, type Network } from "../config/networks.js";
import { getSponsorRelayUrl, getSponsorApiKey } from "../config/sponsor.js";
import type { Account, ContractCallOptions, TransferResult } from "./builder.js";

export interface SponsoredTransferOptions {
  senderKey: string;
  recipient: string;
  amount: bigint;
  memo?: string;
  network: Network;
}

export interface SponsorRelayResponse {
  success: boolean;
  requestId?: string;
  txid?: string;
  explorerUrl?: string;
  fee?: number;
  error?: string;
  code?: string;
  details?: string;
  retryable?: boolean;
  retryAfter?: number;
}

/**
 * Format a failed SponsorRelayResponse into an error message
 */
function formatRelayError(response: SponsorRelayResponse): string {
  const errorMsg = response.error || "Sponsor relay request failed";
  const details = response.details ? ` (${response.details})` : "";
  const retryInfo = response.retryable
    ? typeof response.retryAfter === "number"
      ? ` [Retryable after ${response.retryAfter}s]`
      : " [Retryable; try again later]"
    : "";
  return `${errorMsg}${details}${retryInfo}`;
}

/**
 * Resolve the sponsor API key from the account or environment.
 * Throws if no key is available.
 */
function resolveSponsorApiKey(account: Account): string {
  const apiKey = account.sponsorApiKey || getSponsorApiKey();
  if (!apiKey) {
    throw new Error(
      "Sponsored transactions require SPONSOR_API_KEY environment variable or wallet-level sponsorApiKey"
    );
  }
  return apiKey;
}

/**
 * High-level helper: build a sponsored contract call, submit to relay, and
 * return a TransferResult. Resolves the API key and handles relay errors.
 *
 * This is the primary entry point for services that need sponsored contract calls.
 */
export async function sponsoredContractCall(
  account: Account,
  options: ContractCallOptions,
  network: Network
): Promise<TransferResult> {
  const apiKey = resolveSponsorApiKey(account);

  const networkName = getStacksNetwork(network);
  const transaction = await makeContractCall({
    contractAddress: options.contractAddress,
    contractName: options.contractName,
    functionName: options.functionName,
    functionArgs: options.functionArgs,
    senderKey: account.privateKey,
    network: networkName,
    postConditionMode: options.postConditionMode || PostConditionMode.Deny,
    postConditions: options.postConditions || [],
    sponsored: true,
    fee: 0n,
  });

  const serializedTx = transaction.serialize();
  const response = await submitToSponsorRelay(serializedTx, network, apiKey);

  if (!response.success) {
    throw new Error(formatRelayError(response));
  }

  return { txid: response.txid!, rawTx: serializedTx };
}

/**
 * Build and submit a sponsored STX transfer transaction
 */
export async function transferStxSponsored(
  options: SponsoredTransferOptions,
  apiKey: string
): Promise<SponsorRelayResponse> {
  const networkName = getStacksNetwork(options.network);

  const transaction = await makeSTXTokenTransfer({
    recipient: options.recipient,
    amount: options.amount,
    senderKey: options.senderKey,
    network: networkName,
    memo: options.memo || "",
    sponsored: true,
    fee: 0n,
  });

  const serializedTx = transaction.serialize();
  return submitToSponsorRelay(serializedTx, options.network, apiKey);
}

/**
 * Submit a serialized transaction to the sponsor relay
 */
async function submitToSponsorRelay(
  transaction: string,
  network: Network,
  apiKey: string
): Promise<SponsorRelayResponse> {
  const relayUrl = getSponsorRelayUrl(network);

  const response = await fetch(`${relayUrl}/sponsor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ transaction }),
  });

  const responseText = await response.text();

  let data: SponsorRelayResponse;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = {
      success: false,
      error: `Sponsor relay returned non-JSON response (status ${response.status})`,
      details: responseText || undefined,
    };
  }

  if (!response.ok || !data.success) {
    return {
      success: false,
      error: data.error || "Sponsor relay request failed",
      code: data.code,
      details: data.details,
      retryable: data.retryable,
      retryAfter: data.retryAfter,
    };
  }

  return data as SponsorRelayResponse;
}
