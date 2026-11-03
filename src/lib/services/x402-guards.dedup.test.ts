/**
 * Regression tests for skills#460 — the direct-payment dedup guard.
 *
 * Two defects, both of which made the guard miss the case it exists for:
 *
 *   1. Per-attempt headers were hashed into the key, so a retry that
 *      regenerated `x-request-id` / `idempotency-key` looked like a new request
 *      and paid again.
 *   2. TTL expiry deleted the record without asking whether the payment had
 *      landed, so a retry after 15 minutes could pay twice for a transfer whose
 *      fate was still unknown.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateDedupKey,
  checkDedup,
  recordDedup,
  type DirectPaymentPolicy,
} from "./x402-guards.js";

const base = {
  method: "GET",
  url: "https://x402.test/paid",
  params: { slug: "stacks" },
  payer: "SP000000000000000000002Q6VF78",
  payTo: "SP1111111111111111111111111111111111",
  amount: "100",
  asset: "STX",
};

function policy(dir: string, ttlMs = 900_000): DirectPaymentPolicy {
  return {
    dedupStateFile: path.join(dir, "dedup.json"),
    dedupTtlMs: ttlMs,
  } as DirectPaymentPolicy;
}

const TXID = "a".repeat(64);

describe("generateDedupKey — per-attempt values are not identity", () => {
  test("a regenerated request id does not change the key", () => {
    const first = generateDedupKey({ ...base, headers: { "x-request-id": "req-1" } });
    const retry = generateDedupKey({ ...base, headers: { "x-request-id": "req-2" } });
    expect(retry).toBe(first);
  });

  test("a regenerated idempotency key does not change the key", () => {
    const first = generateDedupKey({ ...base, headers: { "Idempotency-Key": "idem-a" } });
    const retry = generateDedupKey({ ...base, headers: { "Idempotency-Key": "idem-b" } });
    expect(retry).toBe(first);
  });

  test("tracing headers do not change the key", () => {
    const first = generateDedupKey({
      ...base,
      headers: { traceparent: "00-abc-def-01", "x-correlation-id": "c1" },
    });
    const retry = generateDedupKey({
      ...base,
      headers: { traceparent: "00-xyz-uvw-01", "x-correlation-id": "c2" },
    });
    expect(retry).toBe(first);
  });

  test("a header that IS request identity still changes the key", () => {
    // The guard must not become blind: a genuinely different request is new.
    const first = generateDedupKey({ ...base, headers: { "x-api-tier": "basic" } });
    const other = generateDedupKey({ ...base, headers: { "x-api-tier": "pro" } });
    expect(other).not.toBe(first);
  });

  test("a different body, price, payee or payer still changes the key", () => {
    expect(generateDedupKey({ ...base, data: { a: 1 } })).not.toBe(generateDedupKey(base));
    expect(generateDedupKey({ ...base, amount: "200" })).not.toBe(generateDedupKey(base));
    expect(generateDedupKey({ ...base, payTo: "SP2222222222222222222222222222222222" })).not.toBe(
      generateDedupKey(base)
    );
    expect(generateDedupKey({ ...base, payer: "SP3333333333333333333333333333333333" })).not.toBe(
      generateDedupKey(base)
    );
  });
});

describe("dedup TTL — a pending payment is never forgotten", () => {
  test("a pending entry survives TTL expiry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dedup-460-"));
    try {
      const p = policy(dir, 1);
      await recordDedup("k1", TXID, p); // defaults to pending
      await new Promise((r) => setTimeout(r, 20));
      // TTL is 1ms and 20ms have passed; a settled record would be gone.
      const found = await checkDedup("k1", p);
      expect(found).not.toBeNull();
      expect(found?.txid).toBe(TXID);
      expect(found?.status).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a settled entry is forgotten after the TTL", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dedup-460-"));
    try {
      const p = policy(dir, 1);
      await recordDedup("k2", TXID, p, "settled");
      await new Promise((r) => setTimeout(r, 20));
      expect(await checkDedup("k2", p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writing a new record does not prune a pending one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dedup-460-"));
    try {
      const p = policy(dir, 1);
      await recordDedup("pending-key", TXID, p);
      await new Promise((r) => setTimeout(r, 20));
      // A later write runs the prune loop; the pending entry must survive it.
      await recordDedup("other-key", "b".repeat(64), p, "settled");
      expect(await checkDedup("pending-key", p)).not.toBeNull();
      // The just-written settled entry is still fresh, so nothing was pruned.
      expect(await checkDedup("other-key", p)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
