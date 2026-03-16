#!/usr/bin/env bun
/**
 * ERC-8004 skill CLI
 * Unified ERC-8004 on-chain agent identity — register identities, retrieve identity info,
 * query reputation scores, submit feedback, and request third-party validation.
 *
 * Usage: bun run erc8004/erc8004.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { Erc8004Service } from "../src/lib/services/erc8004.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default read-only caller address per network (boot addresses) */
const DEFAULT_CALLER: Record<string, string> = {
  mainnet: "SP000000000000000000002Q6VF78",
  testnet: "ST000000000000000000002AMW42H",
};

/**
 * Get the caller address for read-only calls.
 * Prefers the active wallet address if available.
 */
function getCallerAddress(): string {
  const walletManager = getWalletManager();
  const sessionInfo = walletManager.getSessionInfo();
  return sessionInfo?.address || DEFAULT_CALLER[NETWORK] || DEFAULT_CALLER.testnet;
}

/**
 * Strip optional 0x prefix and validate a hex string.
 * Optionally enforce exact byte count.
 */
function normalizeHex(hex: string, label: string, exactBytes?: number): string {
  let normalized = hex;
  if (normalized.startsWith("0x") || normalized.startsWith("0X")) {
    normalized = normalized.slice(2);
  }
  if (
    normalized.length === 0 ||
    normalized.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(normalized)
  ) {
    throw new Error(`${label} must be a non-empty, even-length hex string`);
  }
  if (exactBytes !== undefined && normalized.length !== exactBytes * 2) {
    throw new Error(
      `${label} must be exactly ${exactBytes} bytes (${exactBytes * 2} hex characters)`
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("erc8004")
  .description(
    "ERC-8004 on-chain agent identity — register identities, retrieve identity info, " +
      "query reputation scores, submit feedback, and request third-party validation"
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

program
  .command("register")
  .description(
    "Register a new agent identity on-chain using the ERC-8004 identity registry. " +
      "Returns a transaction ID. Check the transaction result to get the assigned agent ID. " +
      "Requires an unlocked wallet."
  )
  .option(
    "--uri <uri>",
    "URI pointing to agent metadata (IPFS, HTTP, etc.)"
  )
  .option(
    "--metadata <json>",
    'JSON array of {key, value} pairs where value is a hex-encoded buffer (e.g., \'[{"key":"name","value":"616c696365"}]\')'
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option(
    "--sponsored",
    "Submit as a sponsored transaction",
    false
  )
  .action(
    async (opts: {
      uri?: string;
      metadata?: string;
      fee?: string;
      sponsored: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const service = new Erc8004Service(NETWORK);

        // Parse metadata if provided
        let parsedMetadata: Array<{ key: string; value: Buffer }> | undefined;
        if (opts.metadata) {
          let rawMetadata: unknown;
          try {
            rawMetadata = JSON.parse(opts.metadata);
          } catch {
            throw new Error("--metadata must be valid JSON");
          }
          if (!Array.isArray(rawMetadata)) {
            throw new Error("--metadata must be a JSON array");
          }
          parsedMetadata = rawMetadata.map((m: unknown) => {
            if (
              typeof m !== "object" ||
              m === null ||
              typeof (m as Record<string, unknown>).key !== "string" ||
              typeof (m as Record<string, unknown>).value !== "string"
            ) {
              throw new Error('Each metadata entry must have string "key" and "value" fields');
            }
            const entry = m as { key: string; value: string };
            const normalized = normalizeHex(
              entry.value,
              `metadata value for key "${entry.key}"`
            );
            const buf = Buffer.from(normalized, "hex");
            if (buf.length > 512) {
              throw new Error(
                `metadata value for key "${entry.key}" exceeds 512 bytes (got ${buf.length})`
              );
            }
            return { key: entry.key, value: buf };
          });
        }

        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.registerIdentity(
          account,
          opts.uri,
          parsedMetadata,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message:
            "Identity registration transaction submitted. " +
            "Check transaction result to get your agent ID.",
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-identity
// ---------------------------------------------------------------------------

program
  .command("get-identity <address>")
  .description(
    "Get agent identity information from the ERC-8004 identity registry. " +
      "Pass an agent ID (integer) to look up by ID. " +
      "Returns owner address, URI, and wallet address if set. Does not require a wallet."
  )
  .action(async (address: string) => {
    try {
      const agentId = parseInt(address, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("<address> must be a non-negative integer agent ID");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const identity = await service.getIdentity(agentId, callerAddress);

      if (!identity) {
        printJson({
          success: false,
          agentId,
          message: "Agent ID not found",
        });
        return;
      }

      printJson({
        success: true,
        agentId: identity.agentId,
        owner: identity.owner,
        uri: identity.uri || "(no URI set)",
        wallet: identity.wallet || "(no wallet set)",
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-reputation
// ---------------------------------------------------------------------------

program
  .command("get-reputation <address>")
  .description(
    "Get the aggregated reputation score for an agent from the ERC-8004 reputation registry. " +
      "Returns total feedback count and WAD-averaged summary value. Does not require a wallet."
  )
  .action(async (address: string) => {
    try {
      const agentId = parseInt(address, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("<address> must be a non-negative integer agent ID");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const summary = await service.getReputation(agentId, callerAddress);

      printJson({
        success: true,
        agentId: summary.agentId,
        totalFeedback: summary.totalFeedback,
        summaryValue: summary.summaryValue,
        summaryValueDecimals: summary.summaryValueDecimals,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// give-feedback
// ---------------------------------------------------------------------------

program
  .command("give-feedback <address> <score> <comment>")
  .description(
    "Submit feedback for an agent in the ERC-8004 reputation registry. " +
      "Score is a signed integer (positive = good, negative = bad). " +
      "Comment is used as the primary classification tag. Requires an unlocked wallet."
  )
  .option(
    "--value-decimals <decimals>",
    "Decimal precision for the score (non-negative integer, default 0)",
    "0"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (
      address: string,
      score: string,
      comment: string,
      opts: { valueDecimals: string; fee?: string; sponsored: boolean }
    ) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const agentId = parseInt(address, 10);
        if (isNaN(agentId) || agentId < 0) {
          throw new Error("<address> must be a non-negative integer agent ID");
        }

        const value = parseInt(score, 10);
        if (isNaN(value)) {
          throw new Error("<score> must be an integer");
        }

        const valueDecimals = parseInt(opts.valueDecimals, 10);
        if (isNaN(valueDecimals) || valueDecimals < 0) {
          throw new Error("--value-decimals must be a non-negative integer");
        }

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.giveFeedback(
          account,
          agentId,
          value,
          valueDecimals,
          comment || undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Feedback submitted for agent ${agentId}.`,
          agentId,
          value,
          valueDecimals,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// request-validation
// ---------------------------------------------------------------------------

program
  .command("request-validation <address>")
  .description(
    "Request third-party validation for an agent from a validator in the ERC-8004 validation registry. " +
      "Caller (tx-sender) is the requester. Requires an unlocked wallet."
  )
  .requiredOption(
    "--validator <address>",
    "Stacks address of the validator to request validation from"
  )
  .requiredOption(
    "--request-uri <uri>",
    "URI pointing to the validation request data"
  )
  .requiredOption(
    "--request-hash <hex>",
    "32-byte SHA-256 hash of the request data as a hex string"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (
      address: string,
      opts: {
        validator: string;
        requestUri: string;
        requestHash: string;
        fee?: string;
        sponsored: boolean;
      }
    ) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const agentId = parseInt(address, 10);
        if (isNaN(agentId) || agentId < 0) {
          throw new Error("<address> must be a non-negative integer agent ID");
        }

        const normalizedHash = normalizeHex(opts.requestHash, "--request-hash", 32);
        const requestHashBuf = Buffer.from(normalizedHash, "hex");

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.requestValidation(
          account,
          opts.validator,
          agentId,
          opts.requestUri,
          requestHashBuf,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Validation requested from ${opts.validator} for agent ${agentId}.`,
          validator: opts.validator,
          agentId,
          requestUri: opts.requestUri,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// validation-status
// ---------------------------------------------------------------------------

program
  .command("validation-status <request-id>")
  .description(
    "Check the status of a validation request by its 32-byte request hash. " +
      "Returns validator, agent ID, response score, response hash, tag, last update block, " +
      "and whether a response has been submitted. Does not require a wallet."
  )
  .action(async (requestId: string) => {
    try {
      const normalizedHash = normalizeHex(requestId, "<request-id>", 32);
      const requestHashBuf = Buffer.from(normalizedHash, "hex");

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const status = await service.getValidationStatus(requestHashBuf, callerAddress);

      if (!status) {
        printJson({
          success: false,
          requestHash: requestId,
          message: "Validation request not found",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        requestHash: requestId,
        validator: status.validator,
        agentId: status.agentId,
        response: status.response,
        responseHash: status.responseHash,
        tag: status.tag,
        lastUpdate: status.lastUpdate,
        hasResponse: status.hasResponse,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
