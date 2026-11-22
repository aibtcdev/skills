import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { _testing } from "./nonce-tracker.js";

const DIR = path.join(os.tmpdir(), `aibtc-nonce-lock-${process.pid}`);
const LOCK = path.join(DIR, "nonce-state.lock");

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  _testing.setLockDir(LOCK);
  _testing.setLockMaxWaitMs(80);
});

afterEach(() => {
  _testing.forceReleaseLockDir();
  _testing.resetLockDir();
  _testing.resetLockMaxWaitMs();
  rmSync(DIR, { recursive: true, force: true });
});

const ageLock = (ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(LOCK, t, t);
};

describe("nonce file lock", () => {
  test("does not evict a live holder; contender times out instead of entering", async () => {
    const token = _testing.tryAcquireLock();
    expect(typeof token).toBe("string");
    ageLock(_testing.LOCK_STALE_MS + 5_000);

    let entered = false;
    await expect(
      _testing.withLock(async () => {
        entered = true;
      })
    ).rejects.toThrow(/Failed to acquire nonce lock/);

    expect(entered).toBe(false);
    expect(existsSync(LOCK)).toBe(true);
    _testing.releaseLockDir(token!);
    expect(existsSync(LOCK)).toBe(false);
  });

  test("reclaims a stale lock only after the holder is dead", async () => {
    const token = _testing.tryAcquireLock();
    expect(typeof token).toBe("string");
    // Same lock dir, but the recorded holder pid cannot exist.
    writeFileSync(path.join(LOCK, "owner"), `2147483647:${token}`);
    writeFileSync(path.join(LOCK, "pid"), "2147483647");
    ageLock(_testing.LOCK_STALE_MS + 5_000);

    let entered = false;
    await _testing.withLock(async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(existsSync(LOCK)).toBe(false);
  });

  test("safe release cannot delete a lock owned by another token", () => {
    const token = _testing.tryAcquireLock();
    expect(typeof token).toBe("string");
    writeFileSync(path.join(LOCK, "owner"), `${process.pid}:other-token`);

    _testing.releaseLockDir(token!);
    expect(existsSync(LOCK)).toBe(true);

    _testing.forceReleaseLockDir();
    expect(existsSync(LOCK)).toBe(false);
  });
});
