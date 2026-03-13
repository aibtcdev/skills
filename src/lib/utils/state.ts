import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Normalized state file envelope.
 *
 * Every skill that persists state to ~/.aibtc/ should use this envelope
 * so state files are structurally consistent across skills.
 *
 * @see https://github.com/aibtcdev/skills/issues/122
 */
export interface StateEnvelope<T> {
  /** Schema version — increment when the shape of `state` changes */
  version: number;
  /** ISO 8601 timestamp of the last write */
  updatedAt: string;
  /** Skill-specific payload */
  state: T;
}

const STORAGE_DIR = path.join(os.homedir(), ".aibtc");

/**
 * Read a normalized state file from ~/.aibtc/<filename>.
 *
 * Returns the full envelope on success, or `null` if the file
 * does not exist, is corrupted, or has a version mismatch.
 *
 * @param filename - File name relative to ~/.aibtc/ (e.g. "yield-hunter-state.json")
 * @param expectedVersion - If provided, returns null when the on-disk version differs
 */
export async function readStateFile<T>(
  filename: string,
  expectedVersion?: number
): Promise<StateEnvelope<T> | null> {
  const filePath = path.join(STORAGE_DIR, filename);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const envelope = JSON.parse(raw) as StateEnvelope<T>;

    // Validate envelope shape
    if (
      typeof envelope.version !== "number" ||
      typeof envelope.updatedAt !== "string" ||
      !("state" in envelope)
    ) {
      return null;
    }

    if (expectedVersion !== undefined && envelope.version !== expectedVersion) {
      return null;
    }

    return envelope;
  } catch {
    return null;
  }
}

/**
 * Write a normalized state file to ~/.aibtc/<filename>.
 *
 * Uses atomic write (temp file + rename) to prevent corruption on crash.
 * Automatically sets `updatedAt` to the current time.
 *
 * @param filename - File name relative to ~/.aibtc/ (e.g. "yield-hunter-state.json")
 * @param version - Schema version for this state shape
 * @param state - Skill-specific payload
 */
export async function writeStateFile<T>(
  filename: string,
  version: number,
  state: T
): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });

  const envelope: StateEnvelope<T> = {
    version,
    updatedAt: new Date().toISOString(),
    state,
  };

  const filePath = path.join(STORAGE_DIR, filename);
  const tempFile = `${filePath}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(envelope, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tempFile, filePath);
}

/**
 * Delete a state file from ~/.aibtc/<filename>. Idempotent.
 */
export async function deleteStateFile(filename: string): Promise<void> {
  const filePath = path.join(STORAGE_DIR, filename);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
