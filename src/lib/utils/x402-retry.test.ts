import { describe, expect, test } from "bun:test";
import {
  extractInboxPaymentMetadata,
  resolveInboxPaymentTracking,
} from "./x402-retry.js";

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

describe("resolveInboxPaymentTracking", () => {
  test("falls back to the sent payment id when inbox metadata is absent", () => {
    expect(resolveInboxPaymentTracking({}, "pay_sent")).toEqual({
      paymentId: "pay_sent",
      paymentStatus: undefined,
      nonceReference: "",
    });
  });

  test("uses a pending nonce reference when the inbox reports pending status", () => {
    expect(
      resolveInboxPaymentTracking(
        {
          inbox: {
            paymentStatus: "pending",
          },
        },
        "pay_sent"
      )
    ).toEqual({
      paymentId: "pay_sent",
      paymentStatus: "pending",
      nonceReference: "pending:pay_sent",
    });
  });
});
