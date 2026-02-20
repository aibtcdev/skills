import {
  makeSTXTokenTransfer,
  makeContractCall,
  makeContractDeploy,
  broadcastTransaction,
  ClarityValue,
  PostConditionMode,
  PostCondition,
} from "@stacks/transactions";
import { hexToBytes } from "@stacks/common";
import { getStacksNetwork, getApiBaseUrl, type Network } from "../config/networks.js";
import type { WalletAddresses } from "../utils/storage.js";

export interface Account extends WalletAddresses {
  privateKey: string;
  /**
   * Bitcoin private key as raw bytes (32 bytes) for signing BTC transactions.
   * SECURITY: Never serialize to WIF/hex. Only held in memory during session.
   */
  btcPrivateKey?: Uint8Array;
  /**
   * Bitcoin public key as raw bytes (33 bytes compressed) for building transactions.
   */
  btcPublicKey?: Uint8Array;
  /**
   * Taproot private key as raw bytes (32 bytes) for signing Taproot transactions.
   * SECURITY: Never serialize. Only held in memory during session.
   */
  taprootPrivateKey?: Uint8Array;
  /**
   * Taproot internal public key as raw bytes (32 bytes, x-only) for building Taproot transactions.
   */
  taprootPublicKey?: Uint8Array;
  network: Network;
}

export interface TransferResult {
  txid: string;
  rawTx: string;
}

export interface ContractCallOptions {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditionMode?: PostConditionMode;
  postConditions?: PostCondition[];
  /** Optional fee in micro-STX. If omitted, fee is auto-estimated. */
  fee?: bigint;
}

export interface ContractDeployOptions {
  contractName: string;
  codeBody: string;
  /** Optional fee in micro-STX. If omitted, fee is auto-estimated. */
  fee?: bigint;
}

/**
 * Transfer STX tokens to a recipient
 * @param fee Optional fee in micro-STX. If omitted, fee is auto-estimated.
 */
export async function transferStx(
  account: Account,
  recipient: string,
  amount: bigint,
  memo?: string,
  fee?: bigint
): Promise<TransferResult> {
  const networkName = getStacksNetwork(account.network);

  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount,
    senderKey: account.privateKey,
    network: networkName,
    memo: memo || "",
    ...(fee !== undefined && { fee }),
  });

  const broadcastResponse = await broadcastTransaction({
    transaction,
    network: networkName,
  });

  if ("error" in broadcastResponse) {
    throw new Error(
      `Broadcast failed: ${broadcastResponse.error} - ${broadcastResponse.reason}`
    );
  }

  return {
    txid: broadcastResponse.txid,
    rawTx: transaction.serialize(),
  };
}

/**
 * Call a smart contract function
 */
export async function callContract(
  account: Account,
  options: ContractCallOptions
): Promise<TransferResult> {
  const networkName = getStacksNetwork(account.network);

  const transaction = await makeContractCall({
    contractAddress: options.contractAddress,
    contractName: options.contractName,
    functionName: options.functionName,
    functionArgs: options.functionArgs,
    senderKey: account.privateKey,
    network: networkName,
    postConditionMode: options.postConditionMode || PostConditionMode.Deny,
    postConditions: options.postConditions || [],
    ...(options.fee !== undefined && { fee: options.fee }),
  });

  const broadcastResponse = await broadcastTransaction({
    transaction,
    network: networkName,
  });

  if ("error" in broadcastResponse) {
    throw new Error(
      `Broadcast failed: ${broadcastResponse.error} - ${broadcastResponse.reason}`
    );
  }

  return {
    txid: broadcastResponse.txid,
    rawTx: transaction.serialize(),
  };
}

/**
 * Deploy a smart contract
 */
export async function deployContract(
  account: Account,
  options: ContractDeployOptions
): Promise<TransferResult> {
  const networkName = getStacksNetwork(account.network);

  const transaction = await makeContractDeploy({
    contractName: options.contractName,
    codeBody: options.codeBody,
    senderKey: account.privateKey,
    network: networkName,
    ...(options.fee !== undefined && { fee: options.fee }),
  });

  const broadcastResponse = await broadcastTransaction({
    transaction,
    network: networkName,
  });

  if ("error" in broadcastResponse) {
    throw new Error(
      `Broadcast failed: ${broadcastResponse.error} - ${broadcastResponse.reason}`
    );
  }

  return {
    txid: broadcastResponse.txid,
    rawTx: transaction.serialize(),
  };
}

/**
 * Sign a transaction without broadcasting (for offline signing)
 */
export async function signStxTransfer(
  account: Account,
  recipient: string,
  amount: bigint,
  memo?: string,
  fee?: bigint
): Promise<{ signedTx: string; txid: string }> {
  const networkName = getStacksNetwork(account.network);

  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount,
    senderKey: account.privateKey,
    network: networkName,
    memo: memo || "",
    ...(fee !== undefined && { fee }),
  });

  return {
    signedTx: transaction.serialize(),
    txid: transaction.txid(),
  };
}

/**
 * Sign a contract call without broadcasting
 */
export async function signContractCall(
  account: Account,
  options: ContractCallOptions
): Promise<{ signedTx: string; txid: string }> {
  const networkName = getStacksNetwork(account.network);

  const transaction = await makeContractCall({
    contractAddress: options.contractAddress,
    contractName: options.contractName,
    functionName: options.functionName,
    functionArgs: options.functionArgs,
    senderKey: account.privateKey,
    network: networkName,
    postConditionMode: options.postConditionMode || PostConditionMode.Deny,
    postConditions: options.postConditions || [],
    ...(options.fee !== undefined && { fee: options.fee }),
  });

  return {
    signedTx: transaction.serialize(),
    txid: transaction.txid(),
  };
}

/**
 * Broadcast a pre-signed transaction
 */
export async function broadcastSignedTransaction(
  signedTx: string,
  network: Network
): Promise<{ txid: string }> {
  const baseUrl = getApiBaseUrl(network);
  const txBytes = Buffer.from(hexToBytes(signedTx));

  const response = await fetch(`${baseUrl}/v2/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: txBytes,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Broadcast failed: ${response.statusText} - ${errorText}`);
  }

  const txid = await response.text();
  return { txid: txid.replace(/"/g, "") };
}

export * from "./sponsor-builder.js";
