import {
  makeSTXTokenTransfer,
  makeContractCall,
  PostConditionMode,
} from "@stacks/transactions";
import { getStacksNetwork, type Network } from "../config/networks.js";
import { getSponsorRelayUrl, getSponsorApiKey } from "../config/sponsor.js";
import type { Account, ContractCallOptions, TransferResult } from "./builder.js";
import { acquireNonce, releaseNonce } from "../services/nonce-tracker.js";
import { classifyRelayError, sleep } from "./retry-strategy.js";

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

  if (!response.txid) {
    throw new Error("Sponsor relay succeeded but returned no txid");
  }

  return { txid: response.txid, rawTx: serializedTx };
}

/**
 * Sponsored contract call with nonce-tracker integration and retry logic.
 *
 * Acquires a sender nonce from nonce-tracker before building the transaction,
 * ensuring concurrent dispatch cycles don't collide on the same nonce.
 *
 * Retry behaviour:
 * - Relay-side conflict (NONCE_CONFLICT): sleep retryAfter, resubmit same serialized tx
 * - Sender-side conflict (ConflictingNonceInMempool): release as rejected, re-acquire, rebuild
 * - Transient errors: sleep, resubmit same serialized tx
 * - Non-retryable errors: release as broadcast, throw
 *
 * @param account     - Wallet account (must have privateKey + address)
 * @param options     - Contract call options (nonce field ignored; managed internally)
 * @param network     - Target network
 * @param maxAttempts - Maximum submission attempts (default: 3)
 */
export async function sponsoredContractCallWithRetry(
  account: Account,
  options: ContractCallOptions,
  network: Network,
  maxAttempts = 3
): Promise<TransferResult> {
  const apiKey = resolveSponsorApiKey(account);
  const networkName = getStacksNetwork(network);
  const stxAddress = account.address;

  let acquired = await acquireNonce(stxAddress);
  let nonce = acquired.nonce;
  let serializedTx: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Build (or rebuild after nonce re-acquisition)
    if (serializedTx === null) {
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
        nonce: BigInt(nonce),
      });
      serializedTx = transaction.serialize();
    }

    const response = await submitToSponsorRelay(serializedTx, network, apiKey);

    if (response.success && response.txid) {
      await releaseNonce(stxAddress, nonce, true, undefined, response.txid);
      return { txid: response.txid, rawTx: serializedTx };
    }

    // Last attempt — give up
    if (attempt === maxAttempts - 1) {
      await releaseNonce(stxAddress, nonce, false, "broadcast");
      throw new Error(formatRelayError(response));
    }

    const retry = classifyRelayError(response);

    if (!retry.retryable) {
      await releaseNonce(stxAddress, nonce, false, "broadcast");
      throw new Error(formatRelayError(response));
    }

    if (retry.senderSideConflict) {
      // Nonce not consumed by Hiro — safe to roll back and re-acquire a fresh one
      await releaseNonce(stxAddress, nonce, false, "rejected");
      acquired = await acquireNonce(stxAddress);
      nonce = acquired.nonce;
      serializedTx = null; // Force rebuild with new nonce
      // No sleep — re-acquire already syncs from Hiro
    } else {
      // Relay-side conflict, transient, rate-limited: resubmit same serialized tx
      await sleep(retry.delayMs);
    }
  }

  // Should not reach here but TypeScript requires a return path
  await releaseNonce(stxAddress, nonce, false, "broadcast");
  throw new Error(`sponsoredContractCallWithRetry: exhausted ${maxAttempts} attempts`);
}

/**
 * Sponsored STX transfer with nonce-tracker integration and retry logic.
 *
 * Same retry semantics as sponsoredContractCallWithRetry.
 *
 * @param account     - Wallet account (must have privateKey + address)
 * @param recipient   - Recipient Stacks address
 * @param amount      - Amount in micro-STX
 * @param memo        - Optional memo string
 * @param network     - Target network
 * @param maxAttempts - Maximum submission attempts (default: 3)
 */
export async function transferStxSponsoredWithRetry(
  account: Account,
  recipient: string,
  amount: bigint,
  memo: string | undefined,
  network: Network,
  maxAttempts = 3
): Promise<TransferResult> {
  const apiKey = resolveSponsorApiKey(account);
  const networkName = getStacksNetwork(network);
  const stxAddress = account.address;

  let acquired = await acquireNonce(stxAddress);
  let nonce = acquired.nonce;
  let serializedTx: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (serializedTx === null) {
      const transaction = await makeSTXTokenTransfer({
        recipient,
        amount,
        senderKey: account.privateKey,
        network: networkName,
        memo: memo || "",
        sponsored: true,
        fee: 0n,
        nonce: BigInt(nonce),
      });
      serializedTx = transaction.serialize();
    }

    const response = await submitToSponsorRelay(serializedTx, network, apiKey);

    if (response.success && response.txid) {
      await releaseNonce(stxAddress, nonce, true, undefined, response.txid);
      return { txid: response.txid, rawTx: serializedTx };
    }

    if (attempt === maxAttempts - 1) {
      await releaseNonce(stxAddress, nonce, false, "broadcast");
      throw new Error(formatRelayError(response));
    }

    const retry = classifyRelayError(response);

    if (!retry.retryable) {
      await releaseNonce(stxAddress, nonce, false, "broadcast");
      throw new Error(formatRelayError(response));
    }

    if (retry.senderSideConflict) {
      await releaseNonce(stxAddress, nonce, false, "rejected");
      acquired = await acquireNonce(stxAddress);
      nonce = acquired.nonce;
      serializedTx = null;
    } else {
      await sleep(retry.delayMs);
    }
  }

  await releaseNonce(stxAddress, nonce, false, "broadcast");
  throw new Error(`transferStxSponsoredWithRetry: exhausted ${maxAttempts} attempts`);
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
 * Submit a serialized transaction to the sponsor relay.
 * Exported to allow resubmission of the same serialized tx in retry loops.
 */
export async function submitToSponsorRelay(
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
    body: JSON.stringify({
      transaction: transaction.startsWith("0x") ? transaction : "0x" + transaction,
    }),
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
