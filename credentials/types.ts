/**
 * TypeScript types for the credentials skill.
 * AES-256-GCM encrypted credential storage at ~/.aibtc/credentials.json
 */

/**
 * A single encrypted credential as stored on disk.
 * All sensitive values are encrypted — only id, label, category, and timestamps
 * are stored in plaintext.
 */
export interface EncryptedCredential {
  /** Normalized credential identifier: lowercase, hyphens only */
  id: string;
  /** Human-readable label (stored plaintext) */
  label: string;
  /** Category tag, e.g., "api-key", "token", "url", "secret" */
  category: string;
  /** AES-256-GCM ciphertext (base64) */
  encrypted: string;
  /** 12-byte GCM initialization vector (base64) */
  iv: string;
  /** 32-byte PBKDF2 salt (base64) — unique per credential */
  salt: string;
  /** 16-byte GCM authentication tag (base64) */
  tag: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-updated timestamp */
  updatedAt: string;
}

/**
 * The top-level structure of ~/.aibtc/credentials.json
 */
export interface CredentialStore {
  version: 1;
  credentials: Record<string, EncryptedCredential>;
}

/**
 * Credential metadata — safe to expose without decryption.
 * Excludes encrypted, iv, salt, and tag fields.
 */
export type CredentialMeta = Omit<
  EncryptedCredential,
  "encrypted" | "iv" | "salt" | "tag"
>;

/**
 * A fully decrypted credential, including the plaintext value.
 */
export interface DecryptedCredential extends CredentialMeta {
  /** Plaintext secret value — handle with care */
  value: string;
}
