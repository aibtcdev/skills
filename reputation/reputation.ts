#!/usr/bin/env bun
/**
 * Reputation skill CLI
 * ERC-8004 on-chain agent reputation management
 *
 * Usage: bun run reputation/reputation.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "@aibtc/skills/src/lib/config/networks.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import { Erc8004Service } from "@aibtc/skills/src/lib/services/erc8004.service.js";
import { resolveFee } from "@aibtc/skills/src/lib/utils/fee.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Reputation helpers
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
  .name("reputation")
  .description(
    "ERC-8004 on-chain agent reputation: submit and revoke feedback, append responses, " +
      "approve clients, and query reputation summaries, feedback entries, and client lists"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// give-feedback
// ---------------------------------------------------------------------------

program
  .command("give-feedback")
  .description(
    "Submit feedback for an agent in the ERC-8004 reputation registry. " +
      "Value is a signed integer; value-decimals sets the decimal position. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to give feedback for (non-negative integer)"
  )
  .requiredOption(
    "--value <value>",
    "Feedback value (signed integer, e.g., 5 for positive, -2 for negative)"
  )
  .option(
    "--value-decimals <decimals>",
    "Decimal precision for the value (non-negative integer, default 0)",
    "0"
  )
  .option("--tag1 <tag>", "Primary classification tag (e.g., 'helpful', 'accuracy')", "")
  .option("--tag2 <tag>", "Secondary classification tag", "")
  .option("--endpoint <endpoint>", "Endpoint or context identifier for the feedback", "")
  .option("--feedback-uri <uri>", "URI pointing to detailed feedback data", "")
  .option(
    "--feedback-hash <hex>",
    "32-byte SHA-256 hash of the feedback data as a hex string (optional)"
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
      valueDecimals: string;
      tag1: string;
      tag2: string;
      endpoint: string;
      feedbackUri: string;
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
        if (isNaN(value)) {
          throw new Error("--value must be an integer");
        }

        const valueDecimals = parseInt(opts.valueDecimals, 10);
        if (isNaN(valueDecimals) || valueDecimals < 0) {
          throw new Error("--value-decimals must be a non-negative integer");
        }

        let feedbackHashBuf: Buffer | undefined;
        if (opts.feedbackHash) {
          const normalized = normalizeHex(opts.feedbackHash, "--feedback-hash", 32);
          feedbackHashBuf = Buffer.from(normalized, "hex");
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
          opts.tag1 || undefined,
          opts.tag2 || undefined,
          opts.endpoint || undefined,
          opts.feedbackUri || undefined,
          feedbackHashBuf,
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
// revoke-feedback
// ---------------------------------------------------------------------------

program
  .command("revoke-feedback")
  .description(
    "Revoke previously submitted feedback for an agent. " +
      "Only the original feedback submitter (tx-sender) can revoke their own feedback. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID whose feedback you want to revoke (non-negative integer)"
  )
  .requiredOption(
    "--index <index>",
    "Feedback index to revoke (non-negative integer)"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      agentId: string;
      index: string;
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

        const index = parseInt(opts.index, 10);
        if (isNaN(index) || index < 0) {
          throw new Error("--index must be a non-negative integer");
        }

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.revokeFeedback(
          account,
          agentId,
          index,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Feedback index ${index} revoked for agent ${agentId}.`,
          agentId,
          index,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// append-response
// ---------------------------------------------------------------------------

program
  .command("append-response")
  .description(
    "Append a response to a feedback entry in the ERC-8004 reputation registry. " +
      "Any principal can append a response; tracks unique responders per feedback entry. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID associated with the feedback (non-negative integer)"
  )
  .requiredOption(
    "--client <address>",
    "Stacks address of the original feedback submitter"
  )
  .requiredOption(
    "--index <index>",
    "Feedback index to respond to (non-negative integer)"
  )
  .requiredOption(
    "--response-uri <uri>",
    "URI pointing to the response data"
  )
  .requiredOption(
    "--response-hash <hex>",
    "32-byte SHA-256 hash of the response data as a hex string"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      agentId: string;
      client: string;
      index: string;
      responseUri: string;
      responseHash: string;
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

        const index = parseInt(opts.index, 10);
        if (isNaN(index) || index < 0) {
          throw new Error("--index must be a non-negative integer");
        }

        const normalizedHash = normalizeHex(opts.responseHash, "--response-hash", 32);
        const responseHashBuf = Buffer.from(normalizedHash, "hex");

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.appendResponse(
          account,
          agentId,
          opts.client,
          index,
          opts.responseUri,
          responseHashBuf,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Response appended to feedback index ${index} for agent ${agentId}.`,
          agentId,
          client: opts.client,
          index,
          responseUri: opts.responseUri,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// approve-client
// ---------------------------------------------------------------------------

program
  .command("approve-client")
  .description(
    "Approve a client address to submit feedback for an agent up to a specified index limit. " +
      "Caller must be the agent owner or an approved operator. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to configure approval for (non-negative integer)"
  )
  .requiredOption(
    "--client <address>",
    "Stacks address of the client to approve"
  )
  .requiredOption(
    "--index-limit <limit>",
    "Maximum number of feedback entries the client may submit (non-negative integer)"
  )
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      agentId: string;
      client: string;
      indexLimit: string;
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

        const indexLimit = parseInt(opts.indexLimit, 10);
        if (isNaN(indexLimit) || indexLimit < 0) {
          throw new Error("--index-limit must be a non-negative integer");
        }

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.approveClient(
          account,
          agentId,
          opts.client,
          indexLimit,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Client ${opts.client} approved for agent ${agentId} up to index limit ${indexLimit}.`,
          agentId,
          client: opts.client,
          indexLimit,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-summary
// ---------------------------------------------------------------------------

program
  .command("get-summary")
  .description(
    "Get the aggregated reputation summary for an agent from the ERC-8004 reputation registry. " +
      "Returns total feedback count and WAD-averaged summary value. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .action(async (opts: { agentId: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
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
// read-feedback
// ---------------------------------------------------------------------------

program
  .command("read-feedback")
  .description(
    "Read a specific feedback entry by agent ID, client address, and feedback index. " +
      "Returns value, tags, revocation status, and WAD-averaged value. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .requiredOption(
    "--client <address>",
    "Stacks address of the feedback submitter"
  )
  .requiredOption(
    "--index <index>",
    "Feedback index to read (non-negative integer)"
  )
  .action(async (opts: { agentId: string; client: string; index: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const index = parseInt(opts.index, 10);
      if (isNaN(index) || index < 0) {
        throw new Error("--index must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const entry = await service.getFeedback(agentId, opts.client, index, callerAddress);

      if (!entry) {
        printJson({
          success: false,
          agentId,
          client: opts.client,
          index,
          message: "Feedback entry not found",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        agentId,
        client: entry.client,
        index,
        value: entry.value,
        valueDecimals: entry.valueDecimals,
        wadValue: entry.wadValue,
        tag1: entry.tag1,
        tag2: entry.tag2,
        isRevoked: entry.isRevoked,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// read-all-feedback
// ---------------------------------------------------------------------------

program
  .command("read-all-feedback")
  .description(
    "Get a paginated list of all feedback entries for an agent. " +
      "Supports optional tag filtering and cursor-based pagination (page size: 14). " +
      "Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .option("--tag1 <tag>", "Filter by primary tag (optional)")
  .option("--tag2 <tag>", "Filter by secondary tag (optional)")
  .option("--include-revoked", "Include revoked feedback entries in results", false)
  .option(
    "--cursor <cursor>",
    "Pagination cursor (non-negative integer, from previous response)"
  )
  .action(
    async (opts: {
      agentId: string;
      tag1?: string;
      tag2?: string;
      includeRevoked: boolean;
      cursor?: string;
    }) => {
      try {
        const agentId = parseInt(opts.agentId, 10);
        if (isNaN(agentId) || agentId < 0) {
          throw new Error("--agent-id must be a non-negative integer");
        }

        let cursor: number | undefined;
        if (opts.cursor !== undefined) {
          cursor = parseInt(opts.cursor, 10);
          if (isNaN(cursor) || cursor < 0) {
            throw new Error("--cursor must be a non-negative integer");
          }
        }

        const service = new Erc8004Service(NETWORK);
        const callerAddress = getCallerAddress();
        const page = await service.readAllFeedback(
          agentId,
          callerAddress,
          opts.tag1,
          opts.tag2,
          opts.includeRevoked,
          cursor
        );

        printJson({
          success: true,
          agentId,
          items: page.items,
          cursor: page.cursor ?? null,
          network: NETWORK,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-clients
// ---------------------------------------------------------------------------

program
  .command("get-clients")
  .description(
    "Get a paginated list of client addresses that have given feedback for an agent. " +
      "Cursor-based pagination with page size 14. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .option(
    "--cursor <cursor>",
    "Pagination cursor (non-negative integer, from previous response)"
  )
  .action(async (opts: { agentId: string; cursor?: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      let cursor: number | undefined;
      if (opts.cursor !== undefined) {
        cursor = parseInt(opts.cursor, 10);
        if (isNaN(cursor) || cursor < 0) {
          throw new Error("--cursor must be a non-negative integer");
        }
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const page = await service.getClients(agentId, callerAddress, cursor);

      printJson({
        success: true,
        agentId,
        clients: page.clients,
        cursor: page.cursor ?? null,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-feedback-count
// ---------------------------------------------------------------------------

program
  .command("get-feedback-count")
  .description(
    "Get the total feedback count for an agent from the ERC-8004 reputation registry. " +
      "Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .action(async (opts: { agentId: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const count = await service.getFeedbackCount(agentId, callerAddress);

      printJson({
        success: true,
        agentId,
        feedbackCount: count,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-approved-limit
// ---------------------------------------------------------------------------

program
  .command("get-approved-limit")
  .description(
    "Check the approved feedback index limit for a client on an agent. " +
      "Returns 0 if the client has no explicit approval. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .requiredOption(
    "--client <address>",
    "Stacks address of the client to check"
  )
  .action(async (opts: { agentId: string; client: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const limit = await service.getApprovedLimit(agentId, opts.client, callerAddress);

      printJson({
        success: true,
        agentId,
        client: opts.client,
        approvedLimit: limit,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-last-index
// ---------------------------------------------------------------------------

program
  .command("get-last-index")
  .description(
    "Get the last feedback index for a client on an agent. " +
      "Returns 0 if the client has not given any feedback. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .requiredOption(
    "--client <address>",
    "Stacks address of the client to check"
  )
  .action(async (opts: { agentId: string; client: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const lastIndex = await service.getLastIndex(agentId, opts.client, callerAddress);

      printJson({
        success: true,
        agentId,
        client: opts.client,
        lastIndex,
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
