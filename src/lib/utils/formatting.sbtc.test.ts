import { describe, expect, test } from "bun:test";
import { formatSbtc, satsToSbtcString } from "./formatting.js";

describe("satsToSbtcString", () => {
  test("keeps fractional sBTC instead of truncating to whole coins", () => {
    expect(satsToSbtcString("50000000")).toBe("0.5");
    expect(satsToSbtcString("123456789")).toBe("1.23456789");
    expect(satsToSbtcString("248183430062")).toBe("2481.83430062");
  });

  test("returns whole coins without a decimal point", () => {
    expect(satsToSbtcString("100000000")).toBe("1");
    expect(satsToSbtcString("0")).toBe("0");
  });

  test("trims trailing zeroes in the fractional part", () => {
    expect(satsToSbtcString("100000001")).toBe("1.00000001");
    expect(satsToSbtcString("150000000")).toBe("1.5");
  });
});

describe("formatSbtc", () => {
  test("delegates to satsToSbtcString and appends the unit", () => {
    expect(formatSbtc("50000000")).toBe("0.5 sBTC");
    expect(formatSbtc("248183430062")).toBe("2481.83430062 sBTC");
  });
});
