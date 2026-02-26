import { describe, test, expect } from "bun:test";
import {
  getStacksNetwork,
  getApiBaseUrl,
  EXPLORER_URL,
  getExplorerTxUrl,
  getExplorerAddressUrl,
  getExplorerContractUrl,
} from "./networks.js";

describe("networks config", () => {
  test("getStacksNetwork maps correctly", () => {
    expect(getStacksNetwork("mainnet")).toBe("mainnet");
    expect(getStacksNetwork("testnet")).toBe("testnet");
  });

  test("getApiBaseUrl returns correct Hiro API URLs", () => {
    expect(getApiBaseUrl("mainnet")).toBe("https://api.mainnet.hiro.so");
    expect(getApiBaseUrl("testnet")).toBe("https://api.testnet.hiro.so");
  });

  test("EXPLORER_URL is hiro explorer", () => {
    expect(EXPLORER_URL).toBe("https://explorer.hiro.so");
  });

  test("getExplorerTxUrl formats correctly", () => {
    const url = getExplorerTxUrl("0xabc123", "mainnet");
    expect(url).toBe("https://explorer.hiro.so/txid/0xabc123?chain=mainnet");
  });

  test("getExplorerAddressUrl formats correctly", () => {
    const url = getExplorerAddressUrl("SP123", "testnet");
    expect(url).toBe("https://explorer.hiro.so/address/SP123?chain=testnet");
  });

  test("getExplorerContractUrl formats correctly", () => {
    const url = getExplorerContractUrl("SP123.contract", "mainnet");
    expect(url).toBe("https://explorer.hiro.so/txid/SP123.contract?chain=mainnet");
  });
});
