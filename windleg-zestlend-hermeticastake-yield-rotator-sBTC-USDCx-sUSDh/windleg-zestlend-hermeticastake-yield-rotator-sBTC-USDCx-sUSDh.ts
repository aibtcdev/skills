#!/usr/bin/env bun

import { Command } from "commander";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

// Global fetch wrapper: linear backoff on HTTP 429 from any downstream call.
// Covers @stacks/transactions internal fetches (fee estimation, nonce lookup,
// broadcast, tx-status polling) which hit Hiro /v2/* endpoints without their
// own retry logic. Matches the retry shape in checkHermeticaStakingEnabled.
{
  const _origFetch = globalThis.fetch;
  const _backoffMs = [5000, 15000, 30000];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await _origFetch(input as RequestInfo, init as RequestInit);
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, _backoffMs[attempt]));
        continue;
      }
      return res;
    }
    return _origFetch(input as RequestInfo, init as RequestInit);
  }) as typeof globalThis.fetch;
}

// `Json` is intentionally widened to `unknown` so the strategy module can pass
// nested bigint-bearing structures through internal boundaries; the
// `stringify` helper converts bigints to strings before serialization at the
// output edge.
type Json = unknown;
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";

type Step =
  | "idle"
  | "supply_confirmed"
  | "borrow_confirmed"
  | "swap_confirmed"
  | "complete"
  | "operator_cancelled";

interface Primitive { name: string; entry: string | null; requiredFor: string; }
interface PrimitiveResult { status?: string; action?: string; data?: JsonMap; error?: JsonMap | null; raw?: JsonMap; }

interface Checkpoint {
  version: number;
  cycleId: string;
  wallet: string;
  step: Step;
  requestedSbtcAmountSats: string;
  requestedTargetLtvBps: number;
  createdAt: string;
  updatedAt: string;
  supplyTxid?: string;
  borrowTxid?: string;
  swapTxid?: string;
  stakeTxid?: string;
  borrowedAmountBase?: string;
  borrowedAsset?: string;
  swapOutUsdhBase?: string;
  abortReason?: string;
  nextRequiredAction?: string;
}

interface SharedOptions {
  wallet?: string;
  sbtcAmountSats?: string;
  targetLtv?: string;
  borrowAsset?: string;
  slippageBps?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
  minScore?: string;
  maxPriceDispersionPct?: string;
  exitScoreBelow?: string;
  poolShareCapPct?: string;
  emergencyReservePct?: string;
}

interface RunOptions extends SharedOptions { confirm?: string; }
interface MonitorOptions extends RunOptions {
  mode?: string;
  pollIntervalSeconds?: string;
  maxIterations?: string;
}

// ----- Constants -----

const CONFIRM_TOKEN_ROTATE = "ROTATE";
const CONFIRM_TOKEN_AUTONOMOUS = "AUTONOMOUS";
const CONFIRM_TOKEN_DEPOSIT = "DEPOSIT";
const CONFIRM_TOKEN_SWAP = "SWAP";
const MAX_TARGET_LTV = 0.50;
const WARN_TARGET_LTV = 0.40;
const DEFAULT_TARGET_LTV = "0.40";
const DEFAULT_BORROW_ASSET = "USDCx";
const DEFAULT_SLIPPAGE_BPS = "150";
const DEFAULT_MIN_GAS_RESERVE_USTX = "500000";
const DEFAULT_MEMPOOL_DEPTH_LIMIT = "0";
const DEFAULT_WAIT_SECONDS = "240";
const DEFAULT_MIN_SCORE = "55";
const DEFAULT_EXIT_SCORE_BELOW = "35"; // wind skill emits UNWIND signal at this threshold for the partner unwinder skill; never broadcasts unwind itself
const DEFAULT_MAX_PRICE_DISPERSION_PCT = "2";
const DEFAULT_MAX_PRICE_IMPACT_BPS = "50";
const DEFAULT_POLL_INTERVAL_SECONDS = "3600";
const DEFAULT_MAX_ITERATIONS = "0";
const DEFAULT_POOL_SHARE_CAP_PCT = "5";
const DEFAULT_EMERGENCY_RESERVE_PCT = "30";
const AUTONOMOUS_RATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;
// Dedicated longer timeout for registry endpoints (Bitflow `/tokens`). The
// quotes registry response is large (~100+ tokens) and intermittently slow;
// 5s was tripping the catch-and-return-empty path during normal operation
// and producing null token resolutions downstream.
const HTTP_TIMEOUT_REGISTRY_MS = 20000;
const EXCHANGE_RATE_MIN_HISTORY_HOURS = 24;
const MAX_HISTORY_SAMPLES = 720;

// Bitflow APIs (authoritative). Documented at
// https://bff.bitflowapis.finance/api/quotes/docs and /api/app/docs.
const BITFLOW_QUOTES_BASE = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_BASE = "https://bff.bitflowapis.finance/api/app/v1";

// Hermetica contracts — verified against on-chain Clarity bytecode at block
// 3,567,258 via Hiro /v2/contracts/source. See SKILL.md "Verified contracts".
const HERMETICA_DEPLOYER = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const HERMETICA_STAKING_CONTRACT = "staking-v1-1";
const HERMETICA_EXCHANGE_RATE_FN = "get-usdh-per-susdh";
const HERMETICA_USDH_TOKEN = "usdh-token-v1";
const HERMETICA_SUSDH_TOKEN = "susdh-token-v1";
const HIRO_API_BASE = "https://api.hiro.so";

// Strategy composite weights.
const STRATEGY_WEIGHTS: Record<string, number> = {
  btcRegime: 0.25,
  funding: 0.20,
  carrySpread: 0.15,
  carryTrend: 0.05,
  realizedVol: 0.25,
  peg: 0.10,
};

const DEPENDENCIES: { name: string; requiredFor: string }[] = [
  { name: "zest-asset-deposit-primitive", requiredFor: "supply sBTC into Zest V2 as collateral" },
  { name: "zest-borrow-asset-primitive", requiredFor: "borrow USDCx against the sBTC collateral position" },
  { name: "bitflow-swap-aggregator", requiredFor: "swap borrowed USDCx into USDh via Bitflow's aggregator" },
];


// ----- Error envelope -----

class BlockedError extends Error {
  constructor(public code: string, message: string, public next: string, public data: JsonMap = {}) { super(message); }
}

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringify(v)])) as JsonMap;
  if (value === undefined) return null;
  return value as Json;
}
function output(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  console.log(JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2));
}
function success(action: string, data: JsonMap): void { output("success", action, data, null); }
// Surface fetcher failures to stderr so an outage in Hiro / Bitflow / Binance
// doesn't silently degrade to a null cascade with no operator-visible root
// cause. JSON output contract on stdout is unaffected (stderr is separate).
function logFetchFailure(fnName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[windleg] ${fnName} failed: ${message}`);
}
function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void { output("blocked", action, data, { code, message, next }); }
function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) { blocked(action, error.code, error.message, error.next, error.data); return; }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor and inspect the failing dependency before retrying." });
  process.exitCode = 1;
}

// ----- File / state helpers -----

async function fileExists(filePath: string): Promise<boolean> { try { await fs.access(filePath); return true; } catch { return false; } }
function repoRoot(): string { return process.env.AIBTC_SKILLS_ROOT || process.cwd(); }
function stateDir(): string { return path.join(os.homedir(), ".aibtc", "state", "windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh"); }
function safeWalletKey(wallet: string): string { return wallet.replace(/[^A-Za-z0-9_.-]/g, "_"); }
function checkpointPath(wallet: string): string { return path.join(stateDir(), `${safeWalletKey(wallet)}.json`); }
function historyPath(): string { return path.join(stateDir(), "exchange-rate-history.json"); }
function actionLogPath(wallet: string): string { return path.join(stateDir(), `${safeWalletKey(wallet)}.actions.json`); }

async function readCheckpoint(wallet: string): Promise<Checkpoint | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath(wallet), "utf8")) as Partial<Checkpoint>;
    if (parsed.version !== 1 || parsed.wallet !== wallet || typeof parsed.step !== "string") return null;
    return parsed as Checkpoint;
  } catch { return null; }
}
async function writeCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  await fs.mkdir(stateDir(), { recursive: true });
  const updated = { ...checkpoint, updatedAt: new Date().toISOString() };
  await fs.writeFile(checkpointPath(checkpoint.wallet), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}
function newCheckpoint(wallet: string, sbtcAmountSats: string, ltvBps: number): Checkpoint {
  const now = new Date().toISOString();
  return { version: 1, cycleId: `rot-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, wallet, step: "idle", requestedSbtcAmountSats: sbtcAmountSats, requestedTargetLtvBps: ltvBps, createdAt: now, updatedAt: now };
}
function isUnresolved(checkpoint: Checkpoint | null): boolean {
  if (!checkpoint) return false;
  return !["complete", "operator_cancelled"].includes(checkpoint.step);
}

interface ExchangeRateSample { ts: string; rateNum: number; rateRaw: string; }
interface ExchangeRateHistory { samples: ExchangeRateSample[]; }
async function readHistory(): Promise<ExchangeRateHistory> {
  try { const parsed = JSON.parse(await fs.readFile(historyPath(), "utf8")) as ExchangeRateHistory; if (Array.isArray(parsed.samples)) return parsed; } catch { /* fall through */ }
  return { samples: [] };
}
async function appendHistory(sample: ExchangeRateSample): Promise<ExchangeRateHistory> {
  // Concurrent `computeScore` calls from `score`/`plan`/`run`/`monitor` can race
  // on the history file. Mitigate with:
  //   1. dedupe: skip samples within 60s of an existing one (idempotent for
  //      same-block reads),
  //   2. atomic rename: write to a tmpfile then rename, so partial writes are
  //      never observed by readers.
  // Multi-process races are still possible but the dedupe makes them harmless.
  await fs.mkdir(stateDir(), { recursive: true });
  const history = await readHistory();
  const newTs = Date.parse(sample.ts);
  if (Number.isFinite(newTs) && history.samples.some((s) => Math.abs(Date.parse(s.ts) - newTs) < 60_000)) return history;
  history.samples.push(sample);
  if (history.samples.length > MAX_HISTORY_SAMPLES) history.samples = history.samples.slice(-MAX_HISTORY_SAMPLES);
  const tmpPath = `${historyPath()}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  try {
    await fs.rename(tmpPath, historyPath());
  } catch (renameErr) {
    // Best-effort cleanup of the tmpfile, then surface the failure to the caller.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw renameErr;
  }
  return history;
}

interface ActionLogEntry { ts: string; action: string; cycleId?: string; txid?: string; scoreSnapshot?: JsonMap; }
interface ActionLog { entries: ActionLogEntry[]; }
async function readActionLog(wallet: string): Promise<ActionLog> {
  try { const parsed = JSON.parse(await fs.readFile(actionLogPath(wallet), "utf8")) as ActionLog; if (Array.isArray(parsed.entries)) return parsed; } catch { /* fall through */ }
  return { entries: [] };
}
async function appendActionLog(wallet: string, entry: ActionLogEntry): Promise<ActionLog> {
  await fs.mkdir(stateDir(), { recursive: true });
  const log = await readActionLog(wallet);
  log.entries.push(entry);
  if (log.entries.length > 200) log.entries = log.entries.slice(-200);
  await fs.writeFile(actionLogPath(wallet), `${JSON.stringify(log, null, 2)}\n`, "utf8");
  return log;
}
function lastAutoActionMs(log: ActionLog): number | null {
  // Count any auto-action that ATTEMPTED to broadcast (success OR error) against
  // the 24h rate-limit window. Only `auto:intend:` (logged before the action
  // runs) is excluded — if we excluded `auto:error:` as well, a failed
  // broadcast (e.g. TX_NOT_SUCCESSFUL after the chain saw the tx) wouldn't
  // burn the window and we'd be free to retry tightly, defeating the cap.
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const a = log.entries[i].action;
    if (a.startsWith("auto:") && !a.startsWith("auto:intend:")) return new Date(log.entries[i].ts).getTime();
  }
  return null;
}

// ----- Input validation -----

function ensureWallet(wallet?: string): string { if (!wallet) throw new Error("--wallet is required"); return wallet; }
function ensureSbtcAmount(amount?: string): string {
  if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) throw new Error("--sbtc-amount-sats is required and must be a positive integer in satoshis");
  return amount;
}
function parseLtvOrThrow(value: string | undefined): { ltv: number; bps: number; warn: boolean } {
  const raw = value ?? DEFAULT_TARGET_LTV;
  const ltv = Number(raw);
  if (!Number.isFinite(ltv) || ltv <= 0 || ltv >= 1) throw new Error(`--target-ltv must be a decimal in (0, 1); received ${raw}`);
  if (ltv > MAX_TARGET_LTV) throw new BlockedError("TARGET_LTV_TOO_HIGH", `--target-ltv ${ltv} exceeds the controller cap of ${MAX_TARGET_LTV}.`, `Lower --target-ltv to <= ${MAX_TARGET_LTV} or use a different controller.`, { requestedLtv: ltv, maxAllowed: MAX_TARGET_LTV });
  return { ltv, bps: Math.round(ltv * 10000), warn: ltv > WARN_TARGET_LTV };
}
function parseScoreThreshold(value: string | undefined, defaultStr: string): number {
  const n = Number(value ?? defaultStr);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Score threshold must be 0–100; received ${value ?? defaultStr}`);
  return Math.round(n);
}
function parsePositiveInt(value: string | undefined, defaultStr: string, name: string): number {
  // Non-negative integer (0 allowed) — use for `maxIterations` where 0 means
  // "run forever."
  const n = Number(value ?? defaultStr);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${name} must be a non-negative integer; received ${value ?? defaultStr}`);
  return n;
}
function parseStrictlyPositiveInt(value: string | undefined, defaultStr: string, name: string, lowerBound = 1): number {
  // Strictly positive integer — use for poll cadence so we never produce a hot
  // setTimeout(0) loop hammering external APIs.
  const n = Number(value ?? defaultStr);
  if (!Number.isFinite(n) || n < lowerBound || !Number.isInteger(n)) throw new Error(`${name} must be an integer >= ${lowerBound}; received ${value ?? defaultStr}`);
  return n;
}
function parseFloatOrDefault(value: string | undefined, defaultStr: string, name: string): number {
  const n = Number(value ?? defaultStr);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number; received ${value ?? defaultStr}`);
  return n;
}

// ----- Primitive resolution -----

async function resolvePrimitive(name: string, requiredFor: string): Promise<Primitive> {
  const root = repoRoot();
  for (const c of [path.join(root, "skills", name, `${name}.ts`), path.join(root, name, `${name}.ts`)]) if (await fileExists(c)) return { name, entry: c, requiredFor };
  return { name, entry: null, requiredFor };
}
async function installedPrimitives(): Promise<Primitive[]> { return Promise.all(DEPENDENCIES.map((d) => resolvePrimitive(d.name, d.requiredFor))); }
function missingPrimitives(primitives: Primitive[]): Primitive[] { return primitives.filter((p) => !p.entry); }
function ensureInstalled(primitives: Primitive[]): void {
  const missing = missingPrimitives(primitives);
  if (missing.length > 0) throw new BlockedError("MISSING_PRIMITIVE_DEPENDENCIES", "This composed controller cannot run until all primitive skill dependencies are installed.", "Install (merge) the listed primitive PRs into the same repo, then rerun doctor.", { missing: missing as unknown as Json });
}
function primitiveByName(primitives: Primitive[], name: string): Primitive {
  const found = primitives.find((p) => p.name === name);
  if (!found?.entry) throw new Error(`Primitive ${name} is not installed`);
  return found;
}

async function runPrimitive(entry: string, subcommand: string, args: string[]): Promise<PrimitiveResult> {
  // Use Bun.spawn rather than node's child_process.spawn — matches the runtime
  // this skill targets and avoids importing from `node:*`.
  const proc = Bun.spawn(["bun", "run", entry, subcommand, ...args], {
    cwd: repoRoot(),
    env: { ...process.env, NETWORK: process.env.NETWORK || "mainnet" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const trimmed = stdout.trim();
  let parsed: PrimitiveResult;
  try {
    parsed = JSON.parse(trimmed) as PrimitiveResult;
  } catch {
    throw new BlockedError(
      "INVALID_PRIMITIVE_OUTPUT",
      `Primitive ${path.basename(entry)} did not return one JSON object.`,
      "Inspect the primitive output and fix the primitive before composing.",
      { code, stdout: trimmed.slice(0, 1000), stderr: stderr.slice(0, 1000) }
    );
  }
  if (code !== 0 && parsed.status !== "blocked" && parsed.status !== "error") {
    parsed = {
      ...parsed,
      status: "error",
      error: { code: "PRIMITIVE_EXIT_NONZERO", message: `Primitive exited with code ${code}.`, stderr: stderr.slice(0, 1000) },
    };
  }
  return parsed;
}
function requirePrimitiveSuccess(name: string, result: PrimitiveResult): void {
  if (result.status !== "success") throw new BlockedError("PRIMITIVE_BLOCKED", `${name} did not return success.`, "Resolve the primitive blocker before continuing the composed cycle.", { primitive: name, result: result as JsonMap });
}

// Per-flag helpers. Zest deposit + borrow primitives accept --min-gas-reserve-ustx
// (and --wait-seconds on `run`) but NOT --mempool-depth-limit; only the Bitflow
// swap-aggregator accepts --mempool-depth-limit. Verified by inspecting each
// primitive's `--help` output.
function gasReserveArg(opts: SharedOptions): string[] { return ["--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX]; }
function mempoolDepthArg(opts: SharedOptions): string[] { return ["--mempool-depth-limit", opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT]; }
function commonWaitArgs(opts: SharedOptions): string[] { return ["--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS]; }
function commonSwapArgs(opts: SharedOptions): string[] { return ["--slippage-bps", opts.slippageBps || DEFAULT_SLIPPAGE_BPS, ...gasReserveArg(opts), ...mempoolDepthArg(opts), ...commonWaitArgs(opts)]; }
function supplyArgs(wallet: string, amountSats: string): string[] { return ["--wallet", wallet, "--deposit-asset", "sBTC", "--amount", amountSats]; }
function borrowArgs(wallet: string, borrowAsset: string, amount?: string): string[] {
  const args = ["--wallet", wallet, "--collateral-asset", "sBTC", "--borrow-asset", borrowAsset];
  if (amount) args.push("--amount", amount);
  return args;
}
function atomicToHumanDecimal(atomic: bigint, decimals: number): string {
  // bitflow-swap-aggregator's `--amount-in` is a human-readable decimal string
  // (see its `parsePositiveHuman` / `decimalToAtomic` at amount-parse time).
  // Passing atomic units directly would either fail the input-balance check
  // (rejected as "too large") or, in low-decimal pathological cases, transact
  // 10^decimals more than intended. Always convert atomic -> human here.
  if (decimals <= 0) return atomic.toString();
  const negative = atomic < 0n;
  const absStr = (negative ? -atomic : atomic).toString();
  const padded = absStr.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const out = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}
function swapArgs(wallet: string, amountInAtomic: bigint | string, tokenIn: string, tokenOut: string, tokenInDecimals: number, opts: SharedOptions): string[] {
  const atomic = typeof amountInAtomic === "string" ? BigInt(amountInAtomic) : amountInAtomic;
  const human = atomicToHumanDecimal(atomic, tokenInDecimals);
  return ["--wallet", wallet, "--token-in", tokenIn, "--token-out", tokenOut, "--amount-in", human, ...commonSwapArgs(opts)];
}
function extractTxid(result: PrimitiveResult): string | null {
  // Primitive output shapes observed:
  //   - zest-asset-deposit-primitive / zest-borrow-asset-primitive emit
  //     `data.tx.txid` (see each primitive's `success("run", ...)`).
  //   - bitflow-swap-aggregator emits `data.proof.txid`.
  // Older primitives that used `data.txid` directly are still supported.
  const data = (result.data || {}) as JsonMap;
  const tx = data.tx as JsonMap | undefined;
  const proof = data.proof as JsonMap | undefined;
  const direct = tx?.txid ?? proof?.txid ?? data.txid;
  return typeof direct === "string" ? direct : null;
}
function asBigInt(value: Json | undefined): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}
function extractObservedOut(result: PrimitiveResult): string | null {
  const data = result.data || {};
  const before = data.balances as JsonMap | undefined;
  const after = data.balancesAfter as JsonMap | undefined;
  const beforeOut = asBigInt(before?.outputBalance);
  const afterOut = asBigInt(after?.outputBalance);
  if (beforeOut !== null && afterOut !== null && afterOut >= beforeOut) return (afterOut - beforeOut).toString();
  return null;
}
async function primitiveReadiness(primitives: Primitive[], wallet: string): Promise<JsonMap> {
  const results: JsonMap = {};
  for (const dep of primitives) {
    if (!dep.entry) { results[dep.name] = { status: "missing", requiredFor: dep.requiredFor }; continue; }
    let args: string[] = ["--wallet", wallet];
    if (dep.name === "zest-asset-deposit-primitive") args = ["--wallet", wallet, "--deposit-asset", "sBTC"];
    results[dep.name] = (await runPrimitive(dep.entry, "doctor", args)) as JsonMap;
  }
  return results;
}

// =========================================================================
// === STRATEGY MODULE: price feeds, funding, peg, vol, carry, sizing
// =========================================================================

async function httpJson(url: string, init?: RequestInit, timeoutMs: number = HTTP_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally { clearTimeout(timeout); }
}

interface PriceSample { source: string; priceUsd: number; fetchedAt: string; }
interface PriceFeedConfig { name: string; url: string; parse: (json: unknown) => number | null; }
const PRICE_FEEDS: PriceFeedConfig[] = [
  { name: "coingecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", parse: (j) => { const v = (j as { bitcoin?: { usd?: number } })?.bitcoin?.usd; return typeof v === "number" && v > 0 ? v : null; } },
  { name: "coinpaprika", url: "https://api.coinpaprika.com/v1/tickers/btc-bitcoin", parse: (j) => { const v = (j as { quotes?: { USD?: { price?: number } } })?.quotes?.USD?.price; return typeof v === "number" && v > 0 ? v : null; } },
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD", parse: (j) => { const result = (j as { result?: Record<string, { c?: string[] }> })?.result; if (!result) return null; for (const k of Object.keys(result)) { const last = result[k]?.c?.[0]; if (typeof last === "string") { const v = Number(last); if (Number.isFinite(v) && v > 0) return v; } } return null; } },
  { name: "binance-spot", url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", parse: (j) => { const v = (j as { price?: string })?.price; if (typeof v !== "string") return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; } },
];

async function fetchBtcPriceSamples(): Promise<{ samples: PriceSample[]; failures: { source: string; error: string }[] }> {
  const samples: PriceSample[] = [];
  const failures: { source: string; error: string }[] = [];
  await Promise.allSettled(PRICE_FEEDS.map(async (feed) => {
    try {
      const json = await httpJson(feed.url);
      const price = feed.parse(json);
      if (price !== null) samples.push({ source: feed.name, priceUsd: price, fetchedAt: new Date().toISOString() });
      else failures.push({ source: feed.name, error: "parse returned null" });
    } catch (e) { failures.push({ source: feed.name, error: e instanceof Error ? e.message : String(e) }); }
  }));
  return { samples, failures };
}
function medianNumber(values: number[]): number | null { if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]; }
function dispersionPct(values: number[]): number | null { if (values.length < 2) return null; const min = Math.min(...values), max = Math.max(...values), mean = (min + max) / 2; return mean > 0 ? ((max - min) / mean) * 100 : null; }

async function fetchBtcHistory30d(): Promise<{ closes: number[]; fetchedAt: string } | null> {
  try {
    const json = await httpJson("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily") as { prices?: [number, number][] };
    if (!json.prices || json.prices.length < 7) return null;
    const closes = json.prices.map((p) => p[1]).filter((n) => Number.isFinite(n) && n > 0);
    return closes.length >= 7 ? { closes, fetchedAt: new Date().toISOString() } : null;
  } catch (error) { logFetchFailure("fetchBtcHistory30d", error); return null; }
}
function returnPctOver(closes: number[], days: number): number | null {
  if (closes.length < days + 1) return null;
  const last = closes[closes.length - 1], past = closes[closes.length - 1 - days];
  if (!past || !last) return null;
  return ((last - past) / past) * 100;
}
function realizedVolAnnualizedPct(closes: number[]): number | null {
  if (closes.length < 8) return null;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) { const prev = closes[i - 1], curr = closes[i]; if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev)); }
  if (logReturns.length < 7) return null;
  const mean = logReturns.reduce((s, x) => s + x, 0) / logReturns.length;
  const variance = logReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, logReturns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

async function fetchBinanceFundingInstant(): Promise<{ last8hPct: number | null; annualizedPct: number | null }> {
  try {
    const json = await httpJson("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT") as { lastFundingRate?: string };
    const raw = json.lastFundingRate;
    if (typeof raw !== "string") return { last8hPct: null, annualizedPct: null };
    const rate = Number(raw);
    if (!Number.isFinite(rate)) return { last8hPct: null, annualizedPct: null };
    return { last8hPct: rate * 100, annualizedPct: rate * 3 * 365 * 100 };
  } catch (error) { logFetchFailure("fetchBinanceFundingInstant", error); return { last8hPct: null, annualizedPct: null }; }
}

async function fetchBinanceFunding7dMA(): Promise<{ ma7dAnnualizedPct: number | null; sampleCount: number; rawPrints: number[] }> {
  try {
    const json = await httpJson("https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=21") as Array<{ fundingRate?: string; fundingTime?: number }>;
    if (!Array.isArray(json)) return { ma7dAnnualizedPct: null, sampleCount: 0, rawPrints: [] };
    const rates: number[] = [];
    for (const item of json) {
      const r = Number(item.fundingRate);
      if (Number.isFinite(r)) rates.push(r);
    }
    if (rates.length < 7) return { ma7dAnnualizedPct: null, sampleCount: rates.length, rawPrints: rates };
    const meanPrint = rates.reduce((s, x) => s + x, 0) / rates.length;
    return { ma7dAnnualizedPct: meanPrint * 3 * 365 * 100, sampleCount: rates.length, rawPrints: rates };
  } catch (error) { logFetchFailure("fetchBinanceFunding7dMA", error); return { ma7dAnnualizedPct: null, sampleCount: 0, rawPrints: [] }; }
}

async function callReadHiro(contractAddress: string, contractName: string, fnName: string, args: string[] = []): Promise<{ result: string | null; raw: unknown }> {
  try {
    const url = `${HIRO_API_BASE}/v2/contracts/call-read/${contractAddress}/${contractName}/${fnName}`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sender: contractAddress, arguments: args }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return { result: null, raw: null };
    const json = await res.json() as { result?: string };
    return { result: typeof json.result === "string" ? json.result : null, raw: json };
  } catch (error) { logFetchFailure(`callReadHiro(${contractAddress}.${contractName}.${fnName})`, error); return { result: null, raw: null }; }
}
// Decode a Clarity-serialized uint from Hiro's /v2/contracts/call-read `result`
// field. Hiro returns Clarity-encoded bytes (type-tag + payload), NOT a raw
// big-endian integer — passing the response through `BigInt("0x...")` directly
// (the prior bug) interprets the type-tag byte as the high byte of the value
// and overshoots the real number by ~2^124.
//
// Wire format handled here:
//   raw uint:        0x01 + 16-byte BE  -> 34 hex chars
//   (response (ok uint) ...):  0x07 + (above)
//   (response (err ...) ...):  0x08 + payload  -> returns null
//   anything else:                              returns null
function decodeClarityUint(hex: string | null): bigint | null {
  if (!hex || typeof hex !== "string") return null;
  let cleaned = hex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleaned)) return null;
  if (cleaned.startsWith("07")) cleaned = cleaned.slice(2); // unwrap (ok ...)
  if (cleaned.startsWith("08")) return null;                // (err ...) -> null
  if (!cleaned.startsWith("01")) return null;               // must be uint
  cleaned = cleaned.slice(2);
  if (cleaned.length !== 32) return null;
  try { return BigInt(`0x${cleaned}`); } catch { return null; }
}

async function fetchHermeticaExchangeRate(): Promise<{ rateRaw: string | null; rateNum: number | null; fetchedAt: string }> {
  const r = await callReadHiro(HERMETICA_DEPLOYER, HERMETICA_STAKING_CONTRACT, HERMETICA_EXCHANGE_RATE_FN);
  const big = decodeClarityUint(r.result);
  return { rateRaw: r.result, rateNum: big !== null ? Number(big) : null, fetchedAt: new Date().toISOString() };
}

async function fetchSusdhTotalSupply(): Promise<{ supplyRaw: string | null; supplyBase: bigint | null; supplyNum: number | null }> {
  // `supplyBase` is the precision-safe bigint path used for self-impact pool-
  // share sizing — sUSDh has 8 decimals, and total supply easily exceeds 2^53
  // atomic units once the protocol grows past ~90M sUSDh. `supplyNum` is the
  // lossy Number conversion retained only for legacy callers that compare
  // ratios where precision below the high bits doesn't bind.
  const r = await callReadHiro(HERMETICA_DEPLOYER, HERMETICA_SUSDH_TOKEN, "get-total-supply");
  const big = decodeClarityUint(r.result);
  return { supplyRaw: r.result, supplyBase: big, supplyNum: big !== null ? Number(big) : null };
}

async function fetchWalletUsdcBalance(
  wallet: string,
  usdcContract: string | null,
  usdcxContract: string | null,
): Promise<{ usdcBase: bigint | null; usdcxBase: bigint | null; raw: unknown }> {
  // Hiro `fungible_tokens` keys have shape `<principal>.<contract-name>::<asset-name>`.
  // Match by exact prefix against the resolved contract-principal from the
  // Bitflow token registry. Falls back to substring matching only when no
  // canonical contract is supplied (early-init paths where Bitflow tokens
  // haven't been fetched yet).
  try {
    const res = await fetch(`${HIRO_API_BASE}/extended/v1/address/${wallet}/balances`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return { usdcBase: null, usdcxBase: null, raw: null };
    const json = await res.json() as { fungible_tokens?: Record<string, { balance?: string }> };
    const tokens = json.fungible_tokens || {};
    let usdc: bigint | null = null, usdcx: bigint | null = null;
    const usdcPrefix = usdcContract ? `${usdcContract}::`.toLowerCase() : null;
    const usdcxPrefix = usdcxContract ? `${usdcxContract}::`.toLowerCase() : null;
    for (const [key, val] of Object.entries(tokens)) {
      const balStr = val?.balance;
      const bal = typeof balStr === "string" && /^\d+$/.test(balStr) ? BigInt(balStr) : null;
      if (bal === null) continue;
      const lower = key.toLowerCase();
      if (usdcxPrefix && lower.startsWith(usdcxPrefix)) usdcx = (usdcx ?? 0n) + bal;
      else if (usdcPrefix && lower.startsWith(usdcPrefix)) usdc = (usdc ?? 0n) + bal;
      else if (!usdcxPrefix && !usdcPrefix) {
        // Pre-token-resolution fallback: substring match, narrowest first.
        if (lower.includes("usdcx")) usdcx = (usdcx ?? 0n) + bal;
        else if (lower.includes("usdc")) usdc = (usdc ?? 0n) + bal;
      }
    }
    return { usdcBase: usdc, usdcxBase: usdcx, raw: json };
  } catch (error) { logFetchFailure("fetchWalletUsdcBalance", error); return { usdcBase: null, usdcxBase: null, raw: null }; }
}

function estimateSusdhApy(history: ExchangeRateHistory, currentRate: number | null): number | null {
  if (currentRate === null || currentRate <= 0 || history.samples.length === 0) return null;
  const cutoffMs = Date.now() - EXCHANGE_RATE_MIN_HISTORY_HOURS * 60 * 60 * 1000;
  const oldest = history.samples.find((s) => new Date(s.ts).getTime() <= cutoffMs);
  if (!oldest || oldest.rateNum <= 0) return null;
  const elapsedHours = (Date.now() - new Date(oldest.ts).getTime()) / (60 * 60 * 1000);
  if (elapsedHours < EXCHANGE_RATE_MIN_HISTORY_HOURS) return null;
  const ratio = currentRate / oldest.rateNum;
  return (Math.pow(ratio, (365 * 24) / elapsedHours) - 1) * 100;
}

function estimateSusdhApy7dAgo(history: ExchangeRateHistory, fallbackRate: number | null): { apy7dAgoPct: number | null; baselineTs: string | null } {
  if (history.samples.length < 2 || fallbackRate === null || fallbackRate <= 0) return { apy7dAgoPct: null, baselineTs: null };
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const baseline = history.samples.find((s) => new Date(s.ts).getTime() <= sevenDaysAgoMs);
  if (!baseline) return { apy7dAgoPct: null, baselineTs: null };
  const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const earlier = history.samples.find((s) => new Date(s.ts).getTime() <= eightDaysAgoMs);
  if (!earlier || earlier.rateNum <= 0) return { apy7dAgoPct: null, baselineTs: null };
  const elapsedHours = (new Date(baseline.ts).getTime() - new Date(earlier.ts).getTime()) / (60 * 60 * 1000);
  if (elapsedHours < 1) return { apy7dAgoPct: null, baselineTs: null };
  const ratio = baseline.rateNum / earlier.rateNum;
  return { apy7dAgoPct: (Math.pow(ratio, (365 * 24) / elapsedHours) - 1) * 100, baselineTs: baseline.ts };
}

// ----- Bitflow Quote Engine: token resolution + quote -----

interface TokenInfo { contract: string; symbol: string; decimals: number; }
async function fetchBitflowTokens(): Promise<TokenInfo[]> {
  // Uses HTTP_TIMEOUT_REGISTRY_MS (20s) rather than the default 5s — the
  // Bitflow `/tokens` registry response is ~100+ tokens and intermittently
  // slow. A 5s timeout silently returned `[]`, which cascaded to null token
  // resolutions in `resolveTokenBySymbol` and a confusing
  // BORROW_TOKEN_UNRESOLVED downstream. On failure we log to stderr so the
  // operator sees the actual root cause rather than a downstream null cascade.
  // The JSON output contract on stdout is unaffected (stderr is separate).
  try {
    const json = await httpJson(`${BITFLOW_QUOTES_BASE}/tokens`, undefined, HTTP_TIMEOUT_REGISTRY_MS);
    const list = Array.isArray(json) ? json : (json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).tokens) ? (json as { tokens: unknown[] }).tokens : []);
    const tokens: TokenInfo[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const contract = typeof obj.contract === "string" ? obj.contract : (typeof obj.contract_address === "string" ? obj.contract_address : (typeof obj.contractId === "string" ? obj.contractId : null));
      const symbol = typeof obj.symbol === "string" ? obj.symbol : (typeof obj.name === "string" ? obj.name : null);
      const decimals = typeof obj.decimals === "number" ? obj.decimals : (typeof obj.decimal === "number" ? obj.decimal : null);
      if (contract && symbol && decimals !== null) tokens.push({ contract, symbol, decimals });
    }
    if (tokens.length === 0) {
      console.error(`[windleg] Bitflow /tokens registry returned 0 valid tokens at ${BITFLOW_QUOTES_BASE}/tokens — registry may be malformed or empty.`);
    }
    return tokens;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[windleg] Bitflow /tokens registry fetch failed (timeout=${HTTP_TIMEOUT_REGISTRY_MS}ms): ${message}. Token resolution will return null and downstream callers may surface BORROW_TOKEN_UNRESOLVED — retry or raise --wait-seconds.`);
    return [];
  }
}
async function resolveTokenBySymbol(symbols: string[]): Promise<Record<string, TokenInfo | null>> {
  const tokens = await fetchBitflowTokens();
  const result: Record<string, TokenInfo | null> = {};
  for (const wanted of symbols) {
    const lower = wanted.toLowerCase();
    const match = tokens.find((t) => t.symbol.toLowerCase() === lower) || tokens.find((t) => t.symbol.toLowerCase().includes(lower));
    result[wanted] = match || null;
  }
  return result;
}

interface QuoteResult {
  amountOut: bigint | null;
  minAmountOut: bigint | null;
  priceImpactBps: number | null;
  fee: string | null;
  routePath: string[] | null;
  inputDecimals: number | null;
  outputDecimals: number | null;
  raw: unknown;
}
async function fetchBitflowQuote(inputContract: string, outputContract: string, amountInAtomic: string, slippagePct = 3.0): Promise<QuoteResult> {
  try {
    const body = { input_token: inputContract, output_token: outputContract, amount_in: amountInAtomic, amm_strategy: "best", slippage_tolerance: slippagePct };
    const json = await httpJson(`${BITFLOW_QUOTES_BASE}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as Record<string, unknown>;
    if (!json || (json.success !== undefined && json.success === false)) return { amountOut: null, minAmountOut: null, priceImpactBps: null, fee: null, routePath: null, inputDecimals: null, outputDecimals: null, raw: json };
    const amountOut = typeof json.amount_out === "string" && /^\d+$/.test(json.amount_out) ? BigInt(json.amount_out) : null;
    const minAmountOut = typeof json.min_amount_out === "string" && /^\d+$/.test(json.min_amount_out) ? BigInt(json.min_amount_out) : null;
    const priceImpactBps = typeof json.price_impact_bps === "number" ? json.price_impact_bps : null;
    const fee = typeof json.fee === "string" ? json.fee : null;
    const routePath = Array.isArray(json.route_path) ? (json.route_path as unknown[]).filter((x): x is string => typeof x === "string") : null;
    const inputDecimals = typeof json.input_token_decimals === "number" ? json.input_token_decimals : null;
    const outputDecimals = typeof json.output_token_decimals === "number" ? json.output_token_decimals : null;
    return { amountOut, minAmountOut, priceImpactBps, fee, routePath, inputDecimals, outputDecimals, raw: json };
  } catch (error) { logFetchFailure("fetchBitflowQuote", error); return { amountOut: null, minAmountOut: null, priceImpactBps: null, fee: null, routePath: null, inputDecimals: null, outputDecimals: null, raw: null }; }
}

async function fetchUsdhPegViaQuoteEngine(usdh: TokenInfo | null, usdcx: TokenInfo | null): Promise<{ priceUsd: number | null; priceImpactBps: number | null; probeSizeAtomic: string | null; raw: unknown }> {
  if (!usdh || !usdcx) return { priceUsd: null, priceImpactBps: null, probeSizeAtomic: null, raw: null };
  const probe = BigInt(10) ** BigInt(usdh.decimals);
  const quote = await fetchBitflowQuote(usdh.contract, usdcx.contract, probe.toString(), 3.0);
  if (quote.amountOut === null) return { priceUsd: null, priceImpactBps: quote.priceImpactBps, probeSizeAtomic: probe.toString(), raw: quote.raw };
  const inDec = quote.inputDecimals ?? usdh.decimals;
  const outDec = quote.outputDecimals ?? usdcx.decimals;
  const numerator = Number(quote.amountOut) / Math.pow(10, outDec);
  const denominator = Number(probe) / Math.pow(10, inDec);
  const priceUsd = denominator > 0 ? numerator / denominator : null;
  return { priceUsd, priceImpactBps: quote.priceImpactBps, probeSizeAtomic: probe.toString(), raw: quote.raw };
}

async function fetchSwapLegSlippageEstimate(usdcLike: TokenInfo | null, usdh: TokenInfo | null, projectedBorrowAtomic: bigint | null): Promise<{ priceImpactBps: number | null; expectedAmountOut: bigint | null; minAmountOut: bigint | null; routePath: string[] | null; raw: unknown }> {
  if (!usdcLike || !usdh || projectedBorrowAtomic === null || projectedBorrowAtomic <= 0n) return { priceImpactBps: null, expectedAmountOut: null, minAmountOut: null, routePath: null, raw: null };
  const quote = await fetchBitflowQuote(usdcLike.contract, usdh.contract, projectedBorrowAtomic.toString(), 3.0);
  return { priceImpactBps: quote.priceImpactBps, expectedAmountOut: quote.amountOut, minAmountOut: quote.minAmountOut, routePath: quote.routePath, raw: quote.raw };
}

async function fetchZestUsdcPoolStats(installed: Primitive[], wallet: string, borrowAsset: string): Promise<{ aprPct: number | null; utilization: number | null; totalSuppliedBase: bigint | null; totalBorrowedBase: bigint | null; raw: JsonMap | null }> {
  const borrow = installed.find((p) => p.name === "zest-borrow-asset-primitive");
  if (!borrow?.entry) return { aprPct: null, utilization: null, totalSuppliedBase: null, totalBorrowedBase: null, raw: null };
  try {
    const result = await runPrimitive(borrow.entry, "status", borrowArgs(wallet, borrowAsset));
    if (result.status !== "success") return { aprPct: null, utilization: null, totalSuppliedBase: null, totalBorrowedBase: null, raw: null };
    const data = (result.data || {}) as JsonMap;
    let aprPct: number | null = null, utilization: number | null = null, totalSuppliedBase: bigint | null = null, totalBorrowedBase: bigint | null = null;
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [k, v] of Object.entries(value)) {
        if (aprPct === null && /borrowApr|borrowRate|borrow_apr|borrow_rate|aprPct|ratePct/i.test(k) && (typeof v === "number" || typeof v === "string")) {
          const n = Number(v);
          if (Number.isFinite(n)) { if (n > 0 && n < 1) aprPct = n * 100; else if (n >= 1 && n <= 100) aprPct = n; }
        }
        if (utilization === null && /utilization|usage/i.test(k) && (typeof v === "number" || typeof v === "string")) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 1) utilization = n;
          else if (Number.isFinite(n) && n > 1 && n <= 100) utilization = n / 100;
        }
        if (totalSuppliedBase === null && /totalSupplied|supplyTotal|reserveSize|totalReserves/i.test(k) && (typeof v === "number" || typeof v === "string")) {
          const s = String(v); if (/^\d+$/.test(s)) totalSuppliedBase = BigInt(s);
        }
        if (totalBorrowedBase === null && /totalBorrowed|borrowTotal|totalDebt/i.test(k) && (typeof v === "number" || typeof v === "string")) {
          const s = String(v); if (/^\d+$/.test(s)) totalBorrowedBase = BigInt(s);
        }
        if (typeof v === "object" && v !== null) walk(v);
      }
    };
    walk(data);
    return { aprPct, utilization, totalSuppliedBase, totalBorrowedBase, raw: data };
  } catch (error) { logFetchFailure("fetchZestUsdcPoolStats", error); return { aprPct: null, utilization: null, totalSuppliedBase: null, totalBorrowedBase: null, raw: null }; }
}

function projectPostBorrowApr(spotAprPct: number | null, currentUtilization: number | null, addedBorrowBase: bigint | null, totalSuppliedBase: bigint | null): { projectedAprPct: number | null; deltaBps: number | null; utilizationAfter: number | null; method: string } {
  if (spotAprPct === null || currentUtilization === null || addedBorrowBase === null || totalSuppliedBase === null || totalSuppliedBase === 0n) {
    return { projectedAprPct: null, deltaBps: null, utilizationAfter: null, method: "insufficient_inputs" };
  }
  const addedNum = Number(addedBorrowBase);
  const supplyNum = Number(totalSuppliedBase);
  if (!Number.isFinite(addedNum) || !Number.isFinite(supplyNum) || supplyNum <= 0) return { projectedAprPct: null, deltaBps: null, utilizationAfter: null, method: "non_finite_inputs" };
  const utilizationAfter = Math.min(1, currentUtilization + addedNum / supplyNum);
  if (currentUtilization <= 0) return { projectedAprPct: spotAprPct, deltaBps: 0, utilizationAfter, method: "zero_utilization_floor" };
  const projectedAprPct = spotAprPct * (utilizationAfter / currentUtilization);
  const deltaBps = Math.round((projectedAprPct - spotAprPct) * 100);
  return { projectedAprPct, deltaBps, utilizationAfter, method: "linear_below_kink_estimate" };
}

// ----- Component scoring -----

function clamp(low: number, high: number, value: number): number { return Math.max(low, Math.min(high, value)); }
function scoreBtcRegime(r7: number | null, r30: number | null): number | null {
  if (r7 === null && r30 === null) return null;
  const s7 = r7 === null ? null : Math.round(clamp(0, 100, ((r7 + 10) / 15) * 100));
  const s30 = r30 === null ? null : Math.round(clamp(0, 100, ((r30 + 25) / 30) * 100));
  if (s7 !== null && s30 !== null) return Math.round(0.6 * s7 + 0.4 * s30);
  return s7 ?? s30;
}
function scoreFunding(annualizedPct: number | null): number | null {
  if (annualizedPct === null) return null;
  if (annualizedPct < 0) return 0;
  if (annualizedPct >= 12) return 100;
  return Math.round((annualizedPct / 12) * 100);
}
function scoreCarry(spreadPct: number | null): number | null {
  if (spreadPct === null) return null;
  if (spreadPct < 0) return 0;
  if (spreadPct >= 10) return 100;
  return Math.round((spreadPct / 10) * 100);
}
function scoreCarryTrend(deltaSpreadPp: number | null): number | null {
  if (deltaSpreadPp === null) return null;
  return Math.round(clamp(0, 100, ((deltaSpreadPp + 2) / 4) * 100));
}
function scoreVol(volPct: number | null): number | null {
  if (volPct === null) return null;
  if (volPct >= 80) return 0;
  if (volPct <= 30) return 100;
  return Math.round(((80 - volPct) / 50) * 100);
}
function scorePeg(pegUsd: number | null): number | null {
  if (pegUsd === null) return null;
  if (pegUsd < 0.995) return 0;
  if (pegUsd >= 0.999 && pegUsd <= 1.001) return 100;
  if (pegUsd < 0.999) return Math.round(((pegUsd - 0.995) / 0.004) * 100);
  if (pegUsd <= 1.005) return Math.round(clamp(0, 100, 100 - ((pegUsd - 1.001) / 0.004) * 100));
  return 0;
}

function composeScore(componentScores: Record<string, number | null>): { composite: number | null; dropped: string[]; usedWeights: Record<string, number> } {
  const present = Object.entries(componentScores).filter(([, v]) => v !== null) as [string, number][];
  const dropped = Object.keys(componentScores).filter((k) => componentScores[k] === null);
  if (present.length === 0) return { composite: null, dropped, usedWeights: {} };
  const presentWeightSum = present.reduce((sum, [k]) => sum + (STRATEGY_WEIGHTS[k] || 0), 0);
  if (presentWeightSum === 0) return { composite: null, dropped, usedWeights: {} };
  const usedWeights: Record<string, number> = {};
  let composite = 0;
  for (const [k, v] of present) {
    const w = STRATEGY_WEIGHTS[k] / presentWeightSum;
    usedWeights[k] = Math.round(w * 1000) / 1000;
    composite += w * v;
  }
  return { composite: Math.round(composite), dropped, usedWeights };
}

// ----- Self-impact bounded sizing -----

function computeSelfImpactBoundedSbtcSats(opts: { sbtcAmountSats: bigint | null; targetLtv: number; btcMedianUsd: number | null; poolShareCapPct: number; zestUsdcPoolTotalBase: bigint | null; susdhTotalSupplyBase: bigint | null; usdcDecimals: number; usdhDecimals: number; susdhDecimals: number; }): JsonMap {
  const { sbtcAmountSats, targetLtv, btcMedianUsd, poolShareCapPct, zestUsdcPoolTotalBase, susdhTotalSupplyBase, usdcDecimals, usdhDecimals, susdhDecimals } = opts;
  if (btcMedianUsd === null || btcMedianUsd <= 0) {
    return { selfImpactBoundedSbtcSats: null, zestUsdcUtilizedShareAfterPct: null, hermeticaSusdhUtilizedShareAfterPct: null, poolShareCapPct, note: "Requires BTC USD median to translate sBTC sats <-> USDC base units." };
  }
  const sbtcUsd = sbtcAmountSats !== null ? (Number(sbtcAmountSats) / 1e8) * btcMedianUsd : null;
  const projectedDebtUsd = sbtcUsd !== null ? sbtcUsd * targetLtv : null;
  const projectedDebtBase = projectedDebtUsd !== null ? BigInt(Math.floor(projectedDebtUsd * Math.pow(10, usdcDecimals))) : null;
  const projectedUsdhBase = projectedDebtBase;
  const projectedSusdhBase = projectedUsdhBase !== null ? BigInt(Math.floor(Number(projectedUsdhBase) * Math.pow(10, susdhDecimals - usdhDecimals))) : null;

  const zestShareAfterPct = projectedDebtBase !== null && zestUsdcPoolTotalBase !== null && zestUsdcPoolTotalBase > 0n ? (Number(projectedDebtBase) / Number(zestUsdcPoolTotalBase)) * 100 : null;
  const susdhShareAfterPct = projectedSusdhBase !== null && susdhTotalSupplyBase !== null && susdhTotalSupplyBase > 0n ? (Number(projectedSusdhBase) / Number(susdhTotalSupplyBase)) * 100 : null;

  let bound: number | null = null;
  if (zestUsdcPoolTotalBase !== null) {
    const zestPoolUsd = Number(zestUsdcPoolTotalBase) / Math.pow(10, usdcDecimals);
    const zestBoundSbtc = (poolShareCapPct / 100) * zestPoolUsd / (btcMedianUsd * targetLtv);
    bound = zestBoundSbtc;
  }
  if (susdhTotalSupplyBase !== null) {
    const susdhPoolUsd = Number(susdhTotalSupplyBase) / Math.pow(10, susdhDecimals);
    const susdhBoundSbtc = (poolShareCapPct / 100) * susdhPoolUsd / (btcMedianUsd * targetLtv);
    bound = bound === null ? susdhBoundSbtc : Math.min(bound, susdhBoundSbtc);
  }
  const selfImpactBoundedSbtcSats = bound !== null && bound > 0 ? Math.floor(bound * 1e8) : null;

  return {
    selfImpactBoundedSbtcSats,
    zestUsdcUtilizedShareAfterPct: zestShareAfterPct,
    hermeticaSusdhUtilizedShareAfterPct: susdhShareAfterPct,
    poolShareCapPct,
    note: "`selfImpactBoundedSbtcSats` is the sBTC size at which my position equals --pool-share-cap-pct of either Zest USDC pool or Hermetica sUSDh supply (whichever is tighter). It is a calculation result from operator-supplied caps, not a recommendation.",
  };
}

// ----- Score assembly -----

interface ComputedScore {
  composite: number | null;
  components: JsonMap;
  prices: JsonMap;
  warnings: string[];
  blockers: string[];
  droppedComponents: string[];
  recommendation: "ENTER" | "HOLD" | "UNWIND" | "NO_OPINION";
  selfImpactSizing: JsonMap;
  walletReserve: JsonMap;
  postBorrowProjection: JsonMap;
  inputs: JsonMap;
}

async function computeScore(opts: SharedOptions, wallet: string): Promise<ComputedScore> {
  const installed = await installedPrimitives();
  const borrowAsset = opts.borrowAsset || DEFAULT_BORROW_ASSET;
  const maxDispersion = Number(opts.maxPriceDispersionPct || DEFAULT_MAX_PRICE_DISPERSION_PCT);
  const poolShareCapPct = parseFloatOrDefault(opts.poolShareCapPct, DEFAULT_POOL_SHARE_CAP_PCT, "--pool-share-cap-pct");
  const emergencyReservePct = parseFloatOrDefault(opts.emergencyReservePct, DEFAULT_EMERGENCY_RESERVE_PCT, "--emergency-reserve-pct");
  const ltv = parseLtvOrThrow(opts.targetLtv);
  const sbtcSats = opts.sbtcAmountSats && /^\d+$/.test(opts.sbtcAmountSats) ? BigInt(opts.sbtcAmountSats) : null;

  const tokens = await resolveTokenBySymbol(["USDh", "USDCx", "USDC", "sUSDh"]);

  const [priceResult, historyResult, fundingInstant, fundingMA, exchangeRate, susdhSupply, walletBal, zestPool] = await Promise.all([
    fetchBtcPriceSamples(),
    fetchBtcHistory30d(),
    fetchBinanceFundingInstant(),
    fetchBinanceFunding7dMA(),
    fetchHermeticaExchangeRate(),
    fetchSusdhTotalSupply(),
    fetchWalletUsdcBalance(wallet, tokens["USDC"]?.contract ?? null, tokens["USDCx"]?.contract ?? null),
    fetchZestUsdcPoolStats(installed, wallet, borrowAsset),
  ]);

  const peg = await fetchUsdhPegViaQuoteEngine(tokens["USDh"], tokens["USDCx"]);

  const samples = priceResult.samples;
  const median = samples.length > 0 ? medianNumber(samples.map((s) => s.priceUsd)) : null;
  const dispersion = dispersionPct(samples.map((s) => s.priceUsd));

  const warnings: string[] = [];
  const blockers: string[] = [];
  if (samples.length === 0) blockers.push("NO_BTC_PRICE_SOURCES_REACHABLE");
  if (dispersion !== null && dispersion > maxDispersion) blockers.push(`PRICE_DISPERSION_TOO_HIGH:${dispersion.toFixed(2)}%>${maxDispersion}%`);

  let updatedHistory: ExchangeRateHistory = await readHistory();
  if (exchangeRate.rateNum !== null && exchangeRate.rateNum > 0) updatedHistory = await appendHistory({ ts: exchangeRate.fetchedAt, rateNum: exchangeRate.rateNum, rateRaw: exchangeRate.rateRaw || "" });

  const susdhApyPctSpot = estimateSusdhApy(updatedHistory, exchangeRate.rateNum);
  if (susdhApyPctSpot === null && exchangeRate.rateNum !== null) warnings.push("SUSDH_APY_COLLECTING_HISTORY");

  const usdcDecimals = tokens["USDC"]?.decimals ?? tokens["USDCx"]?.decimals ?? 6;
  const usdhDecimals = tokens["USDh"]?.decimals ?? 8;
  const susdhDecimals = tokens["sUSDh"]?.decimals ?? 8;
  let projectedDebtBase: bigint | null = null;
  if (sbtcSats !== null && median !== null && median > 0) {
    const sbtcUsd = (Number(sbtcSats) / 1e8) * median;
    const projectedDebtUsd = sbtcUsd * ltv.ltv;
    projectedDebtBase = BigInt(Math.floor(projectedDebtUsd * Math.pow(10, usdcDecimals)));
  }
  const postBorrow = projectPostBorrowApr(zestPool.aprPct, zestPool.utilization, projectedDebtBase, zestPool.totalSuppliedBase);
  const usdcAprPctEffective = postBorrow.projectedAprPct ?? zestPool.aprPct;
  const carrySpreadPct = (susdhApyPctSpot !== null && usdcAprPctEffective !== null) ? susdhApyPctSpot - usdcAprPctEffective : null;
  if (carrySpreadPct !== null && carrySpreadPct < 0) warnings.push("CARRY_INVERTED");

  const apy7dAgo = estimateSusdhApy7dAgo(updatedHistory, exchangeRate.rateNum);
  const deltaSpread7dPp = (susdhApyPctSpot !== null && apy7dAgo.apy7dAgoPct !== null) ? susdhApyPctSpot - apy7dAgo.apy7dAgoPct : null;

  const returns7d = historyResult ? returnPctOver(historyResult.closes, 7) : null;
  const returns30d = historyResult ? returnPctOver(historyResult.closes, 30) : null;
  const realizedVolPct = historyResult ? realizedVolAnnualizedPct(historyResult.closes) : null;

  const instantaneousAlarm = fundingInstant.annualizedPct !== null && fundingInstant.annualizedPct < 0;
  if (instantaneousAlarm) warnings.push("FUNDING_MOMENTUM_ROLLING_OVER");

  const btcRegimeBlocked = blockers.length > 0;
  const componentScores: Record<string, number | null> = {
    btcRegime: btcRegimeBlocked ? null : scoreBtcRegime(returns7d, returns30d),
    funding: scoreFunding(fundingMA.ma7dAnnualizedPct),
    carrySpread: scoreCarry(carrySpreadPct),
    carryTrend: scoreCarryTrend(deltaSpread7dPp),
    realizedVol: scoreVol(realizedVolPct),
    peg: scorePeg(peg.priceUsd),
  };
  const composed = composeScore(componentScores);

  const components: JsonMap = {
    btcRegime: { score: componentScores.btcRegime, weight: STRATEGY_WEIGHTS.btcRegime, usedWeight: composed.usedWeights.btcRegime ?? null, input: { medianUsd: median, return7dPct: returns7d, return30dPct: returns30d } },
    funding: { score: componentScores.funding, weight: STRATEGY_WEIGHTS.funding, usedWeight: composed.usedWeights.funding ?? null, input: { binance8hPct: fundingInstant.last8hPct, annualizedPctInstant: fundingInstant.annualizedPct, ma7dAnnualizedPct: fundingMA.ma7dAnnualizedPct, ma7dSampleCount: fundingMA.sampleCount, instantaneousAlarm } },
    carrySpread: { score: componentScores.carrySpread, weight: STRATEGY_WEIGHTS.carrySpread, usedWeight: composed.usedWeights.carrySpread ?? null, input: { susdhApyPct: susdhApyPctSpot, usdcBorrowAprPctSpot: zestPool.aprPct, usdcBorrowAprPctProjected: postBorrow.projectedAprPct, spreadPct: carrySpreadPct, selfImpactBps: postBorrow.deltaBps, projectionMethod: postBorrow.method } },
    carryTrend: { score: componentScores.carryTrend, weight: STRATEGY_WEIGHTS.carryTrend, usedWeight: composed.usedWeights.carryTrend ?? null, input: { susdhApyPctSpot, susdhApyPct7dAgo: apy7dAgo.apy7dAgoPct, deltaSpread7dPp, baselineTs: apy7dAgo.baselineTs } },
    realizedVol: { score: componentScores.realizedVol, weight: STRATEGY_WEIGHTS.realizedVol, usedWeight: composed.usedWeights.realizedVol ?? null, input: { vol30dAnnualizedPct: realizedVolPct } },
    peg: { score: componentScores.peg, weight: STRATEGY_WEIGHTS.peg, usedWeight: composed.usedWeights.peg ?? null, input: { usdhAmmPriceUsd: peg.priceUsd, priceImpactBps: peg.priceImpactBps, probeSizeAtomic: peg.probeSizeAtomic } },
  };

  const prices: JsonMap = { medianUsd: median, dispersionPct: dispersion, samples: samples as unknown as Json, failures: priceResult.failures as unknown as Json };

  const selfImpactSizing = computeSelfImpactBoundedSbtcSats({ sbtcAmountSats: sbtcSats, targetLtv: ltv.ltv, btcMedianUsd: median, poolShareCapPct, zestUsdcPoolTotalBase: zestPool.totalSuppliedBase, susdhTotalSupplyBase: susdhSupply.supplyBase, usdcDecimals, usdhDecimals, susdhDecimals });

  const observedUsdcBase = (walletBal.usdcBase ?? 0n) + (walletBal.usdcxBase ?? 0n);
  let observedReservePct: number | null = null;
  let reserveWarning: string | null = null;
  if (projectedDebtBase !== null && projectedDebtBase > 0n) {
    observedReservePct = (Number(observedUsdcBase) / Number(projectedDebtBase)) * 100;
    if (observedReservePct < emergencyReservePct) {
      reserveWarning = "RESERVE_BELOW_THRESHOLD";
      warnings.push(reserveWarning);
    }
  }
  const walletReserve: JsonMap = {
    walletUsdcReserveBase: observedUsdcBase.toString(),
    projectedDebtBase: projectedDebtBase !== null ? projectedDebtBase.toString() : null,
    requiredReservePct: emergencyReservePct,
    observedReservePct,
    warning: reserveWarning,
    note: "Soft warn only — the strategy never refuses entry on this signal. The 7-day Hermetica cooldown means an external USDC reserve is the only way to pay down debt before liquidation if BTC drops during the cooldown.",
  };

  const minScore = parseScoreThreshold(opts.minScore, DEFAULT_MIN_SCORE);
  const exitBelow = parseScoreThreshold(opts.exitScoreBelow, DEFAULT_EXIT_SCORE_BELOW);
  let recommendation: ComputedScore["recommendation"];
  if (blockers.length > 0 || composed.composite === null) recommendation = "NO_OPINION";
  else if (composed.composite < exitBelow) recommendation = "UNWIND";
  else if (composed.composite >= minScore) recommendation = "ENTER";
  else recommendation = "HOLD";

  return {
    composite: composed.composite,
    components,
    prices,
    warnings,
    blockers,
    droppedComponents: composed.dropped,
    recommendation,
    selfImpactSizing,
    walletReserve,
    postBorrowProjection: { method: postBorrow.method, utilizationAfter: postBorrow.utilizationAfter, projectedAprPct: postBorrow.projectedAprPct, deltaBps: postBorrow.deltaBps, spotAprPct: zestPool.aprPct, currentUtilization: zestPool.utilization, totalSuppliedBase: zestPool.totalSuppliedBase !== null ? zestPool.totalSuppliedBase.toString() : null },
    inputs: { minScoreThreshold: minScore, exitScoreBelowThreshold: exitBelow, maxPriceDispersionPct: maxDispersion, poolShareCapPct, emergencyReservePct, borrowAsset, targetLtv: ltv.ltv, historySamplesUsed: updatedHistory.samples.length, tokenResolution: tokens as unknown as Json },
  };
}

// =========================================================================
// === Commands
// =========================================================================

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const installed = await installedPrimitives();
    const all = installed;
    const checkpoint = await readCheckpoint(wallet);
    const readiness = await primitiveReadiness(installed, wallet);
    const actionLog = await readActionLog(wallet);
    const lastAuto = lastAutoActionMs(actionLog);
    const priceProbe = await fetchBtcPriceSamples();
    const tokens = await resolveTokenBySymbol(["USDh", "USDCx", "USDC"]);
    const data: JsonMap = {
      dependencies: all as unknown as Json,
      missing: missingPrimitives(all) as unknown as Json,
      checkpoint: checkpoint as unknown as Json,
      installedPrimitiveDoctor: readiness,
      strategyReadiness: { btcPriceSourcesReachable: priceProbe.samples.length, btcPriceFailures: priceProbe.failures as unknown as Json, bitflowTokenResolution: tokens as unknown as Json },
      autonomousActions: { lastAutoActionAt: lastAuto ? new Date(lastAuto).toISOString() : null, rateLimitWindowMs: AUTONOMOUS_RATE_LIMIT_MS },
    };
    if (missingPrimitives(installed).length > 0) { blocked("doctor", "MISSING_PRIMITIVE_DEPENDENCIES", "One or more installed-side primitives are missing.", "Install the listed primitives before composing.", data); return; }
    success("doctor", data);
  } catch (error) { fail("doctor", error); }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const installed = await installedPrimitives();
    const all = installed;
    const checkpoint = await readCheckpoint(wallet);
    const borrowAsset = opts.borrowAsset || DEFAULT_BORROW_ASSET;
    const data: JsonMap = { dependencies: all as unknown as Json, missing: missingPrimitives(all) as unknown as Json, checkpoint: checkpoint as unknown as Json };
    if (missingPrimitives(installed).length === 0) {
      const borrow = primitiveByName(installed, "zest-borrow-asset-primitive");
      data.primitiveStatus = { borrow: (await runPrimitive(borrow.entry!, "status", borrowArgs(wallet, borrowAsset))) as unknown as Json };
    }
    success("status", data);
  } catch (error) { fail("status", error); }
}

async function runScore(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const score = await computeScore(opts, wallet);
    success("score", {
      composite: score.composite,
      recommendation: score.recommendation,
      components: score.components,
      selfImpactSizing: score.selfImpactSizing,
      walletReserve: score.walletReserve,
      postBorrowProjection: score.postBorrowProjection,
      prices: score.prices,
      warnings: score.warnings as unknown as Json,
      blockers: score.blockers as unknown as Json,
      droppedComponents: score.droppedComponents as unknown as Json,
      inputs: score.inputs,
    });
  } catch (error) { fail("score", error); }
}

async function runPlan(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const sbtcAmount = ensureSbtcAmount(opts.sbtcAmountSats);
    const ltv = parseLtvOrThrow(opts.targetLtv);
    const borrowAsset = opts.borrowAsset || DEFAULT_BORROW_ASSET;
    const installed = await installedPrimitives();
    ensureInstalled(installed);
    const existing = await readCheckpoint(wallet);
    if (isUnresolved(existing)) throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous rotation checkpoint is unresolved.", "Run resume or cancel before planning a new rotation.", { checkpoint: existing as unknown as Json });
    const supply = primitiveByName(installed, "zest-asset-deposit-primitive");
    const borrow = primitiveByName(installed, "zest-borrow-asset-primitive");
    const supplyPlan = await runPrimitive(supply.entry!, "plan", [...supplyArgs(wallet, sbtcAmount), ...gasReserveArg(opts)]);
    const borrowPlan = await runPrimitive(borrow.entry!, "plan", [...borrowArgs(wallet, borrowAsset), ...gasReserveArg(opts)]);
    const tokens = await resolveTokenBySymbol(["USDh", "USDCx", "USDC", borrowAsset]);
    const usdcLike = tokens[borrowAsset] || tokens["USDCx"] || tokens["USDC"];
    const score = await computeScore(opts, wallet);
    const projectedDebtBase = (score.walletReserve as { projectedDebtBase?: string | null }).projectedDebtBase ?? null;
    const swapEstimate = projectedDebtBase ? await fetchSwapLegSlippageEstimate(usdcLike, tokens["USDh"], BigInt(projectedDebtBase)) : null;
    success("plan", {
      route: "supply-sbtc -> borrow-stable -> swap-to-usdh -> stake-usdh",
      params: { sbtcAmountSats: sbtcAmount, targetLtv: ltv.ltv, targetLtvBps: ltv.bps, targetLtvWarning: ltv.warn ? `target LTV ${ltv.ltv} exceeds the soft-warn threshold ${WARN_TARGET_LTV}` : null, borrowAsset },
      dependencies: installed as unknown as Json,
      strategy: score as unknown as Json,
      swapSlippageEstimate: swapEstimate as unknown as Json,
      steps: [
        { step: "supply", primitive: supply.name, result: supplyPlan as unknown as Json },
        { step: "borrow", primitive: borrow.name, result: borrowPlan as unknown as Json },
        { step: "swap", primitive: "bitflow-swap-aggregator", result: { deferred: true, reason: "Executed at run-time once borrow primitive reports the actual received stablecoin amount. Quote-engine slippage estimate above projects expected output and price impact at projected size." } },
        { step: "stake", primitive: "inline", installed: true, result: { deferred: true, reason: "Inline staking-v1-1.stake call broadcasts at run-time once swap confirms; signer resolved via AIBTC_SESSION_FILE -> STACKS_PRIVATE_KEY -> CLIENT_MNEMONIC, matching the bff-skills primitives' resolver chain." } },
      ],
    });
  } catch (error) { fail("plan", error); }
}

async function applyEntryScoreGate(opts: SharedOptions, wallet: string, action: string): Promise<ComputedScore | null> {
  const minScore = parseScoreThreshold(opts.minScore, DEFAULT_MIN_SCORE);
  if (minScore === 0) return null;
  const score = await computeScore(opts, wallet);
  if (score.blockers.length > 0) throw new BlockedError("STRATEGY_BLOCKERS_PRESENT", `Strategy blockers prevent ${action}: ${score.blockers.join(", ")}`, "Wait for the next polling interval or set --min-score 0 to bypass the gate.", { score: score as unknown as Json });
  if (score.composite === null || score.composite < minScore) throw new BlockedError("STRATEGY_SCORE_TOO_LOW", `Composite score ${score.composite ?? "null"} is below --min-score ${minScore}.`, "Wait for conditions to improve or set --min-score 0 to bypass.", { score: score as unknown as Json });
  return score;
}

function extractZestCollateralAmount(statusResult: PrimitiveResult): bigint | null {
  // zest-borrow-asset-primitive `status` emits `data.assets.collateral.amount`
  // as a stringified bigint (see its `success("status", ...)`).
  const data = (statusResult.data || {}) as JsonMap;
  const assets = data.assets as JsonMap | undefined;
  const collateral = assets?.collateral as JsonMap | undefined;
  const amount = collateral?.amount;
  if (typeof amount === "string" && /^\d+$/.test(amount)) return BigInt(amount);
  if (typeof amount === "number" && Number.isInteger(amount) && amount >= 0) return BigInt(amount);
  return null;
}

function computeBorrowAtomic(collateralSats: bigint, btcMedianUsd: number, targetLtv: number, borrowDecimals: number): bigint {
  // Bound: collateralSats <= 2.1e15 (21M BTC in sats) << Number.MAX_SAFE_INTEGER.
  // At reasonable sBTC sizes this conversion is precision-safe; at extreme
  // sizes the Number path would lose precision but Zest would refuse the
  // supply long before we hit it. Floor to atomic units.
  const sbtcUsd = (Number(collateralSats) / 1e8) * btcMedianUsd;
  const borrowUsd = sbtcUsd * targetLtv;
  if (!Number.isFinite(borrowUsd) || borrowUsd <= 0) return 0n;
  return BigInt(Math.floor(borrowUsd * Math.pow(10, borrowDecimals)));
}

interface ContinueContext {
  btcMedianUsd: number;
  borrowToken: TokenInfo;
  usdhToken: TokenInfo;
  targetLtv: number;
  borrowAssetSymbol: string;
}

async function resolveContinueContext(opts: SharedOptions, wallet: string): Promise<ContinueContext> {
  const ltv = parseLtvOrThrow(opts.targetLtv);
  const borrowAssetSymbol = opts.borrowAsset || DEFAULT_BORROW_ASSET;
  const tokens = await resolveTokenBySymbol(["USDh", borrowAssetSymbol]);
  const borrowToken = tokens[borrowAssetSymbol];
  if (!borrowToken) throw new BlockedError("BORROW_TOKEN_UNRESOLVED", `Bitflow registry did not resolve ${borrowAssetSymbol}.`, "Check Bitflow API connectivity and the spelling of --borrow-asset.");
  const usdhToken = tokens["USDh"];
  if (!usdhToken) throw new BlockedError("USDH_TOKEN_UNRESOLVED", "Bitflow registry did not resolve USDh.", "Check Bitflow API connectivity.");
  const priceSamples = await fetchBtcPriceSamples();
  const btcMedianUsd = medianNumber(priceSamples.samples.map((s) => s.priceUsd));
  if (btcMedianUsd === null || btcMedianUsd <= 0) throw new BlockedError("NO_BTC_PRICE", "Cannot size the borrow leg without a BTC USD median.", "Wait for at least one BTC price source to be reachable, then retry.", { priceFailures: priceSamples.failures });
  return { btcMedianUsd, borrowToken, usdhToken, targetLtv: ltv.ltv, borrowAssetSymbol };
}

async function continueForward(checkpoint: Checkpoint, opts: RunOptions, installed: Primitive[], ctx?: ContinueContext): Promise<Checkpoint> {
  const wallet = checkpoint.wallet;
  let current = checkpoint;
  const context = ctx ?? await resolveContinueContext(opts, wallet);

  // Leg 2: size + borrow.
  if (current.step === "supply_confirmed") {
    const borrow = primitiveByName(installed, "zest-borrow-asset-primitive");
    const statusResult = await runPrimitive(borrow.entry!, "status", borrowArgs(wallet, context.borrowAssetSymbol));
    requirePrimitiveSuccess(borrow.name, statusResult);
    const collateralSats = extractZestCollateralAmount(statusResult);
    if (collateralSats === null || collateralSats <= 0n) {
      throw new BlockedError("ZERO_COLLATERAL_AFTER_SUPPLY", "Zest reports zero sBTC collateral after the supply leg.", "Inspect the supply tx and the wallet's Zest position before resuming.", { statusResult });
    }
    const borrowAtomic = computeBorrowAtomic(collateralSats, context.btcMedianUsd, context.targetLtv, context.borrowToken.decimals);
    if (borrowAtomic <= 0n) throw new BlockedError("BORROW_SIZE_ZERO", "Computed borrow amount is zero — sBTC USD value too small for the target LTV.", "Increase --sbtc-amount-sats or --target-ltv.");
    // Leg 2: inline Zest V2 borrow — fetches Pyth update bytes, broadcasts
    // v0-4-market.borrow(usdcx, amount, some wallet, some [pyth]).
    const borrowTxid = await inlineBorrow(wallet, borrowAtomic);
    if (!borrowTxid) throw new BlockedError("BORROW_BROADCAST_NULL", "Borrow broadcast returned null txid.", "Inspect signer + Zest market state before retrying.");
    const borrowConfirm = await waitForTxConfirmation(borrowTxid, parseWaitSeconds(opts));
    requireTxSuccess("borrow", borrowTxid, borrowConfirm);
    current = await writeCheckpoint({
      ...current,
      step: "borrow_confirmed",
      borrowTxid,
      borrowedAmountBase: borrowAtomic.toString(),
      borrowedAsset: context.borrowAssetSymbol,
    });
  }

  // Leg 3: inline Bitflow DLMM swap — USDCx → USDh via swap-y-for-x.
  if (current.step === "borrow_confirmed") {
    const amount = current.borrowedAmountBase;
    if (!amount || BigInt(amount) <= 0n) throw new BlockedError("MISSING_SWAP_INPUT", "Checkpoint does not carry a positive borrowed amount.", "Cancel or repair the checkpoint before resuming.", { checkpoint: current });
    const slippageBps = Number(opts.slippageBps || DEFAULT_SLIPPAGE_BPS);
    const preSwapUsdh = (await fetchWalletUsdhBalance(wallet)) ?? 0n;
    const swapTxid = await inlineSwap(wallet, BigInt(amount), slippageBps);
    if (!swapTxid) throw new BlockedError("SWAP_BROADCAST_NULL", "Swap broadcast returned null txid.", "Inspect signer + Bitflow router state before retrying.");
    const swapConfirm = await waitForTxConfirmation(swapTxid, parseWaitSeconds(opts));
    requireTxSuccess("swap", swapTxid, swapConfirm);
    // Derive observed USDh from wallet balance delta — the DLMM router does
    // not emit a caller-friendly observed-out in tx_result.
    const postSwapUsdh = (await fetchWalletUsdhBalance(wallet)) ?? 0n;
    const observedUsdhBase = postSwapUsdh - preSwapUsdh;
    if (observedUsdhBase <= 0n) throw new BlockedError("SWAP_OUTPUT_UNKNOWN", "Post-swap wallet USDh balance did not increase.", "Inspect the swap tx on Hiro and verify the router routed through a USDh-output venue.", { preSwapUsdh: preSwapUsdh.toString(), postSwapUsdh: postSwapUsdh.toString(), swapTxid });
    current = await writeCheckpoint({ ...current, step: "swap_confirmed", swapTxid, swapOutUsdhBase: observedUsdhBase.toString() });
  }

  // Leg 4: inline stake.
  if (current.step === "swap_confirmed") {
    const usdhAmount = current.swapOutUsdhBase;
    if (!usdhAmount || BigInt(usdhAmount) <= 0n) throw new BlockedError("MISSING_STAKE_INPUT", "Checkpoint does not carry a positive observed USDh amount.", "Cancel or repair the checkpoint before resuming.", { checkpoint: current });
    const stakeTxid = await inlineStake(wallet, BigInt(usdhAmount));
    current = await writeCheckpoint({ ...current, step: "complete", stakeTxid: stakeTxid || undefined });
  }
  return current;
}

async function runForward(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN_ROTATE) throw new BlockedError("CONFIRMATION_REQUIRED", "This composed write skill requires explicit confirmation.", `Re-run with --confirm=${CONFIRM_TOKEN_ROTATE}.`);
    const wallet = ensureWallet(opts.wallet);
    const sbtcAmount = ensureSbtcAmount(opts.sbtcAmountSats);
    const ltv = parseLtvOrThrow(opts.targetLtv);
    const installed = await installedPrimitives();
    ensureInstalled(installed);
    const existing = await readCheckpoint(wallet);
    if (isUnresolved(existing)) throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous rotation checkpoint is unresolved.", "Run resume or cancel before starting a new rotation.", { checkpoint: existing });
    const gateScore = await applyEntryScoreGate(opts, wallet, "run");

    // Reuse the strategy-derived BTC median for borrow sizing. If the gate
    // bypassed scoring (--min-score=0), re-fetch a fresh sample.
    const ctx = await resolveContinueContext(opts, wallet);

    let checkpoint = await writeCheckpoint(newCheckpoint(wallet, sbtcAmount, ltv.bps));
    // Leg 1: inline Zest V2 supply-collateral-add — sBTC → Zest collateral.
    const supplyTxid = await inlineSupply(wallet, BigInt(sbtcAmount));
    if (!supplyTxid) throw new BlockedError("SUPPLY_BROADCAST_NULL", "Supply broadcast returned null txid.", "Inspect signer + Zest market state before retrying.");
    const supplyConfirm = await waitForTxConfirmation(supplyTxid, parseWaitSeconds(opts));
    requireTxSuccess("supply", supplyTxid, supplyConfirm);
    checkpoint = await writeCheckpoint({ ...checkpoint, step: "supply_confirmed", supplyTxid });

    // Continue with borrow + swap + stake. If any leg blocks, the checkpoint
    // captures the partial state and `resume` can pick up where it left off.
    const completed = await continueForward(checkpoint, opts, installed, ctx);
    success("run", {
      checkpoint: completed,
      gateScore,
      dependencies: installed,
      note: completed.step === "complete"
        ? "Full 4-leg rotation broadcast and confirmed."
        : `Rotation paused at ${completed.step}. Run \`resume --wallet ${wallet} --confirm=${CONFIRM_TOKEN_ROTATE}\` to continue.`,
    });
  } catch (error) { fail("run", error); }
}

async function runResume(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN_ROTATE) throw new BlockedError("CONFIRMATION_REQUIRED", "Resume can continue writes and requires explicit confirmation.", `Re-run with --confirm=${CONFIRM_TOKEN_ROTATE}.`);
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !isUnresolved(checkpoint)) throw new BlockedError("NO_RESUMABLE_STATE", "No unresolved rotation state exists for this wallet.", "Run plan/run for a new rotation if appropriate.", { checkpoint });
    if (!["supply_confirmed", "borrow_confirmed", "swap_confirmed"].includes(checkpoint.step)) throw new BlockedError("UNSUPPORTED_RESUME_STEP", `Cannot resume forward path automatically from ${checkpoint.step}.`, "Use the partner unwinder skill for staked states, or cancel/repair the checkpoint.", { checkpoint });
    const installed = await installedPrimitives();
    ensureInstalled(installed);
    const completed = await continueForward(checkpoint, opts, installed);
    success("resume", { checkpoint: completed, dependencies: installed });
  } catch (error) { fail("resume", error); }
}

async function runCancel(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !isUnresolved(checkpoint)) throw new BlockedError("NO_ACTIVE_CYCLE", "No unresolved rotation state exists for this wallet.", "No cancel action is needed.", { checkpoint: checkpoint as unknown as Json });
    const cancelled = await writeCheckpoint({ ...checkpoint, step: "operator_cancelled", abortReason: "operator_cancelled", nextRequiredAction: "Review on-chain Zest/Hermetica position before starting another rotation. Cancel only clears the local checkpoint." });
    success("cancel", { checkpoint: cancelled as unknown as Json });
  } catch (error) { fail("cancel", error); }
}


// =========================================================================
// === Inline Hermetica stake (verified against on-chain Clarity bytecode)
// =========================================================================
//
// Verified at block 3567258 via Hiro /v2/contracts/source:
//   SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-v1-1
//   (define-public (stake (amount uint) (affiliate (optional (buff 64)))))
//   USDh + sUSDh both 8 decimals. Cooldown 7d (u604800 sec).
//   Reverts on amount=0, staking-disabled, blacklisted-caller, hq-disabled.

async function checkHermeticaStakingEnabled(): Promise<boolean | null> {
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const url = `${HIRO_API_BASE}/v2/contracts/call-read/${HERMETICA_DEPLOYER}/staking-state-v1/get-staking-enabled`;
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: HERMETICA_DEPLOYER, arguments: [] }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt] || 30000));
        continue;
      }
      break;
    } catch (error) {
      lastErr = error;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, [5000, 15000, 30000][attempt] || 30000));
        continue;
      }
    }
  }
  try {
    if (!res || !res.ok) { if (lastErr) logFetchFailure("checkHermeticaStakingEnabled", lastErr); return null; }
    const json = await res.json() as { result?: string; okay?: boolean };
    if (!json.okay || typeof json.result !== "string") return null;
    // Clarity wire format (stacks-blockchain/clarity/src/vm/types/serialization.rs):
    //   ClarityType.BoolTrue  = 0x03
    //   ClarityType.BoolFalse = 0x04
    // The deployed `check-is-staking-enabled` returns a raw bool (not wrapped in
    // a response), so we expect exactly one of these two bytes.
    if (json.result === "0x03") return true;
    if (json.result === "0x04") return false;
    return null;
  } catch (error) { logFetchFailure("checkHermeticaStakingEnabled", error); return null; }
}

async function fetchWalletUsdhBalance(wallet: string): Promise<bigint | null> {
  try {
    const balUrl = `${HIRO_API_BASE}/extended/v1/address/${wallet}/balances`;
    const res = await fetch(balUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json() as { fungible_tokens?: Record<string, { balance?: string }> };
    const tokens = json.fungible_tokens || {};
    const key = `${HERMETICA_DEPLOYER}.usdh-token-v1::usdh`;
    const entry = tokens[key];
    if (!entry?.balance || !/^\d+$/.test(entry.balance)) return null;
    return BigInt(entry.balance);
  } catch (error) { logFetchFailure("fetchWalletUsdhBalance", error); return null; }
}


// Signer resolution for the inline Hermetica stake leg.
//
// Order matches the bff-skills primitives (zest-asset-deposit-primitive,
// zest-borrow-asset-primitive, bitflow-swap-aggregator), so a wallet that signs
// for the supply/borrow/swap legs signs for the stake leg too without extra
// configuration.
//
//   1. AIBTC_SESSION_FILE — encrypted session at `~/.aibtc/sessions/<wallet-id>.json`
//      written by `wallet unlock`, decrypted with the matching session key.
//   2. STACKS_PRIVATE_KEY — raw hex private key in env (smoke-testing).
//   3. CLIENT_MNEMONIC — 12/24-word mnemonic in env, derived via
//      `@stacks/wallet-sdk`. Retained for the original PR test env.
//
// Throws BlockedError("SIGNER_UNAVAILABLE", ...) when no path yields a key
// matching `expectedWallet`.
interface AibtcSessionFile {
  version?: number;
  expiresAt?: string;
  encrypted?: { iv: string; authTag: string; ciphertext: string };
}
function aibtcDir(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}
async function decryptAibtcSession(walletId: string): Promise<{ privateKey: string; address: string } | null> {
  try {
    const sessionRaw = await fs.readFile(aibtcDir("sessions", `${path.basename(walletId)}.json`), "utf8");
    const session = JSON.parse(sessionRaw) as AibtcSessionFile;
    if (session.version !== 1 || !session.encrypted) return null;
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) return null;
    const sessionKey = await fs.readFile(aibtcDir("sessions", ".session-key")).catch(() => null);
    if (!sessionKey || sessionKey.length !== 32) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as { privateKey?: string; address?: string };
    if (typeof parsed.privateKey === "string" && typeof parsed.address === "string") return { privateKey: parsed.privateKey, address: parsed.address };
    return null;
  } catch {
    return null;
  }
}
async function deriveFromMnemonic(mnemonic: string): Promise<string | null> {
  const trimmed = mnemonic.trim();
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 12 || wordCount > 24) return null;
  try {
    const sdk = await import("@stacks/wallet-sdk") as {
      generateWallet: (opts: { secretKey: string; password: string }) => Promise<{ accounts: Array<{ stxPrivateKey?: string }> }>;
    };
    const wallet = await sdk.generateWallet({ secretKey: trimmed, password: "" });
    return wallet.accounts[0]?.stxPrivateKey ?? null;
  } catch {
    return null;
  }
}
async function resolveStakeSigner(expectedWallet: string): Promise<{ privateKey: string; source: string }> {
  const attempts: string[] = [];

  // 1. AIBTC_SESSION_FILE.
  try {
    const configRaw = await fs.readFile(aibtcDir("config.json"), "utf8").catch(() => null);
    const config = configRaw ? JSON.parse(configRaw) as { activeWalletId?: string } : null;
    const walletId = process.env.AIBTC_WALLET_ID || config?.activeWalletId;
    if (walletId) {
      const account = await decryptAibtcSession(walletId);
      if (account) {
        if (account.address === expectedWallet) return { privateKey: account.privateKey, source: "AIBTC_SESSION_FILE" };
        attempts.push(`AIBTC_SESSION_FILE: session resolves to ${account.address}, expected ${expectedWallet}`);
      } else {
        attempts.push("AIBTC_SESSION_FILE: no active unexpired session");
      }
    } else {
      attempts.push("AIBTC_SESSION_FILE: no active wallet id");
    }
  } catch (error) {
    attempts.push(`AIBTC_SESSION_FILE: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. STACKS_PRIVATE_KEY.
  const rawKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (rawKey) {
    try {
      const stx = await import("@stacks/transactions") as { getAddressFromPrivateKey: (key: string, net: "mainnet" | "testnet") => string };
      const address = stx.getAddressFromPrivateKey(rawKey, "mainnet");
      if (address === expectedWallet) return { privateKey: rawKey, source: "STACKS_PRIVATE_KEY" };
      attempts.push(`STACKS_PRIVATE_KEY: key resolves to ${address}, expected ${expectedWallet}`);
    } catch (error) {
      attempts.push(`STACKS_PRIVATE_KEY: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("STACKS_PRIVATE_KEY: not set");
  }

  // 3. CLIENT_MNEMONIC (retained for original PR test env compatibility).
  const mnemonic = process.env.CLIENT_MNEMONIC;
  if (mnemonic) {
    const derived = await deriveFromMnemonic(mnemonic);
    if (derived) {
      try {
        const stx = await import("@stacks/transactions") as { getAddressFromPrivateKey: (key: string, net: "mainnet" | "testnet") => string };
        const address = stx.getAddressFromPrivateKey(derived, "mainnet");
        if (address === expectedWallet) return { privateKey: derived, source: "CLIENT_MNEMONIC" };
        attempts.push(`CLIENT_MNEMONIC: derived key resolves to ${address}, expected ${expectedWallet}`);
      } catch (error) {
        attempts.push(`CLIENT_MNEMONIC: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      attempts.push("CLIENT_MNEMONIC: derivation failed (check word count + sdk install)");
    }
  } else {
    attempts.push("CLIENT_MNEMONIC: not set");
  }

  throw new BlockedError(
    "SIGNER_UNAVAILABLE",
    `No signer available for ${expectedWallet}. Attempts: ${attempts.join("; ")}`,
    "Set AIBTC_SESSION_FILE (`wallet unlock`), STACKS_PRIVATE_KEY, or CLIENT_MNEMONIC to a value that resolves to the wallet that owns USDh."
  );
}

// =========================================================================
// === Hiro tx confirmation polling (used between inline broadcasts)
// =========================================================================
// Poll Hiro /extended/v1/tx/{txid} until the tx settles (success or terminal
// failure) or the wait window elapses. Used between back-to-back inline
// broadcasts so each leg's nonce is fully consumed (mined) before the next
// leg fetches its own nonce — avoids ConflictingNonceInMempool rejections
// when the controller fires multiple txs from the same wallet in a single
// run/resume call. Mirrors the pattern in
// skills/unwindleg-hermeticaunstake-zestrepay-yield-rotator-sUSDh-USDCx-sBTC.

async function waitForTxConfirmation(txid: string, waitSeconds: number): Promise<{ status: string; raw: JsonMap | null }> {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastStatus = "not_indexed";
  let lastRaw: JsonMap | null = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HIRO_API_BASE}/extended/v1/tx/${txid}`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const json = await res.json() as JsonMap;
        lastRaw = json;
        lastStatus = String(json.tx_status ?? "not_indexed");
        if (lastStatus === "success") return { status: lastStatus, raw: lastRaw };
        if (lastStatus.startsWith("abort") || lastStatus === "failed") return { status: lastStatus, raw: lastRaw };
      }
    } catch { /* transient — retry on the next iteration */ }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return { status: lastStatus, raw: lastRaw };
}

function requireTxSuccess(legName: string, txid: string, confirmation: { status: string; raw: JsonMap | null }): void {
  if (confirmation.status === "success") return;
  throw new BlockedError(
    "TX_NOT_SUCCESSFUL",
    `${legName} tx ${txid} did not confirm successfully within --wait-seconds: tx_status=${confirmation.status}.`,
    `Inspect ${txid} on the explorer. If the tx is still pending, increase --wait-seconds and re-run resume. If it aborted, address the underlying revert before retrying.`,
    { leg: legName, txid, status: confirmation.status, raw: confirmation.raw as Json },
  );
}

function parseWaitSeconds(opts: { waitSeconds?: string }): number {
  const raw = opts.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new BlockedError("INVALID_WAIT_SECONDS", `--wait-seconds must be a positive number; got ${raw}`, "Pass a positive integer for --wait-seconds.");
  return parsed;
}

// =========================================================================
// === Pyth Hermes price-feed bytes (used by inline Zest borrow leg)
// =========================================================================
// Zest V2 borrow path consumes (optional (list 3 (buff 8192))) price-feed
// updates; pass `none` to fall back to the protocol's last-known-good prices
// or fetch live update bytes from Pyth Hermes for the collateral + borrow
// asset feeds. Mirrors fetchPythPriceFeedBytes from
// skills/zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts.

const PYTH_HERMES_API = "https://hermes.pyth.network";

const PYTH_FEEDS: Record<string, string> = {
  sBTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  STX: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  USDC: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDCx: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

async function fetchPythPriceFeedBytes(assetSymbols: string[]): Promise<{ bytes: Buffer; feeds: string[] }> {
  const feeds = [...new Set(assetSymbols.map((s) => PYTH_FEEDS[s]).filter(Boolean))];
  if (feeds.length === 0) return { bytes: Buffer.alloc(0), feeds };
  const params = new URLSearchParams();
  params.set("encoding", "hex");
  for (const feed of feeds) params.append("ids[]", feed);
  const res = await fetch(`${PYTH_HERMES_API}/v2/updates/price/latest?${params.toString()}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new BlockedError("PYTH_UPDATE_FETCH_FAILED", `Pyth Hermes returned HTTP ${res.status} for feeds ${feeds.join(",")}.`, "Wait for Pyth Hermes to recover and retry the borrow leg.");
  const payload = await res.json() as { binary?: { encoding?: string; data?: string[] } };
  const hex = payload.binary?.data?.[0];
  if (!hex || payload.binary?.encoding !== "hex") throw new BlockedError("PYTH_UPDATE_SHAPE_UNEXPECTED", "Pyth Hermes did not return hex update bytes.", "Pyth API contract changed; update fetchPythPriceFeedBytes.");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0 || bytes.length > 8192) throw new BlockedError("PYTH_UPDATE_OUT_OF_BOUNDS", `Pyth update length ${bytes.length} is outside the V2 market limit (0 < n <= 8192).`, "Inspect the Pyth payload before retrying.");
  return { bytes, feeds };
}

// =========================================================================
// === Inline Zest V2 supply (sBTC collateral)
// =========================================================================
// Direct broadcast of v0-4-market.supply-collateral-add — replaces the prior
// runPrimitive('zest-asset-deposit-primitive', 'run', ...) dispatch. Mirrors
// the architecture of inlineStake (signer resolve, v6/v7 SDK adapter,
// PostConditionMode.Deny, broadcast fallback chain). Canonical Zest V2
// principals + sBTC vault asset name are verified against
// skills/zest-asset-deposit-primitive/zest-asset-deposit-primitive.ts which
// is merged at https://github.com/BitflowFinance/bff-skills/pull/574.

const ZEST_MARKET_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const ZEST_MARKET_CONTRACT = "v0-4-market";
const ZEST_MARKET_ID = `${ZEST_MARKET_DEPLOYER}.${ZEST_MARKET_CONTRACT}`;
const ZEST_VAULT_SBTC_CONTRACT = "v0-vault-sbtc";
const ZEST_VAULT_USDC_CONTRACT = "v0-vault-usdc";
const ZEST_VAULT_ASSET_NAME = "zft";
const SBTC_TOKEN_DEPLOYER = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_TOKEN_CONTRACT = "sbtc-token";
const SBTC_ASSET_NAME = "sbtc-token";
const USDCX_TOKEN_DEPLOYER = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE";
const USDCX_TOKEN_CONTRACT = "usdcx";
const USDCX_ASSET_NAME = "usdcx-token";
const PYTH_MAX_FEE_USTX = 10n;

async function inlineSupply(wallet: string, sbtcAmountSats: bigint): Promise<string | null> {
  if (sbtcAmountSats <= 0n) {
    throw new BlockedError("INVALID_SUPPLY_AMOUNT", "Supply amount must be positive.", "Inspect --sbtc-amount-sats.");
  }
  const signer = await resolveStakeSigner(wallet);
  const stx = await import("@stacks/transactions");
  const network = await import("@stacks/network");
  const networkAny = network as Record<string, unknown>;
  const mainnet = networkAny.STACKS_MAINNET ?? new (networkAny.StacksMainnet as new () => unknown)();

  const stxAny = stx as Record<string, unknown>;
  const sbtcAssetId = `${SBTC_TOKEN_DEPLOYER}.${SBTC_TOKEN_CONTRACT}` as `${string}.${string}`;
  const vaultId = `${ZEST_MARKET_DEPLOYER}.${ZEST_VAULT_SBTC_CONTRACT}` as `${string}.${string}`;

  function buildLte(principal: string, amount: bigint, assetIdentifier: `${string}.${string}`, assetName: string): unknown {
    if (typeof stxAny.Pc === "object" && stxAny.Pc !== null) {
      const pc = stxAny.Pc as { principal: (p: string) => { willSendLte: (a: string | bigint) => { ft: (id: `${string}.${string}`, name: string) => unknown } } };
      return pc.principal(principal).willSendLte(amount.toString()).ft(assetIdentifier, assetName);
    } else if (typeof stxAny.makeStandardFungiblePostCondition === "function") {
      const fcc = stxAny.FungibleConditionCode as Record<string, unknown> | undefined;
      const createAssetInfo = stxAny.createAssetInfo as (a: string, b: string, c: string) => unknown;
      const make = stxAny.makeStandardFungiblePostCondition as (...args: unknown[]) => unknown;
      const makeContract = stxAny.makeContractFungiblePostCondition as ((...args: unknown[]) => unknown) | undefined;
      if (!fcc?.LessEqual || typeof createAssetInfo !== "function" || typeof makeContract !== "function") {
        throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "v6 PC helpers missing FungibleConditionCode.LessEqual / createAssetInfo / makeContractFungiblePostCondition.", "Reinstall @stacks/transactions.");
      }
      const [addr, name] = assetIdentifier.split(".");
      const info = createAssetInfo(addr, name, assetName);
      // Differentiate standard vs contract principal for v6.
      if (principal.includes(".")) {
        const [pAddr, pName] = principal.split(".");
        return makeContract(pAddr, pName, fcc.LessEqual, amount.toString(), info);
      }
      return make(principal, fcc.LessEqual, amount.toString(), info);
    }
    throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "Neither v6 nor v7 PC builders available.", "Reinstall @stacks/transactions.");
  }

  const postConditions = [
    buildLte(wallet, sbtcAmountSats, sbtcAssetId, SBTC_ASSET_NAME),
    buildLte(ZEST_MARKET_ID, sbtcAmountSats, sbtcAssetId, SBTC_ASSET_NAME),
    buildLte(wallet, sbtcAmountSats, vaultId, ZEST_VAULT_ASSET_NAME),
  ];

  const txParams: Record<string, unknown> = {
    contractAddress: ZEST_MARKET_DEPLOYER,
    contractName: ZEST_MARKET_CONTRACT,
    functionName: "supply-collateral-add",
    functionArgs: [
      (stxAny.contractPrincipalCV as (a: string, b: string) => unknown)(SBTC_TOKEN_DEPLOYER, SBTC_TOKEN_CONTRACT),
      (stxAny.uintCV as (v: string) => unknown)(sbtcAmountSats.toString()),
      (stxAny.uintCV as (v: string) => unknown)("0"),
      (stxAny.noneCV as () => unknown)(),
    ],
    senderKey: signer.privateKey,
    fee: 30000n,
    network: mainnet,
    postConditionMode: (stxAny.PostConditionMode as Record<string, unknown> | undefined)?.Deny ?? stx.PostConditionMode.Deny,
    postConditions,
  };
  const anchorAny = (stxAny.AnchorMode as Record<string, unknown> | undefined)?.Any;
  if (anchorAny !== undefined) txParams.anchorMode = anchorAny;

  const tx = await (stxAny.makeContractCall as (p: unknown) => Promise<unknown>)(txParams);
  let result: { error?: string; reason?: string; txid?: string };
  try {
    result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)({ transaction: tx, network: mainnet } as unknown);
  } catch (newSigFailed) {
    try {
      result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)(tx as unknown, mainnet as unknown);
    } catch (oldSigFailed) {
      throw new BlockedError(
        "BROADCAST_FAILED",
        `Both broadcastTransaction signatures failed: ${(newSigFailed as Error).message} / ${(oldSigFailed as Error).message}`,
        "Verify the installed @stacks/transactions version matches the bff-skills convention.",
      );
    }
  }
  if (result.error) throw new BlockedError("BROADCAST_FAILED", `Supply broadcast rejected: ${result.reason || result.error}`, "Inspect the broadcast error and retry only after resolving the underlying cause.");
  if (typeof result.txid !== "string") throw new BlockedError("BROADCAST_NO_TXID", "Supply broadcast returned no txid.", "Inspect the broadcast result; the signer or network may be misconfigured.");
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

// =========================================================================
// === Inline Zest V2 borrow (USDCx default)
// =========================================================================
// Direct broadcast of v0-4-market.borrow with Pyth Hermes update bytes —
// replaces the prior runPrimitive('zest-borrow-asset-primitive', 'run', ...)
// dispatch. The borrow ABI is `(borrow (ft <ft-trait>) (amount uint)
// (receiver (optional principal)) (price-feeds (optional (list 3 (buff 8192)))))`.
// Pyth feeds for sBTC (collateral) + USDCx (borrow asset) are fetched live
// before each broadcast so Zest's oracle staleness check passes. Mirrors
// skills/zest-borrow-asset-primitive/zest-borrow-asset-primitive.ts which is
// merged at https://github.com/BitflowFinance/bff-skills/pull/572.

async function inlineBorrow(wallet: string, amountAtomic: bigint): Promise<string | null> {
  if (amountAtomic <= 0n) {
    throw new BlockedError("INVALID_BORROW_AMOUNT", "Borrow amount must be positive.", "Inspect the borrow sizing logic before resuming.");
  }
  const signer = await resolveStakeSigner(wallet);
  const pyth = await fetchPythPriceFeedBytes(["sBTC", "USDCx"]);
  const stx = await import("@stacks/transactions");
  const network = await import("@stacks/network");
  const networkAny = network as Record<string, unknown>;
  const mainnet = networkAny.STACKS_MAINNET ?? new (networkAny.StacksMainnet as new () => unknown)();
  const stxAny = stx as Record<string, unknown>;

  const usdcxAssetId = `${USDCX_TOKEN_DEPLOYER}.${USDCX_TOKEN_CONTRACT}` as `${string}.${string}`;
  const usdcVaultId = `${ZEST_MARKET_DEPLOYER}.${ZEST_VAULT_USDC_CONTRACT}` as `${string}.${string}`;

  function buildVaultSendLte(): unknown {
    if (typeof stxAny.Pc === "object" && stxAny.Pc !== null) {
      const pc = stxAny.Pc as { principal: (p: string) => { willSendLte: (a: string | bigint) => { ft: (id: `${string}.${string}`, name: string) => unknown } } };
      return pc.principal(usdcVaultId).willSendLte(amountAtomic.toString()).ft(usdcxAssetId, USDCX_ASSET_NAME);
    }
    if (typeof stxAny.makeContractFungiblePostCondition === "function") {
      const fcc = stxAny.FungibleConditionCode as Record<string, unknown> | undefined;
      const createAssetInfo = stxAny.createAssetInfo as (a: string, b: string, c: string) => unknown;
      const makeContract = stxAny.makeContractFungiblePostCondition as (...args: unknown[]) => unknown;
      if (!fcc?.LessEqual || typeof createAssetInfo !== "function") {
        throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "v6 PC helpers missing FungibleConditionCode.LessEqual / createAssetInfo.", "Reinstall @stacks/transactions.");
      }
      const info = createAssetInfo(USDCX_TOKEN_DEPLOYER, USDCX_TOKEN_CONTRACT, USDCX_ASSET_NAME);
      return makeContract(ZEST_MARKET_DEPLOYER, ZEST_VAULT_USDC_CONTRACT, fcc.LessEqual, amountAtomic.toString(), info);
    }
    throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "Neither v6 nor v7 PC builders available.", "Reinstall @stacks/transactions.");
  }

  function buildPythFeePC(): unknown {
    if (typeof stxAny.Pc === "object" && stxAny.Pc !== null) {
      const pc = stxAny.Pc as { principal: (p: string) => { willSendLte: (a: string | bigint) => { ustx: () => unknown } } };
      return pc.principal(wallet).willSendLte(PYTH_MAX_FEE_USTX.toString()).ustx();
    }
    if (typeof stxAny.makeStandardSTXPostCondition === "function") {
      const fcc = stxAny.FungibleConditionCode as Record<string, unknown> | undefined;
      const make = stxAny.makeStandardSTXPostCondition as (...args: unknown[]) => unknown;
      if (!fcc?.LessEqual) throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "v6 PC helpers missing FungibleConditionCode.LessEqual.", "Reinstall @stacks/transactions.");
      return make(wallet, fcc.LessEqual, PYTH_MAX_FEE_USTX.toString());
    }
    throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "No STX post-condition builder available.", "Reinstall @stacks/transactions.");
  }

  // Price-feeds arg: (optional (list 3 (buff 8192)))
  const priceFeedsArg = pyth.bytes.length > 0
    ? (stxAny.someCV as (v: unknown) => unknown)(
        (stxAny.listCV as (items: unknown[]) => unknown)([
          (stxAny.bufferCV as (b: Buffer) => unknown)(pyth.bytes),
        ])
      )
    : (stxAny.noneCV as () => unknown)();

  const txParams: Record<string, unknown> = {
    contractAddress: ZEST_MARKET_DEPLOYER,
    contractName: ZEST_MARKET_CONTRACT,
    functionName: "borrow",
    functionArgs: [
      (stxAny.contractPrincipalCV as (a: string, b: string) => unknown)(USDCX_TOKEN_DEPLOYER, USDCX_TOKEN_CONTRACT),
      (stxAny.uintCV as (v: string) => unknown)(amountAtomic.toString()),
      (stxAny.someCV as (v: unknown) => unknown)((stxAny.principalCV as (p: string) => unknown)(wallet)),
      priceFeedsArg,
    ],
    senderKey: signer.privateKey,
    fee: 30000n,
    network: mainnet,
    postConditionMode: (stxAny.PostConditionMode as Record<string, unknown> | undefined)?.Deny ?? stx.PostConditionMode.Deny,
    postConditions: [buildVaultSendLte(), buildPythFeePC()],
  };
  const anchorAny = (stxAny.AnchorMode as Record<string, unknown> | undefined)?.Any;
  if (anchorAny !== undefined) txParams.anchorMode = anchorAny;

  const tx = await (stxAny.makeContractCall as (p: unknown) => Promise<unknown>)(txParams);
  let result: { error?: string; reason?: string; txid?: string };
  try {
    result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)({ transaction: tx, network: mainnet } as unknown);
  } catch (newSigFailed) {
    try {
      result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)(tx as unknown, mainnet as unknown);
    } catch (oldSigFailed) {
      throw new BlockedError(
        "BROADCAST_FAILED",
        `Both broadcastTransaction signatures failed: ${(newSigFailed as Error).message} / ${(oldSigFailed as Error).message}`,
        "Verify the installed @stacks/transactions version matches the bff-skills convention.",
      );
    }
  }
  if (result.error) throw new BlockedError("BROADCAST_FAILED", `Borrow broadcast rejected: ${result.reason || result.error}`, "Inspect the broadcast error and retry only after resolving the underlying cause.");
  if (typeof result.txid !== "string") throw new BlockedError("BROADCAST_NO_TXID", "Borrow broadcast returned no txid.", "Inspect the broadcast result; the signer or network may be misconfigured.");
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

// =========================================================================
// === Inline Bitflow DLMM swap (USDCx → USDh, wind direction)
// =========================================================================
// Direct broadcast of dlmm-swap-router-v-1-2.swap-y-for-x-simple-range-multi
// — replaces the prior runPrimitive('bitflow-swap-aggregator', 'run', ...)
// dispatch. The USDh/USDCx 1-bps DLMM pool has USDh as token-x and USDCx as
// token-y (verified via the companion unwind skill's `get-pool` read which
// uses swap-x-for-y for USDh → USDCx — wind direction inverts that to
// swap-y-for-x for USDCx → USDh). min-dy is derived from Bitflow's `/quote`
// endpoint pinned to --slippage-bps and enforced on chain. Pattern mirrors
// the inline swap leg in
// skills/unwindleg-hermeticaunstake-zestrepay-yield-rotator-sUSDh-USDCx-sBTC.

const BITFLOW_ROUTER_DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const BITFLOW_ROUTER_CONTRACT = "dlmm-swap-router-v-1-2";
const BITFLOW_USDH_USDCX_POOL_DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const BITFLOW_USDH_USDCX_POOL_CONTRACT = "dlmm-pool-usdh-usdcx-v-1-bps-1";
const USDH_TOKEN_DEPLOYER = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const USDH_TOKEN_CONTRACT = "usdh-token-v1";
const USDH_ASSET_NAME = "usdh";
const BITFLOW_DLMM_MAX_STEPS = 230;

async function fetchBitflowMinOutUsdh(usdcxBase: bigint, slippageBps: number): Promise<{ minOut: bigint; fee: bigint }> {
  if (usdcxBase <= 0n) throw new BlockedError("INVALID_SWAP_AMOUNT", "USDCx swap amount must be positive.", "Inspect borrowedAmountBase.");
  if (!Number.isFinite(slippageBps) || slippageBps < 0) {
    throw new BlockedError("INVALID_SLIPPAGE_BPS", `slippageBps must be a non-negative finite number; got ${slippageBps}.`, "Pass --slippage-bps as a non-negative integer.");
  }
  const slippagePct = slippageBps / 100;
  const inputToken = `${USDCX_TOKEN_DEPLOYER}.${USDCX_TOKEN_CONTRACT}`;
  const outputToken = `${USDH_TOKEN_DEPLOYER}.${USDH_TOKEN_CONTRACT}`;
  const res = await fetch(`${BITFLOW_QUOTES_BASE}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input_token: inputToken,
      output_token: outputToken,
      amount_in: usdcxBase.toString(),
      slippage_tolerance: slippagePct,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new BlockedError(
      "BITFLOW_QUOTE_FETCH_FAILED",
      `Bitflow /quote returned HTTP ${res.status} for USDCx → USDh.`,
      "Retry once Bitflow recovers; the skill refuses to broadcast a swap without a fresh min-out.",
    );
  }
  const body = await res.json() as {
    min_received?: string; minReceived?: string;
    min_out?: string; minOut?: string;
    min_amount_out?: string; minAmountOut?: string;
    fee?: string; swap_fee?: string; swapFee?: string;
  };
  const raw = body.min_received ?? body.minReceived ?? body.min_out ?? body.minOut ?? body.min_amount_out ?? body.minAmountOut;
  if (!raw) throw new BlockedError("BITFLOW_QUOTE_SHAPE_UNEXPECTED", "Bitflow /quote response missing min_received/min_out/min_amount_out.", "Inspect the response body.", { body: body as JsonMap });
  const parsed = BigInt(raw.split(".")[0]);
  if (parsed <= 0n) throw new BlockedError("BITFLOW_MIN_OUT_NONPOSITIVE", `Bitflow returned non-positive min_received: ${raw}.`, "Inspect quote params + pool liquidity.");

  // Bitflow's swap-y-for-x-simple-range-multi router deducts its fee from the
  // sender wallet in the INPUT token (USDCx here), on top of amount_in. The PC
  // ceiling downstream must cover amount_in + fee, not just amount_in, or the
  // sender-side Deny PC trips with abort_by_post_condition even though Clarity
  // returns (ok ...). Empirically observed on tx 0x4b7fa7b309e9be41... at
  // amount_in=17,860,402 USDCx + fee=8,930 USDCx → sent=17,869,332 USDCx; PC
  // built at amount_in (17,860,402) tripped. Fail loud if Bitflow omits the
  // fee field — we can't build a safe PC without it.
  const rawFee = body.fee ?? body.swap_fee ?? body.swapFee;
  if (!rawFee) throw new BlockedError("BITFLOW_QUOTE_MISSING_FEE", "Bitflow /quote response missing fee/swap_fee field.", "Inspect the response body; the swap PC cannot be safely widened without the router fee.", { body: body as JsonMap });
  const parsedFee = BigInt(rawFee.split(".")[0]);
  if (parsedFee < 0n) throw new BlockedError("BITFLOW_FEE_NEGATIVE", `Bitflow returned negative fee: ${rawFee}.`, "Inspect quote params.");

  return { minOut: parsed, fee: parsedFee };
}

async function inlineSwap(wallet: string, usdcxAmountBase: bigint, slippageBps: number): Promise<string | null> {
  if (usdcxAmountBase <= 0n) throw new BlockedError("INVALID_SWAP_AMOUNT", "Swap amount must be positive.", "Inspect borrowedAmountBase.");
  const { minOut: minUsdhOut, fee: bitflowFee } = await fetchBitflowMinOutUsdh(usdcxAmountBase, slippageBps);

  // PC ceiling = amount_in + router fee. See fetchBitflowMinOutUsdh comment for
  // the on-chain root cause (tx 0x4b7fa7b... aborted with PC built at amount_in
  // only). The function-arg passed to the router is still amount_in (line below
  // at uintCV(usdcxAmountBase)) — the router charges its fee implicitly on top.
  const usdcxOutCeiling = usdcxAmountBase + bitflowFee;

  const signer = await resolveStakeSigner(wallet);
  const stx = await import("@stacks/transactions");
  const network = await import("@stacks/network");
  const networkAny = network as Record<string, unknown>;
  const mainnet = networkAny.STACKS_MAINNET ?? new (networkAny.StacksMainnet as new () => unknown)();
  const stxAny = stx as Record<string, unknown>;

  const usdcxAssetId = `${USDCX_TOKEN_DEPLOYER}.${USDCX_TOKEN_CONTRACT}` as `${string}.${string}`;

  // Sender post-condition only: wallet sends ≤ usdcxOutCeiling USDCx
  // (= amount_in + Bitflow router fee). Receive-side protection comes from the
  // on-chain min-dx (min-USDh-out) argument, which the DLMM router enforces
  // internally; redundant receiver PCs add no safety here.
  let senderPC: unknown;
  if (typeof stxAny.Pc === "object" && stxAny.Pc !== null) {
    const pc = stxAny.Pc as { principal: (p: string) => { willSendLte: (a: string | bigint) => { ft: (id: `${string}.${string}`, name: string) => unknown } } };
    senderPC = pc.principal(wallet).willSendLte(usdcxOutCeiling.toString()).ft(usdcxAssetId, USDCX_ASSET_NAME);
  } else if (typeof stxAny.makeStandardFungiblePostCondition === "function") {
    const fcc = stxAny.FungibleConditionCode as Record<string, unknown> | undefined;
    const createAssetInfo = stxAny.createAssetInfo as (a: string, b: string, c: string) => unknown;
    const make = stxAny.makeStandardFungiblePostCondition as (...args: unknown[]) => unknown;
    if (!fcc?.LessEqual || typeof createAssetInfo !== "function") {
      throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "v6 PC helpers missing FungibleConditionCode.LessEqual / createAssetInfo.", "Reinstall @stacks/transactions.");
    }
    senderPC = make(wallet, fcc.LessEqual, usdcxOutCeiling.toString(), createAssetInfo(USDCX_TOKEN_DEPLOYER, USDCX_TOKEN_CONTRACT, USDCX_ASSET_NAME));
  } else {
    throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "Neither v6 nor v7 PC builders available.", "Reinstall @stacks/transactions.");
  }

  const txParams: Record<string, unknown> = {
    contractAddress: BITFLOW_ROUTER_DEPLOYER,
    contractName: BITFLOW_ROUTER_CONTRACT,
    functionName: "swap-y-for-x-simple-range-multi",
    functionArgs: [
      (stxAny.contractPrincipalCV as (a: string, b: string) => unknown)(BITFLOW_USDH_USDCX_POOL_DEPLOYER, BITFLOW_USDH_USDCX_POOL_CONTRACT),
      (stxAny.contractPrincipalCV as (a: string, b: string) => unknown)(USDH_TOKEN_DEPLOYER, USDH_TOKEN_CONTRACT),
      (stxAny.contractPrincipalCV as (a: string, b: string) => unknown)(USDCX_TOKEN_DEPLOYER, USDCX_TOKEN_CONTRACT),
      (stxAny.uintCV as (v: string) => unknown)(usdcxAmountBase.toString()),
      (stxAny.uintCV as (v: string) => unknown)(minUsdhOut.toString()),
      (stxAny.uintCV as (v: string) => unknown)(BITFLOW_DLMM_MAX_STEPS.toString()),
      (stxAny.noneCV as () => unknown)(),
    ],
    senderKey: signer.privateKey,
    fee: 30000n,
    network: mainnet,
    postConditionMode: (stxAny.PostConditionMode as Record<string, unknown> | undefined)?.Deny ?? stx.PostConditionMode.Deny,
    postConditions: [senderPC],
  };
  const anchorAny = (stxAny.AnchorMode as Record<string, unknown> | undefined)?.Any;
  if (anchorAny !== undefined) txParams.anchorMode = anchorAny;

  const tx = await (stxAny.makeContractCall as (p: unknown) => Promise<unknown>)(txParams);
  let result: { error?: string; reason?: string; txid?: string };
  try {
    result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)({ transaction: tx, network: mainnet } as unknown);
  } catch (newSigFailed) {
    try {
      result = await (stxAny.broadcastTransaction as (a: unknown, b?: unknown) => Promise<typeof result>)(tx as unknown, mainnet as unknown);
    } catch (oldSigFailed) {
      throw new BlockedError(
        "BROADCAST_FAILED",
        `Both broadcastTransaction signatures failed: ${(newSigFailed as Error).message} / ${(oldSigFailed as Error).message}`,
        "Verify the installed @stacks/transactions version matches the bff-skills convention.",
      );
    }
  }
  if (result.error) throw new BlockedError("BROADCAST_FAILED", `Swap broadcast rejected: ${result.reason || result.error}`, "Inspect the broadcast error and retry only after resolving the underlying cause.");
  if (typeof result.txid !== "string") throw new BlockedError("BROADCAST_NO_TXID", "Swap broadcast returned no txid.", "Inspect the broadcast result; the signer or network may be misconfigured.");
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

// Existing fetchWalletUsdhBalance defined elsewhere in this file is used
// post-swap to derive the actual USDh received (balance delta), since the
// DLMM router does not emit a caller-friendly observed-out in tx_result.

async function inlineStake(wallet: string, amountAtomic: bigint): Promise<string | null> {
  if (amountAtomic <= 0n) {
    throw new BlockedError("INVALID_STAKE_AMOUNT", "Stake amount must be positive.", "Inspect the swap output that fed this stake leg.");
  }
  const enabled = await checkHermeticaStakingEnabled();
  if (enabled === false) throw new BlockedError("HERMETICA_STAKING_DISABLED", "Hermetica staking-state-v1.get-staking-enabled returned false.", "Wait for staking to be re-enabled by the protocol.");
  if (enabled === null) throw new BlockedError("HERMETICA_STATE_UNREADABLE", "Could not read Hermetica staking enabled state via Hiro.", "Check Hiro API connectivity and retry.");
  const balance = await fetchWalletUsdhBalance(wallet);
  if (balance !== null && balance < amountAtomic) {
    throw new BlockedError("INSUFFICIENT_USDH_BALANCE", `Wallet USDh balance ${balance.toString()} < amount ${amountAtomic.toString()}.`, "Re-check the swap leg observed-out value or supply more USDh externally.");
  }
  const signer = await resolveStakeSigner(wallet);
  const stx = await import("@stacks/transactions");
  const network = await import("@stacks/network");
  // @stacks/network: v7+ exports the constant STACKS_MAINNET; v6 exposed the
  // StacksMainnet class. Use whichever the installed version provides.
  const networkAny = network as Record<string, unknown>;
  const mainnet = networkAny.STACKS_MAINNET
    ?? new (networkAny.StacksMainnet as new () => unknown)();

  // Post-condition: deny-by-default + allow exactly `amountAtomic` USDh out.
  // v7+ exports the `Pc` builder (Pc.principal(...).willSendEq(...).ft(...));
  // v6 used `makeStandardFungiblePostCondition` + `FungibleConditionCode` +
  // `createAssetInfo`. We adapt at runtime so the skill runs against either
  // SDK major. Both builders produce a post-condition shape that
  // makeContractCall accepts.
  const stxAny = stx as Record<string, unknown>;
  const assetIdentifier = `${HERMETICA_DEPLOYER}.${HERMETICA_USDH_TOKEN}` as `${string}.${string}`;
  let postCondition: unknown;
  if (typeof stxAny.Pc === "object" && stxAny.Pc !== null) {
    const pc = stxAny.Pc as { principal: (p: string) => { willSendEq: (a: string | bigint) => { ft: (id: `${string}.${string}`, name: string) => unknown } } };
    postCondition = pc.principal(wallet).willSendEq(amountAtomic.toString()).ft(assetIdentifier, "usdh");
  } else if (typeof stxAny.makeStandardFungiblePostCondition === "function") {
    const fcc = stxAny.FungibleConditionCode as Record<string, unknown> | undefined;
    const createAssetInfo = stxAny.createAssetInfo as (a: string, b: string, c: string) => unknown;
    const make = stxAny.makeStandardFungiblePostCondition as (...args: unknown[]) => unknown;
    if (!fcc?.Equal || typeof createAssetInfo !== "function") {
      throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "v6 post-condition helpers present but FungibleConditionCode.Equal / createAssetInfo missing.", "Reinstall @stacks/transactions (v6.x or v7.x).");
    }
    postCondition = make(wallet, fcc.Equal, amountAtomic.toString(), createAssetInfo(HERMETICA_DEPLOYER, HERMETICA_USDH_TOKEN, "usdh"));
  } else {
    throw new BlockedError("STACKS_TRANSACTIONS_INCOMPATIBLE", "@stacks/transactions is missing both v6 (makeStandardFungiblePostCondition) and v7 (Pc) post-condition builders.", "Reinstall a supported @stacks/transactions version (v6.x or v7.x).");
  }

  // AnchorMode was an enum in v6 and is gone in v7 (makeContractCall accepts
  // anchorMode as an optional field that defaults appropriately). Pass the v6
  // enum value when present, otherwise omit.
  const txParams: Record<string, unknown> = {
    contractAddress: HERMETICA_DEPLOYER,
    contractName: HERMETICA_STAKING_CONTRACT,
    functionName: "stake",
    functionArgs: [stx.uintCV(amountAtomic.toString()), stx.noneCV()],
    senderKey: signer.privateKey,
    fee: 30000n,
    network: mainnet,
    postConditionMode: stx.PostConditionMode.Deny,
    postConditions: [postCondition],
  };
  const anchorAny = (stxAny.AnchorMode as Record<string, unknown> | undefined)?.Any;
  if (anchorAny !== undefined) txParams.anchorMode = anchorAny;

  const tx = await (stxAny.makeContractCall as (p: unknown) => Promise<unknown>)(txParams);
  // @stacks/transactions v6+ accepts `broadcastTransaction({ transaction, network })`;
  // older versions accept positional args. Use the v6+ shape and fall back.
  let result: { error?: string; reason?: string; txid?: string };
  try {
    result = await (stx as { broadcastTransaction: (a: unknown, b?: unknown) => Promise<typeof result> })
      .broadcastTransaction({ transaction: tx, network: mainnet } as unknown);
  } catch (newSigFailed) {
    try {
      result = await (stx as { broadcastTransaction: (a: unknown, b?: unknown) => Promise<typeof result> })
        .broadcastTransaction(tx as unknown, mainnet as unknown);
    } catch (oldSigFailed) {
      throw new BlockedError(
        "BROADCAST_FAILED",
        `Both broadcastTransaction signatures failed: ${(newSigFailed as Error).message} / ${(oldSigFailed as Error).message}`,
        "Verify the installed @stacks/transactions version matches the bff-skills convention.",
      );
    }
  }
  if (result.error) {
    throw new BlockedError("BROADCAST_FAILED", `Broadcast rejected: ${result.reason || result.error}`, "Inspect the broadcast error and retry only after resolving the underlying cause.");
  }
  if (typeof result.txid !== "string") {
    throw new BlockedError("BROADCAST_NO_TXID", "Broadcast returned no txid.", "Inspect the broadcast result; the signer or network may be misconfigured.");
  }
  return result.txid;
}

// ----- Monitor (HITL + autonomous) -----

async function rateLimitOk(wallet: string): Promise<{ ok: boolean; lastAt: number | null; msUntilNext: number | null }> {
  const log = await readActionLog(wallet);
  const lastAt = lastAutoActionMs(log);
  if (lastAt === null) return { ok: true, lastAt: null, msUntilNext: 0 };
  const elapsed = Date.now() - lastAt;
  if (elapsed >= AUTONOMOUS_RATE_LIMIT_MS) return { ok: true, lastAt, msUntilNext: 0 };
  return { ok: false, lastAt, msUntilNext: AUTONOMOUS_RATE_LIMIT_MS - elapsed };
}

async function runMonitor(opts: MonitorOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const mode = (opts.mode || "hitl").toLowerCase();
    if (mode !== "hitl" && mode !== "autonomous") throw new Error(`--mode must be 'hitl' or 'autonomous'; received ${opts.mode}`);
    if (mode === "autonomous" && opts.confirm !== CONFIRM_TOKEN_AUTONOMOUS) throw new BlockedError("CONFIRMATION_REQUIRED", "Autonomous monitor mode broadcasts writes and requires explicit confirmation.", `Re-run with --mode=autonomous --confirm=${CONFIRM_TOKEN_AUTONOMOUS}.`);
    // Cadence must be >= 60s so a misconfigured monitor can't hot-loop external
    // APIs. maxIterations 0 means "run forever" — keep that semantic.
    const pollSec = parseStrictlyPositiveInt(opts.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS, "--poll-interval-seconds", 60);
    const maxIter = parsePositiveInt(opts.maxIterations, DEFAULT_MAX_ITERATIONS, "--max-iterations");
    let iter = 0;
    const overallStart = new Date().toISOString();
    while (true) {
      iter += 1;
      const score = await computeScore(opts, wallet);
      const checkpoint = await readCheckpoint(wallet);
      const inStakedPosition = checkpoint?.step === "complete";
      const idleOrNoCheckpoint = !checkpoint || checkpoint.step === "idle" || checkpoint.step === "operator_cancelled";
      const inPartialRotation = !!checkpoint && ["supply_confirmed", "borrow_confirmed", "swap_confirmed"].includes(checkpoint.step);
      let intendedAction: string | null = null, intendedReason: string | null = null;
      const exitBelow = parseScoreThreshold(opts.exitScoreBelow, DEFAULT_EXIT_SCORE_BELOW);
      const minScore = parseScoreThreshold(opts.minScore, DEFAULT_MIN_SCORE);
      if (inStakedPosition && score.composite !== null && score.composite < exitBelow) { intendedAction = "unwind-init"; intendedReason = `composite ${score.composite} < exit threshold ${exitBelow}`; }
      else if (inPartialRotation && score.blockers.length === 0) {
        // A prior autonomous `run` (or operator-initiated `run`) broadcast the
        // supply leg but failed to advance through borrow / swap / stake.
        // Auto-resume to complete the rotation rather than leaving capital
        // stranded in a half-built leverage position with no operator signal.
        intendedAction = "resume";
        intendedReason = `partial rotation at ${checkpoint?.step} needs continuation; no strategy blockers`;
      }
      else if (idleOrNoCheckpoint && score.composite !== null && score.composite >= minScore && score.blockers.length === 0) { intendedAction = "run"; intendedReason = `composite ${score.composite} >= min ${minScore} and no blockers`; }
      const pollPayload: JsonMap = { iteration: iter, ts: new Date().toISOString(), overallStart, mode, score: score as unknown as Json, checkpointStep: checkpoint?.step ?? "none", intendedAction, intendedReason };
      if (mode === "hitl" || intendedAction === null) { output("success", "monitor", pollPayload, null); }
      else {
        const rate = await rateLimitOk(wallet);
        if (!rate.ok) { pollPayload.rateLimited = { lastAutoActionAt: rate.lastAt ? new Date(rate.lastAt).toISOString() : null, msUntilNext: rate.msUntilNext }; pollPayload.skipped = `AUTONOMOUS_RATE_LIMITED:${rate.msUntilNext}ms`; output("blocked", "monitor", pollPayload, { code: "AUTONOMOUS_RATE_LIMITED", message: "Auto-action would exceed one-per-24h cap.", next: "Wait for the rate window to reset, or run the action manually with --confirm." }); }
        else {
          await appendActionLog(wallet, { ts: new Date().toISOString(), action: `auto:intend:${intendedAction}`, scoreSnapshot: score as unknown as JsonMap });
          let txid: string | null = null;
          try {
            if (intendedAction === "run") {
              const sbtcAmount = ensureSbtcAmount(opts.sbtcAmountSats);
              const ltv = parseLtvOrThrow(opts.targetLtv);
              const installed = await installedPrimitives();
              ensureInstalled(installed);
              const ctx = await resolveContinueContext(opts, wallet);
              let cp = await writeCheckpoint(newCheckpoint(wallet, sbtcAmount, ltv.bps));
              // Leg 1 inline — same as runForward's supply leg.
              const autoSupplyTxid = await inlineSupply(wallet, BigInt(sbtcAmount));
              if (!autoSupplyTxid) throw new BlockedError("SUPPLY_BROADCAST_NULL", "Autonomous supply broadcast returned null txid.", "Inspect signer + Zest market state before retrying.");
              const autoSupplyConfirm = await waitForTxConfirmation(autoSupplyTxid, parseWaitSeconds(opts));
              requireTxSuccess("supply", autoSupplyTxid, autoSupplyConfirm);
              cp = await writeCheckpoint({ ...cp, step: "supply_confirmed", supplyTxid: autoSupplyTxid });
              cp = await continueForward(cp, opts as RunOptions, installed, ctx);
              txid = cp.stakeTxid || cp.swapTxid || cp.borrowTxid || cp.supplyTxid || null;
              pollPayload.broadcastResult = {
                checkpoint: cp,
                note: cp.step === "complete"
                  ? "Autonomous 4-leg rotation broadcast and confirmed."
                  : `Autonomous rotation paused at ${cp.step}. Operator can drive resume manually.`,
              };
            } else if (intendedAction === "resume") {
              // Continue a partial rotation from whichever step the prior
              // attempt halted at. `continueForward` walks supply_confirmed
              // -> borrow_confirmed -> swap_confirmed -> complete, with
              // its own per-leg failure surfacing if any leg blocks again.
              const installed = await installedPrimitives();
              ensureInstalled(installed);
              const ctx = await resolveContinueContext(opts, wallet);
              const existing = await readCheckpoint(wallet);
              if (!existing) throw new BlockedError("CHECKPOINT_DISAPPEARED", "Checkpoint vanished between resume decision and execution.", "Re-run monitor; if persistent, run plan/run for a fresh cycle.");
              const cp = await continueForward(existing, opts as RunOptions, installed, ctx);
              txid = cp.stakeTxid || cp.swapTxid || cp.borrowTxid || cp.supplyTxid || null;
              pollPayload.broadcastResult = {
                checkpoint: cp,
                note: cp.step === "complete"
                  ? `Autonomous resume completed the rotation from ${existing.step}.`
                  : `Autonomous resume advanced from ${existing.step} to ${cp.step}; further continuation pending.`,
              };
            } else if (intendedAction === "unwind-init") {
              // Wind skill never broadcasts unwind — logs the intent + emits the
              // recommendation for the companion unwinder skill to pick up.
              pollPayload.broadcastResult = { signaled: true, action: "UNWIND_RECOMMENDED", note: "Wind skill emits unwind signals but does not broadcast unwind. Run the companion unwinder skill to act on this." };
              txid = null;
            }
            await appendActionLog(wallet, { ts: new Date().toISOString(), action: `auto:${intendedAction}`, txid: txid || undefined, scoreSnapshot: score as unknown as JsonMap });
            output("success", "monitor", pollPayload, null);
          } catch (e) {
            await appendActionLog(wallet, { ts: new Date().toISOString(), action: `auto:error:${intendedAction}`, scoreSnapshot: score as unknown as JsonMap });
            if (e instanceof BlockedError) output("blocked", "monitor", pollPayload, { code: e.code, message: e.message, next: e.next });
            else output("error", "monitor", pollPayload, { code: "AUTONOMOUS_ACTION_FAILED", message: e instanceof Error ? e.message : String(e), next: "Inspect logs; the controller will not retry the same action automatically." });
          }
        }
      }
      if (maxIter > 0 && iter >= maxIter) break;
      await new Promise((resolve) => setTimeout(resolve, pollSec * 1000));
    }
  } catch (error) { fail("monitor", error); }
}

// ----- CLI wiring -----

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns sBTC and signs writes")
    .option("--sbtc-amount-sats <sats>", "sBTC supply amount in satoshis")
    .option("--target-ltv <decimal>", "target borrow LTV after rotation, e.g. 0.40", DEFAULT_TARGET_LTV)
    .option("--borrow-asset <symbol>", "borrow asset symbol; resolved against the live Zest registry by the borrow primitive", DEFAULT_BORROW_ASSET)
    .option("--slippage-bps <bps>", "swap slippage tolerance in basis points", DEFAULT_SLIPPAGE_BPS)
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX gas reserve", DEFAULT_MIN_GAS_RESERVE_USTX)
    .option("--mempool-depth-limit <count>", "maximum allowed pending tx depth", DEFAULT_MEMPOOL_DEPTH_LIMIT)
    .option("--wait-seconds <seconds>", "wait window passed to primitive write skills", DEFAULT_WAIT_SECONDS)
    .option("--min-score <0-100>", "strategy score gate for run; 0 disables", DEFAULT_MIN_SCORE)
    .option("--exit-score-below <0-100>", "score threshold below which the skill emits an UNWIND recommendation for the companion unwinder skill (informational; this skill never broadcasts unwind)", DEFAULT_EXIT_SCORE_BELOW)
    .option("--max-price-impact-bps <bps>", "swap viability gate", DEFAULT_MAX_PRICE_IMPACT_BPS)
    .option("--max-price-dispersion-pct <pct>", "reject BTC-regime component if cross-source dispersion exceeds this", DEFAULT_MAX_PRICE_DISPERSION_PCT)
    .option("--pool-share-cap-pct <pct>", "self-impact bound: max share of Zest USDC pool or Hermetica sUSDh supply", DEFAULT_POOL_SHARE_CAP_PCT)
    .option("--emergency-reserve-pct <pct>", "wallet USDC reserve target as % of projected debt (soft-warn)", DEFAULT_EMERGENCY_RESERVE_PCT);
}

const program = new Command();

program
  .name("windleg-zestlend-hermeticastake-yield-rotator-sBTC-USDCx-sUSDh")
  .description("Wind-only yield rotator: supply sBTC on Zest, borrow USDCx on Zest, swap USDCx->USDh via Bitflow Quote Engine (viability-gated), stake USDh inline on Hermetica staking-v1-1 (wallet receives sUSDh). Score gates entry; monitor mode (HITL or autonomous, 1 auto-action/24h cap) checks viability over time. Companion unwinder skill closes the loop in a separate PR.");

addSharedOptions(program.command("doctor").description("Check dependency, state, and strategy-feed readiness")).action(runDoctor);
addSharedOptions(program.command("status").description("Read current rotation status")).action(runStatus);
addSharedOptions(program.command("score").description("Compute the strategy composite score and per-component breakdown")).action(runScore);
addSharedOptions(program.command("plan").description("Plan one rotation without broadcasting; includes Quote-Engine swap-slippage projection")).action(runPlan);
addSharedOptions(program.command("run").description("Run one rotation (forward path)")).option("--confirm <ROTATE>", "required confirmation token for forward writes").action(runForward);
addSharedOptions(program.command("resume").description("Resume an interrupted forward path")).option("--confirm <ROTATE>", "required confirmation token for forward writes").action(runResume);
addSharedOptions(program.command("monitor").description("Polling loop with strategy score; HITL by default, --mode=autonomous for rate-limited writes"))
  .option("--mode <hitl|autonomous>", "monitor mode", "hitl")
  .option("--poll-interval-seconds <seconds>", "poll cadence", DEFAULT_POLL_INTERVAL_SECONDS)
  .option("--max-iterations <n>", "stop after N iterations; 0 = run forever", DEFAULT_MAX_ITERATIONS)
  .option("--confirm <AUTONOMOUS>", "required confirmation token when --mode=autonomous")
  .action(runMonitor);
addSharedOptions(program.command("cancel").description("Mark an unresolved checkpoint as operator-cancelled")).action(runCancel);

program.parse(process.argv);
