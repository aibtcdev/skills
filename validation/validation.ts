#!/usr/bin/env bun
/**
 * Validation skill CLI
 * ERC-8004 on-chain agent validation management
 *
 * Usage: bun run validation/validation.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "@aibtc/skills/src/lib/config/networks.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import { Erc8004Service } from "@aibtc/skills/src/lib/services/erc8004.service.js";
import { resolveFee } from "@aibtc/skills/src/lib/utils/fee.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Validation helpers
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
  .name("validation")
  .description(
    "ERC-8004 on-chain agent validation: request validations from validators, " +
      "submit validation responses, and query validation status, summaries, " +
      "and paginated lists by agent or validator"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

program
  .command("request")
  .description(
    "Request validation from a validator for an agent in the ERC-8004 validation registry. " +
      "Caller (tx-sender) is the requester. The request hash must be a 32-byte SHA-256 hash " +
      "of the request data. Requires an unlocked wallet."
  )
  .requiredOption(
    "--validator <address>",
    "Stacks address of the validator to request validation from"
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to request validation for (non-negative integer)"
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
// respond
// ---------------------------------------------------------------------------

program
  .command("respond")
  .description(
    "Submit a validation response for a pending validation request in the ERC-8004 validation registry. " +
      "Only the validator specified in the original request can call this. " +
      "Response must be an integer between 0 and 100. Can be called multiple times for progressive updates. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--request-hash <hex>",
    "32-byte SHA-256 hash of the original request as a hex string"
  )
  .requiredOption(
    "--response <value>",
    "Validation response score (integer between 0 and 100)"
  )
  .requiredOption(
    "--response-uri <uri>",
    "URI pointing to the validation response data"
  )
  .requiredOption(
    "--response-hash <hex>",
    "32-byte SHA-256 hash of the response data as a hex string"
  )
  .option("--tag <tag>", "Classification tag for the validation response", "")
  .option(
    "--fee <fee>",
    'Fee preset ("low", "medium", "high") or micro-STX amount'
  )
  .option("--sponsored", "Submit as a sponsored transaction", false)
  .action(
    async (opts: {
      requestHash: string;
      response: string;
      responseUri: string;
      responseHash: string;
      tag: string;
      fee?: string;
      sponsored: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error("No active wallet. Please unlock your wallet first.");
        }

        const response = parseInt(opts.response, 10);
        if (isNaN(response) || response < 0 || response > 100) {
          throw new Error("--response must be an integer between 0 and 100");
        }

        const normalizedRequestHash = normalizeHex(opts.requestHash, "--request-hash", 32);
        const requestHashBuf = Buffer.from(normalizedRequestHash, "hex");

        const normalizedResponseHash = normalizeHex(opts.responseHash, "--response-hash", 32);
        const responseHashBuf = Buffer.from(normalizedResponseHash, "hex");

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.submitValidationResponse(
          account,
          requestHashBuf,
          response,
          opts.responseUri,
          responseHashBuf,
          opts.tag || "",
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Validation response ${response} submitted for request hash ${opts.requestHash}.`,
          response,
          responseUri: opts.responseUri,
          tag: opts.tag || "",
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-status
// ---------------------------------------------------------------------------

program
  .command("get-status")
  .description(
    "Get the status of a validation request by its 32-byte request hash. " +
      "Returns validator, agent ID, response score, response hash, tag, last update block, " +
      "and whether a response has been submitted. Does not require a wallet."
  )
  .requiredOption(
    "--request-hash <hex>",
    "32-byte SHA-256 hash of the validation request as a hex string"
  )
  .action(async (opts: { requestHash: string }) => {
    try {
      const normalizedHash = normalizeHex(opts.requestHash, "--request-hash", 32);
      const requestHashBuf = Buffer.from(normalizedHash, "hex");

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const status = await service.getValidationStatus(requestHashBuf, callerAddress);

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
// get-summary
// ---------------------------------------------------------------------------

program
  .command("get-summary")
  .description(
    "Get the aggregated validation summary for an agent from the ERC-8004 validation registry. " +
      "Returns the total validation count and average response score. Does not require a wallet."
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
      const summary = await service.getValidationSummary(agentId, callerAddress);

      printJson({
        success: true,
        agentId,
        count: summary.count,
        avgResponse: summary.avgResponse,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-agent-validations
// ---------------------------------------------------------------------------

program
  .command("get-agent-validations")
  .description(
    "Get a paginated list of validation request hashes for an agent from the ERC-8004 validation registry. " +
      "Returns request hashes as hex strings. Cursor-based pagination with page size 14. " +
      "Does not require a wallet."
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
      const page = await service.getAgentValidations(agentId, callerAddress, cursor);

      printJson({
        success: true,
        agentId,
        validations: page.validations,
        cursor: page.cursor ?? null,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-validator-requests
// ---------------------------------------------------------------------------

program
  .command("get-validator-requests")
  .description(
    "Get a paginated list of validation request hashes submitted to a validator from the ERC-8004 validation registry. " +
      "Returns request hashes as hex strings. Cursor-based pagination with page size 14. " +
      "Does not require a wallet."
  )
  .requiredOption(
    "--validator <address>",
    "Stacks address of the validator to query"
  )
  .option(
    "--cursor <cursor>",
    "Pagination cursor (non-negative integer, from previous response)"
  )
  .action(async (opts: { validator: string; cursor?: string }) => {
    try {
      let cursor: number | undefined;
      if (opts.cursor !== undefined) {
        cursor = parseInt(opts.cursor, 10);
        if (isNaN(cursor) || cursor < 0) {
          throw new Error("--cursor must be a non-negative integer");
        }
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const page = await service.getValidatorRequests(opts.validator, callerAddress, cursor);

      printJson({
        success: true,
        validator: opts.validator,
        requests: page.requests,
        cursor: page.cursor ?? null,
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
