import { describe, test, expect } from "bun:test";
import {
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  P2TR_OUTPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
  DUST_THRESHOLD,
  P2TR_INPUT_BASE_VBYTES,
} from "./bitcoin-constants.js";

describe("bitcoin constants", () => {
  test("P2WPKH input size is 68 vB", () => {
    expect(P2WPKH_INPUT_VBYTES).toBe(68);
  });

  test("P2WPKH output size is 31 vB", () => {
    expect(P2WPKH_OUTPUT_VBYTES).toBe(31);
  });

  test("P2TR output size is 43 vB", () => {
    expect(P2TR_OUTPUT_VBYTES).toBe(43);
  });

  test("TX overhead is 10.5 vB", () => {
    expect(TX_OVERHEAD_VBYTES).toBe(10.5);
  });

  test("dust threshold is 546 sats", () => {
    expect(DUST_THRESHOLD).toBe(546);
  });

  test("P2TR input base size is 57.5 vB", () => {
    expect(P2TR_INPUT_BASE_VBYTES).toBe(57.5);
  });

  test("simple fee estimation: 1-in-1-out P2WPKH tx", () => {
    const estimatedVbytes = TX_OVERHEAD_VBYTES + P2WPKH_INPUT_VBYTES + P2WPKH_OUTPUT_VBYTES;
    // 10.5 + 68 + 31 = 109.5 vB — reasonable for a simple tx
    expect(estimatedVbytes).toBe(109.5);
  });
});
