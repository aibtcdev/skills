#!/usr/bin/env bun
/**
 * Tokens skill CLI
 * SIP-010 fungible token operations on Stacks L2
 *
 * Usage: bun run tokens/tokens.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getTokensService } from "../src/lib/services/tokens.service.js";
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
  .name("tokens")
  .description(
    "SIP-010 fungible token operations: check balances, transfer tokens, get metadata, list holdings, and get top holders"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-balance
// ---------------------------------------------------------------------------

program
  .command("get-balance")
  .description(
    "Get the balance of any SIP-010 token for a wallet address. " +
      "Supports well-known tokens by symbol (sBTC, USDCx, ALEX, DIKO) or full contract ID."
  )
  .requiredOption(
    "--token <token>",
    "Token symbol (e.g., 'USDCx', 'sBTC') or contract ID (e.g., 'SP2....contract-name')"
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { token: string; address?: string }) => {
    try {
      const tokensService = getTokensService(NETWORK);
      let walletAddress: string;

      if (opts.address) {
        walletAddress = opts.address;
      } else {
        walletAddress = await getWalletAddress();
      }

      const balance = await tokensService.getBalance(opts.token, walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        token: {
          contractId: balance.contractId,
          symbol: balance.symbol,
          name: balance.name,
          decimals: balance.decimals,
        },
        balance: {
          raw: balance.balance,
          formatted: balance.formattedBalance,
        },
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
    "Transfer any SIP-010 token to a recipient address. Requires an unlocked wallet."
  )
  .requiredOption(
    "--token <token>",
    "Token symbol (e.g., 'USDCx') or contract ID"
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to"
  )
  .requiredOption(
    "--amount <amount>",
    "Amount in smallest unit (depends on token decimals)"
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
      token: string;
      recipient: string;
      amount: string;
      memo?: string;
      fee?: string;
    }) => {
      try {
        const tokensService = getTokensService(NETWORK);
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await tokensService.transfer(
          account,
          opts.token,
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
          token: opts.token,
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
// get-info
// ---------------------------------------------------------------------------

program
  .command("get-info")
  .description(
    "Get metadata for a SIP-010 token (name, symbol, decimals, total supply)."
  )
  .requiredOption(
    "--token <token>",
    "Token symbol or contract ID"
  )
  .action(async (opts: { token: string }) => {
    try {
      const tokensService = getTokensService(NETWORK);
      const info = await tokensService.getTokenInfo(opts.token);

      if (!info) {
        printJson({
          error: "Token metadata not found",
          token: opts.token,
        });
        return;
      }

      printJson({
        network: NETWORK,
        ...info,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list-user-tokens
// ---------------------------------------------------------------------------

program
  .command("list-user-tokens")
  .description("List all fungible tokens owned by an address.")
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const tokensService = getTokensService(NETWORK);
      let walletAddress: string;

      if (opts.address) {
        walletAddress = opts.address;
      } else {
        walletAddress = await getWalletAddress();
      }

      const tokens = await tokensService.getUserTokens(walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        tokenCount: tokens.length,
        tokens: tokens.map((t) => ({
          contractId: t.asset_identifier,
          balance: t.balance,
        })),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-holders
// ---------------------------------------------------------------------------

program
  .command("get-holders")
  .description("Get the top holders of a SIP-010 token.")
  .requiredOption(
    "--token <token>",
    "Token symbol or contract ID"
  )
  .option(
    "--limit <n>",
    "Maximum number of holders to return (default: 20)",
    "20"
  )
  .option(
    "--offset <n>",
    "Offset for pagination (default: 0)",
    "0"
  )
  .action(async (opts: { token: string; limit: string; offset: string }) => {
    try {
      const tokensService = getTokensService(NETWORK);
      const limit = parseInt(opts.limit, 10);
      const offset = parseInt(opts.offset, 10);

      const result = await tokensService.getTokenHolders(opts.token, { limit, offset });

      printJson({
        token: opts.token,
        network: NETWORK,
        total: result.total,
        holders: result.results,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
