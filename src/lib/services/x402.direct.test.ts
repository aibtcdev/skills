import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { AuthType, PostConditionMode, deserializeTransaction } from "@stacks/transactions";
import { getStacksChainId } from "../config/caip.js";
import { getContracts } from "../config/contracts.js";
import { NETWORK, type Network } from "../config/networks.js";
import { _testing as storageTesting } from "../utils/storage.js";
import { InsufficientBalanceError } from "../utils/errors.js";
import { X402_HEADERS, decodePaymentPayload } from "../utils/x402-protocol.js";
import {
  createApiClient,
  getDirectPaymentMetadata,
  mnemonicToAccount,
  parseDirectPaymentAmount,
  resolveDirectPaymentAsset,
  resolvePaymentMode,
} from "./x402.service.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const network = NETWORK as Network;
const SBTC = getContracts(network).SBTC_TOKEN;

// ---------------------------------------------------------------------------
// Fake server: one origin serves the paid endpoint AND the Stacks API routes
// the direct builder reads (fees, nonce, balances, tx status).
// ---------------------------------------------------------------------------

interface FakeOptions {
  accept?: Partial<{ asset: string; amount: string; payTo: string; network: string; maxTimeoutSeconds: number }>;
  fees?: { contract_call: number; token_transfer: number } | "error";
  balances?: { stx: string; sbtc: string };
  nonce?: number;
  txStatus?: string;
  /** When set, the paid 2xx carries a canonical checkStatusUrl hint answered with this status. */
  canonical?: { status: string; terminalReason?: string };
  /** How the paid replay is answered. */
  paid?:
    | { kind: "ok"; body?: unknown }
    | { kind: "http"; status: number; body: unknown }
    | { kind: "hang"; ms: number };
}

interface Fake {
  server: Server;
  origin: string;
  paidRequests: string[]; // raw payment-signature headers
  hiroHits: string[];
  close: () => Promise<void>;
}

async function startFake(sender: string, opts: FakeOptions = {}): Promise<Fake> {
  const paidRequests: string[] = [];
  const hiroHits: string[] = [];
  const pendingTimers: NodeJS.Timeout[] = [];
  // The Hiro client caches mempool fees for 60 s per process, so every test
  // after the first successful fetch sees these defaults regardless of its own
  // `fees` option. token_transfer sits above its 3000 µSTX ceiling on purpose
  // so the clamp is observable.
  const fees = opts.fees ?? { contract_call: 5000, token_transfer: 999_999 };
  const balances = opts.balances ?? { stx: "1000000", sbtc: "100000" };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    // --- fake Stacks API ---
    if (url.pathname === "/extended/v2/mempool/fees") {
      hiroHits.push(url.pathname);
      if (fees === "error") return json(500, { error: "boom" });
      const tier = (medium: number) => ({
        no_priority: medium / 2,
        low_priority: medium / 2,
        medium_priority: medium,
        high_priority: medium * 2,
      });
      return json(200, {
        all: tier(fees.contract_call),
        token_transfer: tier(fees.token_transfer),
        contract_call: tier(fees.contract_call),
        smart_contract: tier(fees.contract_call),
      });
    }
    if (url.pathname === `/extended/v1/address/${sender}/nonces`) {
      hiroHits.push(url.pathname);
      if (opts.nonce === -1) return json(500, { error: "nonces unavailable" });
      return json(200, {
        last_mempool_tx_nonce: null,
        last_executed_tx_nonce: (opts.nonce ?? 7) - 1,
        possible_next_nonce: opts.nonce ?? 7,
        detected_missing_nonces: [],
        detected_mempool_nonces: [],
      });
    }
    if (url.pathname === `/extended/v1/address/${sender}/balances`) {
      hiroHits.push(url.pathname);
      return json(200, {
        stx: { balance: balances.stx, total_sent: "0", total_received: balances.stx, locked: "0", lock_height: 0 },
        fungible_tokens: {
          [`${SBTC}::sbtc-token`]: { balance: balances.sbtc, total_sent: "0", total_received: balances.sbtc },
        },
        non_fungible_tokens: {},
      });
    }
    if (url.pathname.startsWith("/extended/v1/tx/")) {
      hiroHits.push(url.pathname);
      return json(200, { tx_id: url.pathname.split("/").pop(), tx_status: opts.txStatus ?? "success" });
    }
    if (url.pathname === "/rpc/payment-check/pay_relay_123") {
      return json(200, {
        paymentId: "pay_relay_123",
        status: opts.canonical?.status ?? "confirmed",
        ...(opts.canonical?.terminalReason ? { terminalReason: opts.canonical.terminalReason } : {}),
      });
    }

    // --- paid endpoint ---
    if (url.pathname === "/paid") {
      const signature = req.headers[X402_HEADERS.PAYMENT_SIGNATURE];
      if (!signature) {
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
                  amount: "100",
                  asset: SBTC,
                  payTo: sender,
                  maxTimeoutSeconds: 60,
                  ...(opts.accept ?? {}),
                },
              ],
            })
          ).toString("base64")
        );
        return res.end(JSON.stringify({ error: "payment required" }));
      }
      paidRequests.push(String(signature));
      const paid = opts.paid ?? { kind: "ok" };
      if (paid.kind === "hang") {
        pendingTimers.push(setTimeout(() => json(200, { late: true }), paid.ms));
        return;
      }
      if (paid.kind === "http") return json(paid.status, paid.body);
      if (opts.canonical) {
        return json(200, {
          ok: true,
          payment: { checkStatusUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/rpc/payment-check/pay_relay_123` },
        });
      }
      return json(200, paid.body ?? { ok: true });
    }

    json(404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

  return {
    server,
    origin,
    paidRequests,
    hiroHits,
    close: async () => {
      for (const t of pendingTimers) clearTimeout(t);
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to reject");
}

function decodeTx(paymentSignature: string) {
  const payload = decodePaymentPayload(paymentSignature);
  const hex = payload!.payload.transaction.replace(/^0x/, "");
  const tx = deserializeTransaction(hex);
  const auth = tx.auth as { authType: AuthType; spendingCondition: { fee: bigint; nonce: bigint } };
  return { tx, auth, payload: payload! };
}

// ---------------------------------------------------------------------------

describe("resolvePaymentMode", () => {
  test("defaults to sponsored and accepts direct", () => {
    expect(resolvePaymentMode(undefined)).toBe("sponsored");
    expect(resolvePaymentMode("")).toBe("sponsored");
    expect(resolvePaymentMode("Direct ")).toBe("direct");
  });

  test("rejects unknown values", () => {
    expect(() => resolvePaymentMode("auto")).toThrow(/Invalid X402_PAYMENT_MODE/);
  });
});

describe("resolveDirectPaymentAsset / parseDirectPaymentAmount", () => {
  test("accepts native STX and the canonical sBTC token only", () => {
    expect(resolveDirectPaymentAsset("STX", network)).toEqual({ kind: "STX" });
    expect(resolveDirectPaymentAsset("stx", network)).toEqual({ kind: "STX" });
    expect(resolveDirectPaymentAsset(SBTC, network)).toEqual({ kind: "sBTC", contractId: SBTC, assetName: "sbtc-token" });
    expect(resolveDirectPaymentAsset(`${SBTC}::sbtc-token`, network).kind).toBe("sBTC");
  });

  test("refuses look-alikes, third-party tokens, padding and junk", () => {
    const other = network === "mainnet" ? getContracts("testnet").SBTC_TOKEN : getContracts("mainnet").SBTC_TOKEN;
    for (const bad of [
      "SP2XYZ.sbtc-token",
      other, // right shape, wrong network
      `${SBTC}::token-sbtc`,
      ` ${SBTC}`, // the header would carry the padded form; never normalize
      " STX",
      "sbtc",
      "USDC",
      "SP2XYZ.usdc-token::usdc",
      "",
    ]) {
      expect(() => resolveDirectPaymentAsset(bad, network)).toThrow(/Direct x402 payment refused/);
    }
  });

  test("amount must be a positive integer under the cap", () => {
    const sbtc = resolveDirectPaymentAsset(SBTC, network);
    expect(parseDirectPaymentAmount("100", sbtc)).toBe(100n);
    for (const bad of ["0", "-1", "1.5", "1e3", "", "abc", "010", " 100", "100 "]) {
      expect(() => parseDirectPaymentAmount(bad, sbtc)).toThrow(/positive integer/);
    }
    expect(() => parseDirectPaymentAmount("10001", sbtc)).toThrow(/X402_MAX_SATS_PER_PAYMENT/);
    const prev = process.env.X402_MAX_SATS_PER_PAYMENT;
    process.env.X402_MAX_SATS_PER_PAYMENT = "20000";
    try {
      expect(parseDirectPaymentAmount("10001", sbtc)).toBe(10001n);
    } finally {
      if (prev === undefined) delete process.env.X402_MAX_SATS_PER_PAYMENT;
      else process.env.X402_MAX_SATS_PER_PAYMENT = prev;
    }
    expect(() => parseDirectPaymentAmount("1000001", { kind: "STX" })).toThrow(/X402_MAX_USTX_PER_PAYMENT/);
  });
});

describe("createApiClient payment modes", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let sender = "";
  let fake: Fake | null = null;

  beforeEach(async () => {
    for (const key of ["CLIENT_MNEMONIC", "X402_PAYMENT_MODE", "X402_MAX_FEE_USTX", "X402_MAX_SATS_PER_PAYMENT"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLIENT_MNEMONIC = TEST_MNEMONIC;
    delete process.env.X402_PAYMENT_MODE;
    delete process.env.X402_MAX_FEE_USTX;
    delete process.env.X402_MAX_SATS_PER_PAYMENT;
    sender = (await mnemonicToAccount(TEST_MNEMONIC, network)).address;
  });

  afterEach(async () => {
    storageTesting.overrideStacksApiUrl(null);
    if (fake) {
      await fake.close();
      fake = null;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function up(opts: FakeOptions = {}): Promise<Fake> {
    fake = await startFake(sender, opts);
    storageTesting.overrideStacksApiUrl(fake.origin);
    return fake;
  }

  test("default (sponsored) mode is unchanged: sponsored auth, fee 0, no direct metadata", async () => {
    const f = await up();
    const api = await createApiClient(f.origin, "test.sponsored");
    const response = await api.request({ method: "GET", url: "/paid" });

    expect(response.data).toEqual({ ok: true });
    expect(f.paidRequests).toHaveLength(1);
    const { auth, tx } = decodeTx(f.paidRequests[0]);
    expect(auth.authType).toBe(AuthType.Sponsored);
    expect(auth.spendingCondition.fee).toBe(0n);
    expect(tx.postConditionMode).toBe(PostConditionMode.Allow);
    expect(getDirectPaymentMetadata(response)).toEqual({
      mode: undefined,
      txid: undefined,
      txStatus: undefined,
      settlementState: undefined,
    });
    // The sponsored path never touches the Stacks API.
    expect(f.hiroHits).toEqual([]);
  });

  // Runs before any other direct test on purpose: the Hiro client caches
  // mempool fees for 60 s per process, so a fee-endpoint failure is only
  // observable while that cache is still empty.
  test("direct mode fails closed when mempool fees cannot be fetched", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ fees: "error" });
    const api = await createApiClient(f.origin, "test.direct-fees-down");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/could not fetch mempool fees/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("direct mode fails closed when the nonce cannot be fetched", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ nonce: -1 }); // sentinel: the fake answers the nonces route with a 500
    const api = await createApiClient(f.origin, "test.direct-nonce-down");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/could not fetch the account nonce/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("direct mode signs a standard fee-paying sBTC transfer with a deny-mode post-condition", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ nonce: 42 });
    const api = await createApiClient(f.origin, "test.direct");
    const response = await api.request({ method: "GET", url: "/paid" });

    expect(response.data).toEqual({ ok: true });
    expect(f.paidRequests).toHaveLength(1);
    const { auth, tx, payload } = decodeTx(f.paidRequests[0]);
    expect(auth.authType).toBe(AuthType.Standard);
    expect(auth.spendingCondition.fee).toBe(5000n);
    expect(auth.spendingCondition.nonce).toBe(42n);
    expect(tx.postConditionMode).toBe(PostConditionMode.Deny);
    expect(tx.postConditions.values).toHaveLength(1);
    expect(payload.accepted.payTo).toBe(sender);
    expect(payload.accepted.amount).toBe("100");

    const meta = getDirectPaymentMetadata(response);
    expect(meta.mode).toBe("direct");
    expect(meta.txid).toBe(tx.txid());
    expect(meta.txStatus).toBe("success");
    expect(meta.settlementState).toBe("confirmed");
  });

  test("direct mode STX payment clamps the fee to the token_transfer ceiling", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { asset: "STX", amount: "1000" } });
    const api = await createApiClient(f.origin, "test.direct-stx");
    await api.request({ method: "GET", url: "/paid" });

    const { auth, tx } = decodeTx(f.paidRequests[0]);
    expect(auth.authType).toBe(AuthType.Standard);
    expect(auth.spendingCondition.fee).toBe(3000n);
    expect(tx.payload.payloadType).toBe(0); // TokenTransfer
  });

  test("X402_MAX_FEE_USTX lowers the fee ceiling", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.X402_MAX_FEE_USTX = "4000";
    const f = await up();
    const api = await createApiClient(f.origin, "test.direct-fee-cap");
    await api.request({ method: "GET", url: "/paid" });
    expect(decodeTx(f.paidRequests[0]).auth.spendingCondition.fee).toBe(4000n);
  });

  test("X402_MAX_FEE_USTX below the type floor refuses instead of signing at the floor", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.X402_MAX_FEE_USTX = "1000"; // contract_call floor is 3000
    const f = await up();
    const api = await createApiClient(f.origin, "test.direct-fee-floor");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/X402_MAX_FEE_USTX=1000 is below the minimum/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("direct mode refuses padded payTo or amount rather than normalizing them", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { payTo: `${sender} ` } });
    const api = await createApiClient(f.origin, "test.direct-padded-payto");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/not a standard Stacks principal/);
    expect(f.paidRequests).toHaveLength(0);
    await f.close();
    fake = null;

    const g = await up({ accept: { amount: " 100" } });
    const api2 = await createApiClient(g.origin, "test.direct-padded-amount");
    await expect(api2.request({ method: "GET", url: "/paid" })).rejects.toThrow(/positive integer/);
    expect(g.paidRequests).toHaveLength(0);
  });

  test("direct mode refuses an unparseable chain id instead of signing for the wallet's network", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { network: "stacks:unknown" } });
    const api = await createApiClient(f.origin, "test.direct-chain");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/endpoint network "stacks:unknown" is not/);
    expect(f.paidRequests).toHaveLength(0);
    expect(f.hiroHits).toEqual([]);
  });

  test("direct mode refuses a non-positive maxTimeoutSeconds before signing", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { maxTimeoutSeconds: 0 } });
    const api = await createApiClient(f.origin, "test.direct-timeout-zero");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/maxTimeoutSeconds "0" is not a positive number/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("a canonical terminal failure after a paid 2xx keeps the direct txid on the error", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ canonical: { status: "failed", terminalReason: "chain_abort" } });
    const api = await createApiClient(f.origin, "test.direct-canonical-fail");
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    const { tx } = decodeTx(f.paidRequests[0]);
    expect(failure.message).toMatch(/x402 payment failed after the paid request returned/);
    expect(failure.message).toContain(`directTxid: ${tx.txid()}`);
    const meta = getDirectPaymentMetadata(failure);
    expect(meta.txid).toBe(tx.txid());
    expect(meta.settlementState).toBe("submitted");
  });

  test("direct mode refuses an over-cap amount before any paid request", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { amount: "20000" } });
    const api = await createApiClient(f.origin, "test.direct-cap");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/X402_MAX_SATS_PER_PAYMENT/);
    expect(f.paidRequests).toHaveLength(0);
    expect(f.hiroHits).toEqual([]);
  });

  test("direct mode refuses a non-canonical sBTC asset before any network call", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { asset: "SP2XYZ.sbtc-token" } });
    const api = await createApiClient(f.origin, "test.direct-asset");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/only signs native STX or the canonical sBTC/);
    expect(f.paidRequests).toHaveLength(0);
    expect(f.hiroHits).toEqual([]);
  });

  test("direct mode refuses when the wallet lacks STX for gas", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ balances: { stx: "100", sbtc: "100000" } });
    const api = await createApiClient(f.origin, "test.direct-gas");
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    expect(failure).toBeInstanceOf(InsufficientBalanceError);
    expect(failure.message).toMatch(/need STX for gas/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("direct mode refuses when the wallet lacks the sBTC price", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ balances: { stx: "1000000", sbtc: "50" } });
    const api = await createApiClient(f.origin, "test.direct-sbtc");
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    expect(failure).toBeInstanceOf(InsufficientBalanceError);
    expect((failure as InsufficientBalanceError).tokenType).toBe("sBTC");
    expect(f.paidRequests).toHaveLength(0);
  });

  test("direct mode still rejects a network mismatch", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const other: Network = network === "mainnet" ? "testnet" : "mainnet";
    const f = await up({ accept: { network: getStacksChainId(other) } });
    const api = await createApiClient(f.origin, "test.direct-network");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/Network mismatch/);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("a failed paid replay surfaces the server's status and body plus the txid", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ paid: { kind: "http", status: 500, body: { detail: { error: "settle_exploded" } } } });
    const api = await createApiClient(f.origin, "test.direct-500");
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    expect(failure.message).toMatch(/HTTP 500/);
    expect(failure.message).toMatch(/settle_exploded/);
    expect(failure.message).toMatch(/ambiguous/);
    const { tx } = decodeTx(f.paidRequests[0]);
    expect(failure.message).toContain(tx.txid());
    expect(getDirectPaymentMetadata(failure).settlementState).toBe("submitted");
  });

  test("sponsored mode also surfaces the server's answer on a failed paid replay", async () => {
    const f = await up({ paid: { kind: "http", status: 422, body: { detail: { error: "sponsored_unsupported" } } } });
    const api = await createApiClient(f.origin, "test.sponsored-422");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(
      /^x402 payment failed: HTTP 422.*sponsored_unsupported/
    );
  });

  test("a paid replay that outlives maxTimeoutSeconds is reported as ambiguous, not retried", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { maxTimeoutSeconds: 1 }, paid: { kind: "hang", ms: 5000 } });
    const api = await createApiClient(f.origin, "test.direct-timeout");
    const started = Date.now();
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    expect(Date.now() - started).toBeLessThan(4000);
    expect(failure.message).toMatch(/ambiguous/);
    expect(getDirectPaymentMetadata(failure).txid).toBeDefined();
    expect(f.paidRequests).toHaveLength(1);
  });

  test("a paid 2xx whose transaction aborts on chain is reported as failed, not confirmed", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ txStatus: "abort_by_response" });
    const api = await createApiClient(f.origin, "test.direct-abort");
    const response = await api.request({ method: "GET", url: "/paid" });
    const meta = getDirectPaymentMetadata(response);
    expect(meta.txStatus).toBe("abort_by_response");
    expect(meta.settlementState).toBe("failed");
  });

  test("an invalid X402_PAYMENT_MODE fails at client creation", async () => {
    process.env.X402_PAYMENT_MODE = "auto";
    await expect(createApiClient("http://127.0.0.1:1", "test.mode")).rejects.toThrow(/Invalid X402_PAYMENT_MODE/);
  });
});
