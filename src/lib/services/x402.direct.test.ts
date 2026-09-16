import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthType, PostConditionMode, deserializeTransaction } from "@stacks/transactions";
import { getStacksChainId } from "../config/caip.js";
import { getContracts } from "../config/contracts.js";
import { NETWORK, type Network } from "../config/networks.js";
import { _testing as storageTesting } from "../utils/storage.js";
import { InsufficientBalanceError } from "../utils/errors.js";
import { X402_HEADERS, decodePaymentPayload, derivePaymentIdentifier } from "../utils/x402-protocol.js";
import { _lockTesting, generateDedupKey } from "./x402-guards.js";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import {
  createApiClient,
  DuplicatePaymentError,
  getDirectPaymentMetadata,
  mnemonicToAccount,
  parseDirectPaymentAmount,
  resolveDirectPaymentAsset,
  resolveDirectPaymentPolicy,
  resolvePaymentMode,
  resolvePreferredAsset,
  selectStacksPaymentOption,
  SpendLimitError,
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
  /** Extra `accepts` entries appended after the first (each merged over the same defaults). */
  acceptsAfter?: Array<Partial<{ asset: string; amount: string; payTo: string; network: string; maxTimeoutSeconds: number }>>;
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
              accepts: [opts.accept ?? {}, ...(opts.acceptsAfter ?? [])].map((override) => ({
                scheme: "exact",
                network: getStacksChainId(network),
                amount: "100",
                asset: SBTC,
                payTo: sender,
                maxTimeoutSeconds: 60,
                ...override,
              })),
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

describe("selectStacksPaymentOption", () => {
  const chain = getStacksChainId(network);
  const sbtc = { scheme: "exact", network: chain, amount: "100", asset: SBTC, payTo: "SPX", maxTimeoutSeconds: 60 } as const;
  const stx = { scheme: "exact", network: chain, amount: "300000", asset: "STX", payTo: "SPX", maxTimeoutSeconds: 60 } as const;
  const evm = { ...stx, network: "eip155:8453" as never, asset: "0xusdc" };

  test("without a preference it is the first Stacks option, whatever its asset", () => {
    expect(selectStacksPaymentOption([sbtc, stx])).toBe(sbtc);
    expect(selectStacksPaymentOption([stx, sbtc])).toBe(stx);
    expect(selectStacksPaymentOption([evm, stx])).toBe(stx);
    expect(selectStacksPaymentOption([evm])).toBeNull();
  });

  test("a preference picks by asset regardless of order", () => {
    expect(selectStacksPaymentOption([sbtc, stx], "STX")).toBe(stx);
    expect(selectStacksPaymentOption([sbtc, stx], "sBTC")).toBe(sbtc);
    expect(selectStacksPaymentOption([stx, sbtc], "sBTC")).toBe(sbtc);
    // sBTC matches by contract id, STX only literally: an unrelated token is neither.
    expect(selectStacksPaymentOption([{ ...stx, asset: "SP1.other-token" }], "STX")).toBeNull();
    expect(selectStacksPaymentOption([{ ...stx, asset: "stx" }], "STX")?.asset).toBe("stx");
  });

  test("a preference the challenge does not offer selects nothing", () => {
    expect(selectStacksPaymentOption([sbtc], "STX")).toBeNull();
    expect(selectStacksPaymentOption([stx], "sBTC")).toBeNull();
    expect(selectStacksPaymentOption([evm], "STX")).toBeNull();
  });

  test("resolvePreferredAsset canonicalizes case and rejects anything else", () => {
    expect(resolvePreferredAsset(undefined)).toBeUndefined();
    expect(resolvePreferredAsset("")).toBeUndefined();
    expect(resolvePreferredAsset("stx")).toBe("STX");
    expect(resolvePreferredAsset(" SBTC ")).toBe("sBTC");
    expect(() => resolvePreferredAsset("BTC")).toThrow(/Allowed values: sBTC, STX/);
  });
});

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
    const policy = resolveDirectPaymentPolicy({});
    expect(parseDirectPaymentAmount("100", sbtc, policy)).toBe(100n);
    for (const bad of ["0", "-1", "1.5", "1e3", "", "abc", "010", " 100", "100 "]) {
      expect(() => parseDirectPaymentAmount(bad, sbtc, policy)).toThrow(/positive integer/);
    }
    expect(() => parseDirectPaymentAmount("10001", sbtc, policy)).toThrow(/X402_MAX_SATS_PER_PAYMENT/);
    const raised = resolveDirectPaymentPolicy({ X402_MAX_SATS_PER_PAYMENT: "20000" });
    expect(parseDirectPaymentAmount("10001", sbtc, raised)).toBe(10001n);
    expect(() => parseDirectPaymentAmount("1000001", { kind: "STX" }, policy)).toThrow(/X402_MAX_USTX_PER_PAYMENT/);
  });
});

describe("resolveDirectPaymentPolicy", () => {
  test("applies defaults and honours overrides", () => {
    const p = resolveDirectPaymentPolicy({});
    expect(p.maxSatsPerPayment).toBe(10_000n);
    expect(p.maxUstxPerPayment).toBe(1_000_000n);
    expect(p.maxFeeUstx).toBe(100_000n);
    expect(p.dedupTtlMs).toBe(900_000);
    expect(p.spend).toEqual({ enabled: true, dailySats: 50_000n, dailyUstx: 10_000_000n });
    const q = resolveDirectPaymentPolicy({
      X402_DEDUP_TTL_SECONDS: "5",
      SPEND_LIMIT_ENABLED: "false",
      SPEND_LIMIT_DAILY_SATS: "123",
      X402_DEDUP_STATE_FILE: "/tmp/a.json",
    });
    expect(q.dedupTtlMs).toBe(5000);
    expect(q.spend.enabled).toBe(false);
    // Only the exact string "false" disables the ledger — same test as the MCP server.
    for (const notFalse of ["False", "FALSE", " false", "0", "no"]) {
      expect(resolveDirectPaymentPolicy({ SPEND_LIMIT_ENABLED: notFalse }).spend.enabled).toBe(true);
    }
    expect(q.spend.dailySats).toBe(123n);
    expect(q.dedupStateFile).toBe("/tmp/a.json");
  });

  test("rejects malformed values instead of falling back", () => {
    expect(() => resolveDirectPaymentPolicy({ X402_MAX_SATS_PER_PAYMENT: "abc" })).toThrow(/X402_MAX_SATS_PER_PAYMENT/);
    expect(() => resolveDirectPaymentPolicy({ X402_MAX_FEE_USTX: "-1" })).toThrow(/X402_MAX_FEE_USTX/);
    expect(() => resolveDirectPaymentPolicy({ X402_DEDUP_TTL_SECONDS: "0" })).toThrow(/greater than zero/);
    expect(() => resolveDirectPaymentPolicy({ SPEND_LIMIT_DAILY_USTX: "1.5" })).toThrow(/SPEND_LIMIT_DAILY_USTX/);
    expect(() => resolveDirectPaymentPolicy({ X402_DEDUP_TTL_SECONDS: "99999999999" })).toThrow(/at most/);
  });

  test("dedup keys ignore key order and the payment-signature header", () => {
    const base = { method: "get", url: "http://x/paid", payer: "SPX", payTo: "SPY", amount: "1", asset: "STX" };
    const k1 = generateDedupKey({ ...base, params: { b: 2, a: { d: 1, c: 2 } }, headers: { "payment-signature": "one", Accept: "json" } });
    const k2 = generateDedupKey({ ...base, method: "GET", params: { a: { c: 2, d: 1 }, b: 2 }, headers: { accept: "json", "payment-signature": "two" } });
    expect(k1).toBe(k2);
    expect(generateDedupKey({ ...base, params: { a: 1 } })).not.toBe(generateDedupKey({ ...base, params: { a: 2 } }));
    expect(generateDedupKey({ ...base, amount: "2" })).not.toBe(generateDedupKey(base));
  });
});

const ENV_KEYS = [
  "CLIENT_MNEMONIC",
  "X402_PAYMENT_MODE",
  "X402_MAX_FEE_USTX",
  "X402_MAX_SATS_PER_PAYMENT",
  "X402_MAX_USTX_PER_PAYMENT",
  "X402_DEDUP_TTL_SECONDS",
  "X402_DEDUP_STATE_FILE",
  "X402_SPEND_STATE_FILE",
  "SPEND_LIMIT_ENABLED",
  "SPEND_LIMIT_DAILY_SATS",
  "SPEND_LIMIT_DAILY_USTX",
];

describe("createApiClient payment modes", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let sender = "";
  let fake: Fake | null = null;
  let stateDir = "";

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLIENT_MNEMONIC = TEST_MNEMONIC;
    // Fresh, isolated guard state per test: no test can see another's payments.
    stateDir = await mkdtemp(path.join(tmpdir(), "x402-direct-"));
    process.env.X402_DEDUP_STATE_FILE = path.join(stateDir, "dedup.json");
    process.env.X402_SPEND_STATE_FILE = path.join(stateDir, "spend.json");
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
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
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

  test("re-signing the same payment in a new client reuses its payment-identifier (skills #420)", async () => {
    const f = await up();
    for (const n of ["1", "2"]) {
      const api = await createApiClient(f.origin, `test.pid-${n}`);
      await api.request({ method: "GET", url: "/paid" });
    }
    expect(f.paidRequests).toHaveLength(2);
    const [first, second] = f.paidRequests.map((sig) => decodeTx(sig).payload);
    // Deterministic signing: same transfer, same nonce, same bytes...
    expect(second.payload.transaction).toBe(first.payload.transaction);
    // ...so the idempotency key must match too, and be derived from those bytes.
    const idOf = (p: typeof first) => (p.extensions as Record<string, { info: { id: string } }>)["payment-identifier"].info.id;
    expect(idOf(second)).toBe(idOf(first));
    expect(idOf(first)).toBe(derivePaymentIdentifier(first.payload.transaction));
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

  test("with two Stacks options the default still pays the first (sBTC)", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ acceptsAfter: [{ asset: "STX", amount: "300000" }] });
    const api = await createApiClient(f.origin, "test.two-options-default");
    await api.request({ method: "GET", url: "/paid" });

    const { tx, payload } = decodeTx(f.paidRequests[0]);
    expect(payload.accepted.asset).toBe(SBTC);
    expect(tx.payload.payloadType).toBe(2); // ContractCall: sbtc-token transfer
  });

  test("preferredAsset STX pays the STX option even when sBTC is listed first", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ acceptsAfter: [{ asset: "STX", amount: "300000" }] });
    const api = await createApiClient(f.origin, "test.prefer-stx", { preferredAsset: "STX" });
    await api.request({ method: "GET", url: "/paid" });

    const { auth, tx, payload } = decodeTx(f.paidRequests[0]);
    expect(payload.accepted.asset).toBe("STX");
    expect(payload.accepted.amount).toBe("300000");
    expect(auth.authType).toBe(AuthType.Standard);
    expect(tx.payload.payloadType).toBe(0); // TokenTransfer
  });

  test("preferredAsset sBTC pays sBTC when STX is listed first", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ accept: { asset: "STX", amount: "300000" }, acceptsAfter: [{ asset: SBTC, amount: "100" }] });
    const api = await createApiClient(f.origin, "test.prefer-sbtc", { preferredAsset: "sBTC" });
    await api.request({ method: "GET", url: "/paid" });

    const { tx, payload } = decodeTx(f.paidRequests[0]);
    expect(payload.accepted.asset).toBe(SBTC);
    expect(tx.payload.payloadType).toBe(2);
  });

  test("preferredAsset the challenge does not offer fails before any network call", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up(); // sBTC only
    const api = await createApiClient(f.origin, "test.prefer-missing", { preferredAsset: "STX" });
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/does not accept STX on Stacks/);
    expect(f.paidRequests).toHaveLength(0);
    expect(f.hiroHits).toEqual([]);
  });

  test("preferredAsset applies to the sponsored path too", async () => {
    const f = await up({ acceptsAfter: [{ asset: "STX", amount: "300000" }] });
    const api = await createApiClient(f.origin, "test.sponsored-prefer-stx", { preferredAsset: "STX" });
    await api.request({ method: "GET", url: "/paid" });

    const { auth, tx, payload } = decodeTx(f.paidRequests[0]);
    expect(payload.accepted.asset).toBe("STX");
    expect(auth.authType).toBe(AuthType.Sponsored);
    expect(tx.payload.payloadType).toBe(0);
  });

  test("an invalid preferredAsset fails when the client is created", async () => {
    await expect(createApiClient("http://127.0.0.1:1", "test.bad-asset", { preferredAsset: "BTC" as never })).rejects.toThrow(
      /Invalid preferred payment asset/
    );
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

    // A reported failure is not a resolution: the duplicate guard stays armed.
    const again = await createApiClient(f.origin, "test.direct-canonical-fail-2");
    await expect(again.request({ method: "GET", url: "/paid" })).rejects.toBeInstanceOf(DuplicatePaymentError);
    expect(f.paidRequests).toHaveLength(1);
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

  test("an identical request from a second client is refused with the first txid while the first is unresolved", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ paid: { kind: "hang", ms: 1500 } });
    const first = await createApiClient(f.origin, "test.dedup-1");
    const inFlight = first.request({ method: "GET", url: "/paid", params: { slug: "stacks" } });
    while (f.paidRequests.length === 0) await new Promise((r) => setTimeout(r, 20));
    const firstTxid = decodeTx(f.paidRequests[0]).tx.txid();

    // Persisted, keyed by digest only: no request content on disk.
    const onDisk = await readFile(process.env.X402_DEDUP_STATE_FILE!, "utf8");
    expect(onDisk).toContain(firstTxid);
    expect(onDisk).not.toContain("slug");

    const second = await createApiClient(f.origin, "test.dedup-2"); // fresh instance: fresh paymentAttempts entry
    const failure = await rejection(second.request({ method: "GET", url: "/paid", params: { slug: "stacks" } }));
    expect(failure).toBeInstanceOf(DuplicatePaymentError);
    expect((failure as DuplicatePaymentError).txid).toBe(firstTxid);
    expect(failure.message).toContain(firstTxid);
    expect(f.paidRequests).toHaveLength(1);
    await inFlight;
  });

  test("after a paid 2xx, an identical request is a new purchase, not a duplicate", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up();
    for (const n of ["1", "2", "3"]) {
      const api = await createApiClient(f.origin, `test.repeat-${n}`);
      await api.request({ method: "GET", url: "/paid", params: { slug: "stacks" } });
    }
    expect(f.paidRequests).toHaveLength(3);
    expect(JSON.parse(await readFile(process.env.X402_DEDUP_STATE_FILE!, "utf8"))).toEqual({});
  });

  test("a paid request that never reaches the server releases the guard and the ledger", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up();
    const api = await createApiClient(f.origin, "test.not-sent");
    // Send only the paid replay to a closed port: the 402 is real, the replay cannot connect.
    api.interceptors.request.use((config) => {
      const headers = config.headers as unknown as Record<string, unknown>;
      if (headers?.[X402_HEADERS.PAYMENT_SIGNATURE]) config.baseURL = "http://127.0.0.1:1";
      return config;
    });
    const failure = await rejection(api.request({ method: "GET", url: "/paid" }));
    expect(failure.message).toMatch(/never reached the server/);
    expect(failure.message).not.toMatch(/ambiguous/);
    expect(failure).not.toBeInstanceOf(DuplicatePaymentError);
    expect(f.paidRequests).toHaveLength(0);

    const day = new Date().toISOString().slice(0, 10);
    const ledger = JSON.parse(await readFile(process.env.X402_SPEND_STATE_FILE!, "utf8"));
    expect(ledger[sender][day]).toEqual({ ustx: 0, sats: 0 });
    expect(JSON.parse(await readFile(process.env.X402_DEDUP_STATE_FILE!, "utf8"))).toEqual({});

    // The retry is not refused as a duplicate and pays once.
    const retry = await createApiClient(f.origin, "test.not-sent-retry");
    await retry.request({ method: "GET", url: "/paid" });
    expect(f.paidRequests).toHaveLength(1);
  });

  test("the duplicate guard still holds after a failed paid replay (recorded before send)", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ paid: { kind: "http", status: 500, body: { error: "boom" } } });
    const first = await createApiClient(f.origin, "test.dedup-fail-1");
    await rejection(first.request({ method: "GET", url: "/paid" }));
    const second = await createApiClient(f.origin, "test.dedup-fail-2");
    const failure = await rejection(second.request({ method: "GET", url: "/paid" }));
    expect(failure).toBeInstanceOf(DuplicatePaymentError);
    expect(f.paidRequests).toHaveLength(1);
  });

  test("a different request is not a duplicate; the guard clears after the TTL", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.X402_DEDUP_TTL_SECONDS = "1";
    // Failed replays leave the outcome ambiguous, so the records stay armed until the TTL.
    const f = await up({ paid: { kind: "http", status: 500, body: { error: "boom" } } });
    const a = await createApiClient(f.origin, "test.dedup-a");
    await rejection(a.request({ method: "GET", url: "/paid", params: { slug: "stacks" } }));
    const b = await createApiClient(f.origin, "test.dedup-b");
    await rejection(b.request({ method: "GET", url: "/paid", params: { slug: "zest" } }));
    expect(f.paidRequests).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 1100));
    const c = await createApiClient(f.origin, "test.dedup-c");
    await rejection(c.request({ method: "GET", url: "/paid", params: { slug: "stacks" } }));
    expect(f.paidRequests).toHaveLength(3);
  });

  test("the daily spend ledger refuses once today's cap is reached, across client instances", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.SPEND_LIMIT_DAILY_SATS = "150"; // two 100-sat payments do not fit
    const f = await up();
    const a = await createApiClient(f.origin, "test.spend-a");
    await a.request({ method: "GET", url: "/paid", params: { n: "1" } });
    const b = await createApiClient(f.origin, "test.spend-b");
    const failure = await rejection(b.request({ method: "GET", url: "/paid", params: { n: "2" } }));
    expect(failure).toBeInstanceOf(SpendLimitError);
    expect((failure as SpendLimitError).unit).toBe("sats");
    expect((failure as SpendLimitError).remaining).toBe(50n);
    expect(failure.message).toMatch(/SPEND_LIMIT_DAILY_SATS/);
    expect(f.paidRequests).toHaveLength(1);
  });

  test("the spend ledger also meters gas in µSTX for an sBTC payment", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.SPEND_LIMIT_DAILY_USTX = "5000"; // exactly one 5000 µSTX fee fits
    const f = await up();
    const a = await createApiClient(f.origin, "test.spend-gas-a");
    await a.request({ method: "GET", url: "/paid", params: { n: "1" } });
    const b = await createApiClient(f.origin, "test.spend-gas-b");
    const failure = await rejection(b.request({ method: "GET", url: "/paid", params: { n: "2" } }));
    expect(failure).toBeInstanceOf(SpendLimitError);
    expect((failure as SpendLimitError).unit).toBe("ustx");
    expect(f.paidRequests).toHaveLength(1);
  });

  test("SPEND_LIMIT_ENABLED=false turns the ledger off", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.SPEND_LIMIT_ENABLED = "false";
    process.env.SPEND_LIMIT_DAILY_SATS = "150";
    const f = await up();
    for (const n of ["1", "2", "3"]) {
      const api = await createApiClient(f.origin, `test.spend-off-${n}`);
      await api.request({ method: "GET", url: "/paid", params: { n } });
    }
    expect(f.paidRequests).toHaveLength(3);
  });

  test("two direct clients racing on the same request produce exactly one payment", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    // The paid replay takes a moment, as a real one does, so the loser checks while the winner is in flight.
    const f = await up({ paid: { kind: "hang", ms: 1000 } });
    const a = await createApiClient(f.origin, "test.race-a");
    const b = await createApiClient(f.origin, "test.race-b");
    const results = await Promise.allSettled([
      a.request({ method: "GET", url: "/paid", params: { slug: "stacks" } }),
      b.request({ method: "GET", url: "/paid", params: { slug: "stacks" } }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DuplicatePaymentError);
    expect(f.paidRequests).toHaveLength(1);
  });

  test("a live lock held by another process refuses; a stale lease whose holder may be alive refuses too, naming the holder", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    _lockTesting.setMaxWaitMs(600);
    try {
      const f = await up();
      const [lockDir] = _lockTesting.lockDirsFor(resolveDirectPaymentPolicy(process.env));
      expect(_lockTesting.lockDirsFor(resolveDirectPaymentPolicy(process.env))).toHaveLength(1); // same dir for both stores

      // Live holder: fresh mtime, foreign owner token. process.ppid is a running process that is not us.
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(path.join(lockDir, "owner"), `${process.ppid} deadbeefdeadbeef`);
      const blocked = await createApiClient(f.origin, "test.lock-live");
      await expect(blocked.request({ method: "GET", url: "/paid" })).rejects.toThrow(/holding the guard lock/);
      expect(f.paidRequests).toHaveLength(0);

      // No heartbeat for two minutes, but the holder pid is running → not reclaimed, refused with the pid and path.
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockDir, old, old);
      const stale = await createApiClient(f.origin, "test.lock-stale");
      const failure = await rejection(stale.request({ method: "GET", url: "/paid" }));
      expect(failure.message).toMatch(/no heartbeat/);
      expect(failure.message).toMatch(/may still be running/);
      expect(failure.message).toContain(`owner pid ${process.ppid}`);
      expect(failure.message).toContain(lockDir);
      expect(f.paidRequests).toHaveLength(0);
      expect(existsSync(lockDir)).toBe(true);

      // Operator removes the dead lock → payment proceeds and the lock is released afterwards.
      rmSync(lockDir, { recursive: true, force: true });
      const api = await createApiClient(f.origin, "test.lock-cleared");
      await api.request({ method: "GET", url: "/paid" });
      expect(f.paidRequests).toHaveLength(1);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      _lockTesting.setMaxWaitMs(15_000);
    }
  });

  test("a stale lock whose holder is provably gone is reclaimed and the payment proceeds", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    _lockTesting.setMaxWaitMs(600);
    try {
      const f = await up();
      const [lockDir] = _lockTesting.lockDirsFor(resolveDirectPaymentPolicy(process.env));
      const old = new Date(Date.now() - 120_000);
      const owners = [
        "999999 deadbeefdeadbeef", // pid that does not exist
        `${process.pid} 0123456789abcdef`, // our own pid, a token this process never issued (restarted container)
        null, // ownerless: the creator died between mkdir and claiming it
      ];
      for (const [i, owner] of owners.entries()) {
        mkdirSync(lockDir, { recursive: true });
        if (owner) writeFileSync(path.join(lockDir, "owner"), owner);
        utimesSync(lockDir, old, old);
        const api = await createApiClient(f.origin, `test.lock-reclaim-${i}`);
        await api.request({ method: "GET", url: "/paid", params: { i: String(i) } });
        expect(f.paidRequests).toHaveLength(i + 1);
        expect(existsSync(lockDir)).toBe(false);
        expect(existsSync(`${lockDir}.reclaim`)).toBe(false);
      }

      // A fresh ownerless lock is not stale: it may be a creator about to claim it, so it is waited on, not reclaimed.
      mkdirSync(lockDir, { recursive: true });
      const fresh = await createApiClient(f.origin, "test.lock-fresh-ownerless");
      await expect(fresh.request({ method: "GET", url: "/paid", params: { i: "fresh" } })).rejects.toThrow(
        /holding the guard lock/
      );
      rmSync(lockDir, { recursive: true, force: true });
    } finally {
      _lockTesting.setMaxWaitMs(15_000);
    }
  });

  test("the dedup key is canonical over params order and ignores the payment header", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up({ paid: { kind: "http", status: 500, body: { error: "boom" } } });
    const a = await createApiClient(f.origin, "test.canon-a");
    await rejection(a.request({ method: "GET", url: "/paid", params: { b: "2", a: "1" } }));
    const b = await createApiClient(f.origin, "test.canon-b");
    await expect(b.request({ method: "GET", url: "/paid", params: { a: "1", b: "2" } })).rejects.toBeInstanceOf(
      DuplicatePaymentError
    );
    expect(f.paidRequests).toHaveLength(1);
  });

  test("the spend ledger is written in the MCP server's spend-state.json shape", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up();
    const api = await createApiClient(f.origin, "test.ledger-shape");
    await api.request({ method: "GET", url: "/paid" });
    const ledger = JSON.parse(await readFile(process.env.X402_SPEND_STATE_FILE!, "utf8"));
    const day = new Date().toISOString().slice(0, 10);
    expect(ledger[sender][day]).toEqual({ ustx: 5000, sats: 100 });
    expect(resolveDirectPaymentPolicy({}).spendStateFile.endsWith("/.aibtc/spend-state.json")).toBe(true);
  });

  test("a spend ledger written by the MCP server counts against today's cap", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    process.env.SPEND_LIMIT_DAILY_SATS = "150";
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(process.env.X402_SPEND_STATE_FILE!, JSON.stringify({ [sender]: { [day]: { ustx: 0, sats: 100 } } }));
    const f = await up();
    const api = await createApiClient(f.origin, "test.ledger-mcp");
    await expect(api.request({ method: "GET", url: "/paid" })).rejects.toBeInstanceOf(SpendLimitError);
    expect(f.paidRequests).toHaveLength(0);
  });

  test("malformed guard state refuses the payment instead of reading as empty", async () => {
    process.env.X402_PAYMENT_MODE = "direct";
    const f = await up();
    const day = new Date().toISOString().slice(0, 10);
    for (const bad of ["[]", "null", "not json", JSON.stringify({ [sender]: { [day]: { sats: "lots", ustx: 0 } } })]) {
      await writeFile(process.env.X402_SPEND_STATE_FILE!, bad);
      const api = await createApiClient(f.origin, "test.ledger-corrupt");
      await expect(api.request({ method: "GET", url: "/paid" })).rejects.toThrow(/Refusing to trust/);
    }
    expect(f.paidRequests).toHaveLength(0);
  });

  test("a malformed cap env fails at client creation in direct mode only", async () => {
    process.env.X402_MAX_SATS_PER_PAYMENT = "lots";
    await expect(createApiClient("http://127.0.0.1:1", "test.env-sponsored")).resolves.toBeDefined();
    process.env.X402_PAYMENT_MODE = "direct";
    await expect(createApiClient("http://127.0.0.1:1", "test.env-direct")).rejects.toThrow(/X402_MAX_SATS_PER_PAYMENT/);
  });

  test("an invalid X402_PAYMENT_MODE fails at client creation", async () => {
    process.env.X402_PAYMENT_MODE = "auto";
    await expect(createApiClient("http://127.0.0.1:1", "test.mode")).rejects.toThrow(/Invalid X402_PAYMENT_MODE/);
  });
});
