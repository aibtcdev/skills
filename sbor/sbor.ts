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
const UA = "aibtc-skills-sbor/1.0";

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
  externalReference?: { note: string; markets: unknown[] };
  notes: string[];
};

const out = (o: unknown) => { console.log(JSON.stringify(o, null, 2)); };
const die = (msg: string) => { console.log(JSON.stringify({ error: msg })); process.exit(1); };

async function get<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, { headers: { accept: "application/json", "user-agent": UA } });
  } catch (e) {
    die(`SBOR is unreachable at ${BASE}${path}: ${(e as Error).message}. Do not substitute an estimate.`);
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
const staleHours = (iso: string) => (Date.now() - Date.parse(iso)) / 36e5;

const meta = (d: Latest) => ({
  fixing: d.fixing,
  methodologyVersion: d.methodologyVersion,
  basis: d.basis,
  staleHours: Number(staleHours(d.fixing).toFixed(1)),
  stale: staleHours(d.fixing) > 48,
  source: `${BASE}/api/v1/latest.json`
});

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
  .description("Current fixing, every currency or one")
  .option("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
  .action(async o => {
    checkIndex(o.index);
    const d = await get<Latest>("/api/v1/latest.json");
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
  .requiredOption("--rate <number>", "the rate offered, as a percentage")
  .requiredOption("--side <side>", "borrow | supply")
  .requiredOption("--index <index>", "SBOR-USD | SBOR-BTC | SBOR-STX")
  .action(async o => {
    checkIndex(o.index);
    if (!["borrow", "supply"].includes(o.side)) die(`--side must be borrow or supply.`);
    const rate = Number(o.rate);
    if (!Number.isFinite(rate)) die(`--rate must be a number, got "${o.rate}".`);

    const d = await get<Latest>("/api/v1/latest.json");
    const ix = d.indices[o.index];
    if (!ix) return out(absent(o.index, d));

    const side = o.side as "borrow" | "supply";
    const bench = ix[side];
    const diff = bps(rate, bench);
    const worse = side === "borrow" ? diff > 0 : diff < 0;

    const best = [...ix.markets].sort((a, b) =>
      side === "borrow" ? a.borrow - b.borrow : b.supply - a.supply)[0];

    out({
      index: ix.label,
      side,
      offered: rate,
      benchmark: bench,
      differenceBps: diff,
      verdict: Math.abs(diff) < 1 ? "at market" : worse ? "worse than market" : "better than market",
      plain: Math.abs(diff) < 1
        ? `At the market.`
        : side === "borrow"
          ? `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be paying ${diff > 0 ? "more" : "less"} than the benchmark.`
          : `${Math.abs(diff)} bps ${diff > 0 ? "above" : "below"} the market. You would be earning ${diff > 0 ? "more" : "less"} than the benchmark.`,
      best: {
        venue: best.venue, asset: best.asset, rate: best[side],
        utilization: best.utilization ?? null,
        capacityNote: best.utilization == null ? null
          : best.utilization >= 90 ? "Above 90% utilised. The rate may not be drawable and withdrawals may be constrained."
          : best.utilization <= 25 ? "Low utilisation, so there is unused capacity behind this rate."
          : null
      },
      venues: ix.venues,
      largestConstituentWeight: ix.largestConstituentWeight,
      concentrationNote: ix.venues.length === 1
        ? "One venue. This is a reading of that venue, not a market average."
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
    out({
      index: o.index, days, count: rows.length,
      fixings: rows.map(r => r[o.index].withdrawn
        ? { date: r.date, withdrawn: true, reason: r[o.index].reason }
        : { date: r.date, borrow: r[o.index].borrow, supply: r[o.index].supply,
            venues: r[o.index].venues ?? null,
            methodologyVersion: r.methodologyVersion ?? null }),
      meanBorrow: valid.length ? Number((valid.reduce((a, r) => a + r[o.index].borrow, 0) / valid.length).toFixed(2)) : null,
      withdrawnCount: rows.length - valid.length,
      note: "Withdrawn fixings stay in the record rather than being deleted, and are excluded from the mean. A change in methodologyVersion means the basis changed; compare across one with care.",
      source: `${BASE}/api/v1/history.json`
    });
  });

program.command("chains")
  .description("Lending markets off Stacks, for comparison only")
  .action(async () => {
    const d = await get<Latest>("/api/v1/latest.json");
    if (!d.externalReference) return out({ external: [], note: "No external reference in the current fixing.", ...meta(d) });
    out({
      stacks: Object.values(d.indices).map(ix => ({ index: ix.label, borrow: ix.borrow, supply: ix.supply })),
      external: d.externalReference.markets,
      note: d.externalReference.note,
      warning: "Context only. These are never constituents of an SBOR index, come from DefiLlama rather than contract state, and are not on the same basis as the SBOR indices.",
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
