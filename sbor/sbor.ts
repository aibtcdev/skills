#!/usr/bin/env bun
/**
 * sbor: benchmark lending rates for Bitcoin DeFi, read from contract state on
 * every chain SBOR reads (the venues in each answer say which).
 *
 * Read-only. No wallet, no keys, no funds. Reads the public SBOR endpoints and
 * prints a single JSON object to stdout, as every skill here does.
 *
 * https://sbor.xyz
 */
import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const BASE = process.env.SBOR_BASE || "https://sbor.xyz";
const UA = "aibtc-skills-sbor/1.1";
const TIMEOUT_MS = 10_000;
const LATEST = "/api/v1/latest.json";
const HISTORY = "/api/v1/history.json";

/* Mainnet only, hard-coded, as in the other read-only mainnet skills
   (hodlmm-pulse, sbtc-yield-maximizer). SBOR has no wallet and no testnet
   fixing, so there is nothing for the shared NETWORK setting to switch. Every
   answer says which network its numbers come from. */
const NETWORK = "mainnet" as const;

type Market = {
  venue: string; asset: string; borrow: number; supply: number;
  utilization?: number; protocolYield?: number; protocolYieldSource?: string;
  nominalBorrow?: number; nominalSupply?: number;
  depthUsd: number; weight: number; phaseIn?: number;
};
type Index = {
  label: string; currency: string; headline: string;
  borrow: number; supply: number;
  allInSupply?: number; allInSupplyDiffers?: boolean;
  venues: string[]; largestConstituentWeight: number;
  markets: Market[];
  termAverages?: Record<string, { borrow: number | null; supply: number | null } | null>;
  seriesBegan?: string;
};
type Latest = {
  fixing: string; methodologyVersion: string; basis: string;
  indices: Record<string, Index>;
  poxReference?: Record<string, unknown>;
  bitcoinCollateralUsdc?: {
    borrow?: number; supply?: number; utilization?: number; depthUsd?: number; note?: string;
    markets: { chain: string; venue?: string; collateral: string; loan?: string; borrow: number; supply: number;
               utilization?: number; depthUsd: number; weight?: number; phaseIn?: number }[];
    notRead?: string[];
  };
  externalReference?: { note: string; markets: any[] };
  context?: {
    sofr?: { rate: number; effectiveDate: string; average30day?: number;
             average90day?: number; average180day?: number; volumeBillions?: number };
    prices?: { btcUsd: number; stxUsd: number };
    sbtcSupply?: { sbtc: number };
    chainHeight?: { burnBlockHeight: number | null; rewardCycle: number | null };
  };
  notes: string[];
};

const out = (o: unknown) => printJson(o);
const die = (msg: string): never => handleError(new Error(msg));

/* One fetch path for every command, JSON or text, so every request gets the
   same 10 second timeout and the same error handling.
   The 10 second limit covers the whole request, body included, and a body
   that stalls or does not parse is reported with its URL like any other
   failure. */
async function fetchSbor(path: string, accept: string, as: "json" | "text"): Promise<unknown> {
  const url = `${BASE}${path}`;
  let r: Response;
  try {
    r = await fetch(url, {
      headers: { accept, "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    return die(`${timeoutOr(e, url, "did not respond")}. Do not substitute an estimate.`);
  }
  if (!r.ok) return die(`SBOR responded ${r.status} for ${url}. Do not substitute an estimate.`);
  try {
    return as === "json" ? await r.json() : await r.text();
  } catch (e) {
    return die(`${timeoutOr(e, url, "did not finish sending")}. Do not substitute an estimate.`);
  }
}
const timeoutOr = (e: unknown, url: string, what: string) =>
  (e as Error).name === "TimeoutError"
    ? `SBOR ${what} within ${TIMEOUT_MS / 1000}s at ${url}`
    : (e as Error).name === "SyntaxError"
      ? `SBOR returned a body that is not valid JSON at ${url}`
      : `SBOR could not be read at ${url}: ${(e as Error).message}`;
async function get<T>(path: string): Promise<T> {
  return (await fetchSbor(path, "application/json", "json")) as T;
}
async function getText(path: string): Promise<string> {
  return (await fetchSbor(path, "text/plain", "text")) as string;
}

const INDICES = ["SBOR-USD", "SBOR-BTC", "SBOR-STX"];
/* What it costs to borrow USDC against plain 1:1 bitcoin, from every eligible
   market SBOR reads (Morpho on several chains, Granite on Stacks). A reference, not an SBOR index, but
   a benchmark an agent can compare a loan against, so the commands that take a
   benchmark accept it too. History covers the three indices only. */
const BTC_REF = "BTC-COLLATERAL-USDC";
const BENCHMARKS = [...INDICES, BTC_REF];
const checkIndex = (i?: string, allowRef = true) => {
  const ok = allowRef ? BENCHMARKS : INDICES;
  if (i && !ok.includes(i)) die(`Unknown index "${i}". Use one of: ${ok.join(", ")}.`);
};
function refIndex(d: Latest): Index | null {
  const r = d.bitcoinCollateralUsdc;
  if (!r || typeof r.borrow !== "number" || typeof r.supply !== "number") return null;
  return {
    label: BTC_REF, currency: "USDC", headline: "USDC against bitcoin collateral",
    borrow: r.borrow, supply: r.supply,
    /* Venues are the markets that carry weight. A market read at zero weight
       (borrower incentives, for example) is listed by markets but is not part
       of the rate, so it neither counts as a venue nor hides concentration. */
    venues: [...new Set(r.markets.filter(m => (m.weight ?? 0) > 0).map(m => `${m.venue ?? "Morpho"} on ${m.chain}`))],
    largestConstituentWeight: Math.max(0, ...r.markets.map(m => m.weight ?? 0)),
    markets: r.markets.map(m => ({
      venue: `${m.venue ?? "Morpho"} on ${m.chain}`, asset: `${m.collateral}/${m.loan ?? "USDC"}`,
      borrow: m.borrow, supply: m.supply, utilization: m.utilization,
      depthUsd: m.depthUsd, weight: m.weight ?? 0, phaseIn: m.phaseIn
    }))
  };
}
const lookup = (d: Latest, label: string): Index | null =>
  label === BTC_REF ? refIndex(d) : (d.indices[label] ?? null);
const REF_NOTE = "A reference, not an SBOR index: what it costs to borrow USDC against plain 1:1 bitcoin, from every eligible market SBOR reads (the venues list says which). A newly added market phases in over 30 days. Rates are effective APY.";
const NOT_ADVICE = "Market data, not financial advice.";
const ON_CHAIN = {
  stacks: { contract: "SP2SRS600PZ70VHY09CK06FSYKW546NY2ARG6N8CD.sbor-fixings", read: "get-latest" },
  arc: { contract: "0x56B5417de539153994fF6785F8a3b56421C9eb4f", chainId: 5042, read: "latest(bytes32)" },
  note: "Each day's fixing is also posted on-chain, in basis points. The JSON API remains the authoritative record."
};
const bps = (a: number, b: number) => Math.round((a - b) * 100);

const STALE_AFTER_HOURS = 48;
/* A fixing dated more than this far ahead of the local clock is treated as
   unusable: either the timestamp is wrong or this host's clock is, and in both
   cases the age of the data is unknown. A small allowance covers ordinary
   clock skew. */
const FUTURE_TOLERANCE_HOURS = 1;
/* Returns null when the timestamp cannot be parsed, or lies in the future
   beyond the tolerance. Both must be treated as unusable rather than as
   fresh: a NaN or negative age would otherwise read as not stale. */
const staleHours = (iso: string): number | null => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const age = (Date.now() - t) / 36e5;
  return age < -FUTURE_TOLERANCE_HOURS ? null : Math.max(0, age);
};

const METHODOLOGY_NOTE = "SBOR is young: the series began 2026-09-01 and the methodology has been revised as gaps were found. Every fixing records the version that produced it, and changes are published as documented steps rather than smoothed over. Read methodologyVersion before comparing fixings across dates.";

/* path is the file the data was read from. An archive file is a past fixing
   asked for by date, so it is reported as historical, not judged stale. */
const meta = (d: Latest, path: string = LATEST) => {
  const source = `${BASE}${path}`;
  if (path !== LATEST) {
    return {
      fixing: d.fixing,
      methodologyVersion: d.methodologyVersion,
      basis: d.basis,
      network: NETWORK,
      historical: true,
      historicalNote: "A past fixing, read from the archive by date. It is the record of that day, not a current rate.",
      methodologyNote: METHODOLOGY_NOTE,
      source
    };
  }
  const age = staleHours(d.fixing);
  return {
    fixing: d.fixing,
    methodologyVersion: d.methodologyVersion,
    basis: d.basis,
    network: NETWORK,
    staleHours: age === null ? null : Number(age.toFixed(1)),
    stale: age === null ? true : age > STALE_AFTER_HOURS,
    staleNote: age === null
      ? "The fixing timestamp could not be parsed or lies in the future, so the age of this data is unknown. Treat it as unusable."
      : age > STALE_AFTER_HOURS
        ? `The last fixing is ${age.toFixed(1)} hours old. Rates may have moved.`
        : undefined,
    methodologyNote: METHODOLOGY_NOTE,
    source
  };
};

/* Anything that produces a verdict an agent may act on must refuse to do so on
   data it cannot stand behind. Reporting commands may still return with a
   warning; compare may not. */
function requireFresh(d: Latest){
  const age = staleHours(d.fixing);
  if (age === null)
    die(`The fixing timestamp "${d.fixing}" could not be parsed or lies in the future, so the age of this data is unknown. Refusing to return a verdict. Fall back to your own logic.`);
  if (age > STALE_AFTER_HOURS)
    die(`The last fixing is ${age.toFixed(1)} hours old, past the ${STALE_AFTER_HOURS} hour limit. Refusing to return a verdict on stale data. Fall back to your own logic.`);
}

const summarise = (ix: Index) => ({
  index: ix.label,
  borrow: ix.borrow,
  supply: ix.supply,
  ...(ix.allInSupplyDiffers ? {
    allInSupply: ix.allInSupply,
    allInSupplyNote: "Includes protocol yield carried by the asset itself. Not a lending rate. Do not add it to supply."
  } : {}),
  venues: ix.venues,
  venueCount: ix.venues.length,
  largestConstituentWeight: ix.largestConstituentWeight,
  concentrationNote: ix.venues.length === 1
    ? "One venue. This is a reading of that venue, not a market average."
    : undefined
});

const ABSENT_REASON = "The market could not be read, so SBOR omits the index rather than publishing a figure it cannot stand behind. Treat this as unknown, not as zero.";
const absent = (label: string, d: Latest, path: string = LATEST, reason: string = ABSENT_REASON) => ({
  index: label,
  published: false,
  reason,
  publishedThatDay: Object.keys(d.indices),
  ...meta(d, path)
});

/* BTC-COLLATERAL-USDC was first published with the fixing of this date. */
const REF_FIRST_FIXING = "2026-09-25";
/* The archive publishes the dates it holds. --date is checked against that
   list, not against a hard-coded first day or this host's clock, so today's
   date before the day's fixing, a gap, or a date after the last fixing all get
   a clear answer instead of a 404. */
const ARCHIVE_INDEX = "/api/v1/archive-index.json";
type ArchiveIndex = { first: string; last: string; dates: string[] };
/* A real calendar date, not just the right shape: 2026-13-45 and 2026-02-30
   are rejected here as input errors instead of reaching the archive. */
const isCalendarDate = (s: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, day] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
};
/* Formats rate * 100 without floating point noise: 0.07 becomes "7", not
   "7.000000000000001". */
const pct100 = (rate: number) => String(Number((rate * 100).toPrecision(12)));

const program = new Command();
program.name("sbor").description("Benchmark lending rates for Bitcoin DeFi, read from contract state");

program.command("rate")
  .description("Current fixing, or the fixing for a past date")
  .option("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX | BTC-COLLATERAL-USDC")
  .option("--date <YYYY-MM-DD>", "a past date. Omit for the current fixing.")
  .action(async o => {
    checkIndex(o.index);
    if (o.date) {
      if (!isCalendarDate(o.date))
        die(`--date must be a real date in YYYY-MM-DD form, got "${o.date}".`);
      if (o.index === BTC_REF && o.date < REF_FIRST_FIXING)
        die(`${BTC_REF} did not exist on ${o.date}. It was first published with the fixing of ${REF_FIRST_FIXING}.`);
      const ai = await get<ArchiveIndex>(ARCHIVE_INDEX);
      if (!Array.isArray(ai?.dates) || !ai.dates.length)
        die(`The archive index at ${BASE}${ARCHIVE_INDEX} lists no dates. Do not substitute an estimate.`);
      if (!ai.dates.includes(o.date))
        die(o.date < ai.first
          ? `The daily archive starts ${ai.first}. ${o.date} is before it.`
          : o.date > ai.last
            ? `There is no fixing for ${o.date} yet. The latest is ${ai.last}: omit --date to read it.`
            : `No fixing is archived for ${o.date}. Every available date is listed at ${BASE}${ARCHIVE_INDEX}.`);
    }
    const path = o.date ? `/api/v1/archive/${o.date}.json` : LATEST;
    const d = await get<Latest>(path);
    /* An archive file is never rewritten, so a fixing withdrawn later still
       shows its figure there. The withdrawal is recorded in history.json, which
       is read for every past date so a withdrawn figure is never returned as
       the record of that day. */
    const withdrawnThatDay: Record<string, string> = {};
    if (o.date) {
      const h = await get<Record<string, any>[]>(HISTORY);
      const row = Array.isArray(h) ? h.find(r => r?.date === o.date) : undefined;
      for (const [label, v] of Object.entries(row ?? {}))
        if (v && typeof v === "object" && (v as any).withdrawn)
          withdrawnThatDay[label] = String((v as any).reason ?? "Withdrawn after publication.");
    }
    const withdrawnEntry = (label: string) => ({
      index: label, date: o.date, withdrawn: true, reason: withdrawnThatDay[label],
      note: "This fixing was withdrawn after publication. Its figure stays in the archive file, which is never rewritten, but it is not a valid reading. Do not use it."
    });
    if (o.index) {
      if (withdrawnThatDay[o.index]) return out({ ...withdrawnEntry(o.index), ...meta(d, path) });
      const ix = lookup(d, o.index);
      return out(ix ? { ...summarise(ix), ...(o.index === BTC_REF && { note: REF_NOTE }), ...meta(d, path) } : absent(o.index, d, path));
    }
    const ref = refIndex(d);
    const missing = INDICES.filter(l => !d.indices[l]);
    out({
      indices: Object.values(d.indices).map(ix => withdrawnThatDay[ix.label] ? withdrawnEntry(ix.label) : summarise(ix)),
      notPublished: missing.length ? missing.map(l => ({
        index: l,
        reason: "Market could not be read. Omitted rather than estimated. Treat as unknown, not zero."
      })) : undefined,
      bitcoinCollateralUsdc: ref ? (withdrawnThatDay[ref.label] ? withdrawnEntry(ref.label) : { ...summarise(ref), note: REF_NOTE }) : undefined,
      onChain: ON_CHAIN,
      poxReference: d.poxReference ? {
        ...d.poxReference,
        warning: "A staking yield on a locked position, not a lending rate. Never compare it with a borrow or supply rate."
      } : undefined,
      ...meta(d, path)
    });
  });

program.command("compare")
  .description("Is a rate you have been offered above or below the market")
  .requiredOption("--rate <number>", "the rate offered, as a percentage. 4.2 means 4.2%.")
  .requiredOption("--side <side>", "borrow | supply")
  .requiredOption("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX | BTC-COLLATERAL-USDC")
  .action(async o => {
    checkIndex(o.index);
    if (!["borrow", "supply"].includes(o.side)) die(`--side must be borrow or supply, got "${o.side}".`);

    /* This command returns a verdict an agent may act on before borrowing, so
       every input and every field it depends on is checked before any verdict
       is produced. A wrong verdict here is worse than no verdict. */
    const raw = String(o.rate ?? "").trim();
    if (raw === "") die(`--rate is required and cannot be empty.`);
    const rate = Number(raw);
    if (!Number.isFinite(rate)) die(`--rate must be a number, got "${o.rate}".`);
    /* 0% is a real offer: supply rates of 0 occur in SBOR's own record. */
    if (rate < 0 || rate > 100)
      die(`--rate must be a percentage from 0 to 100, got ${rate}. ` +
          `4.2% is "--rate 4.2", not 0.042 and not 420.`);

    /* A fraction passed as a percentage cannot be detected with certainty,
       because rates this low genuinely occur: stSTX supply on Zest was 0.09%
       today. Rejecting everything below half a percent would refuse real
       questions. So it is accepted and flagged, loudly enough that an agent
       reading either the verdict or the plain sentence cannot miss it. */
    const looksLikeFraction = rate > 0 && rate < 0.5;

    const d = await get<Latest>(LATEST);
    requireFresh(d);

    const ix = lookup(d, o.index);
    if (!ix)
      die(`${o.index} is not published in the current fixing, so there is no benchmark to compare against. ` +
          `When a market cannot be read, SBOR omits it rather than publishing a figure it cannot stand behind. ` +
          `Treat this as unknown, not as zero. Published today: ${Object.keys(d.indices).join(", ")}.`);

    const side = o.side as "borrow" | "supply";
    const bench = ix[side];
    if (typeof bench !== "number" || !Number.isFinite(bench))
      die(`${o.index} has no published ${side} rate in the current fixing, so there is nothing to compare against. Treat this as unknown, not as zero.`);

    const diff = bps(rate, bench);
    if (!Number.isFinite(diff))
      die(`Could not compute a difference from offered ${rate} against benchmark ${bench}. Refusing to return a verdict.`);

    const worse = side === "borrow" ? diff > 0 : diff < 0;
    /* Only a full member that carries weight can be named best. A market still
       phasing in is listed by markets, never recommended: a new market's rate
       can be mechanically low for weeks while its rate model adjusts. A market
       at zero weight is not part of the rate at all. */
    const best = [...ix.markets]
      .filter(m => typeof m[side] === "number" && Number.isFinite(m[side]))
      .filter(m => typeof m.phaseIn !== "number" || m.phaseIn >= 1)
      .filter(m => typeof m.weight === "number" && m.weight > 0)
      .sort((a, b) => side === "borrow" ? a.borrow - b.borrow : b.supply - a.supply)[0];

    out({
      index: ix.label,
      side,
      offered: rate,
      benchmark: bench,
      differenceBps: diff,
      verdict: Math.abs(diff) < 1 ? "at market" : worse ? "worse than market" : "better than market",
      /* On the supply side, an index whose assets carry their own yield has two
         figures: the lending rate (the benchmark above) and the all-in rate. An
         offer that already includes staking or protocol yield must be read
         against the all-in figure, so both comparisons are returned. */
      ...(side === "supply" && ix.allInSupplyDiffers && typeof ix.allInSupply === "number" && Number.isFinite(ix.allInSupply) ? {
        allInSupply: ix.allInSupply,
        allInDifferenceBps: bps(rate, ix.allInSupply),
        allInVerdict: Math.abs(bps(rate, ix.allInSupply)) < 1 ? "at market" : bps(rate, ix.allInSupply) < 0 ? "worse than market" : "better than market",
        allInSupplyNote: `The verdict above is against the lending rate alone (${bench}%). If the offer includes the asset's own staking or protocol yield, judge it by allInVerdict, against the all-in rate of ${ix.allInSupply}%. Do not add the two figures.`
      } : {}),
      ...(looksLikeFraction && {
        unitsWarning: `--rate was given as ${rate}, which is ${rate}%, not ${pct100(rate)}%. Rates this low do occur, so this has been treated as ${rate}% and answered. If you meant ${pct100(rate)}%, pass --rate ${pct100(rate)} and read the verdict again. Do not act on this result until you have checked which you meant.`
      }),
      plain: (looksLikeFraction ? `Check units first: this was read as ${rate}%, not ${pct100(rate)}%. ` : "") + (Math.abs(diff) < 1
        ? `At the market.`
        : side === "borrow"
          ? `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be paying ${diff > 0 ? "more" : "less"} than the benchmark.`
          : `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be earning ${diff > 0 ? "more" : "less"} than the benchmark.`),
      best: best ? {
        venue: best.venue, asset: best.asset, rate: best[side],
        utilization: best.utilization ?? null,
        capacityNote: best.utilization == null ? null
          : side === "borrow"
            ? (best.utilization >= 90 ? "Above 90% utilised, so little of the supply is left to borrow at this rate."
              : best.utilization <= 25 ? "Low utilisation, so there is unused capacity behind this rate."
              : null)
            : (best.utilization >= 90 ? "Above 90% utilised, so nearly all of the supply is lent out and earning this rate."
              : best.utilization <= 25 ? "Low utilisation, so most of the supply is not lent out. That is why the rate is low."
              : null)
      } : null,
      venues: ix.venues,
      venueCount: ix.venues.length,
      largestConstituentWeight: ix.largestConstituentWeight,
      concentrationNote: ix.venues.length === 1
        ? "One venue. This is a reading of that venue, not a market average, whatever the constituent weights are."
        : undefined,
      ...(o.index === BTC_REF
        ? { note: REF_NOTE }
        : { hint: `If this is a USDC loan against bitcoin, on any chain, compare with ${BTC_REF} instead: a Stacks index prices lending on Stacks against any collateral.` }),
      notAdvice: NOT_ADVICE,
      ...meta(d)
    });
  });

program.command("markets")
  .description("Venues behind a rate, with utilisation and depth")
  .option("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX | BTC-COLLATERAL-USDC")
  .action(async o => {
    checkIndex(o.index);
    const d = await get<Latest>(LATEST);
    const one = o.index ? lookup(d, o.index) : null;
    const entries = o.index ? (one ? [one] : []) : Object.values(d.indices);
    if (!entries.length) return out(absent(o.index, d));
    out({
      markets: entries.flatMap(ix => ix.markets.map(m => ({
        index: ix.label, venue: m.venue, asset: m.asset,
        borrow: m.borrow, supply: m.supply,
        utilization: m.utilization ?? null,
        protocolYield: m.protocolYield ?? null,
        protocolYieldSource: m.protocolYieldSource ?? null,
        depthUsd: m.depthUsd, weight: m.weight,
        ...(typeof m.phaseIn === "number" && m.phaseIn < 1 && { phaseIn: m.phaseIn, phaseInNote: "A newly added market, phasing in over 30 days. Listed, not yet fully weighted." })
      }))),
      note: "Utilisation is the share of supplied capital currently borrowed. It is why a rate sits where it does. Protocol yield comes from the asset, not the loan, and is not part of the lending rate.",
      ...meta(d)
    });
  });

program.command("history")
  .description("Daily fixings")
  .requiredOption("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
  .option("--days <n>", "how far back, default 30", "30")
  .action(async o => {
    checkIndex(o.index, false);
    const days = Number(o.days);
    if (!Number.isFinite(days) || days < 1) die(`--days must be a positive number.`);
    const h = await get<Record<string, any>[]>(HISTORY);
    /* --days 30 means the last 30 calendar days, today included. */
    const cutoff = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const inWindow = h.filter(r => r.date >= cutoff);
    const rows = inWindow.filter(r => r[o.index]);
    /* A day with a fixing but no entry for this index means the index was not
       published that day. It is listed, never skipped silently: a series with
       hidden gaps would give a mean over days that do not exist. */
    const notPublished = inWindow.filter(r => !r[o.index]).map(r => r.date).sort();
    if (!rows.length) return out({ index: o.index, days, fixings: [], notPublished, notPublishedCount: notPublished.length, note: `No fixings for ${o.index} in the last ${days} days.` });

    const valid = rows.filter(r => !r[o.index].withdrawn && typeof r[o.index].borrow === "number");

    /* A mean across a methodology change averages two different definitions of
       the same number. SBOR revised its methodology several times in the first
       fortnight, so a single mean over that window is close to meaningless.
       Report per version instead and let the caller decide. */
    const byVersion: Record<string, { count: number; meanBorrow: number | null; first: string; last: string }> = {};
    for (const r of valid) {
      const v = r.methodologyVersion ?? "unknown";
      (byVersion[v] ||= { count: 0, meanBorrow: 0, first: r.date, last: r.date });
      byVersion[v].count += 1;
      byVersion[v].meanBorrow = (byVersion[v].meanBorrow ?? 0) + r[o.index].borrow;
      byVersion[v].last = r.date;
    }
    for (const v of Object.keys(byVersion))
      byVersion[v].meanBorrow = Number(((byVersion[v].meanBorrow ?? 0) / byVersion[v].count).toFixed(2));

    const versions = Object.keys(byVersion);
    out({
      index: o.index, days, count: rows.length,
      fixings: rows.map(r => r[o.index].withdrawn
        ? { date: r.date, withdrawn: true, reason: r[o.index].reason }
        : { date: r.date, borrow: r[o.index].borrow, supply: r[o.index].supply,
            venues: r[o.index].venues ?? null,
            methodologyVersion: r.methodologyVersion ?? null }),
      methodologyVersionsInWindow: versions,
      byMethodologyVersion: byVersion,
      meanBorrow: versions.length === 1 && valid.length
        ? Number((valid.reduce((a, r) => a + r[o.index].borrow, 0) / valid.length).toFixed(2))
        : null,
      meanBorrowNote: versions.length > 1
        ? `This window spans ${versions.length} methodology versions (${versions.join(", ")}), so no single mean is given. Use byMethodologyVersion, or narrow --days to stay within one version.`
        : undefined,
      withdrawnCount: rows.length - valid.length,
      notPublished,
      notPublishedCount: notPublished.length,
      note: "Withdrawn fixings stay in the record rather than being deleted, and are excluded from every mean. Days in notPublished had a fixing but no reading for this index: treat them as unknown, not as zero, and note that the series has gaps there. A change in methodologyVersion means the basis changed.",
      source: `${BASE}${HISTORY}`
    });
  });

program.command("chains")
  .description("The same asset classes on other chains, and on the US repo market")
  .option("--index <index>", "only markets comparable to this index")
  .action(async o => {
    checkIndex(o.index);
    const d = await get<Latest>(LATEST);
    const all = d.externalReference?.markets ?? [];
    /* The on-chain comparison has no BTC-COLLATERAL-USDC rows of its own. As a
       dollar rate it is compared with the same dollar markets as SBOR-USD. */
    const comparable = o.index === BTC_REF ? "SBOR-USD" : o.index;
    const markets = o.index ? all.filter((m: any) => m.comparableTo === comparable) : all;
    const sofr = d.context?.sofr;
    const ref = refIndex(d);
    /* BTC-COLLATERAL-USDC is a dollar rate, so it is shown, with SOFR, for
       either dollar benchmark: on its own, or beside SBOR-USD. */
    const dollar = !o.index || o.index === "SBOR-USD" || o.index === BTC_REF;

    /* An index asked for by name that is not in today's fixing is reported as
       not published, as rate and markets do, rather than as an empty list. */
    if (o.index && !lookup(d, o.index)) return out(absent(o.index, d));

    out({
      /* The Stacks index to read beside the one asked for: itself, or for
         BTC-COLLATERAL-USDC, SBOR-USD, the dollar on Stacks. */
      stacks: Object.values(d.indices)
        .filter(ix => !o.index || ix.label === comparable)
        .map(ix => ({ index: ix.label, borrow: ix.borrow, supply: ix.supply })),
      bitcoinCollateralUsdc: ref && dollar
        ? { borrow: ref.borrow, supply: ref.supply, venues: ref.venues, note: REF_NOTE + " A dollar on Stacks is borrowed against any crypto collateral, not only bitcoin." }
        : undefined,
      onChain: markets,
      chainsCovered: [...new Set(markets.map((m: any) => String(m.venue).split(", ").pop()))],
      /* SOFR is the cost of a dollar secured by US government debt. It is the
         benchmark SBOR is modelled on, and the only meaningful comparison for a
         dollar rate outside crypto entirely. */
      offChain: sofr && dollar ? {
        name: "SOFR",
        rate: sofr.rate,
        effectiveDate: sofr.effectiveDate,
        average30day: sofr.average30day ?? null,
        average90day: sofr.average90day ?? null,
        average180day: sofr.average180day ?? null,
        what: "The overnight cost of a dollar in the US repo market, secured by US government debt. Published by the Federal Reserve Bank of New York for the previous business day, so it does not move at weekends.",
        howToRead: d.indices["SBOR-USD"]
          ? `A dollar on Stacks, borrowed against crypto collateral, costs ${d.indices["SBOR-USD"].borrow.toFixed(2)}%, against ${sofr.rate.toFixed(2)}% secured by Treasuries. A cheaper rate on Stacks reflects lower utilisation, not lower risk.`
          : null
      } : undefined,
      note: d.externalReference?.note,
      warning: "Context only. On-chain comparisons are never constituents of an SBOR index. Aave on Ethereum and Base is read from contract state; the other venues come from DefiLlama, and each market's source field says which. Depth is total supplied, labelled by depthBasis. One market is selected per chain: a venue publishing a borrow rate and utilisation is preferred over one that does not, and depth decides between those that publish both.",
      ...meta(d)
    });
  });

program.command("inversions")
  .description("Cross-venue inversions, checked every three hours")
  .action(async () => {
    const v = await get<any>("/api/v1/inversions.json");
    out({
      status: v.status,
      statusNote: v.statusNote,
      checked: v.checked,
      count: (v.inversions || []).length,
      inversions: v.inversions,
      minimumEdgeBps: v.minimumEdgeBps,
      note: v.note,
      warning: v.status === "validating"
        ? "This monitor is being validated. Report detections as observations, not as trades."
        : undefined,
      source: `${BASE}/api/v1/inversions.json`
    });
  });

program.command("context")
  .description("What the world looked like when this fixing was taken")
  .action(async () => {
    const d = await get<Latest>(LATEST);
    if (!d.context) return out({ context: null, note: "No context in the current fixing.", ...meta(d) });
    out({
      ...d.context,
      note: "Recorded alongside each fixing and never used in any calculation. It is kept so a past fixing can be read in the conditions of its day.",
      ...meta(d)
    });
  });

program.command("method")
  .description("Full methodology and integration policy")
  .action(async () => {
    out({ methodology: await getText("/llms.txt"), source: `${BASE}/llms.txt` });
  });

program.parseAsync(process.argv).catch(handleError);
