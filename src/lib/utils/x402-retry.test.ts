import { describe, expect, test } from "bun:test";
import { extractInboxPaymentMetadata } from "./x402-retry.js";

describe("extractInboxPaymentMetadata", () => {
  test("returns pending payment metadata nested under inbox", () => {
    expect(
      extractInboxPaymentMetadata({
        inbox: {
          paymentId: "pay_123",
          paymentStatus: "pending",
        },
      })
    ).toEqual({
      paymentId: "pay_123",
      paymentStatus: "pending",
    });
  });

  test("ignores missing or invalid inbox payment metadata", () => {
    expect(extractInboxPaymentMetadata({})).toEqual({});
    expect(
      extractInboxPaymentMetadata({
        inbox: {
          paymentId: "",
          paymentStatus: "unknown",
        },
      })
    ).toEqual({});
  });
});
