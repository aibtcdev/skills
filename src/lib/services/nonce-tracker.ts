/**
 * Shared Nonce Tracker
 *
 * Cross-process nonce oracle for Stacks transactions. Prevents mempool
 * collisions when multiple agents or skills send transactions concurrently.
 *
 * Primary API: acquireNonce / releaseNonce / syncNonce / getStatus
 * Compat API: getTrackedNonce / recordNonceUsed / reconcileWithChain
 *             (thin wrappers so existing callers like x402-retry don't break)
 *
 * Design:
 * - mkdir-based file lock for cross-process atomicity
 * - Atomic temp+rename writes to prevent corruption
 * - Auto-sync from Hiro when state is stale (>90s)
 * - Acquire/release lifecycle: acquire increments, release records outcome
 * - Rejected nonces can be rolled back; broadcast nonces are consumed
 *
 * State file: ~/.aibtc/nonce-state.json (shared with aibtc-mcp-server)
 *
 * @see https://github.com/aibtcdev/aibtc-mcp-server/issues/413
 * @see https://github.com/aibtcdev/skills/issues/240
 */

import {
  mkdirSync,
  rmdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { getHiroApi, type NonceInfo } from "./hiro-api.js";
import { NETWORK } from "../config/networks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A record of a single submitted transaction. */
export interface PendingTxRecord {
  nonce: number;
  txid: string;
  timestamp: string; // ISO-8601
}

/** Per-address nonce state. */
export interface AddressNonceState {
  /** The next nonce to acquire (i.e. one past the highest assigned). */
  nextNonce: number;
  /** ISO-8601 timestamp of the last state change. */
  lastUpdated: string;
  /** ISO-8601 timestamp of the last Hiro sync. */
  lastSynced: string;
  /** Last executed nonce from Hiro (for diagnostics). */
  lastExecutedNonce: number | null;
  /** Count of mempool-pending txs at last sync. */
  mempoolPending: number;
  /** Rolling log of recent submissions (bounded to MAX_PENDING_LOG). */
  pending: PendingTxRecord[];
}

/** On-disk file format. */
export interface NonceStateFile {
  version: number;
  addresses: Record<string, AddressNonceState>;
}

/** Acquire result returned by acquireNonce. */
export interface AcquireResult {
  nonce: number;
  address: string;
  source: "local" | "hiro";
}

/** Sync result returned by syncNonce. */
export interface SyncResult {
  nonce: number;
  address: string;
  mempoolPending: number;
  lastExecuted: number | null;
  detectedMissing: number[];
}

/** Release result returned by releaseNonce. */
export interface ReleaseResult {
  address: string;
  nonce: number;
  action: "confirmed" | "rolled_back" | "noted";
}

/**
 * Whether a nonce was consumed (broadcast to mempool) or can be reused.
 * - "broadcast": tx reached mempool — nonce consumed even if tx fails on-chain
 * - "rejected": tx never reached mempool — nonce NOT consumed, safe to reuse
 */
export type FailureKind = "broadcast" | "rejected";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".aibtc");
const DEFAULT_NONCE_STATE_FILE = path.join(DEFAULT_STORAGE_DIR, "nonce-state.json");
const LOCK_DIR = path.join(DEFAULT_STORAGE_DIR, "nonce-state.lock");

/** Mutable path — overridable via _testing.setStateFilePath() for test isolation. */
let NONCE_STATE_FILE = DEFAULT_NONCE_STATE_FILE;
const CURRENT_VERSION = 2;

/**
 * How long locally-tracked state is considered fresh before auto-syncing.
 * 90 seconds — ~15-30 Stacks blocks post-Nakamoto (3-5s block time).
 */
export const STALE_NONCE_MS = 90 * 1000;

/** Maximum pending tx records kept per address. */
const MAX_PENDING_LOG = 50;

/** Maximum addresses tracked. Oldest evicted when exceeded. */
const MAX_ADDRESSES = 100;

/** Lock timeout: stale locks older than this are force-removed. */
const LOCK_STALE_MS = 30_000;

/** Max retries to acquire file lock. */
const LOCK_MAX_RETRIES = 6;

/** Delay between lock retries (ms). */
const LOCK_RETRY_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Cross-process file locking (mkdir-based)
// ---------------------------------------------------------------------------

function tryAcquireLock(): boolean {
  try {
    if (!existsSync(DEFAULT_STORAGE_DIR)) {
      mkdirSync(DEFAULT_STORAGE_DIR, { recursive: true });
    }
    mkdirSync(LOCK_DIR);
    writeFileSync(path.resolve(LOCK_DIR, "pid"), process.pid.toString());
    return true;
  } catch {
    return false;
  }
}

function releaseLockDir(): void {
  try {
    const pidFile = path.resolve(LOCK_DIR, "pid");
    if (existsSync(pidFile)) unlinkSync(pidFile);
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

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (tryAcquireLock()) {
      try {
        return await fn();
      } finally {
        releaseLockDir();
      }
    }
    if (isLockStale()) {
      releaseLockDir();
      continue;
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }
  throw new Error(`Failed to acquire nonce lock after ${LOCK_MAX_RETRIES} attempts`);
}

// ---------------------------------------------------------------------------
// File I/O (atomic temp+rename, 0o600 perms)
// ---------------------------------------------------------------------------

function readStateFileSync(): NonceStateFile {
  try {
    const content = readFileSync(NONCE_STATE_FILE, "utf8");
    const parsed = JSON.parse(content);
    // Migrate v1 → v2
    if (parsed.version === 1 && typeof parsed.addresses === "object") {
      return migrateV1toV2(parsed);
    }
    if (parsed.version === CURRENT_VERSION && typeof parsed.addresses === "object") {
      return parsed as NonceStateFile;
    }
    // Unversioned (raw address map from early implementations) — discard
    return createDefaultState();
  } catch {
    return createDefaultState();
  }
}

function writeStateFileSync(state: NonceStateFile): void {
  const dir = path.dirname(NONCE_STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tempFile = `${NONCE_STATE_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  // Atomic rename — prevents corruption if process crashes mid-write
  renameSync(tempFile, NONCE_STATE_FILE);
}

function createDefaultState(): NonceStateFile {
  return { version: CURRENT_VERSION, addresses: {} };
}

/** Migrate v1 schema (lastUsedNonce) to v2 (nextNonce). */
function migrateV1toV2(v1: {
  version: 1;
  addresses: Record<string, { lastUsedNonce: number; lastUpdated: string; pending: PendingTxRecord[] }>;
}): NonceStateFile {
  const v2 = createDefaultState();
  for (const [addr, entry] of Object.entries(v1.addresses)) {
    v2.addresses[addr] = {
      nextNonce: entry.lastUsedNonce + 1,
      lastUpdated: entry.lastUpdated,
      lastSynced: entry.lastUpdated,
      lastExecutedNonce: null,
      mempoolPending: 0,
      pending: entry.pending ?? [],
    };
  }
  return v2;
}

// ---------------------------------------------------------------------------
// Hiro API integration
// ---------------------------------------------------------------------------

async function fetchNonceInfo(address: string): Promise<NonceInfo> {
  const hiroApi = getHiroApi(NETWORK);
  return hiroApi.getNonceInfo(address);
}

function isStale(entry: AddressNonceState): boolean {
  const lastSync = new Date(entry.lastSynced).getTime();
  return Date.now() - lastSync > STALE_NONCE_MS;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function evictOldestAddresses(state: NonceStateFile): void {
  const entries = Object.entries(state.addresses);
  if (entries.length <= MAX_ADDRESSES) return;
  entries.sort((a, b) => new Date(a[1].lastUpdated).getTime() - new Date(b[1].lastUpdated).getTime());
  state.addresses = Object.fromEntries(entries.slice(entries.length - MAX_ADDRESSES));
}

// ---------------------------------------------------------------------------
// Primary API: acquire / release / sync / status
// ---------------------------------------------------------------------------

/**
 * Acquire the next nonce for an address. Atomically increments the stored
 * value under a cross-process file lock. Auto-syncs from Hiro if state
 * is missing or stale.
 */
export async function acquireNonce(address: string): Promise<AcquireResult> {
  return withLock(async () => {
    const state = readStateFileSync();
    let entry = state.addresses[address];
    let source: "local" | "hiro" = "local";

    if (!entry || isStale(entry)) {
      const hiro = await fetchNonceInfo(address);
      const now = new Date().toISOString();
      entry = {
        nextNonce: hiro.possible_next_nonce,
        lastUpdated: now,
        lastSynced: now,
        lastExecutedNonce: hiro.last_executed_tx_nonce,
        mempoolPending: hiro.detected_mempool_nonces?.length ?? 0,
        pending: entry?.pending ?? [],
      };
      state.addresses[address] = entry;
      evictOldestAddresses(state);
      source = "hiro";
    }

    const nonce = entry.nextNonce;
    entry.nextNonce = nonce + 1;
    entry.lastUpdated = new Date().toISOString();
    writeStateFileSync(state);

    return { nonce, address, source };
  });
}

/**
 * Release a nonce after transaction outcome is known.
 *
 * @param address - Stacks address
 * @param nonce - The nonce that was acquired
 * @param success - true if tx succeeded
 * @param failureKind - "broadcast" (nonce consumed) or "rejected" (nonce reusable)
 * @param txid - Transaction ID (for pending log on success)
 */
export async function releaseNonce(
  address: string,
  nonce: number,
  success: boolean,
  failureKind?: FailureKind,
  txid?: string
): Promise<ReleaseResult> {
  return withLock(async () => {
    const state = readStateFileSync();
    const entry = state.addresses[address];

    if (!entry) {
      return { address, nonce, action: "noted" as const };
    }

    if (success) {
      // Record in pending log
      if (txid) {
        entry.pending.push({ nonce, txid, timestamp: new Date().toISOString() });
        if (entry.pending.length > MAX_PENDING_LOG) {
          entry.pending = entry.pending.slice(-MAX_PENDING_LOG);
        }
      }
      entry.lastUpdated = new Date().toISOString();
      writeStateFileSync(state);
      return { address, nonce, action: "confirmed" as const };
    }

    // Failed: only roll back if rejected AND this was the last acquired nonce
    const kind = failureKind ?? "broadcast";
    if (kind === "rejected" && entry.nextNonce === nonce + 1) {
      entry.nextNonce = nonce;
      entry.lastUpdated = new Date().toISOString();
      writeStateFileSync(state);
      return { address, nonce, action: "rolled_back" as const };
    }

    return { address, nonce, action: "noted" as const };
  });
}

/**
 * Force re-sync nonce state from Hiro API.
 */
export async function syncNonce(address: string): Promise<SyncResult> {
  return withLock(async () => {
    const state = readStateFileSync();
    const hiro = await fetchNonceInfo(address);
    const now = new Date().toISOString();

    state.addresses[address] = {
      nextNonce: hiro.possible_next_nonce,
      lastUpdated: now,
      lastSynced: now,
      lastExecutedNonce: hiro.last_executed_tx_nonce,
      mempoolPending: hiro.detected_mempool_nonces?.length ?? 0,
      pending: state.addresses[address]?.pending ?? [],
    };
    writeStateFileSync(state);

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
 * No lock needed — read-only snapshot.
 */
export function getStatus(address?: string): NonceStateFile | AddressNonceState | null {
  const state = readStateFileSync();
  if (address) {
    return state.addresses[address] ?? null;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Compat API (used by x402-retry.ts)
// ---------------------------------------------------------------------------

/**
 * Get the next nonce without acquiring (read-only, no lock, no increment).
 * Returns null if state is missing or stale.
 *
 * @deprecated Use acquireNonce() for atomic nonce assignment.
 */
export async function getTrackedNonce(address: string): Promise<number | null> {
  const state = readStateFileSync();
  const entry = state.addresses[address];
  if (!entry) return null;
  if (isStale(entry)) return null;
  return entry.nextNonce;
}

/**
 * Record that a nonce was used for a transaction.
 * Equivalent to releaseNonce(address, nonce, true, undefined, txid).
 *
 * @deprecated Use acquireNonce() + releaseNonce() for proper lifecycle.
 */
export async function recordNonceUsed(
  address: string,
  nonce: number,
  txid: string
): Promise<void> {
  await releaseNonce(address, nonce, true, undefined, txid);
}

/**
 * Reconcile local state with chain data.
 * Delegates to syncNonce internally.
 *
 * @deprecated Use syncNonce() directly.
 */
export async function reconcileWithChain(
  address: string,
  _chainNextNonce: number
): Promise<void> {
  await syncNonce(address);
}

/**
 * Reset (clear) nonce state for an address.
 * Called on wallet unlock/lock/switch.
 */
export async function resetTrackedNonce(address: string): Promise<void> {
  await withLock(async () => {
    const state = readStateFileSync();
    delete state.addresses[address];
    writeStateFileSync(state);
  });
}

/**
 * Get the raw state for an address (for diagnostics).
 */
export async function getAddressState(address: string): Promise<AddressNonceState | null> {
  return (getStatus(address) as AddressNonceState | null);
}

/**
 * Get the full state file (for diagnostics).
 */
export async function getFullState(): Promise<NonceStateFile> {
  return readStateFileSync();
}

/**
 * Force reload state from disk.
 * With file locking, this is just a no-op since we always read fresh.
 */
export async function reloadFromDisk(): Promise<void> {
  // No-op: withLock reads fresh from disk each time
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

export const _testing = {
  STALE_NONCE_MS,
  MAX_PENDING_LOG,
  MAX_ADDRESSES,
  get NONCE_STATE_FILE() {
    return NONCE_STATE_FILE;
  },
  setStateFilePath(filePath: string): void {
    NONCE_STATE_FILE = filePath;
  },
  resetStateFilePath(): void {
    NONCE_STATE_FILE = DEFAULT_NONCE_STATE_FILE;
  },
  clearMemory(): void {
    // No-op: no in-memory cache with file-lock model
  },
  getMemoryState(): NonceStateFile | null {
    return readStateFileSync();
  },
};
