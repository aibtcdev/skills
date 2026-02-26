import { describe, test, expect } from "bun:test";
import {
  STACKS_CHAIN_IDS,
  BITCOIN_CHAIN_IDS,
  getStacksChainId,
  getBitcoinChainId,
  parseChainId,
  isStacksChainId,
  isBitcoinChainId,
  getNetworkFromStacksChainId,
  getNetworkFromBitcoinChainId,
} from "./caip.js";

describe("CAIP-2 chain identifiers", () => {
  test("STACKS_CHAIN_IDS has correct values", () => {
    expect(STACKS_CHAIN_IDS.mainnet).toBe("stacks:1");
    expect(STACKS_CHAIN_IDS.testnet).toBe("stacks:2147483648");
  });

  test("BITCOIN_CHAIN_IDS has correct values", () => {
    expect(BITCOIN_CHAIN_IDS.mainnet).toBe("bip122:000000000019d6689c085ae165831e93");
    expect(BITCOIN_CHAIN_IDS.testnet).toBe("bip122:000000000933ea01ad0ee984209779ba");
  });

  test("getStacksChainId returns correct chain ID", () => {
    expect(getStacksChainId("mainnet")).toBe("stacks:1");
    expect(getStacksChainId("testnet")).toBe("stacks:2147483648");
  });

  test("getBitcoinChainId returns correct chain ID", () => {
    expect(getBitcoinChainId("mainnet")).toBe("bip122:000000000019d6689c085ae165831e93");
    expect(getBitcoinChainId("testnet")).toBe("bip122:000000000933ea01ad0ee984209779ba");
  });

  test("parseChainId splits namespace and reference", () => {
    expect(parseChainId("stacks:1")).toEqual({ namespace: "stacks", reference: "1" });
    expect(parseChainId("bip122:000000000019d6689c085ae165831e93")).toEqual({
      namespace: "bip122",
      reference: "000000000019d6689c085ae165831e93",
    });
  });

  test("parseChainId throws on invalid input", () => {
    expect(() => parseChainId("invalid")).toThrow("Invalid CAIP-2 chain ID");
    expect(() => parseChainId("")).toThrow("Invalid CAIP-2 chain ID");
  });

  test("isStacksChainId correctly identifies Stacks chains", () => {
    expect(isStacksChainId("stacks:1")).toBe(true);
    expect(isStacksChainId("bip122:000000000019d6689c085ae165831e93")).toBe(false);
  });

  test("isBitcoinChainId correctly identifies Bitcoin chains", () => {
    expect(isBitcoinChainId("bip122:000000000019d6689c085ae165831e93")).toBe(true);
    expect(isBitcoinChainId("stacks:1")).toBe(false);
  });

  test("getNetworkFromStacksChainId returns correct network", () => {
    expect(getNetworkFromStacksChainId("stacks:1")).toBe("mainnet");
    expect(getNetworkFromStacksChainId("stacks:2147483648")).toBe("testnet");
    expect(getNetworkFromStacksChainId("stacks:999")).toBeNull();
  });

  test("getNetworkFromBitcoinChainId returns correct network", () => {
    expect(getNetworkFromBitcoinChainId("bip122:000000000019d6689c085ae165831e93")).toBe("mainnet");
    expect(getNetworkFromBitcoinChainId("bip122:000000000933ea01ad0ee984209779ba")).toBe("testnet");
    expect(getNetworkFromBitcoinChainId("bip122:unknown")).toBeNull();
  });
});
