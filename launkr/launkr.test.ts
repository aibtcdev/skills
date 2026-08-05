import { describe, test, expect } from "bun:test";
import { cvToString } from "@stacks/transactions";
import { parseLaunkrArg, decodeCV, validatePoolStepMatchesRequest } from "./launkr.js";

describe("parseLaunkrArg", () => {
  test("principal — standard address", () => {
    const cv = parseLaunkrArg({ type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW" });
    expect(cvToString(cv)).toBe("SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW");
  });

  test("principal — contract address", () => {
    const cv = parseLaunkrArg({ type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.lft" });
    expect(cvToString(cv)).toBe("SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.lft");
  });

  test("uint", () => {
    const cv = parseLaunkrArg({ type: "uint", value: "1000000000000000" });
    expect(cvToString(cv)).toBe("u1000000000000000");
  });

  test("string-ascii", () => {
    const cv = parseLaunkrArg({ type: "string-ascii", value: "MAT" });
    expect(cvToString(cv)).toBe('"MAT"');
  });

  test("string-utf8", () => {
    const cv = parseLaunkrArg({ type: "string-utf8", value: "hello" });
    expect(cvToString(cv)).toBe('u"hello"');
  });

  // RESOLVED (2026-08-05, biwasxyz review question #3): this used to send
  // someCV(stringUtf8CV("")) for a null value — see SKILL.md for why that
  // workaround existed and why it was reverted. This test locks in the
  // reverted (correct) behavior so it can't silently regress.
  test("optional-utf8 — null value produces none, not Some(\"\")", () => {
    const cv = parseLaunkrArg({ type: "optional-utf8", value: null });
    expect(cvToString(cv)).toBe("none");
  });

  test("optional-utf8 — real value produces Some", () => {
    const cv = parseLaunkrArg({ type: "optional-utf8", value: "https://example.com" });
    expect(cvToString(cv)).toBe('(some u"https://example.com")');
  });

  test("optional-ascii — null value produces none", () => {
    const cv = parseLaunkrArg({ type: "optional-ascii", value: null });
    expect(cvToString(cv)).toBe("none");
  });

  test("unsupported type throws", () => {
    expect(() => parseLaunkrArg({ type: "buffer", value: "00" })).toThrow(/Unsupported Launkr arg type/);
  });
});

describe("decodeCV", () => {
  test("decodes a uint result", () => {
    // (ok u123) as returned by Hiro's call-read endpoint
    expect(decodeCV("0x0701000000000000000000000000000007b")).not.toBeUndefined();
  });

  test("falls back to the raw hex on malformed input", () => {
    expect(decodeCV("not-valid-hex")).toBe("not-valid-hex");
  });
});

describe("validatePoolStepMatchesRequest", () => {
  const bondingArgs = [
    { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.mat" },
    { type: "string-ascii", value: "My Agent Token" },
    { type: "string-ascii", value: "MAT" },
    { type: "uint", value: "6" },
    { type: "uint", value: "1000000000000000" },
    { type: "optional-utf8", value: null },
    { type: "uint", value: "500000000" },
    { type: "uint", value: "2000000000" },
    { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW" },
  ];

  const baseRequest = {
    mode: "bonding" as const,
    name: "My Agent Token",
    symbol: "MAT",
    supply: "1000000000000000",
    feeReceiver: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW",
    virtualStx: "500000000",
    graduationThreshold: "2000000000",
  };

  test("passes when everything matches", () => {
    expect(() =>
      validatePoolStepMatchesRequest({ functionArgs: bondingArgs }, baseRequest)
    ).not.toThrow();
  });

  test("throws on fee-receiver mismatch", () => {
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: bondingArgs },
        { ...baseRequest, feeReceiver: "SP000000000000000000002Q6VF78" }
      )
    ).toThrow(/fee-receiver/);
  });

  test("throws on supply mismatch", () => {
    expect(() =>
      validatePoolStepMatchesRequest({ functionArgs: bondingArgs }, { ...baseRequest, supply: "999" })
    ).toThrow(/supply/);
  });

  // EXTENDED (biwasxyz review, PR #414, worth-addressing #5): the curve
  // parameters weren't cross-checked at all before this fix.
  test("throws on virtual-stx mismatch (bonding)", () => {
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: bondingArgs },
        { ...baseRequest, virtualStx: "999999999" }
      )
    ).toThrow(/virtual-stx/);
  });

  test("throws on graduation-threshold mismatch (bonding)", () => {
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: bondingArgs },
        { ...baseRequest, graduationThreshold: "999999999" }
      )
    ).toThrow(/graduation-threshold/);
  });

  test("throws on stx-seed mismatch (direct)", () => {
    const directArgs = [
      { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.mat" },
      { type: "string-ascii", value: "My Agent Token" },
      { type: "string-ascii", value: "MAT" },
      { type: "uint", value: "6" },
      { type: "uint", value: "1000000000000000" },
      { type: "optional-utf8", value: null },
      { type: "uint", value: "100000000" },
      { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW" },
    ];
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: directArgs },
        {
          mode: "direct",
          name: "My Agent Token",
          symbol: "MAT",
          supply: "1000000000000000",
          feeReceiver: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW",
          stxSeed: "999999999",
        }
      )
    ).toThrow(/stx-seed/);
  });

  test("throws on too-short functionArgs", () => {
    expect(() =>
      validatePoolStepMatchesRequest({ functionArgs: [{ type: "uint", value: "1" }] }, baseRequest)
    ).toThrow(/unexpected number of pool-creation args/);
  });
});
