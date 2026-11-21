import { describe, expect, test } from "bun:test";
import { formatSbtc, satsToSbtcString } from "./formatting.js";

// sBTC is integer satoshis (8 decimals). Integer division truncates, so
// 50_000_000n / 100_000_000n is 0n and a half-sBTC balance renders as "0".
// These cases pin the exact decimal value instead.
describe("satsToSbtcString", () => {
  test("keeps the fractional part of a sub-1-sBTC balance", () => {
    expect(satsToSbtcString(50_000_000n)).toBe("0.5");
    expect(satsToSbtcString("50000000")).toBe("0.5");
  });

  test("keeps all 8 decimals", () => {
    expect(satsToSbtcString(123_456_789n)).toBe("1.23456789");
  });

  test("keeps the full precision of the live peg total", () => {
    expect(satsToSbtcString("248183430062")).toBe("2481.83430062");
  });

  test("does not add a decimal to a whole amount", () => {
    expect(satsToSbtcString(100_000_000n)).toBe("1");
    expect(satsToSbtcString(0n)).toBe("0");
  });

  test("keeps one sat visible", () => {
    expect(satsToSbtcString(1n)).toBe("0.00000001");
  });

  test("trims trailing zeros but not significant ones", () => {
    expect(satsToSbtcString(150_000_000n)).toBe("1.5");
    expect(satsToSbtcString(100_000_010n)).toBe("1.0000001");
  });

  test("handles negatives without losing precision", () => {
    expect(satsToSbtcString(-50_000_000n)).toBe("-0.5");
  });

  test("formatSbtc still appends the unit", () => {
    expect(formatSbtc(50_000_000n)).toBe("0.5 sBTC");
    expect(formatSbtc(100_000_000n)).toBe("1 sBTC");
  });

  test("integer division would have truncated these", () => {
    // The regression these tests guard against, stated directly.
    for (const sats of [1n, 50_000_000n, 99_999_999n, 123_456_789n]) {
      const truncated = (sats / 100_000_000n).toString();
      expect(satsToSbtcString(sats)).not.toBe(truncated);
    }
  });
});
