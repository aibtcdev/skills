import { describe, test, expect } from "bun:test";
import {
  createStxPostCondition,
  createContractStxPostCondition,
  createFungiblePostCondition,
  createContractFungiblePostCondition,
  createNftSendPostCondition,
  createNftNotSendPostCondition,
  PostConditionMode,
} from "./post-conditions.js";

const TEST_ADDR = "SP000000000000000000002Q6VF78";
const TEST_CONTRACT = "SP000000000000000000002Q6VF78.pox-4";
const TOKEN_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

describe("STX post conditions", () => {
  test("createStxPostCondition returns a post condition for each code", () => {
    for (const code of ["eq", "gt", "gte", "lt", "lte"] as const) {
      const pc = createStxPostCondition(TEST_ADDR, code, 1000n);
      expect(pc).toBeDefined();
      expect(pc.type).toContain("stx");
    }
  });

  test("default condition code is eq", () => {
    const pc = createStxPostCondition(TEST_ADDR, "eq" as any, 500n);
    expect(pc).toBeDefined();
  });

  test("createContractStxPostCondition works for all codes", () => {
    for (const code of ["eq", "gt", "gte", "lt", "lte"] as const) {
      const pc = createContractStxPostCondition(TEST_CONTRACT, code, 2000n);
      expect(pc).toBeDefined();
      expect(pc.type).toContain("stx");
    }
  });
});

describe("fungible token post conditions", () => {
  test("createFungiblePostCondition for all codes", () => {
    for (const code of ["eq", "gt", "gte", "lt", "lte"] as const) {
      const pc = createFungiblePostCondition(TEST_ADDR, TOKEN_CONTRACT, "sbtc-token", code, 100n);
      expect(pc).toBeDefined();
      expect(pc.type).toContain("ft");
    }
  });

  test("createContractFungiblePostCondition for all codes", () => {
    for (const code of ["eq", "gt", "gte", "lt", "lte"] as const) {
      const pc = createContractFungiblePostCondition(TEST_CONTRACT, TOKEN_CONTRACT, "sbtc-token", code, 100n);
      expect(pc).toBeDefined();
      expect(pc.type).toContain("ft");
    }
  });

  test("invalid contract ID throws", () => {
    expect(() => createFungiblePostCondition(TEST_ADDR, "invalid", "token", "eq", 100n)).toThrow("Invalid contract ID");
  });
});

describe("NFT post conditions", () => {
  test("createNftSendPostCondition with bigint tokenId", () => {
    const pc = createNftSendPostCondition(TEST_ADDR, TOKEN_CONTRACT, "nft-name", 1n);
    expect(pc).toBeDefined();
    expect(pc.type).toContain("nft");
  });

  test("createNftSendPostCondition with number tokenId", () => {
    const pc = createNftSendPostCondition(TEST_ADDR, TOKEN_CONTRACT, "nft-name", 42);
    expect(pc).toBeDefined();
  });

  test("createNftNotSendPostCondition", () => {
    const pc = createNftNotSendPostCondition(TEST_ADDR, TOKEN_CONTRACT, "nft-name", 1n);
    expect(pc).toBeDefined();
    expect(pc.type).toContain("nft");
  });
});

describe("PostConditionMode export", () => {
  test("PostConditionMode has Allow and Deny", () => {
    expect(PostConditionMode.Allow).toBeDefined();
    expect(PostConditionMode.Deny).toBeDefined();
  });
});
