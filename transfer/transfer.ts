#!/usr/bin/env bun
/**
 * Transfer skill CLI
 * Unified STX, SIP-010 token, and SIP-009 NFT transfers on Stacks L2
 *
 * Usage: bun run transfer/transfer.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount } from "../src/lib/services/x402.service.js";
import { transferStx } from "../src/lib/transactions/builder.js";
import { getTokensService } from "../src/lib/services/tokens.service.js";
import { getNftService } from "../src/lib/services/nft.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format micro-STX as a human-readable STX string.
 */
function formatStx(microStx: string): string {
  const micro = BigInt(microStx);
  const stx = micro / BigInt(1_000_000);
  const remainder = micro % BigInt(1_000_000);
  if (remainder === 0n) {
    return stx.toString() + " STX";
  }
  const padded = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${stx}.${padded} STX`;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("transfer")
  .description(
    "Unified Stacks L2 asset transfers: send STX, SIP-010 fungible tokens, or SIP-009 NFTs to any address. All subcommands require an unlocked wallet."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// stx
// ---------------------------------------------------------------------------

program
  .command("stx")
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
    "Optional memo message to include with the transfer (max 34 bytes)"
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
        let amountBigInt: bigint;
        try {
          amountBigInt = BigInt(opts.amount);
        } catch {
          throw new Error("--amount must be a positive integer (whole micro-STX, no decimals)");
        }
        if (amountBigInt <= 0n) {
          throw new Error("--amount must be a positive integer");
        }

        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "token_transfer");
        const result = await transferStx(
          account,
          opts.recipient,
          amountBigInt,
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
// token
// ---------------------------------------------------------------------------

program
  .command("token")
  .description(
    "Transfer a SIP-010 fungible token to a recipient address. " +
      "Accepts a token symbol (sBTC, USDCx, ALEX, DIKO) or full contract ID. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to"
  )
  .requiredOption(
    "--amount <uint>",
    "Amount in smallest token unit (check decimals with: bun run tokens/tokens.ts get-info --token <contract>)"
  )
  .requiredOption(
    "--contract <token>",
    "Token symbol (e.g., 'USDCx', 'sBTC') or full contract ID"
  )
  .option(
    "--memo <text>",
    "Optional memo message (max 34 bytes)"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      recipient: string;
      amount: string;
      contract: string;
      memo?: string;
      fee?: string;
    }) => {
      try {
        let amountBigInt: bigint;
        try {
          amountBigInt = BigInt(opts.amount);
        } catch {
          throw new Error("--amount must be a positive integer (whole token atoms, no decimals)");
        }
        if (amountBigInt <= 0n) {
          throw new Error("--amount must be a positive integer");
        }

        const tokensService = getTokensService(NETWORK);
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await tokensService.transfer(
          account,
          opts.contract,
          opts.recipient,
          amountBigInt,
          opts.memo,
          resolvedFee
        );

        printJson({
          success: true,
          txid: result.txid,
          from: account.address,
          recipient: opts.recipient,
          contract: opts.contract,
          amount: opts.amount,
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
// nft
// ---------------------------------------------------------------------------

program
  .command("nft")
  .description(
    "Transfer a SIP-009 NFT to a recipient address. " +
      "Requires the NFT collection contract ID and the specific token ID. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to"
  )
  .requiredOption(
    "--token-id <uint>",
    "Integer token ID of the NFT to transfer"
  )
  .requiredOption(
    "--contract <contractId>",
    "NFT collection contract ID (e.g., SP2...my-nft)"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .action(
    async (opts: {
      recipient: string;
      tokenId: string;
      contract: string;
      fee?: string;
    }) => {
      try {
        let tokenId: number;
        try {
          const tokenIdBigInt = BigInt(opts.tokenId);
          if (tokenIdBigInt < 0n) {
            throw new Error("--token-id must be a non-negative integer");
          }
          tokenId = Number(tokenIdBigInt);
        } catch {
          throw new Error("--token-id must be a non-negative integer");
        }

        const nftService = getNftService(NETWORK);
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await nftService.transfer(
          account,
          opts.contract,
          tokenId,
          opts.recipient,
          resolvedFee
        );

        printJson({
          success: true,
          txid: result.txid,
          from: account.address,
          recipient: opts.recipient,
          contract: opts.contract,
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
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
