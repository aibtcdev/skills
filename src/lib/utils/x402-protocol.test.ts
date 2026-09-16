import { describe, expect, test } from "bun:test";
import { derivePaymentIdentifier, generatePaymentIdentifier } from "./x402-protocol.js";

describe("derivePaymentIdentifier", () => {
  const tx = "0x80800000000400a1b2c3";

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
});
