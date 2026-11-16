#!/usr/bin/env bun
/**
 * Identity skill CLI
 * ERC-8004 on-chain agent identity management
 *
 * Usage: bun run identity/identity.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "@aibtc/skills/src/lib/config/networks.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import { Erc8004Service } from "@aibtc/skills/src/lib/services/erc8004.service.js";
import { resolveFee } from "@aibtc/skills/src/lib/utils/fee.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

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
    "ERC-8004 on-chain agent identity: register identities, update URI and metadata, " +
      "manage operator approvals, set/unset wallet, transfer identity NFTs, and query identity info"
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
// set-uri
// ---------------------------------------------------------------------------

program
  .command("set-uri")
  .description(
    "Update the URI for an agent identity in the ERC-8004 identity registry. " +
      "Caller must be the agent owner or an approved operator. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to update (non-negative integer)"
  )
  .requiredOption(
    "--uri <uri>",
    "New URI pointing to agent metadata (IPFS, HTTP, etc.)"
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
      agentId: string;
      uri: string;
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

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.updateIdentityUri(
          account,
          agentId,
          opts.uri,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: "Identity URI update transaction submitted.",
          agentId,
          uri: opts.uri,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// set-metadata
// ---------------------------------------------------------------------------

program
  .command("set-metadata")
  .description(
    "Set a metadata key-value pair for an agent identity in the ERC-8004 identity registry. " +
      "Value must be a hex-encoded buffer (max 512 bytes). " +
      'The key "agentWallet" is reserved and will be rejected by the contract. ' +
      "Caller must be the agent owner or an approved operator. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to update (non-negative integer)"
  )
  .requiredOption(
    "--key <key>",
    "Metadata key (string)"
  )
  .requiredOption(
    "--value <hex>",
    "Metadata value as a hex-encoded buffer (e.g., 616c696365 for 'alice')"
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
      agentId: string;
      key: string;
      value: string;
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

        const normalized = normalizeHex(opts.value, "--value");
        const buf = Buffer.from(normalized, "hex");
        if (buf.length > 512) {
          throw new Error(`--value exceeds 512 bytes (got ${buf.length})`);
        }

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.setMetadata(
          account,
          agentId,
          opts.key,
          buf,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: "Metadata set transaction submitted.",
          agentId,
          key: opts.key,
          valueHex: normalized,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// set-approval
// ---------------------------------------------------------------------------

program
  .command("set-approval")
  .description(
    "Approve or revoke an operator for an agent identity in the ERC-8004 identity registry. " +
      "Approved operators can update URI, metadata, and wallet on behalf of the owner. " +
      "Only the NFT owner can call this. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to update (non-negative integer)"
  )
  .requiredOption(
    "--operator <address>",
    "Stacks address of the operator to approve or revoke"
  )
  .option(
    "--approved",
    "Grant approval (omit to revoke)",
    false
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
      agentId: string;
      operator: string;
      approved: boolean;
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

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.setApprovalForAll(
          account,
          agentId,
          opts.operator,
          opts.approved,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: opts.approved
            ? `Operator ${opts.operator} approved for agent ${agentId}.`
            : `Operator ${opts.operator} revoked for agent ${agentId}.`,
          agentId,
          operator: opts.operator,
          approved: opts.approved,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// set-wallet
// ---------------------------------------------------------------------------

program
  .command("set-wallet")
  .description(
    "Set the agent wallet for an identity to tx-sender (the active wallet address). " +
      "This links the Stacks address to the agent ID without requiring a signature. " +
      "Caller must be the agent owner or an approved operator. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to update (non-negative integer)"
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
      agentId: string;
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

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.setAgentWalletDirect(
          account,
          agentId,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Agent wallet set to tx-sender (${account.address}) for agent ${agentId}.`,
          agentId,
          wallet: account.address,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// unset-wallet
// ---------------------------------------------------------------------------

program
  .command("unset-wallet")
  .description(
    "Remove the agent wallet association from an agent identity in the ERC-8004 identity registry. " +
      "Caller must be the agent owner or an approved operator. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to update (non-negative integer)"
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
      agentId: string;
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

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.unsetAgentWallet(
          account,
          agentId,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Agent wallet cleared for agent ${agentId}.`,
          agentId,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description(
    "Transfer an agent identity NFT to a new owner. " +
      "The active wallet (tx-sender) must equal the current owner. " +
      "Transfer automatically clears the agent wallet association. Requires an unlocked wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID (token ID) to transfer (non-negative integer)"
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address of the new owner"
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
      agentId: string;
      recipient: string;
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

        const service = new Erc8004Service(NETWORK);
        const feeAmount = opts.fee
          ? await resolveFee(opts.fee, NETWORK, "contract_call")
          : undefined;

        const result = await service.transferIdentity(
          account,
          agentId,
          account.address,
          opts.recipient,
          feeAmount,
          opts.sponsored
        );

        printJson({
          success: true,
          txid: result.txid,
          message: `Identity NFT transfer submitted for agent ${agentId}.`,
          agentId,
          sender: account.address,
          recipient: opts.recipient,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-metadata
// ---------------------------------------------------------------------------

program
  .command("get-metadata")
  .description(
    "Read a metadata value by key from the ERC-8004 identity registry. " +
      "Returns the raw buffer value as a hex string. Does not require a wallet."
  )
  .requiredOption(
    "--agent-id <id>",
    "Agent ID to query (non-negative integer)"
  )
  .requiredOption(
    "--key <key>",
    "Metadata key to read"
  )
  .action(async (opts: { agentId: string; key: string }) => {
    try {
      const agentId = parseInt(opts.agentId, 10);
      if (isNaN(agentId) || agentId < 0) {
        throw new Error("--agent-id must be a non-negative integer");
      }

      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const value = await service.getMetadata(agentId, opts.key, callerAddress);

      if (value === null) {
        printJson({
          success: false,
          agentId,
          key: opts.key,
          message: "Metadata key not found for this agent",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        agentId,
        key: opts.key,
        valueHex: value,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-last-id
// ---------------------------------------------------------------------------

program
  .command("get-last-id")
  .description(
    "Get the most recently minted agent ID from the ERC-8004 identity registry. " +
      "Returns null if no agents have been registered. Does not require a wallet."
  )
  .action(async () => {
    try {
      const service = new Erc8004Service(NETWORK);
      const callerAddress = getCallerAddress();
      const lastId = await service.getLastTokenId(callerAddress);

      if (lastId === null) {
        printJson({
          success: false,
          message: "No agents have been registered yet",
          network: NETWORK,
        });
        return;
      }

      printJson({
        success: true,
        lastAgentId: lastId,
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
