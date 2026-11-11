/**
 * Client-side guard for paid LunarCrush calls that return no usable data (#393).
 *
 * The worker charges for a call even when LunarCrush has no data for the
 * symbol (`galaxy_score: null`, a `warning`, an `UNKNOWN` verdict). Refunds
 * and pre-checks would have to live in the worker or the relay, so this guard
 * does what a caller can:
 *
 * - flags a paid-but-empty response and attaches what the provider needs to
 *   honour a manual re-serve (txid, symbol, endpoint, time);
 * - refuses to pay again for the same endpoint + symbol for a cooldown after
 *   an empty answer: the gap is usually per symbol, so paying again within
 *   the hour buys the same nothing;
 * - opens a breaker after several consecutive empty answers across different
 *   symbols, so a scan over N symbols cannot drain its budget during an
 *   upstream outage.
 *
 * Every refusal happens before any request or payment, and `--force`
 * bypasses it. State is advisory: a missing or unreadable file starts fresh.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getStorageDir } from "@aibtc/skills/src/lib/utils/storage.js";

export const SYMBOL_COOLDOWN_MS = 60 * 60 * 1000; // 1 h
export const BREAKER_THRESHOLD = 3; // consecutive empty answers, distinct symbols
export const BREAKER_WINDOW_MS = 10 * 60 * 1000; // 10 min

export type PaidEndpoint = "score" | "oracle";

export interface DegradedRecord {
  at: number;
  txid?: string;
  reason: string;
}

interface NetworkState {
  /** `<endpoint>:<symbol>` → last empty paid answer. */
  empty: Record<string, DegradedRecord>;
  /** Consecutive empty answers since the last good one. */
  streak: { count: number; lastAt: number; symbols: string[] };
}

type GuardState = Record<string, NetworkState>;

export function guardStateFile(): string {
  return process.env.LUNARCRUSH_GUARD_STATE_FILE || path.join(getStorageDir(), "lunarcrush-guard.json");
}

function emptyNetworkState(): NetworkState {
  return { empty: {}, streak: { count: 0, lastAt: 0, symbols: [] } };
}

function readState(): GuardState {
  try {
    const parsed = JSON.parse(readFileSync(guardStateFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as GuardState) : {};
  } catch {
    return {};
  }
}

function writeState(state: GuardState): void {
  const file = guardStateFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

function networkState(state: GuardState, network: string): NetworkState {
  const current = state[network];
  if (!current || typeof current !== "object" || !current.empty || !current.streak) {
    state[network] = emptyNetworkState();
  }
  return state[network];
}

const isMissing = (value: unknown) => value === null || value === undefined;

/**
 * Why a 2xx body carries no usable signal, or null when it does. Matches
 * the shapes the worker documents: `galaxy_score: null` with a `warning` for
 * `score`, and an `UNKNOWN` verdict or null signals for `oracle`.
 */
export function detectDegraded(endpoint: PaidEndpoint, body: unknown): string | null {
  if (!body || typeof body !== "object") return "empty response body";
  const data = body as Record<string, unknown>;
  const warning = typeof data.warning === "string" && data.warning ? data.warning : undefined;
  if (endpoint === "score") {
    if (isMissing(data.galaxy_score)) return warning ? `galaxy_score is null (${warning})` : "galaxy_score is null";
    if (warning) return `upstream warning: ${warning}`;
    return null;
  }
  const signals = (data.signals && typeof data.signals === "object" ? data.signals : {}) as Record<string, unknown>;
  if (data.verdict === "UNKNOWN") return warning ? `verdict UNKNOWN (${warning})` : "verdict UNKNOWN (insufficient data)";
  if (isMissing(signals.galaxy_score)) return warning ? `signals.galaxy_score is null (${warning})` : "signals.galaxy_score is null";
  if (warning) return `upstream warning: ${warning}`;
  return null;
}

export class DegradedGuardError extends Error {
  constructor(
    message: string,
    public readonly kind: "symbol-cooldown" | "breaker-open",
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = "DegradedGuardError";
  }
}

/** Throw before paying when this call would most likely buy an empty answer again. */
export function checkBeforePaying(network: string, endpoint: PaidEndpoint, symbol: string, now = Date.now()): void {
  const state = networkState(readState(), network);
  const { streak } = state;
  if (streak.count >= BREAKER_THRESHOLD && now - streak.lastAt < BREAKER_WINDOW_MS) {
    const retryAfter = Math.ceil((streak.lastAt + BREAKER_WINDOW_MS - now) / 1000);
    throw new DegradedGuardError(
      `Paid call refused, nothing was paid: the last ${streak.count} paid LunarCrush calls ` +
        `(${streak.symbols.join(", ")}) returned no usable data, so the upstream looks degraded. ` +
        `Paid calls resume in ${retryAfter}s, or after one succeeds with --force.`,
      "breaker-open",
      retryAfter
    );
  }
  const prior = state.empty[`${endpoint}:${symbol}`];
  if (prior && now - prior.at < SYMBOL_COOLDOWN_MS) {
    const retryAfter = Math.ceil((prior.at + SYMBOL_COOLDOWN_MS - now) / 1000);
    throw new DegradedGuardError(
      `Paid call refused, nothing was paid: ${endpoint} for ${symbol} returned no usable data ` +
        `${Math.round((now - prior.at) / 1000)}s ago (${prior.reason}${prior.txid ? `, txid ${prior.txid}` : ""}). ` +
        `LunarCrush gaps are usually per symbol, so paying again now would likely buy the same result. ` +
        `Retry in ${retryAfter}s, or pass --force.`,
      "symbol-cooldown",
      retryAfter
    );
  }
}

/** Record the outcome of a paid call: an empty answer extends the streak, a good one resets it. */
export function recordOutcome(
  network: string,
  endpoint: PaidEndpoint,
  symbol: string,
  degraded: { reason: string; txid?: string } | null,
  now = Date.now()
): void {
  const state = readState();
  const net = networkState(state, network);
  for (const [key, record] of Object.entries(net.empty)) {
    if (!record || now - record.at >= SYMBOL_COOLDOWN_MS) delete net.empty[key];
  }
  const key = `${endpoint}:${symbol}`;
  if (degraded) {
    net.empty[key] = { at: now, reason: degraded.reason, ...(degraded.txid ? { txid: degraded.txid } : {}) };
    const fresh = now - net.streak.lastAt < BREAKER_WINDOW_MS;
    const symbols = fresh ? net.streak.symbols : [];
    if (!symbols.includes(symbol)) symbols.push(symbol);
    net.streak = { count: symbols.length, lastAt: now, symbols };
  } else {
    delete net.empty[key];
    net.streak = { count: 0, lastAt: 0, symbols: [] };
  }
  writeState(state);
}

/** Current guard state for one network, for the free `health` output. */
export function guardStatus(network: string, now = Date.now()) {
  const net = networkState(readState(), network);
  const breakerOpen = net.streak.count >= BREAKER_THRESHOLD && now - net.streak.lastAt < BREAKER_WINDOW_MS;
  return {
    breaker: {
      open: breakerOpen,
      consecutiveEmpty: net.streak.count,
      symbols: net.streak.symbols,
      ...(breakerOpen ? { retryAfterSeconds: Math.ceil((net.streak.lastAt + BREAKER_WINDOW_MS - now) / 1000) } : {}),
    },
    coolingDown: Object.entries(net.empty)
      .filter(([, r]) => r && now - r.at < SYMBOL_COOLDOWN_MS)
      .map(([key, r]) => ({ call: key, reason: r.reason, txid: r.txid, retryAfterSeconds: Math.ceil((r.at + SYMBOL_COOLDOWN_MS - now) / 1000) })),
  };
}
