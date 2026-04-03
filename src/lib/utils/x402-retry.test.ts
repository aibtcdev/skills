import { describe, expect, test } from "bun:test";
import {
  classifyRetryableError,
  extractInboxPaymentMetadata,
  resolveInboxPaymentTracking,
} from "./x402-retry.js";

describe("extractInboxPaymentMetadata", () => {
  test("collapses legacy pending into queued caller-facing status", () => {
    expect(
      extractInboxPaymentMetadata({
        inbox: {
          paymentId: "pay_123",
          paymentStatus: "pending",
        },
      })
    ).toEqual({
      paymentId: "pay_123",
      paymentStatus: "queued",
      compatShimUsed: true,
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
    ).toEqual({
      paymentId: undefined,
      paymentStatus: undefined,
      compatShimUsed: false,
    });
  });
});

describe("resolveInboxPaymentTracking", () => {
  test("falls back to the sent payment id when inbox metadata is absent", () => {
    expect(resolveInboxPaymentTracking({}, "pay_sent")).toEqual({
      paymentId: "pay_sent",
      paymentStatus: undefined,
      nonceReference: "",
      compatShimUsed: false,
    });
  });

  test("uses an in-flight nonce reference when the inbox reports queued status", () => {
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
      paymentStatus: "queued",
      nonceReference: "pending:pay_sent",
      compatShimUsed: true,
    });
  });
});

describe("classifyRetryableError", () => {
  test("treats sender nonce duplicate as sender-side rebuild guidance", () => {
    expect(
      classifyRetryableError(409, { code: "SENDER_NONCE_DUPLICATE" })
    ).toEqual({
      retryable: true,
      delayMs: 0,
      relaySideConflict: false,
    });
  });

  test("keeps relay nonce conflict on the same signed payment", () => {
    expect(
      classifyRetryableError(409, { code: "NONCE_CONFLICT", retryAfter: 7 })
    ).toEqual({
      retryable: true,
      delayMs: 7000,
      relaySideConflict: true,
    });
  });
});
