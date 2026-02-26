import { describe, test, expect } from "bun:test";
import {
  MAINNET_CONTRACTS,
  TESTNET_CONTRACTS,
  getContracts,
  parseContractId,
  WELL_KNOWN_TOKENS,
  getAlexContracts,
  getZestContracts,
  getWellKnownTokens,
  getBitflowContracts,
  getErc8004Contracts,
  ZEST_ASSETS,
  ZEST_ASSETS_LIST,
  BITFLOW_CONTRACTS,
} from "./contracts.js";

describe("contracts config", () => {
  test("getContracts returns mainnet contracts for mainnet", () => {
    const contracts = getContracts("mainnet");
    expect(contracts).toBe(MAINNET_CONTRACTS);
    expect(contracts.SBTC_TOKEN).toContain("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4");
  });

  test("getContracts returns testnet contracts for testnet", () => {
    const contracts = getContracts("testnet");
    expect(contracts).toBe(TESTNET_CONTRACTS);
    expect(contracts.SBTC_TOKEN).toContain("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM");
  });

  test("parseContractId splits address and name", () => {
    expect(parseContractId("SP000000000000000000002Q6VF78.bns")).toEqual({
      address: "SP000000000000000000002Q6VF78",
      name: "bns",
    });
  });

  test("parseContractId throws on invalid input", () => {
    expect(() => parseContractId("invalid")).toThrow("Invalid contract ID");
    expect(() => parseContractId("")).toThrow("Invalid contract ID");
  });

  test("WELL_KNOWN_TOKENS has STX as native on both networks", () => {
    expect(WELL_KNOWN_TOKENS.mainnet.STX).toBe("native");
    expect(WELL_KNOWN_TOKENS.testnet.STX).toBe("native");
  });

  test("getAlexContracts returns contracts for mainnet, null for testnet", () => {
    expect(getAlexContracts("mainnet")).toHaveProperty("ammPool");
    expect(getAlexContracts("testnet")).toBeNull();
  });

  test("getZestContracts returns contracts for mainnet, null for testnet", () => {
    const zest = getZestContracts("mainnet");
    expect(zest).not.toBeNull();
    expect(zest!.poolBorrow).toBeDefined();
    expect(getZestContracts("testnet")).toBeNull();
  });

  test("ZEST_ASSETS has expected assets with correct structure", () => {
    const sbtc = ZEST_ASSETS.sBTC;
    expect(sbtc.decimals).toBe(8);
    expect(sbtc.symbol).toBe("sBTC");
    expect(sbtc.token).toContain("sbtc-token");
  });

  test("ZEST_ASSETS_LIST has 10 entries", () => {
    expect(ZEST_ASSETS_LIST).toHaveLength(10);
  });

  test("getWellKnownTokens returns correct tokens per network", () => {
    const mainnetTokens = getWellKnownTokens("mainnet");
    expect(mainnetTokens.sBTC).toBe(MAINNET_CONTRACTS.SBTC_TOKEN);
  });

  test("getBitflowContracts returns correct addresses", () => {
    expect(getBitflowContracts("mainnet").PRIMARY).toBe(BITFLOW_CONTRACTS.mainnet.PRIMARY);
    expect(getBitflowContracts("testnet").PRIMARY).toBe(BITFLOW_CONTRACTS.testnet.PRIMARY);
  });

  test("getErc8004Contracts returns registry addresses", () => {
    const erc = getErc8004Contracts("mainnet");
    expect(erc.identityRegistry).toBe(MAINNET_CONTRACTS.IDENTITY_REGISTRY);
    expect(erc.reputationRegistry).toBe(MAINNET_CONTRACTS.REPUTATION_REGISTRY);
    expect(erc.validationRegistry).toBe(MAINNET_CONTRACTS.VALIDATION_REGISTRY);
  });

  test("all contract IDs follow address.name format", () => {
    for (const [key, value] of Object.entries(MAINNET_CONTRACTS)) {
      expect(value).toMatch(/^S[A-Z0-9]+\.[a-zA-Z0-9-]+$/);
    }
  });
});
