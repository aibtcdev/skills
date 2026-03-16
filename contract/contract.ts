#!/usr/bin/env bun
/**
 * Contract skill CLI
 * Clarity smart contract deployment and interaction: deploy from source files,
 * call public functions with post conditions, and call read-only functions.
 *
 * Usage: bun run contract/contract.ts <subcommand> [options]
 */

import { Command } from "commander";
import { PostConditionMode, PostCondition } from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import {
  callContract,
  deployContract,
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
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a post condition descriptor from JSON to a PostCondition object.
 * Supports type: "stx" | "ft" | "nft"
 */
function parsePostCondition(pc: unknown): PostCondition {
  if (typeof pc !== "object" || pc === null) {
    throw new Error("Post condition must be an object");
  }

  const condition = pc as Record<string, unknown>;
  const { type, principal, conditionCode, amount, asset, assetName, tokenId, notSend } =
    condition;

  if (typeof principal !== "string") {
    throw new Error("Post condition 'principal' must be a string");
  }

  const validConditionCodes = ["eq", "gt", "gte", "lt", "lte"];

  if (type === "stx") {
    if (typeof amount !== "string" && typeof amount !== "number") {
      throw new Error("STX post condition 'amount' must be a string or number");
    }
    if (
      typeof conditionCode !== "string" ||
      !validConditionCodes.includes(conditionCode)
    ) {
      throw new Error(
        `STX post condition 'conditionCode' must be one of: ${validConditionCodes.join(", ")}`
      );
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
      throw new Error(
        "FT post condition 'assetName' must be a string (token name)"
      );
    }
    if (typeof amount !== "string" && typeof amount !== "number") {
      throw new Error("FT post condition 'amount' must be a string or number");
    }
    if (
      typeof conditionCode !== "string" ||
      !validConditionCodes.includes(conditionCode)
    ) {
      throw new Error(
        `FT post condition 'conditionCode' must be one of: ${validConditionCodes.join(", ")}`
      );
    }
    const amountBigInt = BigInt(amount);
    const code = conditionCode as "eq" | "gt" | "gte" | "lt" | "lte";

    if (principal.includes(".")) {
      return createContractFungiblePostCondition(
        principal,
        asset,
        assetName,
        code,
        amountBigInt
      );
    }
    return createFungiblePostCondition(principal, asset, assetName, code, amountBigInt);
  }

  if (type === "nft") {
    if (typeof asset !== "string") {
      throw new Error("NFT post condition 'asset' must be a string (contract ID)");
    }
    if (typeof assetName !== "string") {
      throw new Error(
        "NFT post condition 'assetName' must be a string (NFT name)"
      );
    }
    if (typeof tokenId !== "string" && typeof tokenId !== "number") {
      throw new Error(
        "NFT post condition 'tokenId' must be a string or number"
      );
    }
    let tokenIdBigInt: bigint;
    try {
      tokenIdBigInt = BigInt(tokenId);
    } catch {
      throw new Error(
        `NFT post condition 'tokenId' must be a valid integer, got: ${tokenId}`
      );
    }

    if (notSend === true) {
      return createNftNotSendPostCondition(principal, asset, assetName, tokenIdBigInt);
    }
    return createNftSendPostCondition(principal, asset, assetName, tokenIdBigInt);
  }

  throw new Error(
    `Invalid post condition type: ${type}. Must be 'stx', 'ft', or 'nft'.`
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("contract")
  .description(
    "Clarity smart contract deployment and interaction: deploy contracts from source files, " +
      "call public functions with post conditions, and call read-only functions"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

program
  .command("deploy")
  .description(
    "Deploy a Clarity smart contract from a .clar source file. " +
      "Reads the file, signs, and broadcasts a smart_contract transaction. " +
      "Deployment is irreversible — pre-simulate on stxer.xyz before deploying. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--source <path>",
    "Path to the .clar source file to deploy"
  )
  .requiredOption(
    "--name <contract-name>",
    "Contract name (lowercase, hyphens allowed, max 128 chars)"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      source: string;
      name: string;
      fee?: string;
    }) => {
      try {
        let codeBody: string;
        try {
          codeBody = await Bun.file(opts.source).text();
        } catch (err) {
          throw new Error(
            `Failed to read contract source file '${opts.source}': ${err instanceof Error ? err.message : String(err)}`
          );
        }

        if (!codeBody.trim()) {
          throw new Error(`--source file is empty: ${opts.source}`);
        }

        if (!/^[a-z][a-z0-9-]{0,127}$/.test(opts.name)) {
          throw new Error(
            "--name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (max 128 chars)"
          );
        }

        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "smart_contract");

        const result = await deployContract(account, {
          contractName: opts.name,
          codeBody,
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          contractId: `${account.address}.${opts.name}`,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------

program
  .command("call")
  .description(
    "Call a public function on a deployed Stacks smart contract. " +
      "Signs and broadcasts a contract_call transaction. " +
      "Use --post-conditions to guard token transfers. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--contract <contractId>",
    "Full contract ID in ADDRESS.contract-name format (e.g., SP2...deployer.my-contract)"
  )
  .requiredOption(
    "--function <functionName>",
    "Public function name to call"
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
      contract: string;
      function: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      fee?: string;
    }) => {
      try {
        // Validate contract ID format
        const contractParts = opts.contract.split(".");
        if (contractParts.length !== 2 || !contractParts[0] || !contractParts[1]) {
          throw new Error(
            "--contract must be in ADDRESS.contract-name format (e.g., SP2...deployer.my-contract)"
          );
        }
        const [contractAddress, contractName] = contractParts;

        // Parse function arguments
        let functionArgs: unknown[];
        try {
          functionArgs = JSON.parse(opts.args);
          if (!Array.isArray(functionArgs)) {
            throw new Error("--args must be a JSON array");
          }
        } catch (e) {
          throw new Error(
            `Invalid --args JSON: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        const clarityArgs = functionArgs.map(parseArgToClarityValue);
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");

        const postConditionMode =
          opts.postConditionMode === "allow"
            ? PostConditionMode.Allow
            : PostConditionMode.Deny;

        let parsedPostConditions: PostCondition[] | undefined;
        if (opts.postConditions) {
          let pcArray: unknown[];
          try {
            pcArray = JSON.parse(opts.postConditions);
            if (!Array.isArray(pcArray)) {
              throw new Error("--post-conditions must be a JSON array");
            }
          } catch (e) {
            throw new Error(
              `Invalid --post-conditions JSON: ${e instanceof Error ? e.message : String(e)}`
            );
          }
          parsedPostConditions = pcArray.map(parsePostCondition);
        }

        const account = await getAccount();

        const result = await callContract(account, {
          contractAddress,
          contractName,
          functionName: opts.function,
          functionArgs: clarityArgs,
          postConditionMode,
          ...(parsedPostConditions && { postConditions: parsedPostConditions }),
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          contract: opts.contract,
          function: opts.function,
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
// read
// ---------------------------------------------------------------------------

program
  .command("read")
  .description(
    "Call a read-only function on a deployed Stacks smart contract. " +
      "Does not broadcast a transaction. No wallet required."
  )
  .requiredOption(
    "--contract <contractId>",
    "Full contract ID in ADDRESS.contract-name format (e.g., SP2...deployer.my-contract)"
  )
  .requiredOption(
    "--function <functionName>",
    "Read-only function name to call"
  )
  .option(
    "--args <json>",
    "Function arguments as JSON array (default: [])",
    "[]"
  )
  .option(
    "--sender <address>",
    "Stacks address to use as the read-only call sender (uses active wallet if omitted)"
  )
  .action(
    async (opts: {
      contract: string;
      function: string;
      args: string;
      sender?: string;
    }) => {
      try {
        // Validate contract ID format
        const contractParts = opts.contract.split(".");
        if (contractParts.length !== 2 || !contractParts[0] || !contractParts[1]) {
          throw new Error(
            "--contract must be in ADDRESS.contract-name format (e.g., SP2...deployer.my-contract)"
          );
        }

        // Parse function arguments
        let functionArgs: unknown[];
        try {
          functionArgs = JSON.parse(opts.args);
          if (!Array.isArray(functionArgs)) {
            throw new Error("--args must be a JSON array");
          }
        } catch (e) {
          throw new Error(
            `Invalid --args JSON: ${e instanceof Error ? e.message : String(e)}`
          );
        }

        const clarityArgs = functionArgs.map(parseArgToClarityValue);

        // Resolve sender address
        let senderAddress: string;
        if (opts.sender) {
          senderAddress = opts.sender;
        } else {
          try {
            senderAddress = await getWalletAddress();
          } catch {
            // Fall back to a generic mainnet address if no wallet is available
            senderAddress = "SP000000000000000000002Q6VF78";
          }
        }

        const hiro = getHiroApi(NETWORK);
        const response = await hiro.callReadOnlyFunction(
          opts.contract,
          opts.function,
          clarityArgs,
          senderAddress
        );

        printJson({
          contract: opts.contract,
          function: opts.function,
          okay: response.okay,
          result: response.result ?? null,
          ...(response.cause && { cause: response.cause }),
          network: NETWORK,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
