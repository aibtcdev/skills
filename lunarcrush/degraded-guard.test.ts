import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BREAKER_THRESHOLD,
  BREAKER_WINDOW_MS,
  checkBeforePaying,
  DegradedGuardError,
  detectDegraded,
  guardStatus,
  recordOutcome,
  SYMBOL_COOLDOWN_MS,
} from "./degraded-guard.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lc-guard-"));
  process.env.LUNARCRUSH_GUARD_STATE_FILE = path.join(dir, "guard.json");
});
afterEach(() => {
  delete process.env.LUNARCRUSH_GUARD_STATE_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const refusal = (fn: () => void): DegradedGuardError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DegradedGuardError);
    return error as DegradedGuardError;
  }
  throw new Error("expected a refusal");
};

describe("detectDegraded (#393)", () => {
  test("score: null galaxy_score or a warning is degraded; full data is not", () => {
    expect(detectDegraded("score", { symbol: "BTC", galaxy_score: 59, alt_rank: 63 })).toBeNull();
    expect(detectDegraded("score", { symbol: "XYZ", galaxy_score: null, warning: "upstream failed" })).toMatch(/galaxy_score is null \(upstream failed\)/);
    expect(detectDegraded("score", { symbol: "XYZ" })).toMatch(/galaxy_score is null/);
    expect(detectDegraded("score", { galaxy_score: 40, warning: "partial" })).toMatch(/upstream warning/);
    expect(detectDegraded("score", null)).toMatch(/empty/);
  });

  test("oracle: UNKNOWN verdict or null signals is degraded; a real verdict is not", () => {
    expect(detectDegraded("oracle", { verdict: "BUY", signals: { galaxy_score: 58.8 } })).toBeNull();
    expect(detectDegraded("oracle", { verdict: "UNKNOWN", signals: {} })).toMatch(/verdict UNKNOWN/);
    expect(detectDegraded("oracle", { verdict: "NEUTRAL", signals: { galaxy_score: null } })).toMatch(/signals\.galaxy_score/);
  });
});

describe("checkBeforePaying / recordOutcome", () => {
  const t0 = 1_000_000_000_000;

  test("an empty answer blocks the same endpoint+symbol for the cooldown, not others", () => {
    recordOutcome("mainnet", "score", "xyz", { reason: "galaxy_score is null", txid: "0xabc" }, t0);
    const err = refusal(() => checkBeforePaying("mainnet", "score", "xyz", t0 + 1000));
    expect(err.kind).toBe("symbol-cooldown");
    expect(err.message).toContain("0xabc");
    expect(err.message).toMatch(/nothing was paid/);
    checkBeforePaying("mainnet", "oracle", "xyz", t0 + 1000); // other endpoint
    checkBeforePaying("mainnet", "score", "btc", t0 + 1000); // other symbol
    checkBeforePaying("testnet", "score", "xyz", t0 + 1000); // other network
    checkBeforePaying("mainnet", "score", "xyz", t0 + SYMBOL_COOLDOWN_MS); // cooldown over
  });

  test("a good answer for the symbol lifts its cooldown and resets the streak", () => {
    recordOutcome("mainnet", "score", "xyz", { reason: "null" }, t0);
    recordOutcome("mainnet", "score", "xyz", null, t0 + 10);
    checkBeforePaying("mainnet", "score", "xyz", t0 + 20);
    expect(guardStatus("mainnet", t0 + 20).breaker.consecutiveEmpty).toBe(0);
  });

  test(`${BREAKER_THRESHOLD} consecutive empty answers for different symbols open the breaker for every symbol`, () => {
    ["aaa", "bbb", "ccc"].forEach((sym, i) => recordOutcome("mainnet", "score", sym, { reason: "null" }, t0 + i * 1000));
    const err = refusal(() => checkBeforePaying("mainnet", "oracle", "btc", t0 + 5000));
    expect(err.kind).toBe("breaker-open");
    expect(err.message).toContain("aaa, bbb, ccc");
    expect(guardStatus("mainnet", t0 + 5000).breaker.open).toBe(true);
    // Closes once the window passes since the last empty answer.
    checkBeforePaying("mainnet", "oracle", "btc", t0 + 2000 + BREAKER_WINDOW_MS);
  });

  test("repeats of one symbol do not open the breaker; a good answer in between resets it", () => {
    recordOutcome("mainnet", "score", "aaa", { reason: "null" }, t0);
    recordOutcome("mainnet", "oracle", "aaa", { reason: "null" }, t0 + 1);
    recordOutcome("mainnet", "score", "bbb", { reason: "null" }, t0 + 2);
    expect(guardStatus("mainnet", t0 + 3).breaker.open).toBe(false);
    recordOutcome("mainnet", "score", "btc", null, t0 + 4);
    recordOutcome("mainnet", "score", "ccc", { reason: "null" }, t0 + 5);
    expect(guardStatus("mainnet", t0 + 6).breaker.consecutiveEmpty).toBe(1);
  });

  test("empty answers further apart than the window do not accumulate", () => {
    recordOutcome("mainnet", "score", "aaa", { reason: "null" }, t0);
    recordOutcome("mainnet", "score", "bbb", { reason: "null" }, t0 + BREAKER_WINDOW_MS + 1);
    recordOutcome("mainnet", "score", "ccc", { reason: "null" }, t0 + 2 * BREAKER_WINDOW_MS + 2);
    expect(guardStatus("mainnet", t0 + 2 * BREAKER_WINDOW_MS + 3).breaker.open).toBe(false);
  });

  test("an unreadable state file starts fresh instead of blocking", () => {
    writeFileSync(process.env.LUNARCRUSH_GUARD_STATE_FILE!, "{not json");
    checkBeforePaying("mainnet", "score", "btc", t0);
    recordOutcome("mainnet", "score", "btc", { reason: "null" }, t0);
    expect(refusal(() => checkBeforePaying("mainnet", "score", "btc", t0 + 1)).kind).toBe("symbol-cooldown");
  });
});
