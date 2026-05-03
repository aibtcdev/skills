import { describe, test, expect } from "bun:test";
import { expectedSwapOutput, TOKENS } from "./stacks-alpha-engine";

// Regression guard for arc0btc's review suggestion on PR #345 (review 4216429448):
// "a minimal test that constructs a swap instruction and asserts expectedSwapOutput
// returns output-denomination units would guard against regression."
//
// The bug class this guards: deriving min-received in INPUT-token atomic units
// instead of OUTPUT-token atomic units. Under stable-stable same-decimal pairs
// the bug is invisible; it surfaces when token decimals differ (e.g. sBTC 8d vs
// USDCx 6d). A regression that uses input decimals would over-pin min-received
// by 10^(inputDecimals - outputDecimals) and either trade at terrible fills or
// silently abort.

const PRICES = { sbtc: 78000, stx: 1, usdcx: 1, usdh: 1, aeusdc: 1 };

describe("expectedSwapOutput output-denomination units invariant", () => {
  test("sBTC (8d) -> USDCx (6d): result is scaled by output decimals, not input", () => {
    // 0.01 sBTC at $78,000 -> $780 USD -> 780 USDCx
    // Correct (output 6d):  780 * 10^6 = 780_000_000
    // Bug (input 8d):       780 * 10^8 = 78_000_000_000  (would NOT equal expected)
    const got = expectedSwapOutput(1_000_000, "sbtc", "usdcx", PRICES);
    expect(got).toBe(780_000_000);
    expect(got).not.toBe(78_000_000_000);
  });

  test("sBTC (8d) -> USDh (8d): same-decimal pair total magnitude is correct", () => {
    // Same-decimal pair cannot discriminate the input-vs-output bug class
    // (per file header), but still guards against an unrelated scaling
    // regression that would change the absolute magnitude.
    // 0.01 sBTC at $78,000 -> $780 -> 780 USDh -> 780 * 10^8 = 78_000_000_000
    const got = expectedSwapOutput(1_000_000, "sbtc", "usdh", PRICES);
    expect(got).toBe(78_000_000_000);
  });

  test("USDCx (6d) -> aeUSDC (6d): stable-stable code path at 1:1 USD", () => {
    // Same-decimal stable-stable; doesn't discriminate the bug class but
    // guards the stable-stable code path against future divergence.
    // 100 USDCx -> $100 -> 100 aeUSDC -> 100 * 10^6 = 100_000_000
    const got = expectedSwapOutput(100_000_000, "usdcx", "aeusdc", PRICES);
    expect(got).toBe(100_000_000);
  });

  test("unknown input token returns 0", () => {
    const got = expectedSwapOutput(1_000_000, "doge" as string, "usdcx", PRICES);
    expect(got).toBe(0);
  });

  test("unknown output token returns 0", () => {
    const got = expectedSwapOutput(1_000_000, "sbtc", "ethereum" as string, PRICES);
    expect(got).toBe(0);
  });

  test("stable not in priceMap defaults to $1", () => {
    // Construct prices without aeusdc; expected: aeusdc defaults to $1
    // because it is in the stable-symbol fallback list.
    const partial = { sbtc: 78000, stx: 1, usdcx: 1, usdh: 1 } as unknown as typeof PRICES;
    // 0.01 sBTC at $78,000 -> $780 -> 780 aeUSDC (6d) -> 780_000_000
    const got = expectedSwapOutput(1_000_000, "sbtc", "aeusdc", partial);
    expect(got).toBe(780_000_000);
  });

  test("non-stable input price <= 0 returns 0 (no zero-division)", () => {
    const zeroSbtc = { ...PRICES, sbtc: 0 };
    const got = expectedSwapOutput(1_000_000, "sbtc", "usdcx", zeroSbtc);
    expect(got).toBe(0);
  });

  test("TOKENS export round-trips decimals for all pairs used above", () => {
    // Defensive guard so a TOKENS-table edit (e.g. wrong sBTC decimals)
    // surfaces as a separate failing assertion rather than silently
    // skewing the math tests above.
    expect(TOKENS.sbtc?.decimals).toBe(8);
    expect(TOKENS.usdcx?.decimals).toBe(6);
    expect(TOKENS.usdh?.decimals).toBe(8);
    expect(TOKENS.aeusdc?.decimals).toBe(6);
  });
});
