import { describe, test, expect } from "bun:test";
import { cvToString } from "@stacks/transactions";
import {
  parseArgToClarityValue,
  clarityToString,
  createUint,
  createInt,
  createPrincipal,
  createStringAscii,
  createStringUtf8,
  createBool,
  createBuffer,
  createList,
  createTuple,
  createNone,
  createSome,
  serializeClarityValue,
  deserializeClarityValue,
} from "./clarity-values.js";

describe("parseArgToClarityValue", () => {
  test("null/undefined → none", () => {
    expect(clarityToString(parseArgToClarityValue(null))).toBe("none");
    expect(clarityToString(parseArgToClarityValue(undefined))).toBe("none");
  });

  test("boolean → bool", () => {
    expect(clarityToString(parseArgToClarityValue(true))).toBe("true");
    expect(clarityToString(parseArgToClarityValue(false))).toBe("false");
  });

  test("positive integer → uint", () => {
    expect(clarityToString(parseArgToClarityValue(42))).toBe("u42");
  });

  test("negative integer → int", () => {
    expect(clarityToString(parseArgToClarityValue(-5))).toBe("-5");
  });

  test("zero → uint", () => {
    expect(clarityToString(parseArgToClarityValue(0))).toBe("u0");
  });

  test("float throws", () => {
    expect(() => parseArgToClarityValue(1.5)).toThrow("Floating point");
  });

  test("principal string → principal", () => {
    const addr = "SP000000000000000000002Q6VF78";
    const cv = parseArgToClarityValue(addr);
    expect(clarityToString(cv)).toContain(addr);
  });

  test("contract principal string → principal", () => {
    const addr = "SP000000000000000000002Q6VF78.bns";
    const cv = parseArgToClarityValue(addr);
    expect(clarityToString(cv)).toContain("SP000000000000000000002Q6VF78.bns");
  });

  test("regular string → string-utf8", () => {
    const cv = parseArgToClarityValue("hello");
    expect(clarityToString(cv)).toBe(`u"hello"`);
  });

  test("array → list", () => {
    const cv = parseArgToClarityValue([1, 2, 3]);
    const str = clarityToString(cv);
    expect(str).toContain("u1");
    expect(str).toContain("u2");
    expect(str).toContain("u3");
  });

  test("object → tuple", () => {
    const cv = parseArgToClarityValue({ a: 1, b: true });
    const str = clarityToString(cv);
    expect(str).toContain("a");
    expect(str).toContain("u1");
  });

  test("typed value with type field", () => {
    expect(clarityToString(parseArgToClarityValue({ type: "uint", value: 100 }))).toBe("u100");
    expect(clarityToString(parseArgToClarityValue({ type: "int", value: -10 }))).toBe("-10");
    expect(clarityToString(parseArgToClarityValue({ type: "string-ascii", value: "hi" }))).toBe(`"hi"`);
    expect(clarityToString(parseArgToClarityValue({ type: "bool", value: false }))).toBe("false");
    expect(clarityToString(parseArgToClarityValue({ type: "none", value: null }))).toBe("none");
    expect(clarityToString(parseArgToClarityValue({ type: "some", value: 5 }))).toBe("(some u5)");
  });

  test("typed list value", () => {
    const cv = parseArgToClarityValue({ type: "list", value: [1, 2] });
    const str = clarityToString(cv);
    expect(str).toContain("u1");
  });

  test("typed tuple value", () => {
    const cv = parseArgToClarityValue({ type: "tuple", value: { x: 1 } });
    const str = clarityToString(cv);
    expect(str).toContain("x");
  });

  test("unknown type throws", () => {
    expect(() => parseArgToClarityValue({ type: "unknown", value: 1 })).toThrow("Unknown type");
  });
});

describe("clarity helper creators", () => {
  test("createUint", () => {
    expect(clarityToString(createUint(100))).toBe("u100");
    expect(clarityToString(createUint("999"))).toBe("u999");
    expect(clarityToString(createUint(BigInt(42)))).toBe("u42");
  });

  test("createInt", () => {
    expect(clarityToString(createInt(-7))).toBe("-7");
  });

  test("createPrincipal", () => {
    const cv = createPrincipal("SP000000000000000000002Q6VF78");
    expect(clarityToString(cv)).toContain("SP000000000000000000002Q6VF78");
  });

  test("createStringAscii", () => {
    expect(clarityToString(createStringAscii("hello"))).toBe(`"hello"`);
  });

  test("createStringUtf8", () => {
    expect(clarityToString(createStringUtf8("hello"))).toBe(`u"hello"`);
  });

  test("createBool", () => {
    expect(clarityToString(createBool(true))).toBe("true");
    expect(clarityToString(createBool(false))).toBe("false");
  });

  test("createBuffer from hex", () => {
    const cv = createBuffer("deadbeef");
    expect(clarityToString(cv)).toBe("0xdeadbeef");
  });

  test("createNone and createSome", () => {
    expect(clarityToString(createNone())).toBe("none");
    expect(clarityToString(createSome(createUint(1)))).toBe("(some u1)");
  });

  test("createList", () => {
    const cv = createList([createUint(1), createUint(2)]);
    expect(clarityToString(cv)).toContain("u1");
  });

  test("createTuple", () => {
    const cv = createTuple({ amount: createUint(50) });
    expect(clarityToString(cv)).toContain("amount");
    expect(clarityToString(cv)).toContain("u50");
  });
});

describe("serializeClarityValue", () => {
  test("returns a hex string", () => {
    const hex = serializeClarityValue(createUint(1));
    expect(typeof hex).toBe("string");
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.length).toBeGreaterThan(0);
  });

  test("different values produce different hex", () => {
    const hex1 = serializeClarityValue(createUint(1));
    const hex2 = serializeClarityValue(createUint(2));
    expect(hex1).not.toBe(hex2);
  });
});
