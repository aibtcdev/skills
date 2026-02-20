import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  signMessageHashRsv,
  privateKeyToPublic,
  compressPublicKey,
  serializeCV,
  tupleCV,
  stringAsciiCV,
  uintCV,
  principalCV,
  type ClarityValue,
} from "@stacks/transactions";
import { encrypt, decrypt } from "../utils/encryption.js";
import type { EncryptedData } from "../utils/encryption.js";

// ============================================================================
// Types
// ============================================================================

interface SigningKeySession {
  keyId: string;
  privateKey: string; // 64-char hex (32 bytes)
  pubkey: string; // 66-char hex (33 bytes compressed)
  smartWallet: string; // e.g. "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.beta-v2-wallet"
  unlockedAt: Date;
  expiresAt: Date | null;
}

export interface SigningKeyMetadata {
  id: string;
  pubkey: string; // Hex-encoded 33-byte compressed pubkey
  smartWallet: string;
  createdAt: string;
}

interface SigningKeyIndex {
  version: number;
  keys: SigningKeyMetadata[];
}

interface SigningKeyKeystoreFile {
  version: number;
  encrypted: EncryptedData;
  pubkey: string; // 66-char hex compressed pubkey (for verification without decryption)
}

export interface SigAuth {
  authId: number;
  signature: string; // 130-char hex (65 bytes RSV)
  pubkey: string; // 66-char hex (33 bytes compressed)
}

/**
 * Generate a unique auth-id for each signature, matching frontend convention.
 * Production frontend uses Date.now() — a millisecond timestamp that is
 * effectively unique per operation. The contract only checks that the
 * resulting message-hash hasn't been used before (stored in
 * used-pubkey-authorizations). Since auth-id is part of the hash,
 * different timestamps produce different hashes, allowing repeated
 * operations with the same parameters.
 */
export function generateAuthId(): number {
  return Date.now();
}

// ============================================================================
// SIP-018 hash construction (ported from frontend turnkey-signing.ts)
// ============================================================================

const SIP018_MSG_PREFIX = Buffer.from("534950303138", "hex"); // "SIP018"

function sha256(data: Uint8Array): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

/**
 * Build SIP-018 domain hash for a smart wallet.
 * Domain = sha256(serializeCV({ name, version, chain-id, wallet }))
 */
function getDomainHash(walletAddress: string): Buffer {
  const domainTuple = tupleCV({
    name: stringAsciiCV("smart-wallet-standard"),
    version: stringAsciiCV("1.0.0"),
    "chain-id": uintCV(1), // mainnet
    wallet: principalCV(walletAddress),
  });
  const serialized = serializeCV(domainTuple);
  const serializedBytes =
    typeof serialized === "string"
      ? hexToBytes(serialized)
      : Buffer.from(serialized);
  return sha256(serializedBytes);
}

/**
 * Build a complete SIP-018 message hash.
 *
 * hash = sha256( SIP018_PREFIX || domainHash || sha256(structuredDataBytes) )
 *
 * This matches the frontend's buildSIP018Hash() in turnkey-signing.ts
 * and the on-chain auth-helpers-v3 contract's hash construction.
 */
export function buildSIP018Hash(
  walletAddress: string,
  structuredDataCV: ClarityValue
): string {
  const domainHash = getDomainHash(walletAddress);

  const serialized = serializeCV(structuredDataCV);
  const serializedBytes =
    typeof serialized === "string"
      ? hexToBytes(serialized)
      : Buffer.from(serialized);
  const structuredDataHash = sha256(serializedBytes);

  const combined = Buffer.concat([
    SIP018_MSG_PREFIX,
    domainHash,
    structuredDataHash,
  ]);

  return sha256(combined).toString("hex");
}

// ============================================================================
// Storage paths
// ============================================================================

const STORAGE_DIR = path.join(os.homedir(), ".aibtc");
const SIGNING_KEYS_DIR = path.join(STORAGE_DIR, "signing-keys");
const SIGNING_KEYS_INDEX_FILE = path.join(STORAGE_DIR, "signing-keys.json");

// ============================================================================
// Service
// ============================================================================

class SigningKeyService {
  private static instance: SigningKeyService;
  private session: SigningKeySession | null = null;
  private lockTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  private constructor() {}

  static getInstance(): SigningKeyService {
    if (!SigningKeyService.instance) {
      SigningKeyService.instance = new SigningKeyService();
    }
    return SigningKeyService.instance;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await fs.mkdir(SIGNING_KEYS_DIR, { recursive: true, mode: 0o700 });
      try {
        await fs.access(SIGNING_KEYS_INDEX_FILE);
      } catch {
        const defaultIndex: SigningKeyIndex = { version: 1, keys: [] };
        await this.writeIndex(defaultIndex);
      }
      this.initialized = true;
    }
  }

  // --------------------------------------------------------------------------
  // Index I/O
  // --------------------------------------------------------------------------

  private async readIndex(): Promise<SigningKeyIndex> {
    try {
      const content = await fs.readFile(SIGNING_KEYS_INDEX_FILE, "utf8");
      return JSON.parse(content) as SigningKeyIndex;
    } catch {
      return { version: 1, keys: [] };
    }
  }

  private async writeIndex(index: SigningKeyIndex): Promise<void> {
    const tempFile = `${SIGNING_KEYS_INDEX_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(index, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tempFile, SIGNING_KEYS_INDEX_FILE);
  }

  // --------------------------------------------------------------------------
  // Keystore I/O
  // --------------------------------------------------------------------------

  private getKeystorePath(keyId: string): string {
    return path.join(SIGNING_KEYS_DIR, keyId, "keystore.json");
  }

  private async readKeystore(keyId: string): Promise<SigningKeyKeystoreFile> {
    const content = await fs.readFile(this.getKeystorePath(keyId), "utf8");
    return JSON.parse(content) as SigningKeyKeystoreFile;
  }

  private async writeKeystore(
    keyId: string,
    keystore: SigningKeyKeystoreFile
  ): Promise<void> {
    const keyDir = path.join(SIGNING_KEYS_DIR, keyId);
    await fs.mkdir(keyDir, { recursive: true, mode: 0o700 });

    const keystorePath = this.getKeystorePath(keyId);
    const tempFile = `${keystorePath}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(keystore, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tempFile, keystorePath);
  }

  // --------------------------------------------------------------------------
  // Key management
  // --------------------------------------------------------------------------

  async generateKey(
    password: string,
    smartWallet: string
  ): Promise<{ keyId: string; pubkey: string }> {
    await this.ensureInitialized();

    const privateKeyHex = crypto.randomBytes(32).toString("hex");
    return this.storeKey(privateKeyHex, password, smartWallet);
  }

  async importKey(
    privateKeyHex: string,
    password: string,
    smartWallet: string
  ): Promise<{ keyId: string; pubkey: string }> {
    await this.ensureInitialized();

    if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
      throw new Error(
        "Invalid private key: must be 64 hex characters (32 bytes)"
      );
    }

    return this.storeKey(privateKeyHex, password, smartWallet);
  }

  private async storeKey(
    privateKeyHex: string,
    password: string,
    smartWallet: string
  ): Promise<{ keyId: string; pubkey: string }> {
    const uncompressedPubkey = privateKeyToPublic(privateKeyHex);
    const compressedPubkey = compressPublicKey(uncompressedPubkey);

    const encrypted = await encrypt(privateKeyHex, password);
    const keyId = crypto.randomUUID();

    const keystore: SigningKeyKeystoreFile = {
      version: 1,
      encrypted,
      pubkey: compressedPubkey,
    };
    await this.writeKeystore(keyId, keystore);

    const index = await this.readIndex();
    index.keys.push({
      id: keyId,
      pubkey: compressedPubkey,
      smartWallet,
      createdAt: new Date().toISOString(),
    });
    await this.writeIndex(index);

    return { keyId, pubkey: compressedPubkey };
  }

  async unlock(keyId: string, password: string): Promise<void> {
    await this.ensureInitialized();

    const index = await this.readIndex();
    const keyMeta = index.keys.find((k) => k.id === keyId);
    if (!keyMeta) {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    let keystore: SigningKeyKeystoreFile;
    try {
      keystore = await this.readKeystore(keyId);
    } catch {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    let privateKeyHex: string;
    try {
      privateKeyHex = await decrypt(keystore.encrypted, password);
    } catch {
      throw new Error("Invalid password");
    }

    const now = new Date();
    this.session = {
      keyId,
      privateKey: privateKeyHex,
      pubkey: keystore.pubkey,
      smartWallet: keyMeta.smartWallet,
      unlockedAt: now,
      expiresAt: null,
    };

    this.clearAutoLockTimer();
  }

  lock(): void {
    this.clearAutoLockTimer();
    if (this.session) {
      this.session = null;
    }
  }

  getActiveKey(): SigningKeySession | null {
    if (!this.session) {
      return null;
    }
    if (this.session.expiresAt && new Date() > this.session.expiresAt) {
      this.lock();
      return null;
    }
    return this.session;
  }

  async listKeys(): Promise<SigningKeyMetadata[]> {
    await this.ensureInitialized();
    const index = await this.readIndex();
    return index.keys;
  }

  async updateKeyWallet(keyId: string, smartWallet: string): Promise<void> {
    await this.ensureInitialized();

    const index = await this.readIndex();
    const keyMeta = index.keys.find((k) => k.id === keyId);
    if (!keyMeta) {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    keyMeta.smartWallet = smartWallet;
    await this.writeIndex(index);

    // Update active session if this key is unlocked
    if (this.session?.keyId === keyId) {
      this.session.smartWallet = smartWallet;
    }
  }

  async deleteKey(keyId: string, password: string): Promise<void> {
    await this.ensureInitialized();

    const index = await this.readIndex();
    const keyMeta = index.keys.find((k) => k.id === keyId);
    if (!keyMeta) {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    let keystore: SigningKeyKeystoreFile;
    try {
      keystore = await this.readKeystore(keyId);
    } catch {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    try {
      await decrypt(keystore.encrypted, password);
    } catch {
      throw new Error("Invalid password");
    }

    if (this.session?.keyId === keyId) {
      this.lock();
    }

    const keyDir = path.join(SIGNING_KEYS_DIR, keyId);
    await fs.rm(keyDir, { recursive: true, force: true });

    index.keys = index.keys.filter((k) => k.id !== keyId);
    await this.writeIndex(index);
  }

  async exportKey(keyId: string, password: string): Promise<string> {
    await this.ensureInitialized();

    const index = await this.readIndex();
    const keyMeta = index.keys.find((k) => k.id === keyId);
    if (!keyMeta) {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    let keystore: SigningKeyKeystoreFile;
    try {
      keystore = await this.readKeystore(keyId);
    } catch {
      throw new Error(`Signing key not found: ${keyId}`);
    }

    try {
      return await decrypt(keystore.encrypted, password);
    } catch {
      throw new Error("Invalid password");
    }
  }

  // --------------------------------------------------------------------------
  // SIP-018 signing (off-chain, matching frontend turnkey-signing.ts)
  // --------------------------------------------------------------------------

  /**
   * Build a SIP-018 message hash locally and sign it.
   *
   * This constructs the hash entirely off-chain using the same algorithm
   * as the frontend's turnkey-signing.ts: sha256(SIP018_PREFIX || domainHash || sha256(structuredData))
   *
   * No on-chain read-only calls needed.
   */
  sign(structuredDataCV: ClarityValue, authId: number): SigAuth {
    const session = this.getActiveKey();
    if (!session) {
      throw new Error("Signing key locked. Use pillar_key_unlock first.");
    }

    // Build hash off-chain (same as frontend)
    const messageHash = buildSIP018Hash(session.smartWallet, structuredDataCV);

    // Sign with signMessageHashRsv — returns 65-byte recoverable signature as hex
    const signature = signMessageHashRsv({
      messageHash,
      privateKey: session.privateKey,
    });

    return {
      authId,
      signature,
      pubkey: session.pubkey,
    };
  }

  // --------------------------------------------------------------------------
  // Auto-lock
  // --------------------------------------------------------------------------

  private clearAutoLockTimer(): void {
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }
}

// ============================================================================
// Singleton export
// ============================================================================

export function getSigningKeyService(): SigningKeyService {
  return SigningKeyService.getInstance();
}
