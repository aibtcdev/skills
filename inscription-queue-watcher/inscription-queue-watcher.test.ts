import { describe, expect, test } from "bun:test";
import {
  classifyBrief,
  parseInscriptionId,
  parseNotify,
  recentDates,
  runWatcher,
  type BriefDocument,
  type OnChainResult,
} from "./lib.js";

const NOW = new Date("2026-04-19T12:00:00Z");
const ONCHAIN_CONFIRMED: OnChainResult = {
  txid: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384",
  confirmed: true,
  blockHeight: 944581,
  blockTime: "2026-04-11T04:20:10.000Z",
  explorerUrl: "https://mempool.space/tx/c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384",
  checkedAt: NOW.toISOString(),
};
const ONCHAIN_UNCONFIRMED: OnChainResult = {
  ...ONCHAIN_CONFIRMED,
  confirmed: false,
  blockHeight: null,
  blockTime: null,
};

describe("parseInscriptionId", () => {
  test("parses a standard reveal inscription ID", () => {
    const parsed = parseInscriptionId(
      "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i0"
    );
    expect(parsed).toEqual({
      txid: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384",
      index: 0,
    });
  });

  test("accepts non-zero indices", () => {
    const parsed = parseInscriptionId(
      "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i42"
    );
    expect(parsed?.index).toBe(42);
  });

  test("rejects malformed IDs", () => {
    expect(parseInscriptionId("not-an-id")).toBeNull();
    expect(parseInscriptionId("zzzzi0")).toBeNull();
    expect(parseInscriptionId("c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384")).toBeNull();
  });
});

describe("recentDates", () => {
  test("returns the N most recent UTC dates oldest-first ending today", () => {
    const dates = recentDates(3, NOW);
    expect(dates).toEqual(["2026-04-17", "2026-04-18", "2026-04-19"]);
  });

  test("handles days == 1", () => {
    expect(recentDates(1, NOW)).toEqual(["2026-04-19"]);
  });

  test("returns empty for days < 1", () => {
    expect(recentDates(0, NOW)).toEqual([]);
  });
});

describe("classifyBrief decision tree", () => {
  test("healthy — compiled + inscription + on-chain confirmed", () => {
    const brief: BriefDocument = {
      date: "2026-04-10",
      compiledAt: "2026-04-11T04:20:58.289Z",
      inscription: {
        inscriptionId: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i0",
        inscribedTxid: null,
      },
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: ONCHAIN_CONFIRMED,
      now: NOW,
    });
    expect(result.state).toBe("healthy");
    expect(result.severity).toBe("ok");
    expect(result.onChain?.confirmed).toBe(true);
  });

  test("compiled_no_inscription — compiled > thresholdHours ago, no inscription", () => {
    const brief: BriefDocument = {
      date: "2026-04-17",
      compiledAt: "2026-04-18T05:18:10.000Z",
      inscription: null,
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: null,
      now: NOW,
    });
    expect(result.state).toBe("compiled_no_inscription");
    expect(result.severity).toBe("red");
    expect(result.ageHours).not.toBeNull();
    expect(result.ageHours!).toBeGreaterThan(24);
  });

  test("compiled within grace window reports as pending_inscription (info)", () => {
    const brief: BriefDocument = {
      date: "2026-04-19",
      compiledAt: "2026-04-19T10:00:00.000Z",
      inscription: null,
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: null,
      now: NOW,
    });
    expect(result.state).toBe("pending_inscription");
    expect(result.severity).toBe("info");
    expect(result.compiledAt).toBe("2026-04-19T10:00:00.000Z");
  });

  test("inscription_unconfirmed — inscriptionId present, tx not on-chain", () => {
    const brief: BriefDocument = {
      date: "2026-04-16",
      compiledAt: "2026-04-17T00:00:00.000Z",
      inscription: {
        inscriptionId: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i0",
        inscribedTxid: null,
      },
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: ONCHAIN_UNCONFIRMED,
      now: NOW,
    });
    expect(result.state).toBe("inscription_unconfirmed");
    expect(result.severity).toBe("warn");
  });

  test("inscription_unconfirmed — inscriptionId present, on-chain check returned null", () => {
    const brief: BriefDocument = {
      date: "2026-04-16",
      compiledAt: "2026-04-17T00:00:00.000Z",
      inscription: {
        inscriptionId: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i0",
        inscribedTxid: null,
      },
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: null,
      now: NOW,
    });
    expect(result.state).toBe("inscription_unconfirmed");
    expect(result.severity).toBe("warn");
  });

  test("stale_not_compiled — past date with null compiledAt", () => {
    const brief: BriefDocument = {
      date: "2026-04-15",
      compiledAt: null,
      inscription: null,
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: null,
      now: NOW,
    });
    expect(result.state).toBe("stale_not_compiled");
    expect(result.severity).toBe("warn");
  });

  test("not_compiled — today's date with null compiledAt", () => {
    const brief: BriefDocument = {
      date: "2026-04-19",
      compiledAt: null,
      inscription: null,
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: null,
      now: NOW,
    });
    expect(result.state).toBe("not_compiled");
    expect(result.severity).toBe("info");
  });

  test("reads snake_case compiled_at when camelCase absent (dual-schema drift)", () => {
    const brief: BriefDocument = {
      date: "2026-04-10",
      compiledAt: null,
      compiled_at: "2026-04-11T04:20:58.289Z",
      inscription: {
        inscriptionId: "c6892918e03ac6d157ebd058bab8acb72c23d12530fe3d94ddc7570abec51384i0",
        inscribedTxid: null,
      },
    };
    const result = classifyBrief(brief, {
      thresholdHours: 24,
      onChain: ONCHAIN_CONFIRMED,
      now: NOW,
    });
    expect(result.state).toBe("healthy");
    expect(result.compiledAt).toBe("2026-04-11T04:20:58.289Z");
  });
});

describe("parseNotify", () => {
  test("returns empty arrays when unset", () => {
    expect(parseNotify(undefined)).toEqual({ valid: [], rejected: [] });
    expect(parseNotify("")).toEqual({ valid: [], rejected: [] });
  });

  test("accepts valid bech32 bc1 addresses", () => {
    const result = parseNotify(
      "bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5,bc1pxyz0123456789abcdefghjklmnpqrstuvwxyz0123456"
    );
    expect(result.valid).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  test("filters invalid entries and reports them", () => {
    const result = parseNotify(
      "bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5,not-an-address,garbage"
    );
    expect(result.valid).toEqual(["bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"]);
    expect(result.rejected).toEqual(["not-an-address", "garbage"]);
  });

  test("skips whitespace-only entries silently", () => {
    const result = parseNotify("bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5, , ");
    expect(result.valid).toEqual(["bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"]);
    expect(result.rejected).toEqual([]);
  });
});

describe("runWatcher integration (mocked fetch)", () => {
  function makeFetch(routes: Record<string, () => Response>): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [prefix, handler] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return handler();
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("3-day window mixes healthy + red + unconfirmed and aggregates totals", async () => {
    const briefByDate: Record<string, BriefDocument> = {
      "2026-04-17": {
        date: "2026-04-17",
        compiledAt: "2026-04-18T05:18:10.000Z",
        inscription: null,
      },
      "2026-04-18": {
        date: "2026-04-18",
        compiledAt: "2026-04-19T04:00:00.000Z",
        inscription: {
          inscriptionId: "a".repeat(64) + "i0",
          inscribedTxid: null,
        },
      },
      "2026-04-19": {
        date: "2026-04-19",
        compiledAt: null,
        inscription: null,
      },
    };

    const fetchImpl = makeFetch({
      [`https://aibtc.news/api/brief/`]: () => {
        throw new Error("route resolver used below");
      },
      [`https://mempool.space/api/tx/`]: () => {
        return new Response(
          JSON.stringify({
            confirmed: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    const routedFetch: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://aibtc.news/api/brief/")) {
        const date = url.split("/").pop()!;
        const brief = briefByDate[date];
        if (!brief) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(brief), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return fetchImpl(input);
    }) as typeof fetch;

    const report = await runWatcher({
      days: 3,
      thresholdHours: 24,
      now: NOW,
      fetchImpl: routedFetch,
    });

    expect(report.windowDays).toBe(3);
    expect(report.classifications).toHaveLength(3);
    expect(report.totals.red).toBe(1);
    expect(report.red[0].date).toBe("2026-04-17");
    expect(report.red[0].state).toBe("compiled_no_inscription");
    expect(report.notifyHint).toContain("--notify");
  });

  test("notifyRecipients suppresses notifyHint", async () => {
    const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://aibtc.news/api/brief/")) {
        return new Response(
          JSON.stringify({
            date: "2026-04-19",
            compiledAt: null,
            inscription: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const report = await runWatcher({
      days: 1,
      thresholdHours: 24,
      notifyRecipients: ["bc1qpublisher", "bc1qeditor"],
      now: NOW,
      fetchImpl,
    });
    expect(report.notifyRecipients).toEqual(["bc1qpublisher", "bc1qeditor"]);
    expect(report.notifyHint).toBeUndefined();
  });
});
