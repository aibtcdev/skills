import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { xOnlyPubkeyToP2TR } from "./stacks-alpha-engine";

// BIP-86 test vectors (m/86'/0'/0'/0/0 and /1): x-only internal key -> key-path P2TR address.
const BIP86 = [
  ["cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115", "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"],
  ["83dfe85a3151d2517290da461fe2815591ef69f2b18a2ce63f01697a8b313145", "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh"],
] as const;

describe("xOnlyPubkeyToP2TR (BIP-341 key tweak)", () => {
  test("matches the BIP-86 vectors", () => {
    for (const [key, address] of BIP86) expect(xOnlyPubkeyToP2TR(key)).toBe(address);
  });

  test("matches @scure/btc-signer for other keys", () => {
    for (const key of [
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
    ]) {
      expect(xOnlyPubkeyToP2TR(key)).toBe(p2tr(hex.decode(key)).address!);
    }
  });

  test("rejects an x coordinate that is not on the curve", () => {
    expect(() => xOnlyPubkeyToP2TR("ff".repeat(32))).toThrow();
  });
});
