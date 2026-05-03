import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { getStacksChainId } from "../config/caip.js";
import { NETWORK, type Network } from "../config/networks.js";
import {
  buildPaymentStatusCheckUrl,
  classifyCanonicalPaymentOutcome,
  createApiClient,
  extractPaymentIdentifierFromPaymentSignature,
  fetchCanonicalPaymentStatus,
  getCanonicalPaymentMetadata,
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

  test("degrades explicitly after a paid response when no canonical hint is available", async () => {
    const diagnostics = capturePaymentDiagnostics();
    const network = NETWORK as Network;
    const seen = {
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
        seen.paymentId = extractPaymentIdentifierFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (seen.paymentId && url.pathname === `/payment/${seen.paymentId}`) {
        seen.canonicalPolls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: seen.paymentId,
            status: "queued",
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/${seen.paymentId}`,
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
      // Cast needed: attachCanonicalPaymentMetadata writes dynamic x402* fields
      // onto the AxiosResponse object, which the AxiosResponse type doesn't declare.
      // Cast needed: dynamic x402* fields added by attachCanonicalPaymentMetadata
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(seen.paymentId.startsWith("pay_")).toBe(true);
      expect(seen.canonicalPolls).toBe(0);
      expect(responseMeta.x402PaymentId).toBeUndefined();
      expect(responseMeta.x402CheckUrl).toBeUndefined();
      expect(responseMeta.x402PaymentStatus).toBeUndefined();
      expect(responseMeta.x402PaymentDecision).toBeUndefined();
      expect(diagnostics.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payment.accepted",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
            action: "submit_paid_request",
          }),
          expect.objectContaining({
            event: "payment.fallback_used",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
            action: "canonical_status_unavailable_after_paid_response",
            checkStatusUrl_present: false,
          }),
        ])
      );
    } finally {
      diagnostics.restore();
      server.close();
      await once(server, "close");
    }
  });

  test("does not use an origin-local status route when canonical hints are absent", async () => {
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
        seen.paymentId = extractPaymentIdentifierFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (seen.paymentId && url.pathname === `/payment/${seen.paymentId}`) {
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
      // Cast needed: dynamic x402* fields added by attachCanonicalPaymentMetadata
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(seen.canonicalPolls).toBe(0);
      expect(responseMeta.x402PaymentId).toBeUndefined();
      expect(responseMeta.x402CheckUrl).toBeUndefined();
      expect(responseMeta.x402PaymentStatus).toBeUndefined();
      expect(diagnostics.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "payment.fallback_used",
            tool: "test.endpoint",
            paymentId: seen.paymentId,
            action: "canonical_status_unavailable_after_paid_response",
            checkStatusUrl_present: false,
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
        seen.paymentId = extractPaymentIdentifierFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (seen.paymentId && url.pathname === `/payment/${seen.paymentId}`) {
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
      // Cast needed: dynamic x402* fields added by attachCanonicalPaymentMetadata
      const responseMeta = response as unknown as Record<string, unknown>;

      expect(response.data).toEqual({ ok: true });
      expect(responseMeta.x402PaymentId).toBeUndefined();
      expect(responseMeta.x402CheckUrl).toBeUndefined();
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
            checkStatusUrl_present: false,
          }),
        ])
      );
    } finally {
      diagnostics.restore();
      server.close();
      await once(server, "close");
    }
  });

  test("surfaces canonical payment metadata from an explicit upstream hint", async () => {
    const network = NETWORK as Network;
    const seen = {
      paymentIdentifier: "",
      canonicalPolls: 0,
    };
    const relayPaymentId = "pay_relay_123";
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/paid" && !req.headers[X402_HEADERS.PAYMENT_SIGNATURE]) {
        res.statusCode = 402;
        res.setHeader(
          X402_HEADERS.PAYMENT_REQUIRED,
          Buffer.from(
            JSON.stringify({
              x402Version: 2,
              resource: { url: `${serverOrigin(server)}/paid` },
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
        seen.paymentIdentifier = extractPaymentIdentifierFromPaymentSignature(
          String(req.headers[X402_HEADERS.PAYMENT_SIGNATURE])
        ) ?? "";
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            payment: {
              checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/${relayPaymentId}`,
            },
          })
        );
        return;
      }

      if (url.pathname === `/rpc/payment-check/${relayPaymentId}`) {
        seen.canonicalPolls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: relayPaymentId,
            status: "queued",
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/${relayPaymentId}`,
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
      const metadata = getCanonicalPaymentMetadata(response);

      expect(response.data).toEqual({
        ok: true,
        payment: {
          checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/${relayPaymentId}`,
        },
      });
      expect(seen.paymentIdentifier.startsWith("pay_")).toBe(true);
      expect(seen.paymentIdentifier).not.toBe(relayPaymentId);
      expect(seen.canonicalPolls).toBe(1);
      expect(metadata.paymentId).toBe(relayPaymentId);
      expect(metadata.checkUrl).toBe(
        `${serverOrigin(server)}/rpc/payment-check/${relayPaymentId}`
      );
      expect(metadata.paymentStatus).toMatchObject({
        paymentId: relayPaymentId,
        status: "queued",
      });
      expect(metadata.paymentDecision).toMatchObject({
        action: "poll",
      });
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

  test("stays explicit when the canonical hint is absent", () => {
    expect(
      resolveCanonicalCheckStatusUrl(
        "https://x402-relay.aibtc.com/some/paid/path",
        "pay_123"
      )
    ).toBeUndefined();
  });
});

describe("buildPaymentStatusCheckUrl", () => {
  // Pin the URL contract so a future rename of the relay route surfaces here
  // instead of as runtime `unknown_payment_identity` failures whenever the
  // relay omits checkStatusUrl from its response.
  test("constructs the relay's /payment/{id} route", () => {
    expect(buildPaymentStatusCheckUrl("https://x402-relay.aibtc.com", "pay_abc")).toBe(
      "https://x402-relay.aibtc.com/payment/pay_abc"
    );
  });

  test("preserves the origin and ignores path/query on the input baseUrl", () => {
    expect(
      buildPaymentStatusCheckUrl("https://x402-relay.aibtc.com/inbox/send?x=1", "pay_abc")
    ).toBe("https://x402-relay.aibtc.com/payment/pay_abc");
  });

  test("percent-encodes the paymentId path segment", () => {
    // Defensive: paymentIds today are `pay_<hex>` and contain no reserved
    // characters, but a future ID format change shouldn't be able to escape
    // the `/payment/` segment and hit an unintended relay route.
    expect(buildPaymentStatusCheckUrl("https://relay.example", "pay/../admin")).toBe(
      "https://relay.example/payment/pay%2F..%2Fadmin"
    );
    expect(buildPaymentStatusCheckUrl("https://relay.example", "pay?x=1#frag")).toBe(
      "https://relay.example/payment/pay%3Fx%3D1%23frag"
    );
  });
});

describe("fetchCanonicalPaymentStatus", () => {
  test("consumes an explicit canonical poll hint when provided", async () => {
    const seen = { hintHits: 0, localRouteHits: 0 };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/rpc/payment-check/pay_123") {
        seen.hintHits += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: "pay_123",
            status: "queued",
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
          })
        );
        return;
      }

      if (url.pathname === "/payment/pay_123") {
        seen.localRouteHits += 1;
        res.statusCode = 500;
        res.end("should not be called");
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      expect(
        await fetchCanonicalPaymentStatus(
          "pay_123",
          serverOrigin(server),
          {
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
          }
        )
      ).toMatchObject({
        paymentId: "pay_123",
        status: "queued",
        checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
      });
      expect(seen.hintHits).toBe(1);
      expect(seen.localRouteHits).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("does not poll a synthesized local route unless explicitly enabled", async () => {
    const seen = { localRouteHits: 0 };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/payment/pay_123") {
        seen.localRouteHits += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ paymentId: "pay_123", status: "queued" }));
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      expect(
        await fetchCanonicalPaymentStatus("pay_123", serverOrigin(server))
      ).toBeNull();
      expect(seen.localRouteHits).toBe(0);
      expect(
        await fetchCanonicalPaymentStatus(
          "pay_123",
          serverOrigin(server),
          {
            localStatusRouteBaseUrl: serverOrigin(server),
          }
        )
      ).toMatchObject({
        paymentId: "pay_123",
        status: "queued",
      });
      expect(seen.localRouteHits).toBe(1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  test("prefers the canonical hint even when a bounded local fallback is available", async () => {
    const seen = { hintHits: 0, localRouteHits: 0 };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/rpc/payment-check/pay_123") {
        seen.hintHits += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            paymentId: "pay_123",
            status: "confirmed",
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
          })
        );
        return;
      }

      if (url.pathname === "/payment/pay_123") {
        seen.localRouteHits += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ paymentId: "pay_123", status: "queued" }));
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      expect(
        await fetchCanonicalPaymentStatus(
          "pay_123",
          serverOrigin(server),
          {
            checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
            localStatusRouteBaseUrl: serverOrigin(server),
          }
        )
      ).toMatchObject({
        paymentId: "pay_123",
        status: "confirmed",
        checkStatusUrl: `${serverOrigin(server)}/rpc/payment-check/pay_123`,
      });
      expect(seen.hintHits).toBe(1);
      expect(seen.localRouteHits).toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

function serverOrigin(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}
