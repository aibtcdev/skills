import { describe, expect, test } from "bun:test";
import {
  reconcileDedupEntry,
  txMatchesIntent,
  type ChainNonceInfo,
  type ChainTx,
  type DedupChainReader,
  type PaymentIntent,
} from "./x402-dedup-reconcile.js";
import { generateDedupKey, normalizeObligationId, type DedupEntry } from "./x402-guards.js";

const PAYER = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
const PAY_TO = "SP3TH5S631RYN7Z485TY0KPFVX24R7RW7P25HVZ73";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const TXID = "a".repeat(64);
const OTHER = "b".repeat(64);

const sbtcIntent: PaymentIntent = { payer: PAYER, payTo: PAY_TO, amount: 100n, asset: SBTC };
const stxIntent: PaymentIntent = { payer: PAYER, payTo: PAY_TO, amount: 5000n, asset: "STX" };

const entry = (over: Partial<DedupEntry> = {}): DedupEntry => ({
  txid: TXID,
  timestamp: 0,
  nonce: "7",
  payer: PAYER,
  payTo: PAY_TO,
  amount: "100",
  asset: SBTC,
  ...over,
});

const sbtcTransfer = (over: Partial<ChainTx> = {}, amount = 100n, to = PAY_TO): ChainTx => ({
  tx_id: `0x${OTHER}`,
  tx_status: "success",
  tx_type: "contract_call",
  nonce: 7,
  sender_address: PAYER,
  contract_call: {
    contract_id: SBTC,
    function_name: "transfer",
    function_args: [{ repr: `u${amount}` }, { repr: `'${PAYER}` }, { repr: `'${to}` }, { repr: "none" }],
  },
  ...over,
});

function reader(opts: {
  tx?: ChainTx | null | Error;
  nonces?: Partial<ChainNonceInfo> | Error;
  atNonce?: ChainTx | null;
}): DedupChainReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getTransaction(txid) {
      calls.push(`tx:${txid}`);
      if (opts.tx instanceof Error) throw opts.tx;
      return opts.tx === undefined ? null : opts.tx;
    },
    async getNonceInfo(address) {
      calls.push(`nonces:${address}`);
      if (opts.nonces instanceof Error) throw opts.nonces;
      return { last_executed_tx_nonce: 6, possible_next_nonce: 7, detected_mempool_nonces: [], ...opts.nonces };
    },
    async findTransactionByNonce(address, nonce) {
      calls.push(`byNonce:${address}:${nonce}`);
      return opts.atNonce ?? null;
    },
  };
}

const own = (status: string): ChainTx => ({ tx_id: `0x${TXID}`, tx_status: status, nonce: 7 });

describe("reconcileDedupEntry (#460 reconcile table)", () => {
  test("stored txid confirmed → paid, no nonce lookup", async () => {
    const r = reader({ tx: own("success") });
    expect(await reconcileDedupEntry(entry(), sbtcIntent, r)).toMatchObject({ action: "paid", paidTxid: TXID });
    expect(r.calls).toEqual([`tx:${TXID}`]);
  });

  test("stored txid pending → refuse", async () => {
    expect((await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: own("pending") }))).action).toBe("refuse");
  });

  test("stored txid aborted → clear (its own nonce is consumed)", async () => {
    for (const status of ["abort_by_response", "abort_by_post_condition"]) {
      const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: own(status) }));
      expect(v.action).toBe("clear");
      expect(v).not.toHaveProperty("requireNonce");
    }
  });

  test("unrecognized status → refuse", async () => {
    expect((await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: own("weird") }))).action).toBe("refuse");
  });

  test("dropped, nonce unused and next → clear, pinned to that nonce", async () => {
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: own("dropped_replace_by_fee") }));
    expect(v).toMatchObject({ action: "clear", requireNonce: 7n });
  });

  test("unknown (404), nonce unused and next → clear, pinned", async () => {
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: null }));
    expect(v).toMatchObject({ action: "clear", requireNonce: 7n });
  });

  test("nonce pending in the mempool → refuse", async () => {
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: null, nonces: { detected_mempool_nonces: [7] } }));
    expect(v.action).toBe("refuse");
  });

  test("nonce unused behind a gap → refuse", async () => {
    const v = await reconcileDedupEntry(
      entry(),
      sbtcIntent,
      reader({ tx: null, nonces: { last_executed_tx_nonce: 3, possible_next_nonce: 4 } })
    );
    expect(v.action).toBe("refuse");
    expect(v.reason).toMatch(/4\.\.6 are missing/);
  });

  test("fresh account (no executed nonce) with n next → clear", async () => {
    const v = await reconcileDedupEntry(
      entry({ nonce: "0" }),
      sbtcIntent,
      reader({ tx: null, nonces: { last_executed_tx_nonce: null, possible_next_nonce: 0 } })
    );
    expect(v).toMatchObject({ action: "clear", requireNonce: 0n });
  });

  const used = { last_executed_tx_nonce: 9, possible_next_nonce: 10 };

  test("nonce executed by a matching replacement that confirmed → paid with the replacement's txid", async () => {
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: own("dropped_replace_by_fee"), nonces: used, atNonce: sbtcTransfer() }));
    expect(v).toMatchObject({ action: "paid", paidTxid: OTHER });
  });

  test("nonce executed by a matching transaction that aborted → clear", async () => {
    const v = await reconcileDedupEntry(
      entry(),
      sbtcIntent,
      reader({ tx: null, nonces: used, atNonce: sbtcTransfer({ tx_status: "abort_by_post_condition" }) })
    );
    expect(v.action).toBe("clear");
    expect(v).not.toHaveProperty("requireNonce");
  });

  test("nonce executed by an unrelated transaction → clear", async () => {
    for (const unrelated of [sbtcTransfer({}, 101n), sbtcTransfer({}, 100n, PAYER), { tx_id: `0x${OTHER}`, tx_status: "success", tx_type: "smart_contract", nonce: 7, sender_address: PAYER }]) {
      const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: null, nonces: used, atNonce: unrelated }));
      expect(v.action).toBe("clear");
    }
  });

  test("nonce executed but not indexed yet → refuse", async () => {
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: null, nonces: used, atNonce: null }));
    expect(v.action).toBe("refuse");
    expect(v.reason).toMatch(/not indexed yet/);
  });

  test("legacy record: nonce taken from a dropped tx when the API returns it", async () => {
    const legacy: DedupEntry = { txid: TXID, timestamp: 0 };
    const v = await reconcileDedupEntry(legacy, sbtcIntent, reader({ tx: own("dropped_stale_garbage_collect") }));
    expect(v).toMatchObject({ action: "clear", requireNonce: 7n });
  });

  test("legacy record unknown to the API → refuse with the clear-dedup hint", async () => {
    const v = await reconcileDedupEntry({ txid: TXID, timestamp: 0 }, sbtcIntent, reader({ tx: null }));
    expect(v.action).toBe("refuse");
    expect(v.reason).toContain(`clear-dedup --txid ${TXID}`);
  });

  test("any lookup failure → refuse, never clear", async () => {
    expect((await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: new Error("HTTP 503") }))).action).toBe("refuse");
    const v = await reconcileDedupEntry(entry(), sbtcIntent, reader({ tx: null, nonces: new Error("timeout") }));
    expect(v.action).toBe("refuse");
    expect(v.reason).toMatch(/timeout/);
  });
});

describe("txMatchesIntent", () => {
  test("sBTC: contract, function, amount, sender and recipient must all match", () => {
    expect(txMatchesIntent(sbtcTransfer(), sbtcIntent)).toBe(true);
    expect(txMatchesIntent(sbtcTransfer({ sender_address: PAY_TO }), sbtcIntent)).toBe(false);
    expect(
      txMatchesIntent(
        sbtcTransfer({ contract_call: { ...sbtcTransfer().contract_call, contract_id: `${PAYER}.fake-token` } }),
        sbtcIntent
      )
    ).toBe(false);
  });

  test("STX: recipient and amount must match", () => {
    const tx: ChainTx = {
      tx_id: "0x1",
      tx_status: "success",
      tx_type: "token_transfer",
      sender_address: PAYER,
      token_transfer: { recipient_address: PAY_TO, amount: "5000" },
    };
    expect(txMatchesIntent(tx, stxIntent)).toBe(true);
    expect(txMatchesIntent({ ...tx, token_transfer: { recipient_address: PAY_TO, amount: "4999" } }, stxIntent)).toBe(false);
    expect(txMatchesIntent({ ...tx, token_transfer: { recipient_address: PAY_TO, amount: "abc" } }, stxIntent)).toBe(false);
    expect(txMatchesIntent(tx, sbtcIntent)).toBe(false);
  });
});

describe("generateDedupKey identity (#460)", () => {
  const base = { method: "post", url: "https://x.test/paid", payer: PAYER, payTo: PAY_TO, amount: "100", asset: SBTC };

  test("per-attempt ids and tracing headers are not identity", () => {
    const a = generateDedupKey({ ...base, headers: { "X-Request-Id": "1", traceparent: "t1", "x-correlation-id": "c1", "sentry-trace": "s1", baggage: "b1" } });
    const b = generateDedupKey({ ...base, headers: { "x-request-id": "2", Traceparent: "t2", "X-Correlation-Id": "c2", "sentry-trace": "s2", baggage: "b2" } });
    expect(a).toBe(b);
    expect(a).toBe(generateDedupKey(base));
  });

  test("idempotency-key, accept and other headers stay identity", () => {
    const plain = generateDedupKey(base);
    expect(generateDedupKey({ ...base, headers: { "idempotency-key": "k1" } })).not.toBe(plain);
    expect(generateDedupKey({ ...base, headers: { accept: "text/csv" } })).not.toBe(generateDedupKey({ ...base, headers: { accept: "application/json" } }));
    expect(generateDedupKey({ ...base, headers: { "x-api-tier": "pro" } })).not.toBe(plain);
  });

  test("an obligation id replaces the request content in the key, from the option or the header", () => {
    const viaOption = generateDedupKey({ ...base, data: { ts: 1 }, obligationId: "job-1" });
    const viaHeader = generateDedupKey({ ...base, method: "GET", url: "https://other.test/x", data: { ts: 2 }, headers: { "X-Payment-Obligation-Id": " job-1 " } });
    expect(viaOption).toBe(viaHeader);
    expect(generateDedupKey({ ...base, obligationId: "job-2" })).not.toBe(viaOption);
    // The terms still count: a different price or recipient is a different purchase.
    expect(generateDedupKey({ ...base, amount: "101", obligationId: "job-1" })).not.toBe(viaOption);
    expect(generateDedupKey({ ...base, payTo: PAYER, obligationId: "job-1" })).not.toBe(viaOption);
  });

  test("a blank obligation id falls back to the content hash; an invalid one throws", () => {
    expect(generateDedupKey({ ...base, obligationId: "   " })).toBe(generateDedupKey(base));
    expect(normalizeObligationId(undefined)).toBeUndefined();
    expect(() => normalizeObligationId("x".repeat(257))).toThrow(/printable ASCII/);
    expect(() => normalizeObligationId("tab\there")).toThrow(/printable ASCII/);
    expect(() => normalizeObligationId(42)).toThrow(/must be a string/);
  });
});
