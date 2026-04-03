import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { getStacksChainId } from "../config/caip.js";
import { NETWORK, type Network } from "../config/networks.js";
import {
  buildPaymentStatusCheckUrl,
  classifyCanonicalPaymentOutcome,
  createApiClient,
  extractPaymentIdFromPaymentSignature,
  normalizeCallerFacingPaymentStatus,
  resolveCanonicalCheckStatusUrl,
  mnemonicToAccount,
} from "./x402.service.js";
import { X402_HEADERS } from "../utils/x402-protocol.js";
import type { PaymentDiagnosticEntry } from "../utils/x402-diagnostics.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function capturePaymentDiagnostics(): {
  entries: PaymentDiagnosticEntry[];
  restore: () => void;
} {
  const entries: PaymentDiagnosticEntry[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(arg) as PaymentDiagnosticEntry;
        if (parsed.service === "skills" && typeof parsed.event === "string") {
          entries.push(parsed);
        }
      } catch {
        // ignore non-JSON console output
      }
    }
  };

  return {
    entries,
    restore: () => {
      console.error = originalConsoleError;
    },
  };
}

describe("normalizeCallerFacingPaymentStatus", () => {
  test("collapses legacy transport statuses before exposing them", () => {
    expect(normalizeCallerFacingPaymentStatus("pending")).toBe("queued");
    expect(normalizeCallerFacingPaymentStatus("submitted")).toBe("queued");
  });
});

describe("classifyCanonicalPaymentOutcome", () => {
  test("keeps in-flight states on the same payment", () => {
    expect(classifyCanonicalPaymentOutcome("queued")).toMatchObject({
      action: "poll",
      shouldPollSamePayment: true,
      shouldRebuildResign: false,
      stopPollingOldPayment: false,
    });

    expect(classifyCanonicalPaymentOutcome("mempool")).toMatchObject({
      action: "poll",
      shouldPollSamePayment: true,
      shouldRebuildResign: false,
      stopPollingOldPayment: false,
    });
  });

  test("routes sender nonce terminal reasons to rebuild guidance", () => {
    expect(
      classifyCanonicalPaymentOutcome("failed", "sender_nonce_stale")
    ).toMatchObject({
      action: "rebuild_resign",
      shouldRebuildResign: true,
      shouldRetryNewPayment: false,
    });
  });

  test("does not map relay or sponsor failures to sender rebuild guidance", () => {
    expect(
      classifyCanonicalPaymentOutcome("failed", "sponsor_failure")
    ).toMatchObject({
      action: "bounded_retry",
      shouldRebuildResign: false,
      shouldRetryNewPayment: true,
    });
  });

  test("stops polling replaced and not_found payment identities", () => {
    expect(
      classifyCanonicalPaymentOutcome("replaced", "superseded")
    ).toMatchObject({
      action: "stop",
      stopPollingOldPayment: true,
    });

    expect(
      classifyCanonicalPaymentOutcome("not_found", "unknown_payment_identity")
    ).toMatchObject({
      action: "restart",
      stopPollingOldPayment: true,
    });
  });
});

describe("createApiClient canonical payment flow", () => {
  const originalMnemonic = process.env.CLIENT_MNEMONIC;
  let recipientAddress = "";

  beforeEach(async () => {
    process.env.CLIENT_MNEMONIC = TEST_MNEMONIC;
    const account = await mnemonicToAccount(TEST_MNEMONIC, NETWORK);
    recipientAddress = account.address;
  });

  afterEach(() => {
    if (originalMnemonic === undefined) {
      delete process.env.CLIENT_MNEMONIC;
    } else {
      process.env.CLIENT_MNEMONIC = originalMnemonic;
    }
  });

  test("uses the relay-supplied canonical poll hint after a paid response", async () => {
    const diagnostics = capturePaymentDiagnostics();
    const network = NETWORK as Network;
    const originState = {
      paymentId: "",
      canonicalPolls: 0,
    };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/paid" && !req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        res.statusCode = 402;
        res.setHeader(
          X402_HEADERS.PAYMENT_REQUIRED,
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: "http://example.test/paid" },
              accepts: [
                {
                  scheme: "exact",
                  network: getStacksChainId(network),
                  amount: "1",
                  asset: "STX",
                  payTo: recipientAddress,
                  maxTimeoutSeconds: 60,
                },
              ],
            })
          ).toString("base64")
        );
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }

      if (url.pathname === "/paid" && req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        originState.paymentId = extractPaymentIdFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (
        originState.paymentId &&
        url.pathname === `/api/payment-status/${originState.paymentId}`
      ) {
        originState.canonicalPolls += 1;
        const canonicalHint = `${serverOrigin(server)}/rpc/payment-check/${originState.paymentId}`;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: originState.paymentId,
            status: "queued",
            checkStatusUrl: canonicalHint,
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const api = await createApiClient(serverOrigin(server), "test.endpoint");
      const response = await api.request({ method: "GET", url: "/paid" });
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(originState.paymentId.startsWith("pay_")).toBe(true);
      expect(originState.canonicalPolls).toBe(1);
      expect(responseMeta.x402PaymentId).toBe(originState.paymentId);
      expect(responseMeta.x402CheckUrl).toBe(
        `${serverOrigin(server)}/rpc/payment-check/${originState.paymentId}`
      );
      expect(responseMeta.x402PaymentStatus).toMatchObject({
        checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/${originState.paymentId}`,
      });
      expect(responseMeta.x402PaymentDecision).toMatchObject({
        action: "poll",
        shouldPollSamePayment: true,
      });
      expect(diagnostics.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payment.accepted",
            tool: "test.endpoint",
            paymentId: originState.paymentId,
            action: "submit_paid_request",
          }),
          expect.objectContaining({
            event: "payment.poll",
            tool: "test.endpoint",
            paymentId: originState.paymentId,
            status: "queued",
            action: "poll",
            checkStatusUrl_present: true,
            compat_shim_used: false,
          }),
        ])
      );
      expect(diagnostics.entries.some((entry) => entry.event === "payment.fallback_used")).toBe(false);
    } finally {
      diagnostics.restore();
      server.close();
      await once(server, "close");
    }
  });

  test("builds a fallback poll hint when canonical status omits checkStatusUrl", async () => {
    const diagnostics = capturePaymentDiagnostics();
    const network = NETWORK as Network;
    const seen: { paymentId: string; canonicalPolls: number } = {
      paymentId: "",
      canonicalPolls: 0,
    };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/paid" && !req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        res.statusCode = 402;
        res.setHeader(
          X402_HEADERS.PAYMENT_REQUIRED,
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: "http://example.test/paid" },
              accepts: [
                {
                  scheme: "exact",
                  network: getStacksChainId(network),
                  amount: "1",
                  asset: "STX",
                  payTo: recipientAddress,
                  maxTimeoutSeconds: 60,
                },
              ],
            })
          ).toString("base64")
        );
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }

      if (url.pathname === "/paid" && req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        seen.paymentId = extractPaymentIdFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (seen.paymentId && url.pathname === `/api/payment-status/${seen.paymentId}`) {
        seen.canonicalPolls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: seen.paymentId,
            status: "queued",
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const api = await createApiClient(serverOrigin(server), "test.endpoint");
      const response = await api.request({ method: "GET", url: "/paid" });
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(seen.canonicalPolls).toBe(1);
      expect(responseMeta.x402PaymentId).toBe(seen.paymentId);
      expect(responseMeta.x402CheckUrl).toBe(
        buildPaymentStatusCheckUrl(serverOrigin(server), seen.paymentId)
      );
      expect(responseMeta.x402PaymentStatus).toMatchObject({
        paymentId: seen.paymentId,
        status: "queued",
      });
      expect((responseMeta.x402PaymentStatus as { checkStatusUrl?: string }).checkStatusUrl).toBeUndefined();
      expect(diagnostics.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payment.poll",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
            status: "queued",
            action: "poll",
            checkStatusUrl_present: false,
            compat_shim_used: false,
          }),
        ])
      );
    } finally {
      diagnostics.restore();
      server.close();
      await once(server, "close");
    }
  });

  test("falls back when canonical polling is unavailable after a paid response", async () => {
    const diagnostics = capturePaymentDiagnostics();
    const network = NETWORK as Network;
    const seen: { paymentId: string } = { paymentId: "" };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/paid" && !req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        res.statusCode = 402;
        res.setHeader(
          X402_HEADERS.PAYMENT_REQUIRED,
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: "http://example.test/paid" },
              accepts: [
                {
                  scheme: "exact",
                  network: getStacksChainId(network),
                  amount: "1",
                  asset: "STX",
                  payTo: recipientAddress,
                  maxTimeoutSeconds: 60,
                },
              ],
            })
          ).toString("base64")
        );
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }

      if (url.pathname === "/paid" && req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        seen.paymentId = extractPaymentIdFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (seen.paymentId && url.pathname === `/api/payment-status/${seen.paymentId}`) {
        res.statusCode = 500;
        res.end("boom");
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const api = await createApiClient(serverOrigin(server), "test.endpoint");
      const response = await api.request({ method: "GET", url: "/paid" });
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(responseMeta.x402PaymentId).toBe(seen.paymentId);
      expect(responseMeta.x402CheckUrl).toBe(
        `${serverOrigin(server)}/api/payment-status/${seen.paymentId}`
      );
      expect(responseMeta.x402PaymentStatus).toBeUndefined();
      expect(diagnostics.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payment.accepted",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
          }),
          expect.objectContaining({
            event: "payment.fallback_used",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
            action: "canonical_status_unavailable_after_paid_response",
            checkStatusUrl_present: true,
          }),
        ])
      );
    } finally {
      diagnostics.restore();
      server.close();
      await once(server, "close");
    }
  });

  test("uses canonical polling before txid backup on retry-limit failures", async () => {
    const network = NETWORK as Network;
    const seen: { paymentId: string } = { paymentId: "" };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/paid" && !req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        res.statusCode = 402;
        res.setHeader(
          X402_HEADERS.PAYMENT_REQUIRED,
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: "http://example.test/paid" },
              accepts: [
                {
                  scheme: "exact",
                  network: getStacksChainId(network),
                  amount: "1",
                  asset: "STX",
                  payTo: recipientAddress,
                  maxTimeoutSeconds: 60,
                },
              ],
            })
          ).toString("base64")
        );
        res.end(JSON.stringify({ error: "payment required" }));
        return;
      }

      if (url.pathname === "/paid" && req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        seen.paymentId = extractPaymentIdFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 402;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "still settling" }));
        return;
      }

      if (seen.paymentId && url.pathname === `/api/payment-status/${seen.paymentId}`) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: seen.paymentId,
            status: "failed",
            terminalReason: "sender_nonce_stale",
            checkStatusUrl: `${serverOrigin(server)}/api/payment-status/${seen.paymentId}`,
          })
        );
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const api = await createApiClient(serverOrigin(server));
      try {
        await api.request({ method: "GET", url: "/paid" });
        throw new Error("expected request to fail");
      } catch (error) {
        const paymentError = error as Error & {
          x402PaymentId?: string;
          x402PaymentStatus?: { terminalReason?: string };
        };
        expect(paymentError.message).toContain("sender nonce is stale");
        expect(paymentError.x402PaymentId).toBe(seen.paymentId);
        expect(paymentError.x402PaymentStatus?.terminalReason).toBe(
          "sender_nonce_stale"
        );
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

describe("resolveCanonicalCheckStatusUrl", () => {
  test("prefers a canonical poll hint over the constructed default", () => {
    expect(
      resolveCanonicalCheckStatusUrl(
        "https://x402-relay.aibtc.com/some/paid/path",
        "pay_123",
        "https://relay.example/rpc/payment-check/pay_123"
      )
    ).toBe("https://relay.example/rpc/payment-check/pay_123");
  });

  test("constructs the default poll hint when the canonical hint is absent", () => {
    expect(
      resolveCanonicalCheckStatusUrl(
        "https://x402-relay.aibtc.com/some/paid/path",
        "pay_123"
      )
    ).toBe("https://x402-relay.aibtc.com/api/payment-status/pay_123");
  });
});

function serverOrigin(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
