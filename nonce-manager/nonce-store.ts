// nonce-manager/nonce-store.ts
// Atomic nonce oracle for Stacks transactions.
// Uses mkdir-based file locking for cross-process safety.
// State stored at ~/.aibtc/nonce-state.json for cross-tool sharing.

import {
  mkdirSync,
  rmdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const AIBTC_DIR = join(homedir(), ".aibtc");
const STATE_PATH = join(AIBTC_DIR, "nonce-state.json");
const LOCK_DIR = join(AIBTC_DIR, "nonce-state.lock");
const HIRO_API = "https://api.hiro.so";

/** How old (ms) state can be before auto-resyncing from Hiro */
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** Lock timeout: stale locks older than this are force-removed */
const LOCK_STALE_MS = 30_000; // 30 seconds

/** Max retries to acquire file lock */
const LOCK_MAX_RETRIES = 6;

/** Delay between lock retries (ms) */
const LOCK_RETRY_DELAY_MS = 500;

// ---- Types ----

interface NonceEntry {
  nextNonce: number;
  lastSynced: string;
  lastAcquired: string;
  mempoolPending: number;
  lastExecutedNonce: number | null;
}

interface NonceState {
  [address: string]: NonceEntry;
}

export interface AcquireResult {
  nonce: number;
  address: string;
  source: "local" | "hiro";
}

export interface SyncResult {
  nonce: number;
  address: string;
  mempoolPending: number;
  lastExecuted: number | null;
  detectedMissing: number[];
}

export interface ReleaseResult {
  address: string;
  nonce: number;
  action: "confirmed" | "rolled_back" | "noted";
}

/**
 * Whether a nonce was consumed (broadcast to mempool) or can be reused (never broadcast).
 * - "broadcast": tx reached mempool — nonce consumed even if tx later fails on-chain.
 *   Do NOT roll back. Mempool limit is 25 per address; we can queue beyond that locally.
 * - "rejected": tx never reached mempool (signing error, relay rejection before broadcast,
 *   SENDER_NONCE_STALE, SENDER_NONCE_GAP). Nonce was NOT consumed and can be reused.
 */
export type FailureKind = "broadcast" | "rejected";

// ---- Storage Directory ----

function ensureStorageDir(): void {
  if (!existsSync(AIBTC_DIR)) {
    mkdirSync(AIBTC_DIR, { recursive: true });
  }
}

// ---- File Locking ----

function acquireLock(): boolean {
  try {
    ensureStorageDir();
    mkdirSync(LOCK_DIR);
    // Write PID for stale detection
    writeFileSync(resolve(LOCK_DIR, "pid"), process.pid.toString());
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    const pidFile = resolve(LOCK_DIR, "pid");
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
    rmdirSync(LOCK_DIR);
  } catch {
    // Best effort
  }
}

function isLockStale(): boolean {
  try {
    const stat = statSync(LOCK_DIR);
    return Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function forceReleaseLock(): void {
  try {
    const pidFile = resolve(LOCK_DIR, "pid");
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
    rmdirSync(LOCK_DIR);
  } catch {
    // Best effort
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (acquireLock()) {
      try {
        return await fn();
      } finally {
        releaseLock();
      }
    }

    // Check for stale lock
    if (isLockStale()) {
      forceReleaseLock();
      continue;
    }

    // Wait and retry
    await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }

  throw new Error(`Failed to acquire nonce lock after ${LOCK_MAX_RETRIES} attempts`);
}

// ---- State Persistence ----

function readState(): NonceState {
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as NonceState;
  } catch {
    return {};
  }
}

function writeState(state: NonceState): void {
  ensureStorageDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---- Hiro API ----

interface HiroNonceResponse {
  possible_next_nonce: number;
  last_executed_tx_nonce: number | null;
  detected_mempool_nonces: number[];
  detected_missing_nonces: number[];
}

async function fetchHiroNonce(address: string): Promise<HiroNonceResponse> {
  const url = `${HIRO_API}/extended/v1/address/${address}/nonces`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hiro nonce fetch failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as HiroNonceResponse;
}

function isStale(entry: NonceEntry): boolean {
  const lastSync = new Date(entry.lastSynced).getTime();
  return Date.now() - lastSync > STALE_THRESHOLD_MS;
}

// ---- Public API ----

/**
 * Acquire the next nonce for an address. Atomically increments the stored value.
 * Auto-syncs from Hiro if state is missing or stale (>5 min).
 */
export async function acquireNonce(address: string): Promise<AcquireResult> {
  return withLock(async () => {
    const state = readState();
    let entry = state[address];
    let source: "local" | "hiro" = "local";

    // Auto-sync if missing or stale
    if (!entry || isStale(entry)) {
      const hiro = await fetchHiroNonce(address);
      entry = {
        nextNonce: hiro.possible_next_nonce,
        lastSynced: new Date().toISOString(),
        lastAcquired: new Date().toISOString(),
        mempoolPending: hiro.detected_mempool_nonces?.length ?? 0,
        lastExecutedNonce: hiro.last_executed_tx_nonce,
      };
      state[address] = entry;
      source = "hiro";
    }

    const nonce = entry.nextNonce;

    // Increment for next caller
    entry.nextNonce = nonce + 1;
    entry.lastAcquired = new Date().toISOString();
    writeState(state);

    return { nonce, address, source };
  });
}

/**
 * Release a nonce after transaction outcome is known.
 *
 * @param success - true if tx succeeded (nonce consumed)
 * @param failureKind - when success=false:
 *   "broadcast" = tx reached mempool, nonce consumed (on-chain failure still uses nonce)
 *   "rejected" = tx never broadcast (signing error, relay pre-broadcast rejection),
 *                nonce NOT consumed and can be reused
 *   Defaults to "broadcast" if omitted — safer to assume nonce was consumed.
 */
export async function releaseNonce(
  address: string,
  nonce: number,
  success: boolean,
  failureKind?: FailureKind
): Promise<ReleaseResult> {
  return withLock(async () => {
    const state = readState();
    const entry = state[address];

    if (!entry) {
      return { address, nonce, action: "noted" as const };
    }

    if (success) {
      return { address, nonce, action: "confirmed" as const };
    }

    // Only roll back if tx was rejected before broadcast (nonce not consumed).
    // Default to "broadcast" (nonce consumed) if caller doesn't specify — safer.
    const kind = failureKind ?? "broadcast";
    if (kind === "rejected" && entry.nextNonce === nonce + 1) {
      entry.nextNonce = nonce;
      writeState(state);
      return { address, nonce, action: "rolled_back" as const };
    }

    // Nonce was consumed (broadcast) or can't roll back (another was acquired after)
    return { address, nonce, action: "noted" as const };
  });
}

/**
 * Force re-sync nonce state from Hiro API.
 */
export async function syncNonce(address: string): Promise<SyncResult> {
  return withLock(async () => {
    const state = readState();
    const hiro = await fetchHiroNonce(address);

    state[address] = {
      nextNonce: hiro.possible_next_nonce,
      lastSynced: new Date().toISOString(),
      lastAcquired: state[address]?.lastAcquired ?? new Date().toISOString(),
      mempoolPending: hiro.detected_mempool_nonces?.length ?? 0,
      lastExecutedNonce: hiro.last_executed_tx_nonce,
    };
    writeState(state);

    return {
      nonce: hiro.possible_next_nonce,
      address,
      mempoolPending: hiro.detected_mempool_nonces?.length ?? 0,
      lastExecuted: hiro.last_executed_tx_nonce,
      detectedMissing: hiro.detected_missing_nonces ?? [],
    };
  });
}

/**
 * Get current nonce state for an address (or all addresses).
 */
export function getStatus(address?: string): NonceState | NonceEntry | null {
  const state = readState();
  if (address) {
    return state[address] ?? null;
  }
  return state;
}
