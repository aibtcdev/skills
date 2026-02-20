#!/usr/bin/env bun
/**
 * NFT skill CLI
 * SIP-009 NFT operations on Stacks L2
 *
 * Usage: bun run nft/nft.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getNftService } from "../src/lib/services/nft.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("nft")
  .description(
    "SIP-009 NFT operations: list holdings, get metadata, transfer NFTs, get owner, get collection info, and get transfer history"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-holdings
// ---------------------------------------------------------------------------

program
  .command("get-holdings")
  .description("List all NFTs owned by an address.")
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .option(
    "--contract-id <contractId>",
    "Filter by specific NFT collection contract ID"
  )
  .option(
    "--limit <n>",
    "Maximum number of results (default: 20)",
    "20"
  )
  .option(
    "--offset <n>",
    "Offset for pagination (default: 0)",
    "0"
  )
  .action(
    async (opts: {
      address?: string;
      contractId?: string;
      limit: string;
      offset: string;
    }) => {
      try {
        const nftService = getNftService(NETWORK);
        let walletAddress: string;

        if (opts.address) {
          walletAddress = opts.address;
        } else {
          walletAddress = await getWalletAddress();
        }

        const limit = parseInt(opts.limit, 10);
        const offset = parseInt(opts.offset, 10);

        const result = await nftService.getHoldings(walletAddress, {
          limit,
          offset,
          contractId: opts.contractId,
        });

        printJson({
          address: walletAddress,
          network: NETWORK,
          total: result.total,
          nfts: result.nfts.map((nft) => ({
            collection: nft.asset_identifier,
            tokenId: nft.value.repr,
          })),
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
  .description("Get metadata for a specific NFT (SIP-016).")
  .requiredOption(
    "--contract-id <contractId>",
    "NFT collection contract ID (e.g., SP2....my-nft)"
  )
  .requiredOption(
    "--token-id <n>",
    "Token ID of the NFT (integer)"
  )
  .action(async (opts: { contractId: string; tokenId: string }) => {
    try {
      const nftService = getNftService(NETWORK);
      const tokenId = parseInt(opts.tokenId, 10);

      if (isNaN(tokenId) || tokenId < 0) {
        throw new Error("--token-id must be a non-negative integer");
      }

      const metadata = await nftService.getMetadata(opts.contractId, tokenId);

      printJson({
        contractId: opts.contractId,
        tokenId,
        network: NETWORK,
        metadata,
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
    "Transfer an NFT (SIP-009) to a recipient address. Requires an unlocked wallet."
  )
  .requiredOption(
    "--contract-id <contractId>",
    "NFT collection contract ID"
  )
  .requiredOption(
    "--token-id <n>",
    "Token ID of the NFT to transfer (integer)"
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      contractId: string;
      tokenId: string;
      recipient: string;
      fee?: string;
    }) => {
      try {
        const nftService = getNftService(NETWORK);
        const account = await getAccount();
        const tokenId = parseInt(opts.tokenId, 10);

        if (isNaN(tokenId) || tokenId < 0) {
          throw new Error("--token-id must be a non-negative integer");
        }

        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await nftService.transfer(
          account,
          opts.contractId,
          tokenId,
          opts.recipient,
          resolvedFee
        );

        printJson({
          success: true,
          txid: result.txid,
          from: account.address,
          recipient: opts.recipient,
          contractId: opts.contractId,
          tokenId,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-owner
// ---------------------------------------------------------------------------

program
  .command("get-owner")
  .description("Get the current owner of a specific NFT.")
  .requiredOption(
    "--contract-id <contractId>",
    "NFT collection contract ID"
  )
  .requiredOption(
    "--token-id <n>",
    "Token ID of the NFT (integer)"
  )
  .action(async (opts: { contractId: string; tokenId: string }) => {
    try {
      const nftService = getNftService(NETWORK);
      const tokenId = parseInt(opts.tokenId, 10);

      if (isNaN(tokenId) || tokenId < 0) {
        throw new Error("--token-id must be a non-negative integer");
      }

      // getOwner requires a sender address for the read-only call
      let senderAddress: string;
      try {
        senderAddress = await getWalletAddress();
      } catch {
        // Fall back to contract deployer address if no wallet
        senderAddress = opts.contractId.split(".")[0];
      }

      const owner = await nftService.getOwner(opts.contractId, tokenId, senderAddress);

      printJson({
        contractId: opts.contractId,
        tokenId,
        network: NETWORK,
        owner: owner || "Unknown",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-collection-info
// ---------------------------------------------------------------------------

program
  .command("get-collection-info")
  .description(
    "Get information about an NFT collection including name, total supply, and available functions."
  )
  .requiredOption(
    "--contract-id <contractId>",
    "NFT collection contract ID"
  )
  .action(async (opts: { contractId: string }) => {
    try {
      const nftService = getNftService(NETWORK);
      const info = await nftService.getCollectionInfo(opts.contractId);

      printJson({
        network: NETWORK,
        ...info,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-history
// ---------------------------------------------------------------------------

program
  .command("get-history")
  .description("Get the transfer history of NFTs in a collection.")
  .requiredOption(
    "--contract-id <contractId>",
    "NFT collection contract ID"
  )
  .option(
    "--limit <n>",
    "Maximum number of results (default: 20)",
    "20"
  )
  .option(
    "--offset <n>",
    "Offset for pagination (default: 0)",
    "0"
  )
  .action(async (opts: { contractId: string; limit: string; offset: string }) => {
    try {
      const nftService = getNftService(NETWORK);
      const limit = parseInt(opts.limit, 10);
      const offset = parseInt(opts.offset, 10);

      const result = await nftService.getHistory(opts.contractId, { limit, offset });

      printJson({
        contractId: opts.contractId,
        network: NETWORK,
        total: result.total,
        events: result.events,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
