import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The tracker keeps its lock directory under os.homedir(), which Bun fixes at
// process start. So the real tests run in a child process whose HOME is a temp
// dir, and nothing is ever written to ~/.aibtc.
const CHILD_HOME = process.env.NONCE_TRACKER_TEST_HOME;

if (CHILD_HOME === undefined) {
  test("advanceNonce (run in a child process with a temporary HOME)", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "nonce-tracker-test-"));
    try {
      const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
        env: { ...process.env, HOME: home, NONCE_TRACKER_TEST_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = `${child.stdout}${child.stderr}`;
      expect(output).toMatch(/ 5 pass/);
      expect(child.exitCode, output).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const tracker = await import("./nonce-tracker.js");
const tmp = CHILD_HOME ?? "";
const ADDRESS = "SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ";
const stateFile = path.join(tmp, "state", "nonce-state.json");

function seed(nextNonce: number | null): void {
  const now = new Date().toISOString();
  const addresses =
    nextNonce === null
      ? {}
      : { [ADDRESS]: { nextNonce, lastUpdated: now, lastSynced: now, lastExecutedNonce: null, mempoolPending: 0, pending: [] } };
  tracker._testing.setStateFilePath(stateFile);
  rmSync(path.dirname(stateFile), { recursive: true, force: true });
  // writeStateFileSync creates the directory; seed through the file directly.
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 2, addresses }));
}

afterAll(() => tracker._testing.resetStateFilePath());
beforeEach(() => tracker._testing.setStateFilePath(stateFile));

describe.skipIf(CHILD_HOME === undefined)("advanceNonce", () => {
  test("moves the next nonce past a used one that is ahead and logs the txid", async () => {
    seed(3);
    await tracker.advanceNonce(ADDRESS, 5, "0xaaa");
    const state = tracker.getStatus(ADDRESS) as { nextNonce: number; pending: Array<{ nonce: number; txid: string }> };
    expect(state.nextNonce).toBe(6);
    expect(state.pending).toMatchObject([{ nonce: 5, txid: "0xaaa" }]);
  });

  test("a nonce equal to the next one also advances it", async () => {
    seed(3);
    await tracker.advanceNonce(ADDRESS, 3);
    expect((tracker.getStatus(ADDRESS) as { nextNonce: number }).nextNonce).toBe(4);
  });

  test("never moves backwards", async () => {
    seed(9);
    await tracker.advanceNonce(ADDRESS, 4, "0xold");
    const state = tracker.getStatus(ADDRESS) as { nextNonce: number; pending: unknown[] };
    expect(state.nextNonce).toBe(9);
    expect(state.pending.length).toBe(1);
  });

  test("does nothing without an entry for the address", async () => {
    seed(null);
    await tracker.advanceNonce(ADDRESS, 4, "0xaaa");
    expect(tracker.getStatus(ADDRESS)).toBeNull();
  });

  test("the pending log stays bounded", async () => {
    seed(0);
    for (let n = 0; n < tracker._testing.MAX_PENDING_LOG + 5; n++) await tracker.advanceNonce(ADDRESS, n, `0x${n}`);
    const state = tracker.getStatus(ADDRESS) as { pending: unknown[] };
    expect(state.pending.length).toBe(tracker._testing.MAX_PENDING_LOG);
  });
});
