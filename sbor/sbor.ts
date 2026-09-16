#!/usr/bin/env bun
/**
 * sbor: the benchmark lending rate for Stacks.
 *
 * Read-only. No wallet, no keys, no funds. Reads the public SBOR endpoints and
 * prints a single JSON object to stdout, as every skill here does.
 *
 * https://sbor.xyz
 */
import { Command } from "commander";

const BASE = process.env.SBOR_BASE || "https://sbor.xyz";
const UA = "aibtc-skills-sbor/1.1";
const TIMEOUT_MS = 10_000;

/* Tagged mainnet-only: SBOR reads Stacks mainnet contracts and has no testnet
   equivalent, so a testnet run would silently return mainnet numbers. */
const NETWORK = process.env.NETWORK;
if (NETWORK && NETWORK !== "mainnet") {
  console.log(JSON.stringify({ error: `SBOR is mainnet only. NETWORK is "${NETWORK}". There is no testnet fixing, and returning mainnet rates on a testnet run would be misleading.` }));
  process.exit(1);
}

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

const out = (o: unknown) => { console.log(JSON.stringify(o, null, 2)); };
const die = (msg: string) => { console.log(JSON.stringify({ error: msg })); process.exit(1); };

async function get<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError"
      ? `SBOR did not respond within ${TIMEOUT_MS / 1000}s at ${BASE}${path}`
      : `SBOR is unreachable at ${BASE}${path}: ${(e as Error).message}`;
    die(`${msg}. Do not substitute an estimate.`);
    throw e;
  }
  if (!r.ok) die(`SBOR responded ${r.status} for ${path}. Do not substitute an estimate.`);
  return r.json() as Promise<T>;
}

const INDICES = ["SBOR-USD", "SBOR-BTC", "SBOR-STX"];
const checkIndex = (i?: string) => {
  if (i && !INDICES.includes(i)) die(`Unknown index "${i}". Use one of: ${INDICES.join(", ")}.`);
};
const bps = (a: number, b: number) => Math.round((a - b) * 100);

const STALE_AFTER_HOURS = 48;
/* Returns null when the timestamp cannot be parsed, which must be treated as
   unusable rather than as fresh. A NaN comparison is false, so an unparsed
   timestamp would otherwise read as not stale. */
const staleHours = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 36e5 : null;
};

const meta = (d: Latest) => {
  const age = staleHours(d.fixing);
  return {
    fixing: d.fixing,
    methodologyVersion: d.methodologyVersion,
    basis: d.basis,
    staleHours: age === null ? null : Number(age.toFixed(1)),
    stale: age === null ? true : age > STALE_AFTER_HOURS,
    staleNote: age === null
      ? "The fixing timestamp could not be parsed. Treat this data as unusable."
      : age > STALE_AFTER_HOURS
        ? `The last fixing is ${age.toFixed(1)} hours old. Rates may have moved.`
        : undefined,
    methodologyNote: "SBOR is young: the series began 2026-09-01 and the methodology has been revised as gaps were found. Every fixing records the version that produced it, and changes are published as documented steps rather than smoothed over. Read methodologyVersion before comparing fixings across dates.",
    source: `${BASE}/api/v1/latest.json`
  };
};

/* Anything that produces a verdict an agent may act on must refuse to do so on
   data it cannot stand behind. Reporting commands may still return with a
   warning; compare may not. */
function requireFresh(d: Latest){
  const age = staleHours(d.fixing);
  if (age === null)
    die(`The fixing timestamp "${d.fixing}" could not be parsed, so the age of this data is unknown. Refusing to return a verdict. Fall back to your own logic.`);
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

const absent = (label: string, d: Latest) => ({
  index: label,
  published: false,
  reason: "The market could not be read, so SBOR omits the index rather than publishing a figure that is not real. Treat this as unknown, not as zero.",
  publishedToday: Object.keys(d.indices),
  ...meta(d)
});

const program = new Command();
program.name("sbor").description("The benchmark lending rate for Stacks");

program.command("rate")
  .description("Current fixing, or the fixing for a past date")
  .option("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
  .option("--date <YYYY-MM-DD>", "a past date. Omit for the current fixing.")
  .action(async o => {
    checkIndex(o.index);
    if (o.date && !/^\d{4}-\d{2}-\d{2}$/.test(o.date))
      die(`--date must be YYYY-MM-DD, got "${o.date}".`);
    /* The archive does not go back to the first fixing. Point the caller at the
       index rather than letting them guess and get a 404. */
    if (o.date && o.date < "2026-09-03")
      die(`The daily archive starts 2026-09-03. For what is available, read ${BASE}/api/v1/archive-index.json.`);
    const d = o.date
      ? await get<Latest>(`/api/v1/archive/${o.date}.json`)
      : await get<Latest>("/api/v1/latest.json");
    if (o.index) {
      const ix = d.indices[o.index];
      return out(ix ? { ...summarise(ix), ...meta(d) } : absent(o.index, d));
    }
    const missing = INDICES.filter(l => !d.indices[l]);
    out({
      indices: Object.values(d.indices).map(summarise),
      notPublished: missing.length ? missing.map(l => ({
        index: l,
        reason: "Market could not be read. Omitted rather than estimated. Treat as unknown, not zero."
      })) : undefined,
      poxReference: d.poxReference ? {
        ...d.poxReference,
        warning: "A staking yield on a locked position, not a lending rate. Never compare it with a borrow or supply rate."
      } : undefined,
      ...meta(d)
    });
  });

program.command("compare")
  .description("Is a rate you have been offered above or below the market")
  .requiredOption("--rate <number>", "the rate offered, as a percentage. 4.2 means 4.2%.")
  .requiredOption("--side <side>", "borrow | supply")
  .requiredOption("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
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
    if (rate <= 0 || rate > 100)
      die(`--rate must be a percentage between 0 and 100, got ${rate}. ` +
          `4.2% is "--rate 4.2", not 0.042 and not 420.`);

    /* A fraction passed as a percentage cannot be detected with certainty,
       because rates this low genuinely occur: stSTX supply on Zest was 0.09%
       today. Rejecting everything below half a percent would refuse real
       questions. So it is accepted and flagged, loudly enough that an agent
       reading either the verdict or the plain sentence cannot miss it. */
    const looksLikeFraction = rate < 0.5;

    const d = await get<Latest>("/api/v1/latest.json");
    requireFresh(d);

    const ix = d.indices[o.index];
    if (!ix)
      die(`${o.index} is not published in the current fixing, so there is no benchmark to compare against. ` +
          `When a market cannot be read, SBOR omits the index rather than publishing a figure that is not real. ` +
          `Treat this as unknown, not as zero. Published today: ${Object.keys(d.indices).join(", ")}.`);

    const side = o.side as "borrow" | "supply";
    const bench = ix[side];
    if (typeof bench !== "number" || !Number.isFinite(bench))
      die(`${o.index} has no published ${side} rate in the current fixing, so there is nothing to compare against. Treat this as unknown, not as zero.`);

    const diff = bps(rate, bench);
    if (!Number.isFinite(diff))
      die(`Could not compute a difference from offered ${rate} against benchmark ${bench}. Refusing to return a verdict.`);

    const worse = side === "borrow" ? diff > 0 : diff < 0;
    const best = [...ix.markets]
      .filter(m => typeof m[side] === "number" && Number.isFinite(m[side]))
      .sort((a, b) => side === "borrow" ? a.borrow - b.borrow : b.supply - a.supply)[0];

    out({
      index: ix.label,
      side,
      offered: rate,
      benchmark: bench,
      differenceBps: diff,
      verdict: Math.abs(diff) < 1 ? "at market" : worse ? "worse than market" : "better than market",
      ...(looksLikeFraction && {
        unitsWarning: `--rate was given as ${rate}, which is ${rate}%, not ${rate * 100}%. Rates this low do occur, so this has been treated as ${rate}% and answered. If you meant ${rate * 100}%, pass --rate ${rate * 100} and read the verdict again. Do not act on this result until you have checked which you meant.`
      }),
      plain: (looksLikeFraction ? `Check units first: this was read as ${rate}%, not ${rate * 100}%. ` : "") + (Math.abs(diff) < 1
        ? `At the market.`
        : side === "borrow"
          ? `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be paying ${diff > 0 ? "more" : "less"} than the benchmark.`
          : `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be earning ${diff > 0 ? "more" : "less"} than the benchmark.`),
      best: best ? {
        venue: best.venue, asset: best.asset, rate: best[side],
        utilization: best.utilization ?? null,
        capacityNote: best.utilization == null ? null
          : best.utilization >= 90 ? "Above 90% utilised. The rate may not be drawable and withdrawals may be constrained."
          : best.utilization <= 25 ? "Low utilisation, so there is unused capacity behind this rate."
          : null
      } : null,
      venues: ix.venues,
      venueCount: ix.venues.length,
      largestConstituentWeight: ix.largestConstituentWeight,
      concentrationNote: ix.venues.length === 1
        ? "One venue. This is a reading of that venue, not a market average, whatever the constituent weights are."
        : undefined,
      ...meta(d)
    });
  });

program.command("markets")
  .description("Venues behind a rate, with utilisation and depth")
  .option("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
  .action(async o => {
    checkIndex(o.index);
    const d = await get<Latest>("/api/v1/latest.json");
    const entries = o.index
      ? (d.indices[o.index] ? [d.indices[o.index]] : [])
      : Object.values(d.indices);
    if (!entries.length) return out(absent(o.index, d));
    out({
      markets: entries.flatMap(ix => ix.markets.map(m => ({
        index: ix.label, venue: m.venue, asset: m.asset,
        borrow: m.borrow, supply: m.supply,
        utilization: m.utilization ?? null,
        protocolYield: m.protocolYield ?? null,
        protocolYieldSource: m.protocolYieldSource ?? null,
        depthUsd: m.depthUsd, weight: m.weight
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
    checkIndex(o.index);
    const days = Number(o.days);
    if (!Number.isFinite(days) || days < 1) die(`--days must be a positive number.`);
    const h = await get<Record<string, any>[]>("/api/v1/history.json");
    const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const rows = h.filter(r => r.date >= cutoff && r[o.index]);
    if (!rows.length) return out({ index: o.index, days, fixings: [], note: `No fixings for ${o.index} in the last ${days} days.` });

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
      note: "Withdrawn fixings stay in the record rather than being deleted, and are excluded from every mean. A change in methodologyVersion means the basis changed.",
      source: `${BASE}/api/v1/history.json`
    });
  });

program.command("chains")
  .description("The same asset classes on other chains, and on the US repo market")
  .option("--index <index>", "only markets comparable to this index")
  .action(async o => {
    checkIndex(o.index);
    const d = await get<Latest>("/api/v1/latest.json");
    const all = d.externalReference?.markets ?? [];
    const markets = o.index ? all.filter((m: any) => m.comparableTo === o.index) : all;
    const sofr = d.context?.sofr;

    out({
      stacks: Object.values(d.indices)
        .filter(ix => !o.index || ix.label === o.index)
        .map(ix => ({ index: ix.label, borrow: ix.borrow, supply: ix.supply })),
      onChain: markets,
      chainsCovered: [...new Set(markets.map((m: any) => String(m.venue).split(", ").pop()))],
      /* SOFR is the cost of a dollar secured by US government debt. It is the
         benchmark SBOR is modelled on, and the only meaningful comparison for a
         dollar rate outside crypto entirely. */
      offChain: sofr && (!o.index || o.index === "SBOR-USD") ? {
        name: "SOFR",
        rate: sofr.rate,
        effectiveDate: sofr.effectiveDate,
        average30day: sofr.average30day ?? null,
        average90day: sofr.average90day ?? null,
        average180day: sofr.average180day ?? null,
        what: "The overnight cost of a dollar in the US repo market, secured by US government debt. Published by the Federal Reserve Bank of New York for the previous business day, so it does not move at weekends.",
        howToRead: d.indices["SBOR-USD"]
          ? `A dollar secured by bitcoin on Stacks costs ${d.indices["SBOR-USD"].borrow.toFixed(2)}% to borrow, against ${sofr.rate.toFixed(2)}% secured by Treasuries. Bitcoin is the riskier collateral, so a cheaper rate here reflects low utilisation rather than lower risk.`
          : null
      } : undefined,
      note: d.externalReference?.note,
      warning: "Context only. On-chain comparisons are never constituents of an SBOR index, come from DefiLlama rather than contract state, and are not on the same basis as the SBOR indices. One market is selected per chain: a venue publishing a borrow rate and utilisation is preferred over one that does not, and depth decides between those that publish both.",
      ...meta(d)
    });
  });

program.command("inversions")
  .description("Cross-venue inversions, checked hourly")
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
    const d = await get<Latest>("/api/v1/latest.json");
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
    let r: Response;
    try { r = await fetch(`${BASE}/llms.txt`, { headers: { "user-agent": UA } }); }
    catch (e) { return die(`SBOR is unreachable: ${(e as Error).message}`); }
    if (!r.ok) return die(`SBOR responded ${r.status} for /llms.txt`);
    out({ methodology: await r.text(), source: `${BASE}/llms.txt` });
  });

program.parseAsync(process.argv).catch(e => die((e as Error).message));
