/**
 * Runs in a child process started with HOME set to a scratch dir (see
 * pillar-key-password.test.ts): the key service and the secret file resolve
 * ~/.aibtc from the home directory at process start. Prints one JSON object.
 */
import os from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const expectedHome = process.env.EXPECTED_HOME;
if (!expectedHome || os.homedir() !== expectedHome) {
  // Never touch a real ~/.aibtc.
  console.log(JSON.stringify({ error: `refusing to run: home is ${os.homedir()}, expected ${expectedHome}` }));
  process.exit(1);
}

const mod = await import("../pillar-key-password.js");
const keys = (await import("../signing-key.service.js")).getSigningKeyService();
const LEGACY = mod.derivePillarKeyPassword("pillar-direct-default");
const out: Record<string, unknown> = {};

// 1. No PILLAR_API_KEY: stable per-machine secret, owner-only, not the public default.
const a = await mod.currentPillarKeyPassword("");
const b = await mod.currentPillarKeyPassword("");
const file = path.join(os.homedir(), ".aibtc", "pillar-signing-secret");
out.machine = {
  stable: a === b,
  notLegacy: a !== LEGACY,
  secretHex: /^[0-9a-f]{64}$/.test((await readFile(file, "utf8")).trim()),
  mode: ((await stat(file)).mode & 0o777).toString(8),
};

// 2. With PILLAR_API_KEY the password is derived from it.
out.apiKey = (await mod.currentPillarKeyPassword("api-key-1")) === mod.derivePillarKeyPassword("api-key-1");

// 3. A legacy-default key is unlocked once and re-encrypted under the current password.
{
  const { keyId } = await keys.generateKey(LEGACY, "pending");
  keys.lock();
  const first = await mod.unlockPillarKey(keyId, "");
  const active = keys.getActiveKey()?.keyId === keyId;
  keys.lock();
  const legacyStillOpens = await keys.exportKey(keyId, LEGACY).then(() => true, () => false);
  const currentOpens = await keys.exportKey(keyId, a).then(() => true, () => false);
  const second = await mod.unlockPillarKey(keyId, "");
  keys.lock();
  out.legacy = { first, active, legacyStillOpens, currentOpens, second };
}

// 4. A key made before PILLAR_API_KEY was set still unlocks once it is set.
{
  const { keyId } = await keys.generateKey(a, "pending");
  keys.lock();
  out.machineKeyWithApiKey = await mod.unlockPillarKey(keyId, "api-key-2");
  keys.lock();
}

// 5. A key under an unrelated password is refused.
{
  const { keyId } = await keys.generateKey("something-else", "pending");
  keys.lock();
  out.unrelated = await mod.unlockPillarKey(keyId, "").then(() => "unlocked", (e: Error) => e.message);
}

console.log(JSON.stringify(out));
