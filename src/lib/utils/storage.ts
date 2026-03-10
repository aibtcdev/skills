import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { EncryptedData } from "./encryption.js";
import type { Network } from "../config/networks.js";

/**
 * Storage directory location
 * Migrated from ~/.stx402/ to ~/.aibtc/ in v1.0.0
 */
const OLD_STORAGE_DIR = path.join(os.homedir(), ".stx402");
const STORAGE_DIR = path.join(os.homedir(), ".aibtc");
const WALLETS_DIR = path.join(STORAGE_DIR, "wallets");
const WALLET_INDEX_FILE = path.join(STORAGE_DIR, "wallets.json");
const CONFIG_FILE = path.join(STORAGE_DIR, "config.json");
const SESSIONS_DIR = path.join(STORAGE_DIR, "sessions");
const SESSION_KEY_FILE = path.join(SESSIONS_DIR, ".session-key");

/**
 * Migrate storage from ~/.stx402/ to ~/.aibtc/ (one-time migration)
 */
async function migrateStorage(): Promise<void> {
  try {
    const oldExists = await fs.access(OLD_STORAGE_DIR).then(() => true).catch(() => false);
    const newExists = await fs.access(STORAGE_DIR).then(() => true).catch(() => false);
    if (oldExists && !newExists) {
      await fs.rename(OLD_STORAGE_DIR, STORAGE_DIR);
      console.error(`Migrated wallet storage from ${OLD_STORAGE_DIR} to ${STORAGE_DIR}`);
    }
  } catch (error) {
    console.error(`Failed to migrate storage directory: ${error}`);
  }
}

/**
 * Common address fields for wallet-related types.
 */
export interface WalletAddresses {
  /** Stacks L2 address */
  address: string;
  /** Bitcoin L1 address (P2WPKH - native SegWit) */
  btcAddress?: string;
  /** Bitcoin L1 Taproot address (P2TR - for receiving inscriptions) */
  taprootAddress?: string;
  /** Sponsor relay API key (optional, per-wallet) */
  sponsorApiKey?: string;
}

/**
 * Wallet metadata (stored in index, no sensitive data)
 */
export interface WalletMetadata extends WalletAddresses {
  id: string;
  name: string;
  network: Network;
  createdAt: string;
  lastUsed?: string;
}

/**
 * Wallet index file structure
 */
export interface WalletIndex {
  version: number;
  wallets: WalletMetadata[];
}

/**
 * App configuration
 */
export interface AppConfig {
  version: number;
  activeWalletId: string | null;
  autoLockTimeout: number; // Minutes, 0 = never
  hiroApiKey?: string;
  stacksApiUrl?: string;
}

/**
 * Keystore file structure (contains encrypted mnemonic)
 */
export interface KeystoreFile {
  version: number;
  encrypted: EncryptedData;
  addressIndex: number; // BIP44 address index
}

const CURRENT_INDEX_VERSION = 1;
const CURRENT_CONFIG_VERSION = 1;

/**
 * Get storage directory path
 */
export function getStorageDir(): string {
  return STORAGE_DIR;
}

/**
 * Check if storage directory exists
 */
export async function storageExists(): Promise<boolean> {
  try {
    await fs.access(STORAGE_DIR);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize storage directory structure
 */
export async function initializeStorage(): Promise<void> {
  await migrateStorage();
  // Create directories
  await fs.mkdir(WALLETS_DIR, { recursive: true, mode: 0o700 });

  // Create wallet index if it doesn't exist
  try {
    await fs.access(WALLET_INDEX_FILE);
  } catch {
    const defaultIndex: WalletIndex = {
      version: CURRENT_INDEX_VERSION,
      wallets: [],
    };
    await writeWalletIndex(defaultIndex);
  }

  // Create config if it doesn't exist
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    const defaultConfig: AppConfig = {
      version: CURRENT_CONFIG_VERSION,
      activeWalletId: null,
      autoLockTimeout: 15, // 15 minutes default
    };
    await writeAppConfig(defaultConfig);
  }
}

/**
 * Read wallet index
 */
export async function readWalletIndex(): Promise<WalletIndex> {
  try {
    const content = await fs.readFile(WALLET_INDEX_FILE, "utf8");
    return JSON.parse(content) as WalletIndex;
  } catch {
    return {
      version: CURRENT_INDEX_VERSION,
      wallets: [],
    };
  }
}

/**
 * Write wallet index (atomic write with temp file)
 */
export async function writeWalletIndex(index: WalletIndex): Promise<void> {
  const tempFile = `${WALLET_INDEX_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(index, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempFile, WALLET_INDEX_FILE);
}

/**
 * Read app config
 */
export async function readAppConfig(): Promise<AppConfig> {
  try {
    const content = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(content) as AppConfig;
  } catch {
    return {
      version: CURRENT_CONFIG_VERSION,
      activeWalletId: null,
      autoLockTimeout: 15,
    };
  }
}

/**
 * Write app config (atomic write)
 */
export async function writeAppConfig(config: AppConfig): Promise<void> {
  const tempFile = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempFile, CONFIG_FILE);
}

/**
 * Get keystore file path for a wallet
 */
export function getKeystorePath(walletId: string): string {
  return path.join(WALLETS_DIR, walletId, "keystore.json");
}

/**
 * Read keystore for a wallet
 */
export async function readKeystore(walletId: string): Promise<KeystoreFile> {
  const keystorePath = getKeystorePath(walletId);
  const content = await fs.readFile(keystorePath, "utf8");
  return JSON.parse(content) as KeystoreFile;
}

/**
 * Write keystore for a wallet (creates directory if needed)
 */
export async function writeKeystore(
  walletId: string,
  keystore: KeystoreFile
): Promise<void> {
  const walletDir = path.join(WALLETS_DIR, walletId);
  await fs.mkdir(walletDir, { recursive: true, mode: 0o700 });

  const keystorePath = getKeystorePath(walletId);
  const tempFile = `${keystorePath}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(keystore, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempFile, keystorePath);
}

/**
 * Delete a wallet directory and its contents
 */
export async function deleteWalletStorage(walletId: string): Promise<void> {
  const walletDir = path.join(WALLETS_DIR, walletId);
  await fs.rm(walletDir, { recursive: true, force: true });
}

/**
 * Update wallet metadata in index
 */
export async function updateWalletMetadata(
  walletId: string,
  updates: Partial<WalletMetadata>
): Promise<void> {
  const index = await readWalletIndex();
  const walletIndex = index.wallets.findIndex((w) => w.id === walletId);

  if (walletIndex === -1) {
    throw new Error(`Wallet not found: ${walletId}`);
  }

  index.wallets[walletIndex] = {
    ...index.wallets[walletIndex],
    ...updates,
  };

  await writeWalletIndex(index);
}

/**
 * Add wallet to index
 */
export async function addWalletToIndex(wallet: WalletMetadata): Promise<void> {
  const index = await readWalletIndex();
  index.wallets.push(wallet);
  await writeWalletIndex(index);
}

/**
 * Remove wallet from index
 */
export async function removeWalletFromIndex(walletId: string): Promise<void> {
  const index = await readWalletIndex();
  index.wallets = index.wallets.filter((w) => w.id !== walletId);
  await writeWalletIndex(index);
}

/**
 * Backup keystore file for a wallet (atomic: temp write + rename)
 */
export async function backupKeystore(walletId: string): Promise<void> {
  const keystorePath = getKeystorePath(walletId);
  const backupPath = `${keystorePath}.backup`;
  const tempPath = `${backupPath}.tmp`;
  await fs.copyFile(keystorePath, tempPath);
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, backupPath);
}

/**
 * Restore keystore from backup (atomic: temp write + rename, then delete backup)
 */
export async function restoreKeystoreBackup(walletId: string): Promise<void> {
  const keystorePath = getKeystorePath(walletId);
  const backupPath = `${keystorePath}.backup`;
  const tempPath = `${keystorePath}.tmp`;
  await fs.copyFile(backupPath, tempPath);
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, keystorePath);
  await fs.unlink(backupPath);
}

/**
 * Delete keystore backup file (idempotent — ignores missing file)
 */
export async function deleteKeystoreBackup(walletId: string): Promise<void> {
  const keystorePath = getKeystorePath(walletId);
  const backupPath = `${keystorePath}.backup`;
  try {
    await fs.unlink(backupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ============================================================================
// Session Persistence (cross-process wallet session)
// ============================================================================

/**
 * Serializable session data written to disk.
 * Private keys are stored as hex strings so they round-trip through JSON.
 */
export interface SessionFile {
  version: number;
  walletId: string;
  /** AES-256-GCM encrypted JSON of the account fields */
  encrypted: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  createdAt: string;
  expiresAt: string | null;
}

/**
 * Serialized account payload (private keys as hex).
 * Matches the Account interface from transactions/builder.ts.
 */
interface SerializedAccount {
  address: string;
  btcAddress?: string;
  taprootAddress?: string;
  privateKey: string;
  btcPrivateKey?: string;
  btcPublicKey?: string;
  taprootPrivateKey?: string;
  taprootPublicKey?: string;
  sponsorApiKey?: string;
  network: Network;
}

/**
 * Get or create a machine-local 256-bit session encryption key.
 * The key is stored in ~/.aibtc/sessions/.session-key (mode 0o600).
 * It never leaves the machine and is not derived from the wallet password,
 * so it cannot be used to decrypt the keystore — only the short-lived session file.
 */
async function getOrCreateSessionKey(): Promise<Buffer> {
  // Ensure sessions directory exists
  await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });

  try {
    const raw = await fs.readFile(SESSION_KEY_FILE);
    if (raw.length === 32) return raw;
    // Corrupted — regenerate
  } catch {
    // File does not exist yet
  }

  const key = crypto.randomBytes(32);
  const tempPath = `${SESSION_KEY_FILE}.tmp`;
  await fs.writeFile(tempPath, key, { mode: 0o600 });
  await fs.rename(tempPath, SESSION_KEY_FILE);
  // Read back the winner from disk so racing processes converge on the same key.
  return await fs.readFile(SESSION_KEY_FILE);
}

function getSessionFilePath(walletId: string): string {
  return path.join(SESSIONS_DIR, `${path.basename(walletId)}.json`);
}

/**
 * Write an encrypted session file for the given wallet.
 * accountData contains all private-key material as Uint8Array / Buffer.
 */
export async function writeSessionFile(
  walletId: string,
  accountData: SerializedAccount,
  expiresAt: Date | null
): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });

  const key = await getOrCreateSessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = JSON.stringify(accountData);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const sessionFile: SessionFile = {
    version: 1,
    walletId,
    encrypted: {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    },
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };

  const sessionPath = getSessionFilePath(walletId);
  const tempPath = `${sessionPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(sessionFile, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempPath, sessionPath);
}

/**
 * Read and decrypt a session file.
 * Returns the decrypted account payload and expiry, or null if:
 *   - file does not exist
 *   - session is expired
 *   - decryption fails (tampered or key changed)
 */
export async function readSessionFile(
  walletId: string
): Promise<{ account: SerializedAccount; expiresAt: Date | null } | null> {
  const sessionPath = getSessionFilePath(walletId);

  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, "utf8");
  } catch {
    return null; // File not found
  }

  let sessionFile: SessionFile;
  try {
    sessionFile = JSON.parse(raw) as SessionFile;
  } catch {
    return null; // Corrupted JSON
  }

  if (sessionFile.version !== 1) return null;

  // Check expiry before attempting decryption
  if (sessionFile.expiresAt) {
    const expiresAt = new Date(sessionFile.expiresAt);
    if (new Date() > expiresAt) {
      // Best-effort cleanup of expired session
      await deleteSessionFile(walletId).catch(() => {});
      return null;
    }
  }

  let key: Buffer;
  try {
    key = await getOrCreateSessionKey();
  } catch {
    return null;
  }

  try {
    const iv = Buffer.from(sessionFile.encrypted.iv, "base64");
    const authTag = Buffer.from(sessionFile.encrypted.authTag, "base64");
    const ciphertext = Buffer.from(sessionFile.encrypted.ciphertext, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const account = JSON.parse(decrypted.toString("utf8")) as SerializedAccount;
    const expiresAt = sessionFile.expiresAt ? new Date(sessionFile.expiresAt) : null;
    return { account, expiresAt };
  } catch {
    return null; // Decryption failed — tampered or session key regenerated
  }
}

/**
 * Delete the session file for a wallet (idempotent).
 */
export async function deleteSessionFile(walletId: string): Promise<void> {
  const sessionPath = getSessionFilePath(walletId);
  try {
    await fs.unlink(sessionPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// ============================================================================
// Hiro API Key Management (in-memory cached)
// ============================================================================

let _cachedHiroApiKey: string | null | undefined = undefined; // undefined = not yet loaded

/**
 * Get stored Hiro API key (cached in memory after first read).
 * Returns empty string if no key is stored.
 */
export async function getHiroApiKey(): Promise<string> {
  if (_cachedHiroApiKey !== undefined) return _cachedHiroApiKey || "";
  const config = await readAppConfig();
  _cachedHiroApiKey = config.hiroApiKey || null;
  return _cachedHiroApiKey || "";
}

/**
 * Save Hiro API key to config and update in-memory cache.
 */
export async function setHiroApiKey(key: string): Promise<void> {
  const config = await readAppConfig();
  config.hiroApiKey = key;
  await writeAppConfig(config);
  _cachedHiroApiKey = key;
}

/**
 * Remove Hiro API key from config and clear in-memory cache.
 */
export async function clearHiroApiKey(): Promise<void> {
  const config = await readAppConfig();
  delete config.hiroApiKey;
  await writeAppConfig(config);
  _cachedHiroApiKey = null;
}

// ============================================================================
// Custom Stacks API URL Management (in-memory cached)
// ============================================================================

let _cachedStacksApiUrl: string | null | undefined = undefined; // undefined = not yet loaded

/**
 * Get stored custom Stacks API URL (cached in memory after first read).
 * Returns empty string if no custom URL is stored.
 */
export async function getStacksApiUrl(): Promise<string> {
  if (_cachedStacksApiUrl !== undefined) return _cachedStacksApiUrl || "";
  const config = await readAppConfig();
  _cachedStacksApiUrl = config.stacksApiUrl || null;
  return _cachedStacksApiUrl || "";
}

/**
 * Save custom Stacks API URL to config and update in-memory cache.
 */
export async function setStacksApiUrl(url: string): Promise<void> {
  const config = await readAppConfig();
  config.stacksApiUrl = url;
  await writeAppConfig(config);
  _cachedStacksApiUrl = url;
}

/**
 * Remove custom Stacks API URL from config and clear in-memory cache.
 */
export async function clearStacksApiUrl(): Promise<void> {
  const config = await readAppConfig();
  delete config.stacksApiUrl;
  await writeAppConfig(config);
  _cachedStacksApiUrl = null;
}
