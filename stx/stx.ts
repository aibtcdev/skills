#!/usr/bin/env bun
/**
 * STX skill CLI
 * Stacks L2 STX token and contract operations
 *
 * Usage: bun run stx/stx.ts <subcommand> [options]
 */

import { Command } from "commander";
import { PostConditionMode, PostCondition } from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl, getExplorerAddressUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi, getTransactionStatus } from "../src/lib/services/hiro-api.js";
import {
  transferStx,
  callContract,
  deployContract,
  broadcastSignedTransaction,
} from "../src/lib/transactions/builder.js";
import { parseArgToClarityValue } from "../src/lib/transactions/clarity-values.js";
import {
  createStxPostCondition,
  createContractStxPostCondition,
  createFungiblePostCondition,
  createContractFungiblePostCondition,
  createNftSendPostCondition,
  createNftNotSendPostCondition,
} from "../src/lib/transactions/post-conditions.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// STX helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Stacks address: prefer explicit arg, fall back to wallet session.
 */
async function getStxAddress(address?: string): Promise<string> {
  if (address) {
    return address;
  }

  try {
    return await getWalletAddress();
  } catch {
    throw new Error(
      "No Stacks address provided and wallet is not unlocked. " +
        "Either provide --address or unlock your wallet first."
    );
  }
}

/**
 * Format micro-STX as a human-readable STX string.
 */
function formatStx(microStx: string): string {
  const stx = BigInt(microStx) / BigInt(1_000_000);
  const remainder = BigInt(microStx) % BigInt(1_000_000);
  if (remainder === 0n) {
    return stx.toString() + " STX";
  }
  const decimal = (Number(microStx) / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
  return decimal + " STX";
}

/**
 * Parse a post condition descriptor from JSON to a PostCondition object.
 */
function parsePostCondition(pc: unknown): PostCondition {
  if (typeof pc !== "object" || pc === null) {
    throw new Error("Post condition must be an object");
  }

  const condition = pc as Record<string, unknown>;
  const { type, principal, conditionCode, amount, asset, assetName, tokenId, notSend } = condition;

  if (typeof principal !== "string") {
    throw new Error("Post condition 'principal' must be a string");
  }

  const validConditionCodes = ["eq", "gt", "gte", "lt", "lte"];

  if (type === "stx") {
    if (typeof amount !== "string" && typeof amount !== "number") {
      throw new Error("STX post condition 'amount' must be a string or number");
    }
    if (typeof conditionCode !== "string" || !validConditionCodes.includes(conditionCode)) {
      throw new Error(`STX post condition 'conditionCode' must be one of: ${validConditionCodes.join(", ")}`);
    }
    const amountBigInt = BigInt(amount);
    const code = conditionCode as "eq" | "gt" | "gte" | "lt" | "lte";

    if (principal.includes(".")) {
      return createContractStxPostCondition(principal, code, amountBigInt);
    }
    return createStxPostCondition(principal, code, amountBigInt);
  }

  if (type === "ft") {
    if (typeof asset !== "string") {
      throw new Error("FT post condition 'asset' must be a string (contract ID)");
    }
    if (typeof assetName !== "string") {
      throw new Error("FT post condition 'assetName' must be a string (token name)");
    }
    if (typeof amount !== "string" && typeof amount !== "number") {
      throw new Error("FT post condition 'amount' must be a string or number");
    }
    if (typeof conditionCode !== "string" || !validConditionCodes.includes(conditionCode)) {
      throw new Error(`FT post condition 'conditionCode' must be one of: ${validConditionCodes.join(", ")}`);
    }
    const amountBigInt = BigInt(amount);
    const code = conditionCode as "eq" | "gt" | "gte" | "lt" | "lte";

    if (principal.includes(".")) {
      return createContractFungiblePostCondition(principal, asset, assetName, code, amountBigInt);
    }
    return createFungiblePostCondition(principal, asset, assetName, code, amountBigInt);
  }

  if (type === "nft") {
    if (typeof asset !== "string") {
      throw new Error("NFT post condition 'asset' must be a string (contract ID)");
    }
    if (typeof assetName !== "string") {
      throw new Error("NFT post condition 'assetName' must be a string (NFT name)");
    }
    if (typeof tokenId !== "string" && typeof tokenId !== "number") {
      throw new Error("NFT post condition 'tokenId' must be a string or number");
    }
    let tokenIdBigInt: bigint;
    try {
      tokenIdBigInt = BigInt(tokenId);
    } catch {
      throw new Error(`NFT post condition 'tokenId' must be a valid integer, got: ${tokenId}`);
    }

    if (notSend === true) {
      return createNftNotSendPostCondition(principal, asset, assetName, tokenIdBigInt);
    }
    return createNftSendPostCondition(principal, asset, assetName, tokenIdBigInt);
  }

  throw new Error(`Invalid post condition type: ${type}. Must be 'stx', 'ft', or 'nft'.`);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("stx")
  .description(
    "Stacks L2 STX operations: check balances, transfer STX, broadcast transactions, call contracts, deploy contracts, and check transaction status"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-balance
// ---------------------------------------------------------------------------

program
  .command("get-balance")
  .description(
    "Get the STX balance for a Stacks address. Returns balance in micro-STX and STX."
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const address = await getStxAddress(opts.address);
      const hiro = getHiroApi(NETWORK);
      const stxBalance = await hiro.getStxBalance(address);

      printJson({
        address,
        network: NETWORK,
        balance: {
          microStx: stxBalance.balance,
          stx: formatStx(stxBalance.balance),
        },
        locked: {
          microStx: stxBalance.locked,
          stx: formatStx(stxBalance.locked),
        },
        explorerUrl: getExplorerAddressUrl(address, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description(
    "Transfer STX to a recipient address. " +
      "Requires an unlocked wallet. " +
      "1 STX = 1,000,000 micro-STX."
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to (starts with SP or ST)"
  )
  .requiredOption(
    "--amount <microStx>",
    "Amount in micro-STX (e.g., '2000000' for 2 STX)"
  )
  .option(
    "--memo <text>",
    "Optional memo message to include with the transfer"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      recipient: string;
      amount: string;
      memo?: string;
      fee?: string;
    }) => {
      try {
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "token_transfer");
        const result = await transferStx(
          account,
          opts.recipient,
          BigInt(opts.amount),
          opts.memo,
          resolvedFee
        );

        printJson({
          success: true,
          txid: result.txid,
          from: account.address,
          recipient: opts.recipient,
          amount: formatStx(opts.amount),
          amountMicroStx: opts.amount,
          memo: opts.memo || null,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// broadcast-transaction
// ---------------------------------------------------------------------------

program
  .command("broadcast-transaction")
  .description("Broadcast a pre-signed Stacks transaction to the network.")
  .requiredOption(
    "--signed-tx <hex>",
    "The signed transaction as a hex string"
  )
  .action(async (opts: { signedTx: string }) => {
    try {
      const result = await broadcastSignedTransaction(opts.signedTx, NETWORK);

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// call-contract
// ---------------------------------------------------------------------------

program
  .command("call-contract")
  .description(
    "Call a function on a Stacks smart contract. Signs and broadcasts the transaction. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--contract-address <address>",
    "The contract deployer's address (e.g., SP2...)"
  )
  .requiredOption(
    "--contract-name <name>",
    "The contract name (e.g., my-token)"
  )
  .requiredOption(
    "--function-name <name>",
    "The function to call (e.g., transfer)"
  )
  .option(
    "--args <json>",
    "Function arguments as JSON array (default: []). Typed: [{\"type\":\"uint\",\"value\":100}]",
    "[]"
  )
  .option(
    "--post-condition-mode <mode>",
    "'deny' (default) blocks unexpected transfers; 'allow' permits any",
    "deny"
  )
  .option(
    "--post-conditions <json>",
    "Post conditions as JSON array. See SKILL.md for format."
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      contractAddress: string;
      contractName: string;
      functionName: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      fee?: string;
    }) => {
      try {
        const account = await getAccount();

        let functionArgs: unknown[];
        try {
          functionArgs = JSON.parse(opts.args);
          if (!Array.isArray(functionArgs)) {
            throw new Error("--args must be a JSON array");
          }
        } catch (e) {
          throw new Error(`Invalid --args JSON: ${e instanceof Error ? e.message : String(e)}`);
        }

        const clarityArgs = functionArgs.map(parseArgToClarityValue);
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");

        const postConditionMode =
          opts.postConditionMode === "allow" ? PostConditionMode.Allow : PostConditionMode.Deny;

        let parsedPostConditions: PostCondition[] | undefined;
        if (opts.postConditions) {
          let pcArray: unknown[];
          try {
            pcArray = JSON.parse(opts.postConditions);
            if (!Array.isArray(pcArray)) {
              throw new Error("--post-conditions must be a JSON array");
            }
          } catch (e) {
            throw new Error(`Invalid --post-conditions JSON: ${e instanceof Error ? e.message : String(e)}`);
          }
          parsedPostConditions = pcArray.map(parsePostCondition);
        }

        const result = await callContract(account, {
          contractAddress: opts.contractAddress,
          contractName: opts.contractName,
          functionName: opts.functionName,
          functionArgs: clarityArgs,
          postConditionMode,
          ...(parsedPostConditions && { postConditions: parsedPostConditions }),
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          contract: `${opts.contractAddress}.${opts.contractName}`,
          function: opts.functionName,
          args: functionArgs,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// deploy-contract
// ---------------------------------------------------------------------------

program
  .command("deploy-contract")
  .description(
    "Deploy a Clarity smart contract to the Stacks blockchain. Requires an unlocked wallet."
  )
  .requiredOption(
    "--contract-name <name>",
    "Unique name for the contract (lowercase, hyphens allowed)"
  )
  .requiredOption(
    "--code-body <source>",
    "The complete Clarity source code"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      contractName: string;
      codeBody: string;
      fee?: string;
    }) => {
      try {
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "smart_contract");

        const result = await deployContract(account, {
          contractName: opts.contractName,
          codeBody: opts.codeBody,
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          contractId: `${account.address}.${opts.contractName}`,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-transaction-status
// ---------------------------------------------------------------------------

program
  .command("get-transaction-status")
  .description("Check the status of a Stacks transaction by its txid.")
  .requiredOption(
    "--txid <txid>",
    "The transaction ID (64 character hex string)"
  )
  .action(async (opts: { txid: string }) => {
    try {
      const status = await getTransactionStatus(opts.txid, NETWORK);

      printJson({
        txid: opts.txid,
        ...status,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(opts.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
