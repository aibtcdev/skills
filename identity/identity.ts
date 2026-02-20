#!/usr/bin/env bun
/**
 * Identity skill CLI
 * ERC-8004 on-chain agent identity, reputation, and validation management
 *
 * Usage: bun run identity/identity.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { Erc8004Service } from "../src/lib/services/erc8004.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Identity helpers
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
  .name("identity")
  .description(
    "ERC-8004 on-chain agent identity and reputation: register identities, query info, " +
      "submit feedback, and manage third-party validation requests"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

program
  .command("register")
  .description(
    "Register a new agent identity on-chain using ERC-8004 identity registry. " +
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
// get
// ---------------------------------------------------------------------------

program
  .command("get")
  .description(
    "Get agent identity information from the ERC-8004 identity registry. " +
      "Returns owner address, URI, and wallet address if set."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to look up (non-negative integer)"
  )
  .action(async (opts: { agentId: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
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
// give-feedback
// ---------------------------------------------------------------------------

program
  .command("give-feedback")
  .description(
    "Submit feedback for an agent using the ERC-8004 reputation registry. " +
      "Value is normalized to 18 decimals (WAD) internally for aggregation. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to give feedback for (non-negative integer)"
  )
  .requiredOption(
    "--value <n>",
    "Feedback value (e.g., 5 for 5-star rating)"
  )
  .requiredOption(
    "--decimals <n>",
    "Decimals for the value (e.g., 0 for integer ratings, 0-18)"
  )
  .option("--tag1 <tag>", "Optional tag 1 (max 64 chars)")
  .option("--tag2 <tag>", "Optional tag 2 (max 64 chars)")
  .option("--endpoint <url>", "Optional endpoint URL")
  .option("--feedback-uri <uri>", "Optional feedback URI")
  .option(
    "--feedback-hash <hex>",
    "Optional feedback hash as hex string (32 bytes / 64 hex chars)"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      agentId: string;
      value: string;
      decimals: string;
      tag1?: string;
      tag2?: string;
      endpoint?: string;
      feedbackUri?: string;
      feedbackHash?: string;
      fee?: string;
      sponsored: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const agentId = parseInt(opts.agentId, 10);
        if (isNaN(agentId) || agentId < 0) {
          throw new Error("--agent-id must be a non-negative integer");
        }

        const value = parseInt(opts.value, 10);
        if (isNaN(value) || value < 0) {
          throw new Error("--value must be a non-negative integer");
        }

        const decimals = parseInt(opts.decimals, 10);
        if (isNaN(decimals) || decimals < 0 || decimals > 18) {
          throw new Error("--decimals must be an integer between 0 and 18");
        }

        const service = new Erc8004Service(NETWORK);

        const hashBuffer = opts.feedbackHash
          ? Buffer.from(normalizeHex(opts.feedbackHash, "feedbackHash", 32), "hex")
          : undefined;

        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.giveFeedback(
          account,
          agentId,
          value,
          decimals,
          opts.tag1,
          opts.tag2,
          opts.endpoint,
          opts.feedbackUri,
          hashBuffer,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: "Feedback submitted successfully",
          agentId,
          value,
          decimals,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-reputation
// ---------------------------------------------------------------------------

program
  .command("get-reputation")
  .description(
    "Get aggregated reputation summary for an agent from the ERC-8004 reputation registry. " +
      "Returns average rating as a raw WAD string (18 decimals) and total feedback count."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to get reputation for (non-negative integer)"
  )
  .action(async (opts: { agentId: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const reputation = await service.getReputation(agentId, callerAddress);

      if (reputation.totalFeedback === 0) {
        printJson({
          success: true,
          agentId,
          totalFeedback: 0,
          summaryValue: "0",
          summaryValueDecimals: 0,
          message: "No feedback yet for this agent",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        agentId: reputation.agentId,
        totalFeedback: reputation.totalFeedback,
        summaryValue: reputation.summaryValue,
        summaryValueDecimals: reputation.summaryValueDecimals,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// request-validation
// ---------------------------------------------------------------------------

program
  .command("request-validation")
  .description(
    "Request third-party validation for an agent using the ERC-8004 validation registry. " +
      "The validator will be notified and can respond with a score (0-100). " +
      "Must be called by the agent owner or an approved operator. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--validator <address>",
    "Stacks address of the validator"
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to request validation for (non-negative integer)"
  )
  .requiredOption(
    "--request-uri <uri>",
    "URI with validation request details"
  )
  .requiredOption(
    "--request-hash <hex>",
    "Unique request hash as hex string (32 bytes / 64 hex chars)"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      validator: string;
      agentId: string;
      requestUri: string;
      requestHash: string;
      fee?: string;
      sponsored: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const agentId = parseInt(opts.agentId, 10);
        if (isNaN(agentId) || agentId < 0) {
          throw new Error("--agent-id must be a non-negative integer");
        }

        const normalizedHash = normalizeHex(opts.requestHash, "requestHash", 32);
        const hashBuffer = Buffer.from(normalizedHash, "hex");

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.requestValidation(
          account,
          opts.validator,
          agentId,
          opts.requestUri,
          hashBuffer,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: "Validation request submitted successfully",
          validator: opts.validator,
          agentId,
          requestHash: opts.requestHash,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-validation-status
// ---------------------------------------------------------------------------

program
  .command("get-validation-status")
  .description(
    "Get the status of a validation request using the ERC-8004 validation registry. " +
      "Returns validator, agent ID, response score (0-100), and response metadata."
  )
  .requiredOption(
    "--request-hash <hex>",
    "Request hash as hex string (32 bytes / 64 hex chars)"
  )
  .action(async (opts: { requestHash: string }) => {
    try {
      const normalizedHash = normalizeHex(opts.requestHash, "requestHash", 32);
      const hashBuffer = Buffer.from(normalizedHash, "hex");

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const status = await service.getValidationStatus(hashBuffer, callerAddress);

      if (!status) {
        printJson({
          success: false,
          requestHash: opts.requestHash,
          message: "Validation request not found",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        requestHash: opts.requestHash,
        validator: status.validator,
        agentId: status.agentId,
        response: status.response,
        responseHash: status.responseHash,
        tag: status.tag || "(no tag)",
        lastUpdate: status.lastUpdate,
        hasResponse: status.hasResponse,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-validation-summary
// ---------------------------------------------------------------------------

program
  .command("get-validation-summary")
  .description(
    "Get validation summary for an agent using the ERC-8004 validation registry. " +
      "Returns total validation count and average response score (0-100)."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to get validation summary for (non-negative integer)"
  )
  .action(async (opts: { agentId: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const summary = await service.getValidationSummary(agentId, callerAddress);

      printJson({
        success: true,
        agentId,
        count: summary.count,
        averageResponse: summary.avgResponse,
        message:
          summary.count === 0
            ? "No validations yet for this agent"
            : `${summary.count} validation(s) with average score ${summary.avgResponse}/100`,
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
