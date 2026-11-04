import { describe, test, expect, afterEach, mock } from "bun:test";
import { PostConditionMode, makeContractCall } from "@stacks/transactions";
import { AibtcError } from "../src/lib/utils/errors.js";

// The nonce tracker writes under ~/.aibtc: replace the call the skill makes with a recorder.
const tracked: Array<[string, number, string]> = [];
const realTracker = await import("../src/lib/services/nonce-tracker.js");
mock.module("../src/lib/services/nonce-tracker.js", () => ({
  ...realTracker,
  advanceNonce: async (address: string, nonce: number, txid?: string) => {
    tracked.push([address, nonce, txid ?? ""]);
  },
}));
const bolt = await import("./bolt.js");
import type { WriteContext } from "./bolt.js";

const SENDER = "SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  tracked.length = 0;
});

type Reply = Response | Error;
interface Call {
  url: string;
  body: string | undefined;
  signal: AbortSignal | null | undefined;
}

/** Replace fetch with a script of replies, one per call; an Error is thrown as a failed request. */
function mockFetch(replies: Reply[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as string | undefined, signal: init?.signal });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error("unexpected extra fetch");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (status: number) =>
  new Response("<html><body>Bad Gateway</body></html>", { status, headers: { "content-type": "text/html" } });
const timeout = () => new DOMException("The operation timed out.", "TimeoutError");

const PENDING_MSG = `Invalid nonce: nonce 5 from ${SENDER} is already pending. Try again`;
const ctx = { sender: SENDER, nonce: 7n };

async function caught(promise: Promise<unknown>): Promise<AibtcError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AibtcError);
    return error as AibtcError;
  }
  throw new Error("expected a rejection");
}

describe("boltError", () => {
  const cases: Array<[string, number, string, Record<string, unknown>, string]> = [
    ["code FEE_TOO_LOW", 400, "x", { code: "FEE_TOO_LOW" }, "BOLT_FEE_TOO_LOW"],
    ["code NONCE_PENDING", 409, "x", { code: "NONCE_PENDING" }, "BOLT_INVALID_NONCE"],
    ["code UNAVAILABLE on 503", 503, "x", { code: "UNAVAILABLE" }, "BOLT_TEMPORARILY_UNAVAILABLE"],
    ["code NOT_REFUNDED on 503", 503, "x", { code: "NOT_REFUNDED" }, "BOLT_REFUND_FAILED"],
    ["code NODE_REJECTED", 400, "x", { code: "NODE_REJECTED" }, "BOLT_REJECTED"],
    ["429 without code", 429, "slow down", {}, "BOLT_RATE_LIMITED"],
    // BY_MESSAGE order: the broad "Try again / Nothing was charged" must not win.
    ["fee below minimum + Nothing was charged", 400, "Fee below minimum required fee: 24. Nothing was charged.", {}, "BOLT_FEE_TOO_LOW"],
    ["invalid nonce + Try again", 409, "Invalid nonce: transaction has 3, the next nonce for SP1 is 5. Try again", {}, "BOLT_INVALID_NONCE"],
    ["insufficient credit + Nothing was charged", 400, "Insufficient sponsor credit. Nothing was charged.", {}, "BOLT_INSUFFICIENT_CREDIT"],
    ["not sponsored on credit + Try again", 400, "Contract not sponsored on credit. Try again", {}, "BOLT_CONTRACT_NOT_ON_CREDIT"],
    ["insufficient balance + Nothing was charged", 400, "Insufficient sBTC balance. Nothing was charged.", {}, "BOLT_INSUFFICIENT_BALANCE"],
    ["bare Try again", 503, "Try again later", {}, "BOLT_TEMPORARILY_UNAVAILABLE"],
    ["rejected by the network", 400, "Transaction rejected by the network", {}, "BOLT_REJECTED"],
  ];
  for (const [name, status, message, body, code] of cases) {
    test(name, () => expect(bolt.boltError(status, message, body).code).toBe(code));
  }

  test("an unrecognised refusal is BOLT_UNRECOGNIZED and says the outcome is unknown", () => {
    const error = bolt.boltError(400, "Something nobody mapped");
    expect(error.code).toBe("BOLT_UNRECOGNIZED");
    expect(error.suggestion).toMatch(/unknown/);
    expect(error.suggestion).toMatch(/credit-ledger/);
  });

  test("details carry txid, feeTxid and credit", () => {
    const error = bolt.boltError(400, "x", { code: "CALL_NOT_SENT", feeTxid: "0xf", credit: 10, txid: "0xt" });
    expect(error.details).toMatchObject({ feeTxid: "0xf", credit: 10, txid: "0xt", boltCode: "CALL_NOT_SENT" });
  });
});

describe("nonceFromRefusal", () => {
  const refusal = (message: string, details?: Record<string, unknown>) =>
    new AibtcError(message, "BOLT_INVALID_NONCE", { status: 409, ...details });
  test("pending nonce -> the next one", () => expect(bolt.nonceFromRefusal(refusal(PENDING_MSG))).toBe(6n));
  test("stale nonce -> the one Bolt names", () =>
    expect(bolt.nonceFromRefusal(refusal("the transaction has 3, the next nonce for SP1 is 9"))).toBe(9n));
  test("stale message that is not behind -> none", () =>
    expect(bolt.nonceFromRefusal(refusal("the transaction has 9, the next nonce for SP1 is 9"))).toBeUndefined());
  test("a refusal that names a txid is never re-signed", () =>
    expect(bolt.nonceFromRefusal(refusal(PENDING_MSG, { txid: "0xabc" }))).toBeUndefined());
  test("other codes and non-errors -> none", () => {
    expect(bolt.nonceFromRefusal(new AibtcError(PENDING_MSG, "BOLT_REJECTED"))).toBeUndefined();
    expect(bolt.nonceFromRefusal(new Error(PENDING_MSG))).toBeUndefined();
  });
});

describe("minimumFeeFromRefusal / minCreditFee", () => {
  const tooLow = (message: string, details?: Record<string, unknown>) =>
    new AibtcError(message, "BOLT_FEE_TOO_LOW", details);
  test("from the body", () => expect(bolt.minimumFeeFromRefusal(tooLow("x", { minimumFee: 24 }))).toBe(24n));
  test("from the message", () =>
    expect(bolt.minimumFeeFromRefusal(tooLow("Fee below minimum required fee: 31."))).toBe(31n));
  test("none when unnamed or another code", () => {
    expect(bolt.minimumFeeFromRefusal(tooLow("too low"))).toBeUndefined();
    expect(bolt.minimumFeeFromRefusal(new AibtcError("minimum required fee: 5", "BOLT_REJECTED"))).toBeUndefined();
  });
  test("minCreditFee: 10 up to 500 bytes, 1 per 50 bytes above", () => {
    expect(bolt.minCreditFee("00".repeat(100))).toBe(10n);
    expect(bolt.minCreditFee("00".repeat(500))).toBe(10n);
    expect(bolt.minCreditFee("00".repeat(3000))).toBe(60n);
    expect(bolt.minCreditFee("00".repeat(3001))).toBe(61n);
  });
});

describe("boltWrite", () => {
  const ok = { txid: "0xaaa" };

  test("every request carries a timeout signal", async () => {
    const calls = mockFetch([json(200, ok)]);
    await bolt.boltWrite("/w", { a: 1 }, ctx);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  test("an HTML 502 is no answer: the same body is sent once more", async () => {
    const calls = mockFetch([html(502), json(200, ok)]);
    const result = await bolt.boltWrite<{ txid: string }>("/w", { a: 1 }, ctx);
    expect(result.txid).toBe("0xaaa");
    expect(calls.length).toBe(2);
    expect(calls[1].body).toBe(calls[0].body);
  });

  test("a 503 with Bolt JSON is an answer: no resend, mapped by code", async () => {
    const calls = mockFetch([json(503, { message: "Try again later", code: "UNAVAILABLE" })]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(calls.length).toBe(1);
    expect(error.code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
  });

  test("a 503 NOT_REFUNDED is not retried", async () => {
    const calls = mockFetch([json(503, { message: "Amount could not be returned", code: "NOT_REFUNDED" })]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(calls.length).toBe(1);
    expect(error.code).toBe("BOLT_REFUND_FAILED");
  });

  test("two no-answers -> BOLT_SENT_UNCONFIRMED with sender and nonce", async () => {
    const calls = mockFetch([html(504), html(502)]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(calls.length).toBe(2);
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.details).toMatchObject({ sender: SENDER, nonce: "7" });
    expect(error.suggestion).toMatch(/Do not sign again/);
  });

  test("a credit write points at credit-ledger --nonce", async () => {
    mockFetch([html(504), html(502)]);
    const error = await caught(bolt.boltWrite("/w", {}, { ...ctx, credit: true }));
    expect(error.suggestion).toMatch(/credit-ledger --nonce 7/);
  });

  test("a timeout is no answer too: resent once, then BOLT_SENT_UNCONFIRMED, not the raw error", async () => {
    const calls = mockFetch([timeout(), timeout()]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(calls.length).toBe(2);
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
  });

  test("a 2xx with an empty body on a real send -> BOLT_SENT_UNCONFIRMED", async () => {
    mockFetch([new Response("", { status: 200 })]);
    expect((await caught(bolt.boltWrite("/w", {}, ctx))).code).toBe("BOLT_SENT_UNCONFIRMED");
  });

  test("a 2xx that is not JSON -> BOLT_SENT_UNCONFIRMED", async () => {
    mockFetch([new Response("OK", { status: 200 })]);
    expect((await caught(bolt.boltWrite("/w", {}, ctx))).code).toBe("BOLT_SENT_UNCONFIRMED");
  });

  test("a 2xx without a string txid -> BOLT_SENT_UNCONFIRMED", async () => {
    mockFetch([json(200, {})]);
    expect((await caught(bolt.boltWrite("/w", {}, ctx))).code).toBe("BOLT_SENT_UNCONFIRMED");
    mockFetch([json(200, { txid: 5 })]);
    expect((await caught(bolt.boltWrite("/w", {}, ctx))).code).toBe("BOLT_SENT_UNCONFIRMED");
  });

  test("a nonce refusal that names a txid -> BOLT_SENT_UNCONFIRMED carrying it", async () => {
    mockFetch([json(409, { message: PENDING_MSG, code: "NONCE_PENDING", txid: "0xdead", feeTxid: "0xfee" })]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.details).toMatchObject({ txid: "0xdead", feeTxid: "0xfee", sender: SENDER, nonce: "7" });
    expect(error.suggestion).toMatch(/0xdead/);
  });

  test("after a resend, a nonce refusal naming the txid is recovered when the route allows it", async () => {
    mockFetch([html(502), json(409, { message: PENDING_MSG, code: "NONCE_PENDING", txid: "0xdead" })]);
    const result = await bolt.boltWrite<{ txid: string }>(
      "/w",
      {},
      ctx,
      (refusal) => (typeof (refusal.details as { txid?: unknown }).txid === "string" ? { txid: "0xdead" } : undefined)
    );
    expect(result.txid).toBe("0xdead");
  });

  test("after a resend, a nonce refusal without txid -> BOLT_SENT_UNCONFIRMED", async () => {
    mockFetch([timeout(), json(409, { message: PENDING_MSG, code: "NONCE_PENDING" })]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
  });
});

describe("boltWrite: a refusal after a resend", () => {
  const sentTwice = (second: Response, recover?: (r: AibtcError) => { txid: string } | undefined) => {
    mockFetch([html(502), second]);
    return caught(bolt.boltWrite<{ txid: string }>("/w", {}, ctx, recover));
  };

  test("a 429 rate limit on the repeat is BOLT_SENT_UNCONFIRMED, keeping code and message", async () => {
    const error = await sentTwice(json(429, { message: "slow down", code: "RATE_LIMITED" }));
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.details).toMatchObject({ sender: SENDER, nonce: "7", refusal: { code: "BOLT_RATE_LIMITED", message: "slow down" } });
    expect(error.suggestion).toMatch(/Do not sign again/);
  });

  test("INSUFFICIENT_BALANCE on the repeat (the first attempt spent the funds) is BOLT_SENT_UNCONFIRMED", async () => {
    const error = await sentTwice(json(400, { message: "Insufficient sBTC balance. Nothing was charged.", code: "INSUFFICIENT_BALANCE" }));
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.details).toMatchObject({ refusal: { code: "BOLT_INSUFFICIENT_BALANCE" } });
  });

  test("a refusal that recover turns into a result is still a result", async () => {
    mockFetch([html(502), json(429, { message: "slow", code: "RATE_LIMITED" })]);
    const result = await bolt.boltWrite<{ txid: string }>("/w", {}, ctx, () => ({ txid: "0xrec" }));
    expect(result.txid).toBe("0xrec");
  });

  test("a refusal on a first attempt is unchanged", async () => {
    mockFetch([json(429, { message: "slow down", code: "RATE_LIMITED" })]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(error.code).toBe("BOLT_RATE_LIMITED");
  });
});

describe("boltRequest: what counts as no answer", () => {
  const withStatus = (status: number) => new Response("denied", { status, headers: { "content-type": "text/plain" } });

  for (const status of [403, 413, 429]) {
    test(`a non-Bolt ${status} never reached Bolt: BOLT_TEMPORARILY_UNAVAILABLE, no resend`, async () => {
      const calls = mockFetch([withStatus(status)]);
      const error = await caught(bolt.boltWrite("/w", {}, ctx));
      expect(calls.length).toBe(1);
      expect(error.code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
      expect(error.message).toMatch(/Nothing reached Bolt; nothing was sent or charged/);
      expect(error.message).toContain(String(status));
    });
  }

  test("a non-Bolt 408 and 5xx stay no answer: resent once", async () => {
    for (const status of [408, 500, 503]) {
      const calls = mockFetch([withStatus(status), json(200, { txid: "0xok" })]);
      expect((await bolt.boltWrite<{ txid: string }>("/w", {}, ctx)).txid).toBe("0xok");
      expect(calls.length).toBe(2);
    }
  });

  test("a dropped connection stays no answer and the message does not claim a 30 s wait", async () => {
    mockFetch([new Error("connection refused"), new Error("connection reset")]);
    const error = await caught(bolt.boltWrite("/w", {}, ctx));
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.message).toContain("connection refused");
    expect(error.message).toContain("connection reset");
    expect(error.message).not.toMatch(/30 s/);
  });

  test("a read that fails at once does not claim a 30 s wait either", async () => {
    mockFetch([new Error("ECONNREFUSED")]);
    const error = await caught(bolt.boltRead("/r"));
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toMatch(/30 s/);
  });

  test("a non-Bolt 429 on the repeat of a write is BOLT_SENT_UNCONFIRMED", async () => {
    mockFetch([html(502), withStatus(429)]);
    expect((await caught(bolt.boltWrite("/w", {}, ctx))).code).toBe("BOLT_SENT_UNCONFIRMED");
  });
});

describe("boltWrite nonce tracking", () => {
  test("a txid is recorded under the nonce", async () => {
    mockFetch([json(200, { txid: "0xaaa" })]);
    await bolt.boltWrite("/w", {}, ctx);
    expect(tracked).toEqual([[SENDER, 7, "0xaaa"]]);
  });
  test("a call paid in the request records the payment at n and the call at n+1", async () => {
    mockFetch([json(200, { txid: "0xcall", feeTxid: "0xpay" })]);
    await bolt.boltWrite("/w", {}, ctx);
    expect(tracked).toEqual([[SENDER, 7, "0xpay"], [SENDER, 8, "0xcall"]]);
  });
  test("a recovered answer is recorded too", async () => {
    mockFetch([html(502), json(409, { message: PENDING_MSG, code: "NONCE_PENDING", txid: "0xdead" })]);
    await bolt.boltWrite<{ txid: string }>("/w", {}, ctx, () => ({ txid: "0xdead" }));
    expect(tracked).toEqual([[SENDER, 7, "0xdead"]]);
  });
  test("nothing without a nonce, and nothing on a refusal", async () => {
    mockFetch([json(200, { txid: "0xaaa" })]);
    await bolt.boltWrite("/w", {}, { sender: SENDER });
    mockFetch([json(409, { message: PENDING_MSG, code: "NONCE_PENDING" })]);
    await caught(bolt.boltWrite("/w", {}, ctx));
    expect(tracked).toEqual([]);
  });
});

describe("boltRead", () => {
  test("an HTML 502 on a read is BOLT_TEMPORARILY_UNAVAILABLE", async () => {
    mockFetch([html(502)]);
    expect((await caught(bolt.boltRead("/r"))).code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
  });
  test("a timeout on a read is BOLT_TEMPORARILY_UNAVAILABLE, not a raw error", async () => {
    mockFetch([timeout()]);
    expect((await caught(bolt.boltRead("/r"))).code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
  });
  for (const [name, reply] of [
    ["an empty body", () => new Response("", { status: 200 })],
    ["a body that is not JSON", () => new Response("OK", { status: 200 })],
    ["a JSON array", () => json(200, [1])],
    ["a JSON string", () => json(200, "ok")],
    ["JSON null", () => new Response("null", { status: 200 })],
  ] as Array<[string, () => Response]>) {
    test(`a 2xx with ${name} is BOLT_TEMPORARILY_UNAVAILABLE, nothing sent or charged`, async () => {
      mockFetch([reply()]);
      const error = await caught(bolt.boltRead("/r"));
      expect(error.code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
      expect(error.message).toMatch(/Nothing was sent or charged/);
    });
  }
  test("a JSON object passes", async () => {
    mockFetch([json(200, { status: "ok" })]);
    expect(await bolt.boltRead<{ status: string }>("/r")).toEqual({ status: "ok" });
  });
  test("a Bolt refusal on a read keeps its code", async () => {
    mockFetch([json(429, { message: "slow", code: "RATE_LIMITED" })]);
    expect((await caught(bolt.boltRead("/r"))).code).toBe("BOLT_RATE_LIMITED");
  });
});

describe("boltCheck", () => {
  test("POSTs the JSON body with the timeout signal and returns the object", async () => {
    const calls = mockFetch([json(200, { minimumFee: 12 })]);
    const answer = await bolt.boltCheck<{ minimumFee: number }>("/c", { a: 1 });
    expect(answer).toEqual({ minimumFee: 12 });
    expect(calls[0].url).toMatch(/\/c$/);
    expect(calls[0].body).toBe('{"a":1}');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });
  test("read semantics: no answer is unavailable (never resent), an unusable 2xx too, a refusal keeps its code", async () => {
    const calls = mockFetch([html(502)]);
    expect((await caught(bolt.boltCheck("/c", {}))).code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
    expect(calls.length).toBe(1);
    mockFetch([new Response("", { status: 200 })]);
    expect((await caught(bolt.boltCheck("/c", {}))).code).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
    mockFetch([json(400, { message: "x", code: "FEE_TOO_LOW" })]);
    expect((await caught(bolt.boltCheck("/c", {}))).code).toBe("BOLT_FEE_TOO_LOW");
  });
});

describe("signAndSend", () => {
  const spec = {} as Parameters<typeof bolt.signAndSend>[0];
  function signer() {
    const nonces: Array<bigint | undefined> = [];
    const sign = async (_spec: unknown, nonce?: bigint) => {
      nonces.push(nonce);
      return { serializedTx: "00", sender: SENDER, nonce: nonce ?? 5n };
    };
    return { nonces, sign: sign as never };
  }
  const refusalReply = (extra: Record<string, unknown> = {}) =>
    json(409, { message: PENDING_MSG, code: "NONCE_PENDING", ...extra });
  const write = (serializedTx: string, c: WriteContext) =>
    bolt.boltWrite<{ txid: string }>("/w", { serializedTx }, c);

  test("sponsor-call: a nonce refusal that names a txid is not signed over", async () => {
    mockFetch([refusalReply({ txid: "0xdead" })]);
    const { nonces, sign } = signer();
    const error = await caught(bolt.signAndSend(spec, write, { autoResign: true, sign }));
    expect(nonces.length).toBe(1);
    expect(error.code).toBe("BOLT_SENT_UNCONFIRMED");
    expect(error.details).toMatchObject({ txid: "0xdead" });
  });

  test("sponsor-call: a nonce refusal without txid is signed again once, at the nonce Bolt names", async () => {
    mockFetch([refusalReply(), json(200, { txid: "0xok" })]);
    const { nonces, sign } = signer();
    const sent = await bolt.signAndSend(spec, write, { autoResign: true, sign });
    expect(nonces).toEqual([undefined, 6n]);
    expect(sent.result.txid).toBe("0xok");
    expect(sent.nonce).toBe(6n);
  });

  test("transfer/deposit: a nonce refusal without txid is never re-signed", async () => {
    const calls = mockFetch([refusalReply()]);
    const { nonces, sign } = signer();
    const error = await caught(bolt.signAndSend(spec, write, { sign }));
    expect(nonces.length).toBe(1);
    expect(calls.length).toBe(1);
    expect(error.code).toBe("BOLT_INVALID_NONCE");
    expect(error.suggestion).toMatch(/earlier attempt of this same payment/);
  });

  test("transfer/deposit: a stale-nonce refusal is not re-signed either", async () => {
    mockFetch([json(409, { message: `the transaction has 3, the next nonce for ${SENDER} is 9`, code: "NONCE_MISMATCH" })]);
    const { nonces, sign } = signer();
    await caught(bolt.signAndSend(spec, write, { sign }));
    expect(nonces.length).toBe(1);
  });
});

describe("feeToResend", () => {
  const tooLow = (minimum: number) => new AibtcError(`minimum required fee: ${minimum}`, "BOLT_FEE_TOO_LOW", { minimumFee: minimum });
  const base = { userFee: false, sentFee: 20n, firstFee: 20n };
  test("minimum above the fee sent, within the default ceiling -> resend at the minimum", () =>
    expect(bolt.feeToResend(tooLow(24), base)).toBe(24n));
  test("minimum at or below the fee sent -> no resend", () => {
    expect(bolt.feeToResend(tooLow(20), base)).toBeUndefined();
    expect(bolt.feeToResend(tooLow(5), base)).toBeUndefined();
  });
  test("an explicit --fee is never changed", () =>
    expect(bolt.feeToResend(tooLow(24), { ...base, userFee: true })).toBeUndefined());
  test("minimum exactly at the default ceiling (10x) is accepted", () =>
    expect(bolt.feeToResend(tooLow(200), base)).toBe(200n));
  test("minimum above the default ceiling -> BOLT_FEE_TOO_LOW with minimumFee and maxFee", () => {
    try {
      bolt.feeToResend(tooLow(201), base);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AibtcError).code).toBe("BOLT_FEE_TOO_LOW");
      expect((error as AibtcError).details).toMatchObject({ minimumFee: 201, maxFee: 200 });
      expect((error as AibtcError).suggestion).toMatch(/--fee 201 or a higher --max-fee/);
    }
  });
  test("--max-fee overrides the default ceiling", () => {
    expect(bolt.feeToResend(tooLow(300), { ...base, maxFee: 300n })).toBe(300n);
    expect(() => bolt.feeToResend(tooLow(301), { ...base, maxFee: 300n })).toThrow();
  });
  test("a refusal that is not a fee refusal -> rethrow (undefined)", () =>
    expect(bolt.feeToResend(new AibtcError("x", "BOLT_REJECTED"), base)).toBeUndefined());
  test("the ceiling follows the first fee, not the one just sent", () => {
    expect(bolt.feeToResend(tooLow(150), { userFee: false, sentFee: 100n, firstFee: 20n })).toBe(150n);
    expect(() => bolt.feeToResend(tooLow(250), { userFee: false, sentFee: 100n, firstFee: 20n })).toThrow();
  });
});

describe("assertFirstFeeWithinMax (--max-fee is the most the command may spend)", () => {
  test("a first fee above --max-fee is BOLT_INVALID_ARGUMENT naming both", () => {
    try {
      bolt.assertFirstFeeWithinMax(25n, 20n);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AibtcError).code).toBe("BOLT_INVALID_ARGUMENT");
      expect((error as AibtcError).message).toBe("fee 25 is above --max-fee 20");
    }
  });
  test("a fee at or under --max-fee, or no --max-fee, passes", () => {
    expect(() => bolt.assertFirstFeeWithinMax(20n, 20n)).not.toThrow();
    expect(() => bolt.assertFirstFeeWithinMax(5n, 20n)).not.toThrow();
    expect(() => bolt.assertFirstFeeWithinMax(5000n, undefined)).not.toThrow();
  });
});

describe("originNonce (sponsor-call --serialized-tx)", () => {
  const KEY = "edf9aee84d9b7abc145504dde6726c64f369d37ee34ded868fabd39e1ac3da2d01";
  async function signedAt(nonce: bigint): Promise<string> {
    const tx = await makeContractCall({
      contractAddress: SENDER,
      contractName: "c",
      functionName: "f",
      functionArgs: [],
      senderKey: KEY,
      network: "mainnet",
      sponsored: true,
      fee: 0n,
      nonce,
    });
    return tx.serialize();
  }
  test("reads the origin nonce of a signed transaction", async () => {
    expect(bolt.originNonce(await signedAt(42n))).toBe(42n);
    expect(bolt.originNonce(await signedAt(0n))).toBe(0n);
  });
  test("undecodable input -> undefined", () => {
    expect(bolt.originNonce("zz")).toBeUndefined();
    expect(bolt.originNonce("")).toBeUndefined();
    expect(bolt.originNonce("0011")).toBeUndefined();
  });
  test("a lost answer for that nonce names credit-ledger --nonce N, and a success advances the tracker", async () => {
    const nonce = bolt.originNonce(await signedAt(42n));
    mockFetch([html(504), html(502)]);
    const error = await caught(bolt.boltWrite("/w", {}, { sender: SENDER, credit: true, nonce }));
    expect(error.suggestion).toMatch(/credit-ledger --nonce 42/);
    mockFetch([json(200, { txid: "0xaaa" })]);
    await bolt.boltWrite("/w", {}, { sender: SENDER, credit: true, nonce });
    expect(tracked).toEqual([[SENDER, 42, "0xaaa"]]);
  });
});

describe("argument checks", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as AibtcError).code ?? (error as Error).name;
    }
    return "no error";
  };
  test("assertMainnetPrincipal accepts SP/SM addresses and, when allowed, contracts", () => {
    expect(code(() => bolt.assertMainnetPrincipal(SENDER, "--recipient", true))).toBe("no error");
    expect(code(() => bolt.assertMainnetPrincipal(`${SENDER}.my-contract`, "--recipient", true))).toBe("no error");
    // Clarity contract names may contain `_`.
    expect(code(() => bolt.assertMainnetPrincipal(`${SENDER}.my_contract`, "--recipient", true))).toBe("no error");
    expect(code(() => bolt.assertMainnetPrincipal("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", "--address"))).toBe("no error");
  });
  test("assertMainnetPrincipal accepts valid short mainnet addresses (c32check, not a length rule)", () => {
    const burn = "SP000000000000000000002Q6VF78";
    expect(burn.length).toBe(29);
    expect(code(() => bolt.assertMainnetPrincipal(burn, "--address"))).toBe("no error");
    expect(code(() => bolt.assertMainnetPrincipal(`${burn}.pox-4`, "--recipient", true))).toBe("no error");
    expect(code(() => bolt.assertMainnetPrincipal(`${burn}.my_contract`, "--recipient", true))).toBe("no error");
  });
  test("assertMainnetPrincipal refuses an ST address and a mainnet address with a broken checksum", () => {
    expect(code(() => bolt.assertMainnetPrincipal("ST000000000000000000002AMW42H", "--address"))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal("SP000000000000000000002Q6VF79", "--address"))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal(`${SENDER.slice(0, -1)}K.c`, "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
  });
  test("assertMainnetPrincipal refuses testnet, malformed, and contracts when not allowed", () => {
    expect(code(() => bolt.assertMainnetPrincipal("ST3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02W1N0YJF", "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal("SN3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02W1N0YJF.c", "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal("ST3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02W1N0YJF.c", "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal("not-an-address", "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal(`${SENDER}.c`, "--address"))).toBe("BOLT_INVALID_ARGUMENT");
    expect(code(() => bolt.assertMainnetPrincipal(`${SENDER}.`, "--recipient", true))).toBe("BOLT_INVALID_ARGUMENT");
  });

  test("parsePostConditionMode: allow|deny in any case, nothing else", () => {
    expect(bolt.parsePostConditionMode("allow")).toBe(PostConditionMode.Allow);
    expect(bolt.parsePostConditionMode("ALLOW")).toBe(PostConditionMode.Allow);
    expect(bolt.parsePostConditionMode("Deny")).toBe(PostConditionMode.Deny);
    for (const bad of ["", "alow", "deny ", "true"]) {
      expect(code(() => bolt.parsePostConditionMode(bad))).toBe("BOLT_INVALID_ARGUMENT");
    }
  });

  const pc = (amount: unknown) => ({ type: "stx", principal: SENDER, conditionCode: "eq", amount });
  test("parsePostCondition accepts digit strings and safe non-negative integers", () => {
    expect(code(() => bolt.parsePostCondition(pc("100")))).toBe("no error");
    expect(code(() => bolt.parsePostCondition(pc(0)))).toBe("no error");
  });
  test("parsePostCondition refuses other amounts with BOLT_INVALID_ARGUMENT, not a SyntaxError", () => {
    for (const bad of ["1.5", "abc", "", "-1", -1, 1.5, "1e3", " 5"]) {
      expect(code(() => bolt.parsePostCondition(pc(bad)))).toBe("BOLT_INVALID_ARGUMENT");
    }
  });

  test("parseCreditBalance guards a missing or invalid balance", () => {
    expect(bolt.parseCreditBalance({ balance: "120" })).toBe(120n);
    for (const bad of [undefined, {}, { balance: null }, { balance: "abc" }, { balance: "-1" }, { balance: 1.5 }]) {
      expect(code(() => bolt.parseCreditBalance(bad))).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
    }
  });
  test("parseCreditBalance's error is a read error: nothing sent or charged, no write advice", () => {
    try {
      bolt.parseCreditBalance({});
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AibtcError).message).toMatch(/Nothing was sent or charged/);
      expect((error as AibtcError).suggestion).not.toMatch(/credit-ledger|before running the command again/);
      expect((error as AibtcError).suggestion).toMatch(/Nothing was sent or charged/);
    }
  });

  test("nonceFromHiro takes Hiro's possible_next_nonce and nothing else", () => {
    expect(bolt.nonceFromHiro(4)).toBe(4n);
    expect(bolt.nonceFromHiro(0)).toBe(0n);
    for (const bad of [undefined, null, "4", -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(code(() => bolt.nonceFromHiro(bad))).toBe("BOLT_TEMPORARILY_UNAVAILABLE");
    }
  });
});
