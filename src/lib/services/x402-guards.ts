/**
 * Guards for direct (non-sponsored) x402 payments.
 *
 * Direct mode signs transfers from the operator's own wallet, so every mistake
 * costs the operator rather than a relay. Three rails live here:
 *
 * - policy: every direct-mode env var, parsed once at client creation so a
 *   typo fails before any 402 is answered;
 * - a persisted request-key → txid record, so an identical request repeated
 *   within the TTL (a retry after an ambiguous failure, a second process, a
 *   CLI invoked twice) is refused with the earlier txid instead of paid twice;
 * - the per-wallet daily spend ledger, SHARED with the aibtc MCP server
 *   (`~/.aibtc/spend-state.json`, same shape and env names), so one wallet has
 *   one daily cap no matter which tool spends from it.
 *
 * Check → sign → record runs under a cross-process lock (mkdir-based) so two
 * concurrent direct clients cannot both see "no prior payment" and sign
 * twice. A lease with no heartbeat is reclaimed only when its holder is
 * provably gone (see `reclaimDeadLock`); otherwise the payment is refused and
 * the holder named. Files are written 0600 via
 * temp+rename under a 0700 directory. Keys are SHA-256 digests and values are
 * txids/amounts: no request content reaches disk. A state file that exists
 * but cannot be trusted (unparseable, wrong shape, malformed entries) refuses
 * the payment rather than being read as "nothing spent".
 */

import fs from "node:fs/promises";
import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getStorageDir } from "../utils/storage.js";
import { AibtcError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface DirectPaymentPolicy {
  /** Per-payment cap for sBTC-priced endpoints, in sats. */
  maxSatsPerPayment: bigint;
  /** Per-payment cap for STX-priced endpoints, in micro-STX. */
  maxUstxPerPayment: bigint;
  /** Fee ceiling in micro-STX (also bounded by the per-type clamp). */
  maxFeeUstx: bigint;
  /** How long an identical request is refused after a signed payment. */
  dedupTtlMs: number;
  /** Cumulative daily caps per wallet; `enabled: false` turns the ledger off. */
  spend: { enabled: boolean; dailySats: bigint; dailyUstx: bigint };
  dedupStateFile: string;
  /** Defaults to the MCP server's ledger so both tools meter the same wallet. */
  spendStateFile: string;
}

export const DIRECT_POLICY_DEFAULTS = {
  maxSatsPerPayment: 10_000n,
  maxUstxPerPayment: 1_000_000n, // 1 STX
  maxFeeUstx: 100_000n, // 0.1 STX
  dedupTtlSeconds: 900n, // 15 min — longer than a realistic agent retry
  maxDedupTtlSeconds: 2_592_000n, // 30 days — beyond this a "duplicate" is a new purchase
  dailySats: 50_000n, // mirrors the MCP server's SPEND_LIMIT_DAILY_SATS
  dailyUstx: 10_000_000n, // 10 STX — mirrors SPEND_LIMIT_DAILY_USTX
} as const;

function parseEnvBigInt(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return BigInt(raw.trim());
}

function parseEnvPositiveBigInt(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const value = parseEnvBigInt(env, name, fallback);
  if (value <= 0n) throw new Error(`${name} must be greater than zero, got "${env[name]}"`);
  return value;
}

/**
 * Parse every direct-mode setting. Throws on the first invalid value so a
 * misconfiguration surfaces at client creation, never at payment time.
 */
export function resolveDirectPaymentPolicy(env: NodeJS.ProcessEnv = process.env): DirectPaymentPolicy {
  const dedupTtlSeconds = parseEnvPositiveBigInt(env, "X402_DEDUP_TTL_SECONDS", DIRECT_POLICY_DEFAULTS.dedupTtlSeconds);
  if (dedupTtlSeconds > DIRECT_POLICY_DEFAULTS.maxDedupTtlSeconds) {
    throw new Error(
      `X402_DEDUP_TTL_SECONDS must be at most ${DIRECT_POLICY_DEFAULTS.maxDedupTtlSeconds} (30 days), got "${env.X402_DEDUP_TTL_SECONDS}"`
    );
  }
  // Exactly the MCP server's test (spend-limiter.ts: `!== "false"`). A looser
  // parse here would let "False" disable this ledger while the MCP server,
  // sharing the same file, still believed the wallet was capped.
  const spendEnabled = env.SPEND_LIMIT_ENABLED !== "false";
  return {
    maxSatsPerPayment: parseEnvBigInt(env, "X402_MAX_SATS_PER_PAYMENT", DIRECT_POLICY_DEFAULTS.maxSatsPerPayment),
    maxUstxPerPayment: parseEnvBigInt(env, "X402_MAX_USTX_PER_PAYMENT", DIRECT_POLICY_DEFAULTS.maxUstxPerPayment),
    maxFeeUstx: parseEnvBigInt(env, "X402_MAX_FEE_USTX", DIRECT_POLICY_DEFAULTS.maxFeeUstx),
    dedupTtlMs: Number(dedupTtlSeconds) * 1000,
    spend: {
      enabled: spendEnabled,
      dailySats: parseEnvPositiveBigInt(env, "SPEND_LIMIT_DAILY_SATS", DIRECT_POLICY_DEFAULTS.dailySats),
      dailyUstx: parseEnvPositiveBigInt(env, "SPEND_LIMIT_DAILY_USTX", DIRECT_POLICY_DEFAULTS.dailyUstx),
    },
    dedupStateFile: env.X402_DEDUP_STATE_FILE || path.join(getStorageDir(), "x402-dedup.json"),
    spendStateFile: env.X402_SPEND_STATE_FILE || path.join(getStorageDir(), "spend-state.json"),
  };
}

// ---------------------------------------------------------------------------
// Cross-process lock (mkdir is atomic on every platform we run on)
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60_000; // no heartbeat for a minute means a dead holder
const LOCK_HEARTBEAT_MS = 10_000; // a live holder refreshes the lease this often
const LOCK_RETRY_MS = 250;
let lockMaxWaitMs = 15_000;

/**
 * One lock per state directory. The spend ledger is the resource shared with
 * other tools, so its directory always gets a lock; the dedup store gets its
 * own only when it lives elsewhere. Acquired in sorted order so two processes
 * with mismatched overrides cannot deadlock.
 */
function lockDirsFor(policy: DirectPaymentPolicy): string[] {
  const dirs = new Set([path.dirname(policy.spendStateFile), path.dirname(policy.dedupStateFile)]);
  return [...dirs].sort().map((d) => path.join(d, "x402-guards.lock"));
}

function tryLock(dir: string, token: string): boolean {
  try {
    mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    mkdirSync(dir);
  } catch {
    return false;
  }
  try {
    writeFileSync(path.join(dir, "owner"), `${process.pid} ${token}`, { mode: 0o600 });
    return true;
  } catch {
    // We created the directory but could not claim it: remove it rather than
    // leave an ownerless lock that nobody can prove is dead.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // nothing more we can do; the stale-lock path reports it
    }
    return false;
  }
}

function lockIsStale(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Touch the lease so a slow-but-live build is never mistaken for a dead one. */
function heartbeat(dir: string): void {
  try {
    const now = new Date();
    utimesSync(dir, now, now);
  } catch {
    // if the dir is gone we lost the lock; the owner check on unlock handles it
  }
}

function ownedBy(dir: string, token: string): boolean {
  try {
    return readFileSync(path.join(dir, "owner"), "utf8").endsWith(` ${token}`);
  } catch {
    return false;
  }
}

/**
 * Release our own lock. Only the directory we created is removed; the owner
 * check guards against the one way it could be someone else's (an operator
 * deleted our lock by hand and another payment took the path meanwhile).
 */
function unlock(dir: string, token: string): void {
  try {
    if (ownedBy(dir, token)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // already gone; nothing to release
  }
}

/** "<pid> <token>" from the lock's owner file, or null if it cannot be read. */
function readOwner(dir: string): { raw: string; pid: number; token: string } | null {
  try {
    const raw = readFileSync(path.join(dir, "owner"), "utf8");
    const match = /^(\d+) (\S+)$/.exec(raw);
    return match ? { raw, pid: Number(match[1]), token: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * True only when the holder is provably not running on this host: the pid
 * does not exist (ESRCH), or it is our own pid with a token this process never
 * issued — a previous incarnation, e.g. a restarted container that reuses
 * pid 1. EPERM (someone else's live process) and pid reuse by an unrelated
 * process both read as alive, which errs toward refusing.
 */
function holderIsDead(owner: { pid: number; token: string }): boolean {
  if (owner.pid === process.pid) {
    return ![...heldLocks.values()].includes(owner.token);
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Remove a stale lock whose holder is gone, so a crashed payment (SIGKILL,
 * OOM, reboot) does not block every later direct payment until a human steps
 * in. Safe because:
 *
 * - removal of someone else's lock is serialized by a second mkdir lock
 *   (`<lock>.reclaim`), and the owner + staleness are re-read while holding it;
 * - the only other way a lock directory disappears is its own holder
 *   releasing it, and a dead holder cannot do that — so the lock inspected
 *   under the reclaim lock is the lock removed;
 * - a live holder heartbeats every LOCK_HEARTBEAT_MS, so it is never stale.
 *
 * An ownerless lock (created, then the process died before claiming it) is
 * reclaimable once stale, since a live creator writes the owner immediately.
 * Returns true if the lock was removed.
 */
function reclaimDeadLock(dir: string): boolean {
  const reclaimDir = `${dir}.reclaim`;
  try {
    mkdirSync(reclaimDir);
  } catch {
    return false; // another process is reclaiming; keep waiting
  }
  try {
    if (!lockIsStale(dir)) return false;
    const owner = readOwner(dir);
    if (owner && !holderIsDead(owner)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmdirSync(reclaimDir);
    } catch {
      // already gone
    }
  }
}

function describeHolder(dir: string): string {
  try {
    const [pid] = readFileSync(path.join(dir, "owner"), "utf8").split(" ");
    let alive = true;
    try {
      process.kill(Number(pid), 0);
    } catch {
      alive = false;
    }
    return `owner pid ${pid}${alive ? "" : " (not running)"}`;
  } catch {
    return "owner unknown";
  }
}

/**
 * Wait for the lock. A lease with no heartbeat is reclaimed only when its
 * holder is provably dead (`reclaimDeadLock`); a stale lease whose holder may
 * still be alive is reported, with the owner pid and the path, and the
 * payment is refused.
 */
async function acquire(dir: string, token: string): Promise<void> {
  const deadline = Date.now() + lockMaxWaitMs;
  while (true) {
    if (tryLock(dir, token)) return;
    if (lockIsStale(dir)) {
      if (reclaimDeadLock(dir)) continue;
      if (lockIsStale(`${dir}.reclaim`)) {
        throw new Error(
          `Direct x402 payment refused: a lock reclaim at ${dir}.reclaim was interrupted over ` +
            `${LOCK_STALE_MS / 1000}s ago. Remove that directory (not the lock itself) and retry.`
        );
      }
      if (lockIsStale(dir) && !reclaimInProgress(dir)) {
        throw new Error(
          `Direct x402 payment refused: the guard lock at ${dir} has had no heartbeat for over ` +
            `${LOCK_STALE_MS / 1000}s (${describeHolder(dir)}) and its holder may still be running. ` +
            `If that process is dead, remove the directory and retry; do not remove it while a ` +
            `payment may still be in progress.`
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Direct x402 payment refused: another payment is holding the guard lock at ${dir} ` +
          `(${describeHolder(dir)}, waited ${Math.round(lockMaxWaitMs / 1000)}s). Retry once it finishes.`
      );
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

function reclaimInProgress(dir: string): boolean {
  try {
    statSync(`${dir}.reclaim`);
    return true;
  } catch {
    return false;
  }
}

/** Release held locks if the process is killed mid-build (Ctrl-C, SIGTERM). */
const heldLocks = new Map<string, string>();
let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const release = () => {
    for (const [dir, token] of heldLocks) unlock(dir, token);
    heldLocks.clear();
  };
  process.once("exit", release);
  // Conventional 128 + signal number, so callers can still tell how we died.
  const exitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const [signal, code] of Object.entries(exitCodes)) {
    process.once(signal, () => {
      release();
      process.exit(code);
    });
  }
}

/**
 * Run `fn` while holding the guard lock(s). Waits for a live holder and
 * refuses (never signs) if it cannot acquire — contention or a stale lease is
 * a reason to stop, not to guess.
 */
export async function withDirectPaymentLock<T>(policy: DirectPaymentPolicy, fn: () => Promise<T>): Promise<T> {
  installExitHooks();
  const token = randomBytes(8).toString("hex");
  const dirs = lockDirsFor(policy);
  const held: string[] = [];
  const timer = setInterval(() => held.forEach(heartbeat), LOCK_HEARTBEAT_MS);
  timer.unref();
  try {
    for (const dir of dirs) {
      await acquire(dir, token);
      held.push(dir);
      heldLocks.set(dir, token);
    }
    return await fn();
  } finally {
    clearInterval(timer);
    for (const dir of held.reverse()) {
      unlock(dir, token);
      heldLocks.delete(dir);
    }
  }
}

/** Test seams: shorten the contention wait; inspect lock paths. */
export const _lockTesting = {
  setMaxWaitMs(ms: number): void {
    lockMaxWaitMs = ms;
  },
  lockDirsFor,
};

// ---------------------------------------------------------------------------
// State files: fail closed on anything that is not what we wrote
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStateFile(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; // first run
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Refusing to trust corrupt state at ${file}; move it aside to continue.`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Refusing to trust malformed state at ${file} (expected an object); move it aside to continue.`);
  }
  return parsed;
}

async function writeStateFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tempFile, file);
}

// ---------------------------------------------------------------------------
// Request dedup: request key → txid
// ---------------------------------------------------------------------------

export interface DedupEntry {
  txid: string;
  timestamp: number;
}

/** Deterministic JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/** Headers that vary per attempt or are transport plumbing, never request identity. */
const NON_IDENTITY_HEADERS = new Set([
  "payment-signature",
  "content-length",
  "host",
  "accept-encoding",
  "connection",
  "user-agent",
]);

/**
 * Stable key for "the same paid request": method, absolute URL, canonicalized
 * params and body, the caller's request headers, the payer and the challenge
 * terms — so a different price or recipient is a different key.
 */
export function generateDedupKey(input: {
  method: string;
  url: string;
  params?: unknown;
  data?: unknown;
  headers?: Record<string, unknown>;
  payer: string;
  payTo: string;
  amount: string;
  asset: string;
}): string {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (NON_IDENTITY_HEADERS.has(lower) || value === undefined || value === null) continue;
    headers[lower] = String(value);
  }
  const payload = canonicalJson({
    method: input.method.toUpperCase(),
    url: input.url,
    params: input.params ?? null,
    data: input.data ?? null,
    headers,
    payer: input.payer,
    payTo: input.payTo,
    amount: input.amount,
    asset: input.asset,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export class DuplicatePaymentError extends AibtcError {
  constructor(
    message: string,
    public readonly txid: string,
    public readonly ageMs: number
  ) {
    super(message, "DUPLICATE_PAYMENT");
    this.name = "DuplicatePaymentError";
  }
}

function parseDedupEntry(file: string, key: string, value: unknown): DedupEntry {
  if (
    !isPlainObject(value) ||
    typeof value.txid !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.txid) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  ) {
    throw new Error(`Refusing to trust malformed dedup entry ${key.slice(0, 8)}… at ${file}; move the file aside to continue.`);
  }
  return { txid: value.txid, timestamp: value.timestamp };
}

/** Return the fresh prior entry for `key`, or null. */
export async function checkDedup(key: string, policy: DirectPaymentPolicy): Promise<DedupEntry | null> {
  const state = await readStateFile(policy.dedupStateFile);
  if (!(key in state)) return null;
  const entry = parseDedupEntry(policy.dedupStateFile, key, state[key]);
  if (Date.now() - entry.timestamp > policy.dedupTtlMs) return null;
  return entry;
}

/** Record a signed payment for `key`; prunes expired entries while writing. */
export async function recordDedup(key: string, txid: string, policy: DirectPaymentPolicy): Promise<void> {
  const state = await readStateFile(policy.dedupStateFile);
  const now = Date.now();
  for (const [k, v] of Object.entries(state)) {
    const entry = parseDedupEntry(policy.dedupStateFile, k, v);
    if (now - entry.timestamp > policy.dedupTtlMs) delete state[k];
  }
  state[key] = { txid, timestamp: now } satisfies DedupEntry;
  await writeStateFile(policy.dedupStateFile, state);
}

/**
 * Forget the record for `key` if it still names `txid`. Called once the paid
 * request is known to have been delivered (the server answered 2xx) or known
 * never to have been sent: in both cases the outcome is no longer ambiguous,
 * so an identical request after that is a new purchase, not a retry. Holds
 * the guard lock for the read-modify-write.
 */
export async function clearDedup(key: string, txid: string, policy: DirectPaymentPolicy): Promise<void> {
  await withDirectPaymentLock(policy, async () => {
    const state = await readStateFile(policy.dedupStateFile);
    if (!(key in state)) return;
    const entry = parseDedupEntry(policy.dedupStateFile, key, state[key]);
    if (entry.txid !== txid) return; // a later payment owns this key now
    delete state[key];
    await writeStateFile(policy.dedupStateFile, state);
  });
}

// ---------------------------------------------------------------------------
// Daily spend ledger: { [wallet]: { [UTC day]: { ustx: number, sats: number } } }
// — byte-compatible with the MCP server's ~/.aibtc/spend-state.json.
// ---------------------------------------------------------------------------

export type SpendUnit = "sats" | "ustx";

export class SpendLimitError extends AibtcError {
  constructor(
    message: string,
    public readonly unit: SpendUnit,
    public readonly attempted: bigint,
    public readonly remaining: bigint
  ) {
    super(message, "SPEND_LIMIT");
    this.name = "SpendLimitError";
  }
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parseLedgerAmount(file: string, address: string, day: string, unit: SpendUnit, value: unknown): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(
    `Refusing to trust malformed spend ledger entry ${address}/${day}/${unit} at ${file}; move the file aside to continue.`
  );
}

function readDay(
  file: string,
  state: Record<string, unknown>,
  address: string,
  day: string
): { sats: bigint; ustx: bigint } {
  const wallet = state[address];
  if (wallet === undefined) return { sats: 0n, ustx: 0n };
  if (!isPlainObject(wallet)) throw new Error(`Refusing to trust malformed spend ledger for ${address} at ${file}.`);
  const entry = wallet[day];
  if (entry === undefined) return { sats: 0n, ustx: 0n };
  if (!isPlainObject(entry)) throw new Error(`Refusing to trust malformed spend ledger day ${address}/${day} at ${file}.`);
  return {
    sats: parseLedgerAmount(file, address, day, "sats", entry.sats),
    ustx: parseLedgerAmount(file, address, day, "ustx", entry.ustx),
  };
}

/** Throw if adding `spends` would push today's total over the daily cap. Does not record. */
export async function checkSpend(
  address: string,
  spends: Array<{ unit: SpendUnit; amount: bigint }>,
  policy: DirectPaymentPolicy
): Promise<void> {
  if (!policy.spend.enabled) return;
  const state = await readStateFile(policy.spendStateFile);
  const today = readDay(policy.spendStateFile, state, address, utcDay());
  const totals = { sats: 0n, ustx: 0n };
  for (const s of spends) totals[s.unit] += s.amount;
  for (const unit of ["sats", "ustx"] as const) {
    if (totals[unit] === 0n) continue;
    const cap = unit === "sats" ? policy.spend.dailySats : policy.spend.dailyUstx;
    const remaining = cap > today[unit] ? cap - today[unit] : 0n;
    if (totals[unit] > remaining) {
      const envVar = unit === "sats" ? "SPEND_LIMIT_DAILY_SATS" : "SPEND_LIMIT_DAILY_USTX";
      throw new SpendLimitError(
        `Direct x402 payment refused: ${totals[unit]} ${unit} would exceed today's remaining budget of ` +
          `${remaining} ${unit} for ${address} (daily cap ${cap}). Raise ${envVar}, or set ` +
          `SPEND_LIMIT_ENABLED=false to disable the ledger, then retry.`,
        unit,
        totals[unit],
        remaining
      );
    }
  }
}

/**
 * Record spends against today's ledger for `address` (MCP-compatible shape).
 * Keeps the last 8 days per wallet. Returns the UTC day booked, so a spend
 * that turns out never to have left the process can be released from the
 * same day even across midnight.
 */
export async function recordSpend(
  address: string,
  spends: Array<{ unit: SpendUnit; amount: bigint }>,
  policy: DirectPaymentPolicy
): Promise<string> {
  const day = utcDay();
  if (!policy.spend.enabled) return day;
  await adjustSpend(address, spends, day, 1n, policy);
  return day;
}

/**
 * Undo `recordSpend` for a payment that was signed but provably never sent
 * (the paid request could not reach the server). Floors at zero. Holds the
 * guard lock for the read-modify-write.
 */
export async function releaseSpend(
  address: string,
  spends: Array<{ unit: SpendUnit; amount: bigint }>,
  day: string,
  policy: DirectPaymentPolicy
): Promise<void> {
  if (!policy.spend.enabled) return;
  await withDirectPaymentLock(policy, () => adjustSpend(address, spends, day, -1n, policy));
}

async function adjustSpend(
  address: string,
  spends: Array<{ unit: SpendUnit; amount: bigint }>,
  day: string,
  sign: 1n | -1n,
  policy: DirectPaymentPolicy
): Promise<void> {
  const state = await readStateFile(policy.spendStateFile);
  const totals = readDay(policy.spendStateFile, state, address, day);
  for (const s of spends) {
    const next = totals[s.unit] + sign * s.amount;
    totals[s.unit] = next > 0n ? next : 0n;
  }
  const wallet = (isPlainObject(state[address]) ? state[address] : {}) as Record<string, unknown>;
  // Numbers, not strings: the MCP server reads this file with `?? 0` arithmetic.
  wallet[day] = { ustx: Number(totals.ustx), sats: Number(totals.sats) };
  for (const key of Object.keys(wallet).sort().slice(0, -8)) delete wallet[key];
  state[address] = wallet;
  await writeStateFile(policy.spendStateFile, state);
}

/** Today's remaining budget, for status output. */
export async function spendStatus(
  address: string,
  policy: DirectPaymentPolicy
): Promise<{ enabled: boolean; day: string; sats: { spent: bigint; remaining: bigint }; ustx: { spent: bigint; remaining: bigint } }> {
  const day = utcDay();
  const today = policy.spend.enabled
    ? readDay(policy.spendStateFile, await readStateFile(policy.spendStateFile), address, day)
    : { sats: 0n, ustx: 0n };
  const rem = (cap: bigint, spent: bigint) => (cap > spent ? cap - spent : 0n);
  return {
    enabled: policy.spend.enabled,
    day,
    sats: { spent: today.sats, remaining: rem(policy.spend.dailySats, today.sats) },
    ustx: { spent: today.ustx, remaining: rem(policy.spend.dailyUstx, today.ustx) },
  };
}
