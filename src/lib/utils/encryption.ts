import crypto from "crypto";

/**
 * Encrypted data structure with all parameters needed for decryption
 */
export interface EncryptedData {
  ciphertext: string; // Base64-encoded encrypted data
  iv: string; // Base64-encoded initialization vector (12 bytes)
  authTag: string; // Base64-encoded GCM auth tag (16 bytes)
  salt: string; // Base64-encoded Scrypt salt (32 bytes)
  scryptParams: {
    N: number; // CPU/memory cost
    r: number; // Block size
    p: number; // Parallelization
    keyLen: number; // Key length
  };
  version: number; // Schema version for future migrations
}

// Scrypt parameters - memory-hard to resist GPU/ASIC attacks
const SCRYPT_PARAMS = {
  N: 16384, // 2^14 - CPU/memory cost
  r: 8, // Block size
  p: 1, // Parallelization
  keyLen: 32, // 256 bits for AES-256
};

const CURRENT_VERSION = 1;

/**
 * Derive encryption key from password using Scrypt
 */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_PARAMS.keyLen,
      {
        N: SCRYPT_PARAMS.N,
        r: SCRYPT_PARAMS.r,
        p: SCRYPT_PARAMS.p,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

/**
 * Encrypt plaintext with password using AES-256-GCM
 */
export async function encrypt(
  plaintext: string,
  password: string
): Promise<EncryptedData> {
  // Generate random salt and IV
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12); // GCM recommended IV size

  // Derive key from password
  const key = await deriveKey(password, salt);

  // Encrypt with AES-256-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    salt: salt.toString("base64"),
    scryptParams: SCRYPT_PARAMS,
    version: CURRENT_VERSION,
  };
}

/**
 * Decrypt ciphertext with password using AES-256-GCM
 */
export async function decrypt(
  encrypted: EncryptedData,
  password: string
): Promise<string> {
  // Decode from base64
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const salt = Buffer.from(encrypted.salt, "base64");

  // Derive key using stored parameters
  const key = await deriveKeyWithParams(password, salt, encrypted.scryptParams);

  // Decrypt with AES-256-GCM
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error("Decryption failed - invalid password or corrupted data");
  }
}

/**
 * Derive key with custom scrypt parameters (for stored data)
 */
function deriveKeyWithParams(
  password: string,
  salt: Buffer,
  params: EncryptedData["scryptParams"]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keyLen,
      {
        N: params.N,
        r: params.r,
        p: params.p,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

/**
 * Generate cryptographically secure random bytes
 */
export function randomBytes(length: number): Buffer {
  return crypto.randomBytes(length);
}

/**
 * Generate a random UUID for wallet IDs
 */
export function generateWalletId(): string {
  return crypto.randomUUID();
}
