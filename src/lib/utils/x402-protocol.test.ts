import { describe, expect, test } from "bun:test";
import { derivePaymentIdentifier, generatePaymentIdentifier } from "./x402-protocol.js";

describe("derivePaymentIdentifier", () => {
  const tx = "0x80800000000400a1b2c3";
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  test("same transaction bytes give the same identifier, regardless of 0x prefix or case", () => {
    expect(derivePaymentIdentifier(tx)).toBe(derivePaymentIdentifier(tx));
    expect(derivePaymentIdentifier(tx)).toBe(derivePaymentIdentifier(tx.slice(2).toUpperCase()));
  });

  test("different transactions give different identifiers", () => {
    expect(derivePaymentIdentifier(tx)).not.toBe(derivePaymentIdentifier("0x80800000000400a1b2c4"));
  });

  test("has the same shape as a generated identifier", () => {
    expect(derivePaymentIdentifier(tx)).toMatch(/^pay_[0-9a-f]{32}$/);
    expect(generatePaymentIdentifier()).toMatch(/^pay_[0-9a-f]{32}$/);
  });

  test("secret-keyed derivation is deterministic for the same secret and tx (skills #420, #434)", () => {
    expect(derivePaymentIdentifier(tx, secret)).toBe(derivePaymentIdentifier(tx, secret));
    expect(derivePaymentIdentifier(tx, secret)).toBe(
      derivePaymentIdentifier(tx.slice(2).toUpperCase(), secret)
    );
  });

  test("secret-keyed derivation cannot be derived from public tx bytes alone (skills #434)", () => {
    const publicDerived = derivePaymentIdentifier(tx);
    const secretDerived = derivePaymentIdentifier(tx, secret);
    expect(secretDerived).not.toBe(publicDerived);
    expect(secretDerived).toMatch(/^pay_[0-9a-f]{32}$/);
  });

  test("different secrets produce different identifiers for the same transaction", () => {
    const secretB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    expect(derivePaymentIdentifier(tx, secret)).not.toBe(derivePaymentIdentifier(tx, secretB));
  });
});
