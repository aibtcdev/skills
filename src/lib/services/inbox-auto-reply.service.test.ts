import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostConditionMode, deserializeTransaction } from "@stacks/transactions";
import { getStacksChainId } from "../config/caip.js";
import { getContracts } from "../config/contracts.js";
import { NETWORK, type Network } from "../config/networks.js";
import type { Account } from "../transactions/builder.js";
import { _testing as storageTesting } from "../utils/storage.js";
import { deriveBitcoinKeyPair } from "../utils/bitcoin.js";
import { X402_HEADERS, decodePaymentPayload } from "../utils/x402-protocol.js";
import { mnemonicToAccount } from "./x402.service.js";
import { PaidRequestError, postWithSponsoredPayment } from "./x402-post.js";
import {
  AIBTC_API,
  DEFAULT_DAILY_CAP_SATS,
  INFERENCE_GATEWAY,
  MAX_REPLY_CHARS,
  cleanReply,
  marketplaceReplyGenerator,
  readAddressLedger,
  replySigningMessage,
  resolveDailyCapSats,
  runAutoReply,
  setAutoReplyLedgerFile,
  skipReason,
  type AddressLedger,
  type InboxMessage,
  type ReplyGenerator,
} from "./inbox-auto-reply.service.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const emptyLedger = (): AddressLedger => ({ handled: {}, pending: {}, spentSats: {} });

function msg(id: string, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: id,
    fromAddress: "SP2SENDER",
    toBtcAddress: "bc1qself",
    content: `hello ${id}`,
    paymentTxid: `0x${id}`,
    paymentSatoshis: 100,
    paymentStatus: "confirmed",
    sentAt: "2026-10-01T00:00:00.000Z",
    peerBtcAddress: "bc1qsender",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("skipReason", () => {
  const self = { btcAddress: "bc1qself", stxAddress: "SPSELF" };

  test("a paid, confirmed, unanswered message is eligible", () => {
    expect(skipReason(msg("a"), self, emptyLedger())).toBeNull();
  });

  test("messages without paymentStatus (pre-field) count as settled", () => {
    expect(skipReason(msg("a", { paymentStatus: undefined }), self, emptyLedger())).toBeNull();
  });

  test("a pending payment is not settled unless recovered via txid", () => {
    expect(skipReason(msg("a", { paymentStatus: "pending" }), self, emptyLedger())).toBe("payment_not_settled");
    expect(skipReason(msg("a", { paymentStatus: "pending", recoveredViaTxid: true }), self, emptyLedger())).toBeNull();
  });

  test("unpaid, self, replied and handled messages are skipped", () => {
    expect(skipReason(msg("a", { paymentTxid: undefined }), self, emptyLedger())).toBe("unpaid");
    expect(skipReason(msg("a", { paymentSatoshis: 0 }), self, emptyLedger())).toBe("unpaid");
    expect(skipReason(msg("a", { fromAddress: "SPSELF" }), self, emptyLedger())).toBe("from_self");
    expect(skipReason(msg("a", { peerBtcAddress: "bc1qself" }), self, emptyLedger())).toBe("from_self");
    expect(skipReason(msg("a", { repliedAt: "2026-10-02T00:00:00Z" }), self, emptyLedger())).toBe("already_replied");
    expect(skipReason(msg("a"), self, { ...emptyLedger(), handled: { a: "x" } })).toBe("already_handled");
  });
});

describe("resolveDailyCapSats", () => {
  test("keeps a valid stored cap, including 0", () => {
    expect(resolveDailyCapSats(250)).toBe(250);
    expect(resolveDailyCapSats(0)).toBe(0);
  });

  test("a missing or malformed stored cap falls back to the default (#455)", () => {
    for (const value of [undefined, null, "500", -1, 1.5, Number.NaN]) {
      expect(resolveDailyCapSats(value)).toBe(DEFAULT_DAILY_CAP_SATS);
    }
  });
});

describe("cleanReply", () => {
  test("strips think blocks, including an unterminated one, and collapses whitespace", () => {
    expect(cleanReply("<think>plan\nstuff</think>\n Hello   there \n")).toBe("Hello there");
    expect(cleanReply("Hi.<think>ran out of tokens")).toBe("Hi.");
  });

  test("fits the outbox limit", () => {
    const out = cleanReply("x".repeat(MAX_REPLY_CHARS + 50));
    expect(out.length).toBe(MAX_REPLY_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
let routes: Array<{ match: (url: URL, method: string) => boolean; handle: Handler }> = [];
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];

function route(match: (url: URL, method: string) => boolean, handle: Handler): void {
  routes.push({ match, handle });
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    calls.push({ url: url.href, method, headers, body: typeof init?.body === "string" ? init.body : undefined });
    const hit = routes.find((r) => r.match(url, method));
    if (!hit) return new Response(`no route for ${method} ${url.href}`, { status: 599 });
    return hit.handle(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

let stateDir: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "inbox-auto-reply-"));
  setAutoReplyLedgerFile(path.join(stateDir, "inbox-auto-reply.json"));
  process.env.X402_SPEND_STATE_FILE = path.join(stateDir, "spend-state.json");
  process.env.X402_DEDUP_STATE_FILE = path.join(stateDir, "dedup.json");
  routes = [];
  calls = [];
  installFetchMock();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
  storageTesting.overrideStacksApiUrl(null);
  await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runAutoReply
// ---------------------------------------------------------------------------

describe("runAutoReply", () => {
  let account: Account;
  let btc: string;

  beforeEach(async () => {
    const keys = deriveBitcoinKeyPair(TEST_MNEMONIC, "mainnet");
    account = {
      ...(await mnemonicToAccount(TEST_MNEMONIC, "mainnet")),
      btcAddress: keys.address,
      btcPrivateKey: keys.privateKey,
      btcPublicKey: keys.publicKeyBytes,
    };
    btc = keys.address;
  });

  /** Inbox newest first, as the API returns it. */
  function serveInbox(messages: InboxMessage[]): void {
    route(
      (u, m) => m === "GET" && u.href.startsWith(`${AIBTC_API}/inbox/${btc}`),
      () => json({ inbox: { messages } })
    );
  }

  function serveOutbox(status: number | (() => number), body: unknown = {}): Array<Record<string, string>> {
    const posted: Array<Record<string, string>> = [];
    route(
      (u, m) => m === "POST" && u.href === `${AIBTC_API}/outbox/${btc}`,
      (_u, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return json(body, typeof status === "function" ? status() : status);
      }
    );
    return posted;
  }

  function fakeGenerator(price = 1): ReplyGenerator & { seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      async generate({ message, beforePay }) {
        await beforePay(price);
        seen.push(message.messageId);
        return { text: `reply to ${message.messageId}`, inferenceCostSats: price };
      },
    };
  }

  const base = { systemPrompt: "be brief", dailyCapSats: 1000, maxRepliesPerRun: 5, dryRun: false };

  test("answers eligible messages oldest first, signs and posts them, and never answers twice", async () => {
    serveInbox([msg("c"), msg("b", { paymentStatus: "pending" }), msg("a")]);
    const posted = serveOutbox(201, { reply: { repliedAt: "2026-10-27T00:00:00.000Z" } });
    const generator = fakeGenerator();

    const summary = await runAutoReply({ ...base, account, generator });
    expect(generator.seen).toEqual(["a", "c"]);
    expect(summary.replied.map((r) => r.messageId)).toEqual(["a", "c"]);
    expect(summary.skipped).toEqual([{ messageId: "b", reason: "payment_not_settled" }]);
    expect(summary.inferenceSatsSpent).toBe(2);
    expect(summary.inferenceSatsSpentToday).toBe(2);
    expect(summary.inferenceCapRemainingSats).toBe(998);
    expect(posted[0].messageId).toBe("a");
    expect(posted[0].reply).toBe("reply to a");
    expect(typeof posted[0].signature).toBe("string");
    expect(replySigningMessage("a", "reply to a")).toBe("Inbox Reply | a | reply to a");

    const again = await runAutoReply({ ...base, account, generator });
    expect(again.replied).toEqual([]);
    expect(again.skipped.filter((s) => s.reason === "already_handled").map((s) => s.messageId).sort()).toEqual(["a", "c"]);
    expect(generator.seen).toEqual(["a", "c"]);
  });

  test("a reply paid for but not posted is saved and posted next run without paying again", async () => {
    serveInbox([msg("a")]);
    let outboxStatus = 500;
    serveOutbox(() => outboxStatus);
    const generator = fakeGenerator();

    const first = await runAutoReply({ ...base, account, generator });
    expect(first.failed).toEqual([expect.objectContaining({ messageId: "a", replySaved: true })]);
    expect((await readAddressLedger(btc)).pending.a).toBe("reply to a");

    outboxStatus = 201;
    const second = await runAutoReply({ ...base, account, generator });
    expect(second.replied).toEqual([expect.objectContaining({ messageId: "a", reusedPending: true, inferenceCostSats: 0 })]);
    expect(generator.seen).toEqual(["a"]);
    const ledger = await readAddressLedger(btc);
    expect(ledger.pending).toEqual({});
    expect(ledger.handled.a).toBeDefined();
  });

  test("an outbox 409 counts as already answered", async () => {
    serveInbox([msg("a")]);
    serveOutbox(409);
    const summary = await runAutoReply({ ...base, account, generator: fakeGenerator() });
    expect(summary.skipped).toEqual([{ messageId: "a", reason: "already_replied" }]);
    expect((await readAddressLedger(btc)).handled.a).toBe("already_replied");
  });

  test("stops at the daily cap before paying, and at the run limit", async () => {
    serveInbox([msg("d"), msg("c"), msg("b"), msg("a")]);
    serveOutbox(201);
    const generator = fakeGenerator(1);

    const capped = await runAutoReply({ ...base, dailyCapSats: 2, account, generator });
    expect(capped.replied.map((r) => r.messageId)).toEqual(["a", "b"]);
    expect(capped.stoppedEarly).toBe("daily_cap");
    expect(capped.skipped).toEqual([
      { messageId: "c", reason: "daily_cap" },
      { messageId: "d", reason: "daily_cap" },
    ]);
    expect(capped.inferenceCapRemainingSats).toBe(0);
    expect(generator.seen).toEqual(["a", "b"]);

    const limited = await runAutoReply({ ...base, maxRepliesPerRun: 1, account, generator });
    expect(limited.replied.map((r) => r.messageId)).toEqual(["c"]);
    expect(limited.skipped).toContainEqual({ messageId: "d", reason: "run_limit" });
  });

  test("a dry run drafts replies without posting or marking anything handled", async () => {
    serveInbox([msg("a")]);
    const posted = serveOutbox(201);
    const summary = await runAutoReply({ ...base, dryRun: true, account, generator: fakeGenerator() });
    expect(summary.drafted.map((d) => d.messageId)).toEqual(["a"]);
    expect(posted).toEqual([]);
    expect((await readAddressLedger(btc)).handled).toEqual({});
  });

  test("a failure before payment releases the daily-cap booking", async () => {
    serveInbox([msg("a")]);
    serveOutbox(201);
    const generator: ReplyGenerator = {
      async generate({ beforePay }) {
        await beforePay(5);
        throw new Error("balance check failed");
      },
    };
    const summary = await runAutoReply({ ...base, account, generator });
    expect(summary.failed).toEqual([expect.objectContaining({ messageId: "a", replySaved: false })]);
    expect(summary.inferenceSatsSpentToday).toBe(0);
  });

  test("a failure after payment keeps the daily-cap booking", async () => {
    serveInbox([msg("a")]);
    serveOutbox(201);
    const generator: ReplyGenerator = {
      async generate({ beforePay }) {
        await beforePay(5);
        throw new PaidRequestError("Paid request failed (503): provider down");
      },
    };
    const summary = await runAutoReply({ ...base, account, generator });
    expect(summary.inferenceSatsSpent).toBe(5);
    expect(summary.inferenceSatsSpentToday).toBe(5);
  });

  test("refuses a wallet without a bc1q address", async () => {
    await expect(
      runAutoReply({ ...base, account: { ...account, btcAddress: "bc1pxyz" }, generator: fakeGenerator() })
    ).rejects.toThrow(/bc1q/);
  });
});

// ---------------------------------------------------------------------------
// postWithSponsoredPayment
// ---------------------------------------------------------------------------

describe("postWithSponsoredPayment", () => {
  const network = NETWORK as Network;
  const endpoint = "https://gateway.test/v1/chat/completions";
  let account: Account;

  beforeEach(async () => {
    account = await mnemonicToAccount(TEST_MNEMONIC, network);
    // Unreachable Stacks API: the sponsored balance pre-check fails open.
    storageTesting.overrideStacksApiUrl("http://127.0.0.1:1");
    route(
      (u) => u.pathname.startsWith("/v2/accounts/") || u.pathname.includes("/nonces"),
      () => json({ nonce: 0, balance: "0x0", locked: "0x0", possible_next_nonce: 0, last_executed_tx_nonce: null })
    );
  });

  function challenge(extra: Record<string, unknown> = { feePayer: "SP3F6ZPHAR5D0YT0CTPJST7H3NBZ43A5FW226FMYP" }): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: { url: "/v1/chat/completions" },
        accepts: [
          {
            scheme: "exact",
            network: getStacksChainId(network),
            amount: "1",
            asset: getContracts(network).SBTC_TOKEN,
            payTo: "SPNFFPJBGM5V004X629NN1T0DFQT3ZWBK8F61NQ8",
            maxTimeoutSeconds: 300,
            extra,
          },
        ],
      })
    ).toString("base64");
  }

  function serveEndpoint(paid: () => Response, extra?: Record<string, unknown>, url = endpoint): void {
    route(
      (u, m) => m === "POST" && u.href === url,
      (_u, init) => {
        const headers = new Headers(init?.headers);
        if (!headers.get(X402_HEADERS.PAYMENT_SIGNATURE)) {
          return new Response("{}", { status: 402, headers: { [X402_HEADERS.PAYMENT_REQUIRED]: challenge(extra) } });
        }
        return paid();
      }
    );
  }

  async function spentSats(): Promise<number> {
    try {
      const ledger = JSON.parse(await readFile(process.env.X402_SPEND_STATE_FILE!, "utf8"));
      return Object.values(ledger[account.address] ?? {}).reduce((sum: number, d) => sum + (d as { sats: number }).sats, 0);
    } catch {
      return 0;
    }
  }

  test("books the price, signs a pinned sponsored sBTC transfer and returns the paid body", async () => {
    serveEndpoint(() => json({ choices: [{ message: { content: "hi" } }] }));
    const seen: string[] = [];
    const result = await postWithSponsoredPayment({
      account,
      url: endpoint,
      body: { model: "m" },
      beforePay: async (accept) => {
        seen.push(accept.amount);
      },
    });
    expect(result.paid).toBe(true);
    expect(JSON.parse(result.text).choices[0].message.content).toBe("hi");
    expect(seen).toEqual(["1"]);
    expect(await spentSats()).toBe(1);

    const paidCall = calls.find((c) => c.url === endpoint && c.headers[X402_HEADERS.PAYMENT_SIGNATURE.toLowerCase()]);
    const payload = decodePaymentPayload(paidCall!.headers[X402_HEADERS.PAYMENT_SIGNATURE.toLowerCase()]);
    const tx = deserializeTransaction(payload!.payload.transaction.replace(/^0x/, ""));
    expect(tx.postConditionMode).toBe(PostConditionMode.Deny);
    expect(tx.postConditions.values.length).toBe(1);
  });

  test("a failure after the payment was sent is a PaidRequestError and the booking stands", async () => {
    serveEndpoint(() => new Response("provider unavailable", { status: 503 }));
    const failure = await postWithSponsoredPayment({ account, url: endpoint, body: {} }).catch((e) => e);
    expect(failure).toBeInstanceOf(PaidRequestError);
    expect(await spentSats()).toBe(1);
  });

  test("a paid inference with an unusable body fails as paid, so the cap booking is kept (#455)", async () => {
    const generator = marketplaceReplyGenerator(account, "m");
    let body = "";
    serveEndpoint(() => new Response(body, { status: 200 }), undefined, `${INFERENCE_GATEWAY}/v1/chat/completions`);
    for (body of ["not json", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: "  " } }] })]) {
      const failure = await generator
        .generate({ systemPrompt: "s", message: msg("a"), beforePay: async () => {} })
        .catch((e) => e);
      expect(failure).toBeInstanceOf(PaidRequestError);
    }
  });

  test("refusing in beforePay signs and books nothing", async () => {
    serveEndpoint(() => json({}));
    await expect(
      postWithSponsoredPayment({
        account,
        url: endpoint,
        body: {},
        beforePay: async () => {
          throw new Error("over cap");
        },
      })
    ).rejects.toThrow("over cap");
    expect(await spentSats()).toBe(0);
    expect(calls.filter((c) => c.headers[X402_HEADERS.PAYMENT_SIGNATURE.toLowerCase()])).toEqual([]);
  });

  test("refuses an endpoint that does not sponsor gas", async () => {
    serveEndpoint(() => json({}), {});
    await expect(postWithSponsoredPayment({ account, url: endpoint, body: {} })).rejects.toThrow(/feePayer/);
    expect(await spentSats()).toBe(0);
  });

  test("the shared spend ledger caps sponsored payments too", async () => {
    process.env.SPEND_LIMIT_DAILY_SATS = "1";
    serveEndpoint(() => json({ ok: true }));
    await postWithSponsoredPayment({ account, url: endpoint, body: {} });
    await expect(postWithSponsoredPayment({ account, url: endpoint, body: {} })).rejects.toThrow(/SPEND_LIMIT_DAILY_SATS/);
    expect(await spentSats()).toBe(1);
  });
});
