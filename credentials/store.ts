/**
 * Credential store core implementation.
 * AES-256-GCM encrypted credential storage with PBKDF2 key derivation.
 *
 * Storage: ~/.aibtc/credentials.json
 * Encryption: AES-256-GCM, PBKDF2-SHA256 (100k iterations), per-credential salt + IV
 * Dependencies: Node.js crypto module only — no external packages, no src/lib imports
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type {
  CredentialStore,
  EncryptedCredential,
  CredentialMeta,
  DecryptedCredential,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_DIR = path.join(os.homedir(), ".aibtc");
const CREDENTIALS_FILE = path.join(STORAGE_DIR, "credentials.json");

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LEN = 32; // 256 bits for AES-256
const PBKDF2_DIGEST = "sha256";
const IV_BYTES = 12; // GCM recommended IV length (96 bits)
const SALT_BYTES = 32; // 256-bit salt per credential
const STORE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES-256 key from a password and base64-encoded salt.
 * Uses PBKDF2-SHA256 with 100,000 iterations.
 */
function deriveKey(password: string, saltBase64: string): Buffer {
  const salt = Buffer.from(saltBase64, "base64");
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    PBKDF2_DIGEST
  );
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext value with AES-256-GCM.
 * Generates a fresh random IV and salt for each call.
 *
 * Returns the base64-encoded encrypted, iv, salt, and tag fields
 * suitable for merging into an EncryptedCredential.
 */
function encryptValue(
  value: string,
  password: string
): Pick<EncryptedCredential, "encrypted" | "iv" | "salt" | "tag"> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const saltBase64 = salt.toString("base64");

  const key = deriveKey(password, saltBase64);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encryptedBuf = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encryptedBuf.toString("base64"),
    iv: iv.toString("base64"),
    salt: saltBase64,
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt an EncryptedCredential's value using the provided password.
 * Throws on wrong password or corrupted data (GCM auth tag mismatch).
 */
function decryptValue(cred: EncryptedCredential, password: string): string {
  const key = deriveKey(password, cred.salt);
  const iv = Buffer.from(cred.iv, "base64");
  const ciphertext = Buffer.from(cred.encrypted, "base64");
  const tag = Buffer.from(cred.tag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error(
      "Decryption failed — invalid password or corrupted credential data"
    );
  }
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

/**
 * Read the credential store from disk.
 * Returns an empty store (version: 1, credentials: {}) if the file does not exist.
 */
export async function readStore(): Promise<CredentialStore> {
  try {
    const content = await fs.readFile(CREDENTIALS_FILE, "utf8");
    return JSON.parse(content) as CredentialStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: STORE_VERSION, credentials: {} };
    }
    throw err;
  }
}

/**
 * Write the credential store to disk atomically.
 * Uses a temp file + rename to avoid partial writes.
 * File is written with mode 0o600 (owner read/write only).
 */
async function writeStore(store: CredentialStore): Promise<void> {
  // Ensure storage directory exists
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const tempFile = `${CREDENTIALS_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempFile, CREDENTIALS_FILE);
}

// ---------------------------------------------------------------------------
// ID normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a credential ID: lowercase, replace spaces/underscores with hyphens,
 * strip any character that is not alphanumeric or a hyphen.
 */
export function normalizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Add or update a credential in the store.
 * Encrypts the value with AES-256-GCM using the provided password.
 *
 * If a credential with the same normalized ID already exists, it is replaced.
 * The createdAt timestamp is preserved on update; updatedAt is always set to now.
 */
export async function addCredential(
  id: string,
  value: string,
  password: string,
  label?: string,
  category?: string
): Promise<EncryptedCredential> {
  const normalId = normalizeId(id);
  if (!normalId) {
    throw new Error("Credential ID must contain at least one alphanumeric character");
  }

  const store = await readStore();
  const existing = store.credentials[normalId];
  const now = new Date().toISOString();

  const encrypted = encryptValue(value, password);

  const credential: EncryptedCredential = {
    id: normalId,
    label: label ?? existing?.label ?? normalId,
    category: category ?? existing?.category ?? "secret",
    ...encrypted,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.credentials[normalId] = credential;
  await writeStore(store);

  return credential;
}

/**
 * Retrieve and decrypt a credential by ID.
 * Throws if the credential does not exist or the password is wrong.
 */
export async function getCredential(
  id: string,
  password: string
): Promise<DecryptedCredential> {
  const normalId = normalizeId(id);
  const store = await readStore();
  const cred = store.credentials[normalId];

  if (!cred) {
    throw new Error(`Credential not found: ${normalId}`);
  }

  const value = decryptValue(cred, password);

  return {
    id: cred.id,
    label: cred.label,
    category: cred.category,
    value,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
}

/**
 * List all credentials as metadata (no decryption, no sensitive values).
 * Returns an array sorted by createdAt ascending.
 */
export async function listCredentials(): Promise<CredentialMeta[]> {
  const store = await readStore();
  return Object.values(store.credentials)
    .map(({ id, label, category, createdAt, updatedAt }) => ({
      id,
      label,
      category,
      createdAt,
      updatedAt,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Delete a credential by ID.
 * Verifies the password by successfully decrypting the credential first,
 * then removes it from the store.
 *
 * Throws if the credential does not exist or the password is wrong.
 */
export async function deleteCredential(
  id: string,
  password: string
): Promise<void> {
  const normalId = normalizeId(id);
  const store = await readStore();
  const cred = store.credentials[normalId];

  if (!cred) {
    throw new Error(`Credential not found: ${normalId}`);
  }

  // Verify password before deleting
  decryptValue(cred, password);

  delete store.credentials[normalId];
  await writeStore(store);
}

/**
 * Rotate the master password by re-encrypting all credentials.
 * Decrypts every credential with the old password and re-encrypts with the new one.
 * Writes atomically — if any step fails, the original store is preserved.
 *
 * Returns the count of credentials re-encrypted.
 */
export async function rotatePassword(
  oldPassword: string,
  newPassword: string
): Promise<number> {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("New password must be at least 8 characters");
  }

  const store = await readStore();
  const ids = Object.keys(store.credentials);

  if (ids.length === 0) {
    return 0;
  }

  // Decrypt all with old password first — validates oldPassword before mutating
  const decrypted: Array<{ id: string; value: string }> = [];
  for (const id of ids) {
    const cred = store.credentials[id];
    const value = decryptValue(cred, oldPassword); // throws on wrong password
    decrypted.push({ id, value });
  }

  // Re-encrypt all with new password
  const now = new Date().toISOString();
  for (const { id, value } of decrypted) {
    const cred = store.credentials[id];
    const reEncrypted = encryptValue(value, newPassword);
    store.credentials[id] = {
      ...cred,
      ...reEncrypted,
      updatedAt: now,
    };
  }

  await writeStore(store);
  return ids.length;
}
