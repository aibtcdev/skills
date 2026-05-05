#!/usr/bin/env bun
/**
 * LunarCrush skill CLI
 *
 * Pay-per-call LunarCrush social/market intelligence via x402 on Stacks.
 *
 * Usage: bun run lunarcrush/lunarcrush.ts <subcommand> [options]
 */

import { Command } from "commander";
import { createApiClient } from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Endpoint hosts
// ---------------------------------------------------------------------------

const HOSTS = {
  mainnet: "https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev",
  testnet: "https://lunarcrush-x402-poc.lunarcrush.workers.dev",
} as const;

type NetworkOption = keyof typeof HOSTS;

function resolveHost(networkOpt: string | undefined): { network: NetworkOption; baseUrl: string } {
  const net = (networkOpt ?? "mainnet").toLowerCase();
  if (net !== "mainnet" && net !== "testnet") {
    throw new Error(`invalid --network "${networkOpt}". Must be "mainnet" or "testnet".`);
  }
  return { network: net as NetworkOption, baseUrl: HOSTS[net as NetworkOption] };
}

function normalizeSymbol(raw: string | undefined): string {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) throw new Error("--symbol is required");
  if (s.length > 16) throw new Error("--symbol too long (max 16 chars)");
  if (!/^[a-z0-9]+$/.test(s)) throw new Error("--symbol must match [a-z0-9]+");
  return s;
}

// ---------------------------------------------------------------------------
// Free-route helper (health, meta) — uses plain fetch, no payment required
// ---------------------------------------------------------------------------

async function fetchFree(baseUrl: string, path: string): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

function decodePaymentReceipt(header: unknown): Record<string, unknown> | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Commander setup
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("lunarcrush")
  .description("Pay-per-call LunarCrush social/market intelligence via x402 on Stacks")
  .version("0.0.1");

// ---------------------------------------------------------------------------
// oracle — premium combined endpoint with verdict + vibe one-liner
// ---------------------------------------------------------------------------

program
  .command("oracle")
  .description(
    "Premium combined LunarCrush oracle for a symbol — verdict (STRONG-BUY/BUY/NEUTRAL/WATCH/AVOID), confidence (0-1), reasoning, and a vibe one-liner. One paid call, ~$0.025 USD in STX."
  )
  .requiredOption("--symbol <symbol>", "Crypto ticker (e.g. BTC, ETH, STX)")
  .option("--network <network>", "mainnet or testnet (default: mainnet)", "mainnet")
  .action(async (opts) => {
    try {
      const symbol = normalizeSymbol(opts.symbol);
      const { network, baseUrl } = resolveHost(opts.network);

      const api = await createApiClient(baseUrl, "lunarcrush.oracle");
      const response = await api.request({
        method: "GET",
        url: `/oracle/${symbol}`,
      });

      const output: Record<string, unknown> = {
        ...((response.data as Record<string, unknown>) ?? {}),
        network,
        endpoint: `${baseUrl}/oracle/${symbol}`,
      };
      const receipt = decodePaymentReceipt(response.headers?.["payment-response"]);
      if (receipt) output.payment_receipt = receipt;

      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

program
  .command("score")
  .description(
    "Fetch Galaxy Score, AltRank, market cap rank, price, and 24h change for a symbol. Costs ~$0.005 USD in STX."
  )
  .requiredOption("--symbol <symbol>", "Crypto ticker (e.g. BTC, ETH, STX)")
  .option("--network <network>", "mainnet or testnet (default: mainnet)", "mainnet")
  .action(async (opts) => {
    try {
      const symbol = normalizeSymbol(opts.symbol);
      const { network, baseUrl } = resolveHost(opts.network);

      const api = await createApiClient(baseUrl, "lunarcrush.score");
      const response = await api.request({
        method: "GET",
        url: `/galaxy-score/${symbol}`,
      });

      const output: Record<string, unknown> = {
        ...((response.data as Record<string, unknown>) ?? {}),
        network,
        endpoint: `${baseUrl}/galaxy-score/${symbol}`,
      };
      const receipt = decodePaymentReceipt(response.headers?.["payment-response"]);
      if (receipt) output.payment_receipt = receipt;

      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

program
  .command("health")
  .description("Liveness probe (free).")
  .option("--network <network>", "mainnet or testnet (default: mainnet)", "mainnet")
  .action(async (opts) => {
    try {
      const { network, baseUrl } = resolveHost(opts.network);
      const data = await fetchFree(baseUrl, "/health");
      printJson({
        network,
        endpoint: `${baseUrl}/health`,
        ...(typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

program
  .command("meta")
  .description(
    "Fetch live endpoint catalog and current microSTX pricing (USD-pegged, recomputed hourly). Free."
  )
  .option("--network <network>", "mainnet or testnet (default: mainnet)", "mainnet")
  .action(async (opts) => {
    try {
      const { network, baseUrl } = resolveHost(opts.network);
      const data = await fetchFree(baseUrl, "/");
      printJson({
        network,
        endpoint: baseUrl,
        ...(typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}),
      });
    } catch (error) {
      handleError(error);
    }
  });

program.parse(process.argv);
