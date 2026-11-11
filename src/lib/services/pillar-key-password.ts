/**
 * Password for Pillar direct-mode signing keys, so tools can unlock them after
 * a restart without asking the user.
 *
 * The password is derived from a secret: PILLAR_API_KEY when set, otherwise a
 * random per-machine secret stored owner-only at ~/.aibtc/pillar-signing-secret.
 * The keystore itself is encrypted with scrypt + AES-256-GCM using that
 * password (see utils/encryption.ts).
 *
 * Older releases (and the aibtc MCP server, which shares ~/.aibtc/signing-keys)
 * used the public constant "pillar-direct-default" when PILLAR_API_KEY was not
 * set, so anyone holding a copy of the keystore could decrypt it. Keys still
 * encrypted that way are re-encrypted under the current password the first
 * time they are unlocked.
 *
 * Keep this in sync with aibtc-mcp-server's copy: both tools must derive the
 * same password from the same secret file.
 */
import crypto from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { getSigningKeyService } from "./signing-key.service.js";

const LEGACY_DEFAULT_SECRET = "pillar-direct-default";

function secretFilePath(): string {
  return path.join(os.homedir(), ".aibtc", "pillar-signing-secret");
}

/** Password for a given secret (format unchanged since the first release). */
export function derivePillarKeyPassword(secret: string): string {
  // The result is the *password* fed to scrypt (N=2^14) with a random salt per
  // keystore, not the encryption key, so a fast hash here is not the KDF.
  return crypto.createHash("sha256").update(`pillar-agent-signing-key:${secret}`).digest("hex");
}

async function readMachineSecret(): Promise<string | null> {
  try {
    const value = (await fs.readFile(secretFilePath(), "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read the per-machine secret, creating it (owner-only) on first use. */
async function readOrCreateMachineSecret(): Promise<string> {
  const existing = await readMachineSecret();
  if (existing) return existing;
  const file = secretFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    // "wx": never overwrite a secret another process just created.
    await fs.writeFile(file, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = await readMachineSecret();
  if (!created) throw new Error(`Could not read ${file}`);
  return created;
}

/** The password new Pillar keys are stored under. */
export async function currentPillarKeyPassword(apiKey: string): Promise<string> {
  return derivePillarKeyPassword(apiKey || (await readOrCreateMachineSecret()));
}

/**
 * Passwords to try when unlocking, current first. Includes the per-machine
 * secret even when PILLAR_API_KEY is set (a key created before the key was
 * configured), and the legacy public default.
 */
async function candidatePasswords(apiKey: string): Promise<{ current: string; legacy: string; all: string[] }> {
  const current = await currentPillarKeyPassword(apiKey);
  const machine = apiKey ? await readMachineSecret() : null;
  const legacy = derivePillarKeyPassword(LEGACY_DEFAULT_SECRET);
  const all = [current, ...(machine ? [derivePillarKeyPassword(machine)] : []), legacy];
  return { current, legacy, all: [...new Set(all)] };
}

/**
 * Unlock a Pillar signing key with the derived password. A key still under the
 * legacy public default is re-encrypted under the current password first.
 * Throws "Invalid password" when no candidate works.
 */
export async function unlockPillarKey(keyId: string, apiKey: string): Promise<{ migrated: boolean }> {
  const keyService = getSigningKeyService();
  const { current, legacy, all } = await candidatePasswords(apiKey);
  for (const password of all) {
    try {
      await keyService.unlock(keyId, password);
    } catch {
      continue;
    }
    if (password === legacy && current !== legacy) {
      await keyService.changePassword(keyId, legacy, current);
      return { migrated: true };
    }
    return { migrated: false };
  }
  throw new Error("Invalid password");
}
