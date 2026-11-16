import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The key service and the secret file resolve ~/.aibtc from the home directory
// fixed at process start, so the scenarios run in a child process whose HOME
// is a scratch dir. The child refuses to run if its home isn't that dir.
let home = "";
beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "pillar-key-")));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test("Pillar signing-key password: per-machine secret, API key, legacy migration", () => {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "run", path.join(import.meta.dir, "__fixtures__", "pillar-key-password.scenario.ts")],
    env: { ...process.env, HOME: home, EXPECTED_HOME: home, PILLAR_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  if (proc.exitCode !== 0) throw new Error(`scenario failed: ${stdout}\n${new TextDecoder().decode(proc.stderr)}`);
  const out = JSON.parse(stdout.split("\n").pop()!);

  // Without PILLAR_API_KEY: a stable, owner-only per-machine secret, not the public default.
  expect(out.machine).toEqual({ stable: true, notLegacy: true, secretHex: true, mode: "600" });
  // With PILLAR_API_KEY: derived from it.
  expect(out.apiKey).toBe(true);
  // A key under the legacy public default unlocks once, is re-encrypted, and the default no longer opens it.
  expect(out.legacy).toEqual({
    first: { migrated: true },
    active: true,
    legacyStillOpens: false,
    currentOpens: true,
    second: { migrated: false },
  });
  // A key created before PILLAR_API_KEY was set still unlocks after it is set.
  expect(out.machineKeyWithApiKey).toEqual({ migrated: false });
  // An unrelated password is refused.
  expect(out.unrelated).toBe("Invalid password");
});
