import { describe, expect, test } from "bun:test";
import {
  classifyRetryableError,
  extractInboxPaymentMetadata,
  extractServerIssuedPaymentIdentifier,
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

  test("falls back to server-issued paymentId in response body when inbox.paymentId is absent", () => {
    expect(
      extractInboxPaymentMetadata({
        paymentId: "pay_server_issued_456",
      })
    ).toEqual({
      paymentId: "pay_server_issued_456",
      paymentStatus: undefined,
      compatShimUsed: false,
    });

    expect(
      extractInboxPaymentMetadata({
        "payment-identifier": {
          info: { id: "pay_server_ext_789" },
        },
      })
    ).toEqual({
      paymentId: "pay_server_ext_789",
      paymentStatus: undefined,
      compatShimUsed: false,
    });
  });
});

describe("extractServerIssuedPaymentIdentifier", () => {
  test("extracts identifier from settlement extensions (payment-response header)", () => {
    const settlement = {
      success: true,
      transaction: "0x123",
      network: "stacks:1" as const,
      extensions: {
        "payment-identifier": {
          info: { id: "pay_settlement_ext_123" },
        },
      },
    };
    expect(extractServerIssuedPaymentIdentifier(null, settlement)).toBe("pay_settlement_ext_123");
  });

  test("extracts identifier from settlement extensions direct paymentId key", () => {
    const settlement = {
      success: true,
      transaction: "0x123",
      network: "stacks:1" as const,
      extensions: {
        paymentId: "pay_direct_key_456",
      },
    };
    expect(extractServerIssuedPaymentIdentifier(null, settlement)).toBe("pay_direct_key_456");
  });

  test("extracts identifier from response body payment_identifier", () => {
    expect(
      extractServerIssuedPaymentIdentifier({ payment_identifier: "pay_body_snake_789" })
    ).toBe("pay_body_snake_789");
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
