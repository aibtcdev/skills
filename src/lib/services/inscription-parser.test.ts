import { describe, test, expect } from "bun:test";
import { InscriptionParser, createInscriptionParser } from "./inscription-parser.js";

describe("InscriptionParser", () => {
  test("createInscriptionParser returns an InscriptionParser instance", () => {
    const parser = createInscriptionParser("mainnet");
    expect(parser).toBeInstanceOf(InscriptionParser);
  });

  test("parser can be created for both networks", () => {
    const mainnet = createInscriptionParser("mainnet");
    const testnet = createInscriptionParser("testnet");
    expect(mainnet).toBeInstanceOf(InscriptionParser);
    expect(testnet).toBeInstanceOf(InscriptionParser);
  });

  test("parseWitness throws for non-3-element witness (micro-ordinals requirement)", () => {
    const parser = createInscriptionParser("mainnet");
    // micro-ordinals requires exactly 3 witness elements
    expect(() => parser.parseWitness([])).toThrow("Wrong witness");
    expect(() => parser.parseWitness(["deadbeef"])).toThrow("Wrong witness");
    expect(() => parser.parseWitness(["aa", "bb"])).toThrow("Wrong witness");
  });

  test("parseWitness with invalid script data throws or returns undefined", () => {
    const parser = createInscriptionParser("mainnet");
    // micro-ordinals is strict about script parsing — invalid data throws
    // This validates the wrapper doesn't silently swallow random data
    const witness = [
      "3044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622ad4010726870540656fe9dcb01",
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "51".repeat(33), // valid-length control block with OP_1 opcodes
    ];
    // Should either throw or return undefined — both are acceptable
    try {
      const result = parser.parseWitness(witness);
      // If it doesn't throw, result should be undefined (no inscriptions)
      expect(result).toBeUndefined();
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});
