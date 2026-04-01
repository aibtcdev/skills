#!/usr/bin/env bun
/**
 * Flying Whale x402 Paid API Client
 *
 * Client for 7 x402 paid intelligence endpoints on Cloudflare Workers.
 * Each paid call requires an x402 payment header (STX, sBTC, or USDCx).
 * Free commands: list, probe.
 *
 * Operator: Flying Whale | ERC-8004 #54 | zaghmout.btc
 *
 * Usage: bun run flying-whale-x402/flying-whale-x402.ts <subcommand> [options]
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BASE = "https://flying-whale-api.flying-whale-ai.workers.dev";
const FETCH_TIMEOUT_MS = 60_000;

interface EndpointDef {
  slug: string;
  name: string;
  tier: string;
  price: number;
  description: string;
  input: Record<string, string>;
}

const ENDPOINTS: EndpointDef[] = [
  { slug: "market-analysis", name: "Market Analysis", tier: "Intelligence", price: 5000, description: "Real-time market analytics with live price data from CoinGecko and mempool.space", input: { query: "STX price analysis" } },
  { slug: "wallet-report", name: "Wallet Report", tier: "Intelligence", price: 3000, description: "On-chain wallet classification from real Hiro API balance and transaction data", input: { address: "SP..." } },
  { slug: "risk-score", name: "Risk Score", tier: "Intelligence", price: 2000, description: "Deterministic DeFi risk scoring computed from on-chain positions and holdings", input: { address: "SP..." } },
  { slug: "contract-audit", name: "Smart Contract Audit", tier: "Professional", price: 50000, description: "Deep Clarity security audit of real deployed contract source code via Hiro API", input: { contractId: "SPaddress.contract-name" } },
  { slug: "defi-strategy", name: "DeFi Strategy", tier: "Professional", price: 25000, description: "Personalized DeFi strategy based on real wallet holdings, market conditions, and risk tolerance", input: { address: "SP...", goals: "maximize yield", riskTolerance: "moderate" } },
  { slug: "hodlmm-analysis", name: "HODLMM Pool Analysis", tier: "Professional", price: 10000, description: "Bitflow HODLMM liquidity pool analysis with live market data and position metrics", input: { pool: "stx-sbtc", address: "SP... (optional)" } },
  { slug: "full-portfolio", name: "Full Portfolio Intelligence", tier: "Premium", price: 100000, description: "Complete portfolio intelligence combining all data sources with AI executive analysis", input: { address: "SP..." } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function handleError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function postWithPayment(endpoint: string, body: Record<string, unknown>, paymentToken?: string): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentToken) {
    headers["X-PAYMENT"] = paymentToken;
  }
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("flying-whale-x402")
  .description("Flying Whale x402 paid API client — 7 intelligence endpoints on Stacks L2")
  .version("1.0.0");

// --- list (free) ---
program
  .command("list")
  .description("List all available endpoints with pricing (free)")
  .action(async () => {
    try {
      printJson({
        endpoints: ENDPOINTS.map((ep) => ({
          slug: ep.slug,
          name: ep.name,
          tier: ep.tier,
          price: ep.price,
          currency: "microSTX",
          description: ep.description,
        })),
        total: ENDPOINTS.length,
        accepts: ["STX", "sBTC", "USDCx"],
        base: BASE,
      });
    } catch (err) {
      handleError(err);
    }
  });

// --- probe (free) ---
program
  .command("probe")
  .description("Probe an endpoint for pricing and required input (free GET)")
  .requiredOption("--endpoint <slug>", "Endpoint slug (e.g. market-analysis)")
  .action(async (opts) => {
    try {
      const data = await fetchJson<unknown>(`${BASE}/api/${opts.endpoint}`);
      printJson(data);
    } catch (err) {
      handleError(err);
    }
  });

// --- market-analysis (5,000 microSTX) ---
program
  .command("market-analysis")
  .description("Real-time market analytics — 5,000 microSTX")
  .requiredOption("--query <text>", "Market analysis query")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("market-analysis", { query: opts.query }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- wallet-report (3,000 microSTX) ---
program
  .command("wallet-report")
  .description("On-chain wallet classification — 3,000 microSTX")
  .requiredOption("--address <addr>", "Stacks address to analyze")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("wallet-report", { address: opts.address }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- risk-score (2,000 microSTX) ---
program
  .command("risk-score")
  .description("DeFi risk scoring — 2,000 microSTX")
  .requiredOption("--address <addr>", "Stacks address to score")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("risk-score", { address: opts.address }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- contract-audit (50,000 microSTX) ---
program
  .command("contract-audit")
  .description("Clarity security audit — 50,000 microSTX")
  .requiredOption("--contract-id <id>", "Contract ID (SPaddress.contract-name)")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("contract-audit", { contractId: opts.contractId }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- defi-strategy (25,000 microSTX) ---
program
  .command("defi-strategy")
  .description("Personalized DeFi strategy — 25,000 microSTX")
  .requiredOption("--address <addr>", "Stacks address")
  .option("--goals <text>", "Investment goals", "maximize yield")
  .option("--risk-tolerance <level>", "Risk tolerance: conservative, moderate, aggressive", "moderate")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("defi-strategy", {
        address: opts.address,
        goals: opts.goals,
        riskTolerance: opts.riskTolerance,
      }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- hodlmm-analysis (10,000 microSTX) ---
program
  .command("hodlmm-analysis")
  .description("HODLMM pool analysis — 10,000 microSTX")
  .requiredOption("--pool <id>", "Pool identifier (e.g. stx-sbtc)")
  .option("--address <addr>", "Stacks address for position analysis")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const body: Record<string, string> = { pool: opts.pool };
      if (opts.address) body.address = opts.address;
      const result = await postWithPayment("hodlmm-analysis", body, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// --- full-portfolio (100,000 microSTX) ---
program
  .command("full-portfolio")
  .description("Full portfolio intelligence — 100,000 microSTX")
  .requiredOption("--address <addr>", "Stacks address")
  .option("--payment-token <token>", "x402 payment token")
  .action(async (opts) => {
    try {
      const result = await postWithPayment("full-portfolio", { address: opts.address }, opts.paymentToken);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

program.parse(process.argv);
