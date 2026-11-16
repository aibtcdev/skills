#!/usr/bin/env bun
/**
 * Tenero skill CLI
 * Market analytics for tokens, wallets, DEXs, and markets via Tenero (formerly STXTools)
 *
 * Usage: bun run tenero/tenero.ts <subcommand> [options]
 */

import { Command } from "commander";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

const BASE_URL = "https://api.tenero.io";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function fetchTenero(path: string): Promise<unknown> {
  const response = await fetch(`${BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(
      `Tenero API error: ${response.status} ${response.statusText}`
    );
  }
  const json = (await response.json()) as {
    statusCode: number;
    message: string;
    data: unknown;
  };
  return json.data;
}

// ---------------------------------------------------------------------------
// Address helper
// ---------------------------------------------------------------------------

async function getStxAddress(address?: string): Promise<string> {
  if (address) {
    return address;
  }

  const walletManager = getWalletManager();
  const sessionInfo = walletManager.getSessionInfo();

  if (sessionInfo?.address) {
    return sessionInfo.address;
  }

  throw new Error(
    "No Stacks address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("tenero")
  .description(
    "Tenero market analytics — token info, market stats, top gainers/losers, " +
      "wallet holdings and trades, trending DEX pools, whale trades, holder distribution, and search. " +
      "Covers Stacks, Spark, and SportsFun chains. No API key required."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// token-info
// ---------------------------------------------------------------------------

program
  .command("token-info")
  .description("Get token details including metadata, price, and volume.")
  .requiredOption("--token <address>", "Token contract address")
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { token: string; chain: string }) => {
    try {
      const data = await fetchTenero(
        `/v1/${opts.chain}/tokens/${opts.token}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// market-summary
// ---------------------------------------------------------------------------

program
  .command("market-summary")
  .description(
    "Get token market summary including price history, volume, and liquidity."
  )
  .requiredOption("--token <address>", "Token contract address")
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { token: string; chain: string }) => {
    try {
      const data = await fetchTenero(
        `/v1/${opts.chain}/tokens/${opts.token}/market_summary`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// market-stats
// ---------------------------------------------------------------------------

program
  .command("market-stats")
  .description(
    "Get overall market statistics including total volume, market cap, and active tokens."
  )
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { chain: string }) => {
    try {
      const data = await fetchTenero(`/v1/${opts.chain}/market/stats`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// top-gainers
// ---------------------------------------------------------------------------

program
  .command("top-gainers")
  .description("Get top gaining tokens by price change percentage.")
  .option("--chain <chain>", "Chain to query", "stacks")
  .option("--limit <number>", "Maximum number of results", "10")
  .action(async (opts: { chain: string; limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10);
      const data = await fetchTenero(
        `/v1/${opts.chain}/market/top_gainers?limit=${limit}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// top-losers
// ---------------------------------------------------------------------------

program
  .command("top-losers")
  .description("Get top losing tokens by price change percentage.")
  .option("--chain <chain>", "Chain to query", "stacks")
  .option("--limit <number>", "Maximum number of results", "10")
  .action(async (opts: { chain: string; limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10);
      const data = await fetchTenero(
        `/v1/${opts.chain}/market/top_losers?limit=${limit}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// wallet-holdings
// ---------------------------------------------------------------------------

program
  .command("wallet-holdings")
  .description(
    "Get wallet token holdings with current value. Uses active wallet if --address is omitted."
  )
  .option(
    "--address <stx_address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { address?: string; chain: string }) => {
    try {
      const address = await getStxAddress(opts.address);
      const data = await fetchTenero(
        `/v1/${opts.chain}/wallets/${address}/holdings_value`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// wallet-trades
// ---------------------------------------------------------------------------

program
  .command("wallet-trades")
  .description(
    "Get wallet trade history. Uses active wallet if --address is omitted."
  )
  .option(
    "--address <stx_address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .option("--chain <chain>", "Chain to query", "stacks")
  .option("--limit <number>", "Maximum number of results", "20")
  .action(async (opts: { address?: string; chain: string; limit: string }) => {
    try {
      const address = await getStxAddress(opts.address);
      const limit = parseInt(opts.limit, 10);
      const data = await fetchTenero(
        `/v1/${opts.chain}/wallets/${address}/trades?limit=${limit}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// trending-pools
// ---------------------------------------------------------------------------

program
  .command("trending-pools")
  .description(
    "Get trending DEX pools by volume within a timeframe (1h, 6h, 24h)."
  )
  .option("--timeframe <string>", "Timeframe: 1h, 6h, or 24h", "24h")
  .option("--chain <chain>", "Chain to query", "stacks")
  .option("--limit <number>", "Maximum number of results", "10")
  .action(
    async (opts: { timeframe: string; chain: string; limit: string }) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const data = await fetchTenero(
          `/v1/${opts.chain}/pools/trending/${opts.timeframe}?limit=${limit}`
        );
        printJson(data);
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// whale-trades
// ---------------------------------------------------------------------------

program
  .command("whale-trades")
  .description("Get large/whale trades above threshold value.")
  .option("--chain <chain>", "Chain to query", "stacks")
  .option("--limit <number>", "Maximum number of results", "10")
  .action(async (opts: { chain: string; limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10);
      const data = await fetchTenero(
        `/v1/${opts.chain}/market/whale_trades?limit=${limit}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// holder-stats
// ---------------------------------------------------------------------------

program
  .command("holder-stats")
  .description("Get token holder distribution and statistics.")
  .requiredOption("--token <address>", "Token contract address")
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { token: string; chain: string }) => {
    try {
      const data = await fetchTenero(
        `/v1/${opts.chain}/tokens/${opts.token}/holder_stats`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

program
  .command("search")
  .description("Search tokens, pools, and wallets by name or address.")
  .requiredOption("--query <string>", "Search query string")
  .option("--chain <chain>", "Chain to query", "stacks")
  .action(async (opts: { query: string; chain: string }) => {
    try {
      const data = await fetchTenero(
        `/v1/${opts.chain}/search?query=${encodeURIComponent(opts.query)}`
      );
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
