#!/usr/bin/env bun
/**
 * hodlmm-signal-allocator
 *
 * Signal-gated HODLMM yield allocator.
 * Reads aibtc.news bitcoin-macro signals + Quantum Readiness Index + live HODLMM APR,
 * computes a risk-adjusted yield score, and executes a Bitflow swap (STX → sBTC)
 * when all five safety gates pass and --confirm is provided.
 *
 * Usage: bun run hodlmm-signal-allocator.ts <command> [options]
 * All commands emit strict JSON to stdout. Debug/warnings go to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ─────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(os.homedir(), ".hodlmm-signal-allocator-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_API    = "https://bff.bitflowapis.finance/api/app/v1";
const AIBTC_SIGNALS_API  = "https://aibtc.news/api/signals";
const QUANTUM_MAP_URL    = "https://quantum-power-map.p-d07.workers.dev/data.json";
const HIRO_API           = "https://api.mainnet.hiro.so";
const EXPLORER_BASE      = "https://explorer.hiro.so/txid";

// Hard limits — enforced in code, not configurable at runtime
const MAX_SWAP_STX          = 500;
const MIN_SIGNAL_SCORE      = 60;
const MAX_QUANTUM_RISK_FACTOR = 0.15;
const MAX_PRICE_IMPACT_PCT  = 1.5;
const MIN_STX_RESERVE_USTX  = 10_000_000; // 10 STX in µSTX
const COOLDOWN_MS           = 6 * 60 * 60 * 1000; // 6 hours
const SIGNAL_LOOKBACK_MS    = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS      = 20_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface ExecutionRecord {
  ts: number;
  pool_id: string;
  amount_stx: number;
  amount_sbtc_estimated: number | null;
  txId: string | null;
  explorerUrl: string | null;
  signal_score: number;
  readiness_index: number;
  quantum_risk_factor: number;
  signals_used: string[];
  price_impact_pct: number | null;
  status: "completed" | "dry-run" | "failed";
  error_message: string | null;
}

interface AllocatorState {
  last_exec_ts: number | null;
  last_pool: string | null;
  execution_log: ExecutionRecord[];
}

interface HodlmmPool {
  id: string;
  apr24h: number;
  tvlUsd: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXPriceUsd: number;
  tokenYPriceUsd: number;
  tokenXDecimals: number;
  tokenYDecimals: number;
  activeBin: number;
}

interface AibtcSignal {
  id: string;
  headline: string;
  score: number | null;
  status: string;
  timestamp: string;
}

interface QuantumMapData {
  readiness_index: number;
  last_updated: string;
  developers: Array<{ name: string; score: number }>;
}

// ─── Output helpers ─────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "blocked", action: next, data, error: { code, message, next } });
}

function fail(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ─── State helpers ─────────────────────────────────────────────────────────────

function readState(): AllocatorState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as AllocatorState;
    }
  } catch { /* fall through */ }
  return { last_exec_ts: null, last_pool: null, execution_log: [] };
}

function writeState(state: AllocatorState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendExecution(record: ExecutionRecord): void {
  const state = readState();
  state.last_exec_ts = record.ts;
  state.last_pool = record.pool_id;
  state.execution_log = [...state.execution_log, record].slice(-50); // keep last 50
  writeState(state);
}

// ─── HTTP helper ────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-signal-allocator" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrl(url: string): Promise<"ok" | "down"> {
  try {
    await fetchJson(url, 8_000);
    return "ok";
  } catch {
    return "down";
  }
}

// ─── HODLMM helpers ─────────────────────────────────────────────────────────────

async function fetchHodlmmPool(poolId: string): Promise<HodlmmPool | null> {
  try {
    const resp = await fetchJson<any>(`${BITFLOW_APP_API}/pools`);
    // API returns { data: [...] } or [...] directly
    const pools: any[] = Array.isArray(resp) ? resp : (resp.data ?? []);
    const pool = pools.find((p: any) =>
      (p.poolId ?? "").toLowerCase() === poolId.toLowerCase()
    );
    if (!pool) return null;
    const tx = pool.tokens ?? {};
    const tokenX = tx.tokenX ?? {};
    const tokenY = tx.tokenY ?? {};
    // Field names verified against bff.bitflowapis.finance/api/app/v1/pools (2026-04-05)
    return {
      id: pool.poolId,
      apr24h: parseFloat(pool.apr24h ?? pool.apr ?? 0),
      tvlUsd: parseFloat(pool.tvlUsd ?? 0),
      tokenXSymbol: tokenX.symbol ?? "?",
      tokenYSymbol: tokenY.symbol ?? "?",
      tokenXPriceUsd: parseFloat(tokenX.priceUsd ?? 0),
      tokenYPriceUsd: parseFloat(tokenY.priceUsd ?? 0),
      tokenXDecimals: parseInt(tokenX.decimals ?? 6),
      tokenYDecimals: parseInt(tokenY.decimals ?? 8),
      activeBin: 0, // active_bin is in the quotes API; unused in allocation logic
    };
  } catch {
    return null;
  }
}

// ─── Signals helpers ────────────────────────────────────────────────────────────

async function fetchBitcoinMacroSignals(): Promise<AibtcSignal[]> {
  const since = new Date(Date.now() - SIGNAL_LOOKBACK_MS).toISOString();
  const url = `${AIBTC_SIGNALS_API}?beat=btc-macro&status=approved&limit=30&since=${encodeURIComponent(since)}`;
  try {
    const data = await fetchJson<any>(url);
    const signals: AibtcSignal[] = (data.signals ?? data ?? []).map((s: any) => ({
      id: s.id ?? s.signal_id ?? "",
      headline: s.headline ?? s.title ?? "",
      score: typeof s.score === "number" ? s.score : null,
      status: s.status ?? "approved",
      timestamp: s.timestamp ?? s.created_at ?? new Date().toISOString(),
    }));
    return signals.filter(s => s.status === "approved");
  } catch {
    return [];
  }
}

function computeSignalScore(signals: AibtcSignal[]): { score: number; used: Array<{ id: string; headline: string; score: number; age_hours: number }> } {
  const now = Date.now();
  const scoredSignals = signals
    .filter(s => s.score !== null && s.score > 0)
    .map(s => {
      const age_hours = (now - new Date(s.timestamp).getTime()) / (1000 * 3600);
      const recency_weight = 1 - (age_hours / 24) * 0.4; // decay up to 40% over 24h
      const weighted_score = (s.score as number) * Math.max(recency_weight, 0.6);
      return { id: s.id, headline: s.headline, score: s.score as number, age_hours: parseFloat(age_hours.toFixed(1)), weighted_score };
    });

  if (scoredSignals.length === 0) return { score: 0, used: [] };

  const avg = scoredSignals.reduce((sum, s) => sum + s.weighted_score, 0) / scoredSignals.length;
  const composite = Math.min(Math.round(avg), 100);

  return {
    score: composite,
    used: scoredSignals.slice(0, 5).map(({ id, headline, score, age_hours }) => ({ id, headline, score, age_hours })),
  };
}

// ─── Quantum Map helpers ─────────────────────────────────────────────────────────

async function fetchQuantumReadiness(): Promise<{ readiness_index: number; stale: boolean; last_updated: string }> {
  try {
    const data = await fetchJson<any>(QUANTUM_MAP_URL);
    const readiness_index = typeof data.readiness_index === "number"
      ? data.readiness_index
      : (data.composite_score ?? data.score ?? 23);
    const last_updated = data.last_updated ?? data.updated_at ?? new Date().toISOString();
    const age_days = (Date.now() - new Date(last_updated).getTime()) / (1000 * 86400);
    return { readiness_index, stale: age_days > 7, last_updated };
  } catch {
    // Graceful degradation: return conservative default
    return { readiness_index: 23, stale: true, last_updated: "unknown" };
  }
}

function computeQuantumRiskFactor(readiness_index: number): number {
  // Risk factor: 0.20 at index 0, 0.0 at index 100
  // Scale: (100 - index) / 100 × 0.20
  // At index 25: (100 - 25) / 100 × 0.20 = 0.15  ← exactly hits MAX_QUANTUM_RISK_FACTOR gate
  // At index 24: (100 - 24) / 100 × 0.20 = 0.152 ← blocks (aligns with AGENT.md "index ≥ 25 required")
  // At index 50: (100 - 50) / 100 × 0.20 = 0.10
  return parseFloat(((100 - readiness_index) / 100 * 0.20).toFixed(4));
}

// ─── Wallet balance helper ──────────────────────────────────────────────────────

async function getStxBalanceUstx(address: string): Promise<bigint> {
  try {
    const data = await fetchJson<any>(`${HIRO_API}/v2/accounts/${address}?proof=0`, 8_000);
    return BigInt("0x" + (data.balance ?? "0").replace(/^0x/, ""));
  } catch {
    return 0n;
  }
}

async function getSbtcBalance(address: string): Promise<number> {
  try {
    const data = await fetchJson<any>(
      `${HIRO_API}/extended/v1/address/${address}/balances`,
      8_000
    );
    const fungible = data.fungible_tokens ?? {};
    const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
    for (const key of Object.keys(fungible)) {
      if (key.startsWith(SBTC_CONTRACT)) {
        return parseInt(fungible[key].balance ?? "0") / 1e8;
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

// ─── Wallet key loading (same pattern as dca.ts) ────────────────────────────────

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto");
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      process.stderr.write(`Wallet decrypt error: ${e.message}\n`);
    }
  }

  throw new Error(
    "No wallet found or decryption failed. Run: npx @aibtc/mcp-server@latest --install"
  );
}

// ─── Bitflow swap execution ─────────────────────────────────────────────────────

async function getBitflowSDK(): Promise<any> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as any);
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST ?? "https://bff.bitflowapis.finance",
    BITFLOW_API_KEY: process.env.BITFLOW_API_KEY ?? "",
    READONLY_CALL_API_HOST: HIRO_API,
    READONLY_CALL_API_KEY: process.env.READONLY_CALL_API_KEY ?? "",
    KEEPER_API_HOST: process.env.KEEPER_API_HOST ?? "https://bff.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL ?? "https://bff.bitflowapis.finance",
    KEEPER_API_KEY: process.env.KEEPER_API_KEY ?? "",
    BITFLOW_PROVIDER_ADDRESS: process.env.BITFLOW_PROVIDER_ADDRESS ?? "",
  });
}

async function executeSwap(opts: {
  amountStx: number;
  senderAddress: string;
  stxPrivateKey: string;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string; amountOutEstimated: number | null; priceImpactPct: number | null }> {
  const sdk = await getBitflowSDK();

  // Find token IDs
  const tokens = await sdk.getAvailableTokens();
  const stxToken = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === "stx" || (t.tokenId ?? "").toLowerCase() === "stx"
  );
  const sbtcToken = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === "sbtc" || (t.tokenId ?? "").includes("sbtc")
  );

  if (!stxToken || !sbtcToken) throw new Error("Could not find STX or sBTC token in Bitflow");

  const tokenInId = stxToken.tokenId ?? stxToken["token-id"];
  const tokenOutId = sbtcToken.tokenId ?? sbtcToken["token-id"];
  const tokenInDecimals = stxToken.tokenDecimals ?? 6;
  const tokenOutDecimals = sbtcToken.tokenDecimals ?? 8;

  // Get quote
  const quoteResult = await sdk.getQuoteForRoute(tokenInId, tokenOutId, opts.amountStx);
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(`No swap route found for STX → sBTC`);
  }

  const amountOutEstimated: number = quoteResult.bestRoute.quote ?? null;
  const priceImpactPct: number | null = quoteResult.bestRoute.priceImpact ?? null;

  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return {
      txId: fakeTxId,
      explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`,
      amountOutEstimated,
      priceImpactPct,
    };
  }

  // Live execution
  const { makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode } =
    await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountStx,
    tokenXDecimals: tokenInDecimals,
    tokenYDecimals: tokenOutDecimals,
  };

  const swapParams = await sdk.prepareSwap(swapExecutionData, opts.senderAddress, 0.015); // 1.5% slippage

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET,
    senderKey: opts.stxPrivateKey,
    anchorMode: AnchorMode.Any,
    fee: 5000n,
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  }

  const txId: string = broadcastRes.txid;
  return {
    txId,
    explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
    amountOutEstimated,
    priceImpactPct,
  };
}

// ─── Commands ──────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-signal-allocator")
  .description("Signal-gated HODLMM yield allocator with Quantum Risk adjustment");

// ── doctor ──────────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Health check: Bitflow APIs, aibtc.news signals, Quantum Power Map, BitflowSDK")
  .action(async () => {
    const checks: Record<string, string> = {};
    const degraded: string[] = [];

    // Parallel checks for read-only endpoints
    const [bitflowQuotes, bitflowApp, aibtcSignals] = await Promise.all([
      checkUrl(`${BITFLOW_QUOTES_API}/pools`),
      checkUrl(`${BITFLOW_APP_API}/pools`),
      checkUrl(`${AIBTC_SIGNALS_API}?beat=btc-macro&limit=1`),
    ]);

    checks.bitflow_quotes = bitflowQuotes;
    checks.bitflow_app = bitflowApp;
    checks.aibtc_signals = aibtcSignals;

    // Quantum Map — stale is degraded, not down
    const qm = await fetchQuantumReadiness();
    checks.quantum_map = qm.stale ? "degraded" : "ok";
    if (qm.stale) degraded.push("quantum_map (data stale > 7 days)");

    // BitflowSDK import check
    try {
      await import("@bitflowlabs/core-sdk" as any);
      checks.bitflow_sdk = "ok";
    } catch {
      checks.bitflow_sdk = "missing";
    }

    const allDown = Object.values(checks).filter(v => v === "down");
    const hasMissing = checks.bitflow_sdk === "missing";
    const overallStatus = (allDown.length > 0 || hasMissing) ? "down"
      : degraded.length > 0 ? "degraded"
      : "ok";

    if (overallStatus === "down" || overallStatus === "missing") {
      fail(
        "DEPENDENCY_DOWN",
        `Required dependencies unavailable: ${allDown.join(", ")}${hasMissing ? ", bitflow_sdk" : ""}`,
        "Run `bun install` to install @bitflowlabs/core-sdk. Check network for API issues.",
        { checks, degraded }
      );
    } else {
      success(
        overallStatus === "ok"
          ? "All dependencies healthy — ready for scan"
          : "Dependencies degraded but operational — proceeding with caution",
        { checks, degraded, quantum_readiness_index: qm.readiness_index }
      );
    }
  });

// ── scan ─────────────────────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Evaluate signal score, quantum risk, and HODLMM APR — check all gates")
  .requiredOption("--pool <id>", "HODLMM pool ID (e.g. dlmm_1)", "dlmm_1")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .action(async (opts) => {
    const { pool, wallet } = opts;

    if (!/^SP[A-Z0-9]{30,}$/.test(wallet)) {
      return fail("INVALID_WALLET", "Wallet must be a valid Stacks mainnet address (SP...)", "Provide a valid --wallet address");
    }

    // Parallel data fetch
    const [poolData, signals, quantum, stxBalanceUstx, sbtcBalance] = await Promise.all([
      fetchHodlmmPool(pool),
      fetchBitcoinMacroSignals(),
      fetchQuantumReadiness(),
      getStxBalanceUstx(wallet),
      getSbtcBalance(wallet),
    ]);

    if (!poolData) {
      return fail("POOL_NOT_FOUND", `HODLMM pool '${pool}' not found in Bitflow API`, "Check available pools at bff.bitflowapis.finance/api/app/v1/pools");
    }

    const { score: signal_score, used: signals_used } = computeSignalScore(signals);
    const quantum_risk_factor = computeQuantumRiskFactor(quantum.readiness_index);
    const adjusted_apr = parseFloat((poolData.apr24h * (1 - quantum_risk_factor)).toFixed(4));

    const state = readState();
    const cooldown_ok = state.last_exec_ts === null
      || (Date.now() - state.last_exec_ts) >= COOLDOWN_MS;
    const next_eligible_at = state.last_exec_ts
      ? new Date(state.last_exec_ts + COOLDOWN_MS).toISOString()
      : null;

    const gates = {
      signal_ok: signal_score >= MIN_SIGNAL_SCORE,
      quantum_ok: quantum_risk_factor <= MAX_QUANTUM_RISK_FACTOR,
      cooldown_ok,
    };

    let recommendation: string;
    if (!gates.signal_ok) recommendation = "WAIT_FOR_SIGNAL";
    else if (!gates.quantum_ok) recommendation = "QUANTUM_RISK_HIGH";
    else if (!gates.cooldown_ok) recommendation = "COOLDOWN_ACTIVE";
    else if (signal_score >= 80 && quantum_risk_factor <= 0.10) recommendation = "ALLOCATE";
    else if (signal_score >= 60 && quantum_risk_factor <= 0.10) recommendation = "ALLOCATE_HALF";
    else recommendation = "HOLD";

    const allGatesPass = gates.signal_ok && gates.quantum_ok && gates.cooldown_ok;

    success(
      allGatesPass
        ? `Gates pass — ${recommendation}. APR ${poolData.apr24h.toFixed(2)}% adjusted to ${adjusted_apr.toFixed(2)}% for quantum risk.`
        : `Gates blocked — ${recommendation}. Run scan again when conditions change.`,
      {
        pool_id: poolData.id,
        pool_apr_24h: poolData.apr24h,
        pool_tvl_usd: poolData.tvlUsd,
        adjusted_apr,
        signal_score,
        signals_count: signals.length,
        signals_used,
        quantum_risk_factor,
        readiness_index: quantum.readiness_index,
        quantum_map_stale: quantum.stale,
        quantum_map_last_updated: quantum.last_updated,
        gates,
        recommendation,
        wallet_stx_balance: parseFloat((Number(stxBalanceUstx) / 1_000_000).toFixed(6)),
        wallet_sbtc_balance: sbtcBalance,
        next_eligible_at,
        amount_scaling_note: signal_score >= 80
          ? "High confidence — full amount eligible"
          : signal_score >= 60
          ? "Moderate confidence — amount will be halved"
          : "Below threshold — execution blocked",
      }
    );
  });

// ── run ──────────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute Bitflow swap after all 5 safety gates pass. Requires --confirm.")
  .requiredOption("--pool <id>", "HODLMM pool ID", "dlmm_1")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--amount-stx <n>", "STX amount to swap (max 500)")
  .option("--confirm", "Required to execute live swap. Without this, returns simulation only.")
  .option("--dry-run", "Simulate swap without broadcasting (still runs all validation)")
  .option("--password <pwd>", "Wallet password (or set AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    const { pool, wallet, confirm: doConfirm, dryRun } = opts;
    const amountStx = parseFloat(opts.amountStx);
    const password = opts.password ?? process.env.AIBTC_WALLET_PASSWORD ?? "";

    // Input validation
    if (!/^SP[A-Z0-9]{30,}$/.test(wallet)) {
      return fail("INVALID_WALLET", "Wallet must be a valid Stacks mainnet address (SP...)", "Provide a valid --wallet address");
    }
    if (isNaN(amountStx) || amountStx <= 0) {
      return fail("INVALID_AMOUNT", "amount-stx must be a positive number", "Provide --amount-stx > 0");
    }

    // Gate 3: spend cap
    if (amountStx > MAX_SWAP_STX) {
      return blocked("EXCEEDS_CAP", `Amount ${amountStx} STX exceeds hard cap of ${MAX_SWAP_STX} STX`, `Reduce --amount-stx to ≤ ${MAX_SWAP_STX}`);
    }

    // Parallel data fetch (same as scan)
    const [poolData, signals, quantum, stxBalanceUstx] = await Promise.all([
      fetchHodlmmPool(pool),
      fetchBitcoinMacroSignals(),
      fetchQuantumReadiness(),
      getStxBalanceUstx(wallet),
    ]);

    if (!poolData) {
      return fail("POOL_NOT_FOUND", `HODLMM pool '${pool}' not found`, "Check pool ID");
    }

    const { score: signal_score, used: signals_used } = computeSignalScore(signals);
    const quantum_risk_factor = computeQuantumRiskFactor(quantum.readiness_index);

    // Gate 1: signal quality
    if (signal_score < MIN_SIGNAL_SCORE) {
      return blocked(
        "LOW_SIGNAL_SCORE",
        `Signal score ${signal_score} below minimum ${MIN_SIGNAL_SCORE}. ${signals.length} approved signals found in last 24h.`,
        "Wait for higher-quality aibtc.news bitcoin-macro signals before allocating",
        { signal_score, signals_count: signals.length, min_required: MIN_SIGNAL_SCORE }
      );
    }

    // Gate 2: quantum risk
    if (quantum_risk_factor > MAX_QUANTUM_RISK_FACTOR) {
      return blocked(
        "QUANTUM_RISK_HIGH",
        `Quantum risk factor ${quantum_risk_factor} exceeds max ${MAX_QUANTUM_RISK_FACTOR}. Readiness Index: ${quantum.readiness_index}/100.`,
        "Wait for Quantum Readiness Index to improve above 25 before long-duration HODLMM allocation",
        { quantum_risk_factor, readiness_index: quantum.readiness_index, max_allowed: MAX_QUANTUM_RISK_FACTOR }
      );
    }

    // Scale amount by signal confidence
    const scaledAmountStx = signal_score >= 80 ? amountStx : amountStx * 0.5;
    const amountUstx = BigInt(Math.round(scaledAmountStx * 1_000_000));

    // Gate 4: STX reserve
    const requiredUstx = amountUstx + BigInt(MIN_STX_RESERVE_USTX);
    if (stxBalanceUstx < requiredUstx) {
      const available = parseFloat((Number(stxBalanceUstx) / 1_000_000).toFixed(6));
      const required = parseFloat((Number(requiredUstx) / 1_000_000).toFixed(6));
      return blocked(
        "INSUFFICIENT_RESERVE",
        `Wallet has ${available} STX, needs ${required} STX (${scaledAmountStx} swap + 10 STX gas reserve)`,
        `Fund wallet with at least ${(required - available).toFixed(2)} more STX before executing`,
        { wallet_stx_balance: available, required_stx: required, scaled_amount_stx: scaledAmountStx }
      );
    }

    // Cooldown check
    const state = readState();
    if (state.last_exec_ts && (Date.now() - state.last_exec_ts) < COOLDOWN_MS) {
      const next_eligible_at = new Date(state.last_exec_ts + COOLDOWN_MS).toISOString();
      return blocked(
        "COOLDOWN_ACTIVE",
        `Last execution was ${Math.round((Date.now() - state.last_exec_ts) / 60000)} minutes ago. Cooldown: 6 hours.`,
        `Try again after ${next_eligible_at}`,
        { next_eligible_at, last_exec_ts: new Date(state.last_exec_ts).toISOString() }
      );
    }

    // Confirm gate — if no --confirm and no --dry-run, return full simulation preview
    if (!doConfirm && !dryRun) {
      return blocked(
        "CONFIRM_REQUIRED",
        `All gates pass. Ready to swap ${scaledAmountStx} STX → sBTC on pool ${pool}. Add --confirm to execute.`,
        "Review simulation below, then run with --confirm to execute live swap",
        {
          simulation: {
            pool_id: pool,
            amount_stx_scaled: scaledAmountStx,
            signal_score,
            quantum_risk_factor,
            adjusted_apr: parseFloat((poolData.apr24h * (1 - quantum_risk_factor)).toFixed(4)),
            signal_basis: signals_used,
            readiness_index: quantum.readiness_index,
            scaling_reason: signal_score >= 80 ? "Full amount (signal ≥ 80)" : "Half amount (signal 60-79)",
          },
          gates_passed: { signal: true, quantum: true, reserve: true, cooldown: true },
        }
      );
    }

    // Get quote to check Gate 5: price impact
    let priceImpactPct: number | null = null;
    try {
      const sdk = await getBitflowSDK();
      const tokens = await sdk.getAvailableTokens();
      const stxToken = tokens.find((t: any) =>
        (t.symbol ?? "").toLowerCase() === "stx" || (t.tokenId ?? "").toLowerCase() === "stx"
      );
      const sbtcToken = tokens.find((t: any) =>
        (t.symbol ?? "").toLowerCase() === "sbtc" || (t.tokenId ?? "").includes("sbtc")
      );
      if (stxToken && sbtcToken) {
        const quoteResult = await sdk.getQuoteForRoute(
          stxToken.tokenId ?? stxToken["token-id"],
          sbtcToken.tokenId ?? sbtcToken["token-id"],
          scaledAmountStx
        );
        priceImpactPct = quoteResult?.bestRoute?.priceImpact ?? null;
      }
    } catch (e: any) {
      process.stderr.write(`Quote pre-check failed: ${e.message}\n`);
    }

    // Gate 5: price impact
    if (priceImpactPct !== null && priceImpactPct > MAX_PRICE_IMPACT_PCT) {
      return blocked(
        "PRICE_IMPACT_HIGH",
        `Price impact ${priceImpactPct.toFixed(2)}% exceeds max ${MAX_PRICE_IMPACT_PCT}%. Spread too wide.`,
        "Wait for deeper liquidity or reduce --amount-stx",
        { price_impact_pct: priceImpactPct, max_allowed: MAX_PRICE_IMPACT_PCT }
      );
    }

    // Execute swap
    const isLiveDryRun = !!dryRun;
    const walletKeys = isLiveDryRun ? { stxPrivateKey: "", stxAddress: wallet } : await getWalletKeys(password);

    let swapResult: { txId: string; explorerUrl: string; amountOutEstimated: number | null; priceImpactPct: number | null };
    try {
      swapResult = await executeSwap({
        amountStx: scaledAmountStx,
        senderAddress: walletKeys.stxAddress,
        stxPrivateKey: walletKeys.stxPrivateKey,
        dryRun: isLiveDryRun,
      });
    } catch (e: any) {
      const record: ExecutionRecord = {
        ts: Date.now(),
        pool_id: pool,
        amount_stx: scaledAmountStx,
        amount_sbtc_estimated: null,
        txId: null,
        explorerUrl: null,
        signal_score,
        readiness_index: quantum.readiness_index,
        quantum_risk_factor,
        signals_used: signals_used.map(s => s.id),
        price_impact_pct: priceImpactPct,
        status: "failed",
        error_message: e.message,
      };
      appendExecution(record);
      return fail("SWAP_FAILED", e.message, "Check wallet balance, Bitflow API status, and try again", { error_detail: e.message });
    }

    const next_eligible_at = new Date(Date.now() + COOLDOWN_MS).toISOString();

    const record: ExecutionRecord = {
      ts: Date.now(),
      pool_id: pool,
      amount_stx: scaledAmountStx,
      amount_sbtc_estimated: swapResult.amountOutEstimated,
      txId: swapResult.txId,
      explorerUrl: swapResult.explorerUrl,
      signal_score,
      readiness_index: quantum.readiness_index,
      quantum_risk_factor,
      signals_used: signals_used.map(s => s.id),
      price_impact_pct: swapResult.priceImpactPct ?? priceImpactPct,
      status: isLiveDryRun ? "dry-run" : "completed",
      error_message: null,
    };
    // Only update cooldown timer for live executions — dry-run must not block real execution
    if (!isLiveDryRun) {
      appendExecution(record);
    } else {
      // Log dry-run to execution_log for audit trail but do not touch last_exec_ts
      const state = readState();
      state.execution_log = [...state.execution_log, record].slice(-50);
      writeState(state);
    }

    const adjusted_apr = parseFloat((poolData.apr24h * (1 - quantum_risk_factor)).toFixed(4));

    success(
      isLiveDryRun
        ? `Dry-run complete — simulated ${scaledAmountStx} STX → ${swapResult.amountOutEstimated?.toFixed(6) ?? "?"} sBTC. Add --confirm for live execution.`
        : `Swapped ${scaledAmountStx} STX → ~${swapResult.amountOutEstimated?.toFixed(6) ?? "?"} sBTC for HODLMM entry. TX: ${swapResult.txId}`,
      {
        txId: swapResult.txId,
        explorerUrl: swapResult.explorerUrl,
        dry_run: isLiveDryRun,
        amount_in_stx: scaledAmountStx,
        amount_out_sbtc_estimated: swapResult.amountOutEstimated,
        price_impact_pct: swapResult.priceImpactPct ?? priceImpactPct,
        signal_score,
        readiness_index: quantum.readiness_index,
        signal_basis: signals_used,
        quantum_risk_factor,
        adjusted_apr,
        pool_apr_24h: poolData.apr24h,
        scaling_applied: signal_score < 80 ? "50% (moderate signal confidence)" : "100% (high signal confidence)",
        next_eligible_at,
      }
    );
  });

program.parseAsync(process.argv).catch((e: any) => {
  out({
    status: "error",
    action: "Unhandled error — check stderr for details",
    data: {},
    error: { code: "UNHANDLED_ERROR", message: e?.message ?? String(e), next: "Report issue at bff-skills GitHub" },
  });
  process.stderr.write(e?.stack ?? e?.message ?? String(e));
  process.exit(1);
});
