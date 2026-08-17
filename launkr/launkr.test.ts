import { describe, test, expect } from "bun:test";
import { cvToString, serializeCV, uintCV, boolCV, tupleCV, someCV, noneCV, principalCV } from "@stacks/transactions";
import { parseLaunkrArg, decodeCV, unwrapCV, validatePoolStepMatchesRequest } from "./launkr.js";

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

// FIX (biwasxyz review round 2, PR #414, blocker A): get-pool's decode bug
// (a single `.value` unwrap wasn't enough for a tuple response — every
// field inside stayed wrapped as {type, value}) shipped with zero test
// coverage of the actual decode path against a real response shape. These
// tests build a real ClarityValue, serialize it exactly like the chain
// would, and run it through decodeCV -> unwrapCV — the same round-trip
// get-pool does — rather than asserting against hand-written mock objects,
// per biwasxyz's suggestion that this is exactly what would have caught it.
describe("unwrapCV", () => {
  // serializeCV returns a hex string directly on this repo's pinned
  // @stacks/transactions — decodeCV strips a leading "0x" if present, so
  // either form works, but normalize so this test doesn't silently start
  // testing something else if that return type ever changes upstream.
  function decodeHex(cv: Parameters<typeof serializeCV>[0]): unknown {
    const serialized = serializeCV(cv);
    const hex = typeof serialized === "string" ? serialized : Buffer.from(serialized).toString("hex");
    return unwrapCV(decodeCV(hex));
  }

  test("unwraps a bare uint", () => {
    expect(decodeHex(uintCV(123))).toBe("123");
  });

  test("unwraps some(uint) to the plain value", () => {
    expect(decodeHex(someCV(uintCV(1976087347052n)))).toBe("1976087347052");
  });

  test("unwraps none to null", () => {
    expect(decodeHex(noneCV())).toBeNull();
  });

  // This is the exact shape get-pool decodes: (optional (tuple ...)) with
  // a bool and a uint field — the case the old one-level unwrap got wrong.
  test("unwraps a get-pool-shaped tuple — every field is a plain value, not an object", () => {
    const pool = decodeHex(
      someCV(
        tupleCV({
          active: boolCV(true),
          mode: uintCV(1),
          "fee-receiver": principalCV("SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW"),
        })
      )
    ) as Record<string, unknown>;

    // The bug this guards against: the old code's single-level unwrap left
    // these as {type:"bool",value:true} / {type:"uint",value:"1"}, so
    // String(p["mode"]) produced the literal text "[object Object]" and
    // p["active"] printed as an object instead of the boolean itself.
    expect(pool["active"]).toBe(true);
    expect(pool["mode"]).toBe("1");
    expect(pool["fee-receiver"]).toBe("SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW");
    expect(typeof pool["active"]).not.toBe("object");
    expect(String(pool["mode"])).not.toBe("[object Object]");
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
    tokenPrincipal: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.mat",
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
          tokenPrincipal: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.mat",
          name: "My Agent Token",
          symbol: "MAT",
          supply: "1000000000000000",
          feeReceiver: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW",
          stxSeed: "999999999",
        }
      )
    ).toThrow(/stx-seed/);
  });

  // FIX (biwasxyz review round 2, PR #414, "also worth fixing"): args[0]
  // (which token the pool is even for) was never checked before.
  test("throws on token-principal mismatch", () => {
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: bondingArgs },
        { ...baseRequest, tokenPrincipal: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.different-token" }
      )
    ).toThrow(/token:/);
  });

  // FIX (biwasxyz review round 2): the old check was `args.length < 8`,
  // which accepted 8 args under bonding mode (needs 9) and read
  // graduation-threshold and fee-receiver from the same slot.
  test("throws on wrong arg count for bonding mode (8 args, needs 9)", () => {
    const eightArgBondingArgs = bondingArgs.slice(0, 8); // drop fee-receiver
    expect(() =>
      validatePoolStepMatchesRequest({ functionArgs: eightArgBondingArgs }, baseRequest)
    ).toThrow(/expected exactly 9/);
  });

  test("throws on wrong arg count for direct mode (9 args, needs 8)", () => {
    const nineArgDirectArgs = [
      ...bondingArgs.slice(0, 7),
      { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW" },
      { type: "principal", value: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW" },
    ];
    expect(() =>
      validatePoolStepMatchesRequest(
        { functionArgs: nineArgDirectArgs },
        {
          mode: "direct",
          tokenPrincipal: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW.mat",
          name: "My Agent Token",
          symbol: "MAT",
          supply: "1000000000000000",
          feeReceiver: "SP1YNEJRV1AJHGVSF2EMDWP58NF2XBNPYG0R94ZWW",
          stxSeed: "100000000",
        }
      )
    ).toThrow(/expected exactly 8/);
  });

  test("throws on too-short functionArgs", () => {
    expect(() =>
      validatePoolStepMatchesRequest({ functionArgs: [{ type: "uint", value: "1" }] }, baseRequest)
    ).toThrow(/expected exactly 9/);
  });
});
