import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { derivePaymentIdentifier, generatePaymentIdentifier } from "./x402-protocol.js";

describe("derivePaymentIdentifier", () => {
  const tx = "0x80800000000400a1b2c3";
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("same transaction bytes give the same identifier, regardless of 0x prefix or case (skills #420)", () => {
    expect(derivePaymentIdentifier(tx, secret)).toBe(derivePaymentIdentifier(tx, secret));
    expect(derivePaymentIdentifier(tx, secret)).toBe(
      derivePaymentIdentifier(tx.slice(2).toUpperCase(), secret)
    );
  });

  test("different transactions give different identifiers", () => {
    expect(derivePaymentIdentifier(tx, secret)).not.toBe(
      derivePaymentIdentifier("0x80800000000400a1b2c4", secret)
    );
  });

  test("has the same shape as a generated identifier", () => {
    expect(derivePaymentIdentifier(tx, secret)).toMatch(/^pay_[0-9a-f]{32}$/);
    expect(generatePaymentIdentifier()).toMatch(/^pay_[0-9a-f]{32}$/);
  });

  test("cannot be computed from the public tx bytes alone (skills #434)", () => {
    const bytes = Buffer.from(tx.slice(2), "hex");
    const publicHash = `pay_${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}`;
    expect(derivePaymentIdentifier(tx, secret)).not.toBe(publicHash);
  });

  test("different secrets produce different identifiers for the same transaction", () => {
    const secretB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    expect(derivePaymentIdentifier(tx, secret)).not.toBe(derivePaymentIdentifier(tx, secretB));
  });

  test("refuses to derive without a secret rather than falling back to a public hash", () => {
    expect(() => derivePaymentIdentifier(tx, "")).toThrow();
  });
});
