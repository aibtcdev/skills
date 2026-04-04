#!/usr/bin/env bun
/**
 * HODLMM Arb Scanner skill CLI
 *
 * Cross-pool efficiency detection for Bitflow HODLMM.
 * When the same token pair trades across multiple HODLMM pools with different
 * bin step configurations, execution quality (fees, depth, volume) varies.
 * This skill identifies those structural differences and recommends which
 * pool to route through for swaps or LP.
 *
 * Self-contained: uses Bitflow APIs directly.
 * HODLMM bonus eligible: Yes — analyses cross-pool HODLMM structure.
 *
 * Usage: bun run hodlmm-arb-scanner/hodlmm-arb-scanner.ts <subcommand>
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://bff.bitflowapis.finance";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HodlmmRichPool {
  poolId: string;
  tokens?: {
    tokenX?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
    tokenY?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
  };
  tvlUsd?: number;
  tvlBtc?: number;
  volumeUsd1d?: number;
  volumeUsd7d?: number;
  feesUsd1d?: number;
  feesUsd7d?: number;
  apr?: number;
  apr24h?: number;
  binStep?: string;
  baseFee?: number;
  poolComposition?: {
    tokenX?: { liquidity?: number; liquidityUsd?: number; percentage?: number };
    tokenY?: { liquidity?: number; liquidityUsd?: number; percentage?: number };
  };
}

interface HodlmmPoolListItem {
  pool_id: string;
  token_x: string;
  token_y: string;
  active_bin: number;
  active?: boolean;
  bin_step?: number;
  x_total_fee_bps?: string;
  y_total_fee_bps?: string;
}

interface PoolProfile {
  poolId: string;
  pair: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  binStep: number;
  totalFeeBps: number;
  effectiveFeePct: number;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  apr: number;
  apr24h: number;
  compositionPctX: number;
  compositionPctY: number;
  compositionBalance: number;
  routingScore: number;
}

interface PairComparison {
  pair: string;
  displayPair: string;
  poolCount: number;
  pools: PoolProfile[];
  bestForSwap: string;
  bestForLp: string;
  edgeSummary: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText} (${url})`);
  return res.json() as Promise<T>;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function getPoolList(): Promise<HodlmmPoolListItem[]> {
  const response = await fetchJson<{ pools?: HodlmmPoolListItem[] }>(
    `${BITFLOW_API}/api/quotes/v1/pools`
  );
  return Array.isArray(response?.pools) ? response.pools : [];
}

async function getRichPool(poolId: string): Promise<HodlmmRichPool> {
  return fetchJson<HodlmmRichPool>(`${BITFLOW_API}/api/app/v1/pools/${poolId}`);
}

// ---------------------------------------------------------------------------
// Pool profiling
// ---------------------------------------------------------------------------

/**
 * Routing score: composite metric for swap execution quality.
 * Higher = better pool to route swaps through.
 *
 * Factors (weighted):
 * - TVL depth (40%): deeper pools = less slippage
 * - Volume activity (30%): active pools = tighter spreads from arb bots
 * - Fee efficiency (20%): lower fees = better execution
 * - Composition balance (10%): balanced pools = two-sided liquidity
 */
function computeRoutingScore(pool: HodlmmRichPool, totalFeeBps: number): number {
  const tvl = pool.tvlUsd ?? 0;
  const volume = pool.volumeUsd1d ?? 0;
  const feePct = totalFeeBps / 100;
  const pctX = pool.poolComposition?.tokenX?.percentage ?? 50;
  const balance = 1 - Math.abs(pctX - 50) / 50; // 1.0 = perfectly balanced, 0.0 = single-sided

  // Normalize each factor to 0-100 range
  const tvlScore = Math.min(tvl / 10000, 100); // $1M TVL = score 100
  const volumeScore = Math.min(volume / 1000, 100); // $100K daily volume = score 100
  const feeScore = Math.max(100 - feePct * 100, 0); // 0% fee = 100, 1% fee = 0
  const balanceScore = balance * 100;

  return Number(
    (tvlScore * 0.4 + volumeScore * 0.3 + feeScore * 0.2 + balanceScore * 0.1).toFixed(2)
  );
}

function buildPoolProfile(
  listItem: HodlmmPoolListItem,
  richPool: HodlmmRichPool
): PoolProfile {
  const totalFeeBps = Number(listItem.x_total_fee_bps ?? 0);
  const binStep = Number(richPool.binStep ?? listItem.bin_step ?? 10);

  const tokenXContract = listItem.token_x;
  const tokenYContract = listItem.token_y;
  const pairContracts = [tokenXContract, tokenYContract].sort();
  const pair = pairContracts.join(" / ");

  const pctX = richPool.poolComposition?.tokenX?.percentage ?? 50;
  const pctY = richPool.poolComposition?.tokenY?.percentage ?? 50;

  return {
    poolId: listItem.pool_id,
    pair,
    tokenXSymbol: richPool.tokens?.tokenX?.symbol ?? tokenXContract.split(".").pop() ?? "?",
    tokenYSymbol: richPool.tokens?.tokenY?.symbol ?? tokenYContract.split(".").pop() ?? "?",
    binStep,
    totalFeeBps,
    effectiveFeePct: Number((totalFeeBps / 100).toFixed(2)),
    tvlUsd: richPool.tvlUsd ?? 0,
    volumeUsd1d: richPool.volumeUsd1d ?? 0,
    volumeUsd7d: richPool.volumeUsd7d ?? 0,
    feesUsd1d: richPool.feesUsd1d ?? 0,
    apr: richPool.apr ?? 0,
    apr24h: richPool.apr24h ?? 0,
    compositionPctX: pctX,
    compositionPctY: pctY,
    compositionBalance: Number((1 - Math.abs(pctX - 50) / 50).toFixed(4)),
    routingScore: computeRoutingScore(richPool, totalFeeBps),
  };
}

// ---------------------------------------------------------------------------
// Cross-pool comparison
// ---------------------------------------------------------------------------

function buildPairComparison(profiles: PoolProfile[]): PairComparison {
  const sorted = [...profiles].sort((a, b) => b.routingScore - a.routingScore);
  const first = sorted[0];
  const displayPair = `${first.tokenXSymbol}/${first.tokenYSymbol}`;

  // Best for swap: highest routing score (depth + volume + low fees)
  const bestSwap = sorted[0];

  // Best for LP: highest APR among pools with meaningful TVL
  const lpCandidates = sorted.filter((p) => p.tvlUsd >= 50);
  const bestLp = lpCandidates.length > 0
    ? [...lpCandidates].sort((a, b) => b.apr - a.apr)[0]
    : sorted[0];

  // Edge summary
  const edges: string[] = [];
  if (sorted.length >= 2) {
    const [top, second] = sorted;
    if (top.tvlUsd > second.tvlUsd * 5) {
      edges.push(`${top.poolId} has ${(top.tvlUsd / (second.tvlUsd || 1)).toFixed(0)}x more TVL than ${second.poolId}`);
    }
    if (top.totalFeeBps !== second.totalFeeBps) {
      edges.push(`Fee difference: ${top.poolId} charges ${top.effectiveFeePct}% vs ${second.poolId} at ${second.effectiveFeePct}%`);
    }
    if (top.binStep !== second.binStep) {
      edges.push(`Bin granularity: ${top.poolId} uses step ${top.binStep} vs ${second.poolId} step ${second.binStep} (tighter step = finer price resolution)`);
    }
    if (second.volumeUsd1d === 0 && top.volumeUsd1d > 0) {
      edges.push(`${second.poolId} has zero volume — effectively inactive`);
    }
  }

  return {
    pair: first.pair,
    displayPair,
    poolCount: profiles.length,
    pools: sorted,
    bestForSwap: bestSwap.poolId,
    bestForLp: bestLp.poolId,
    edgeSummary: edges.length > 0
      ? edges.join(". ") + "."
      : "Pools are structurally similar. Routing preference is marginal.",
  };
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

interface ScanResult {
  network: string;
  totalPools: number;
  multiPoolPairs: number;
  comparisons: PairComparison[];
  summary: string;
  timestamp: string;
}

async function runScan(): Promise<ScanResult> {
  const poolList = await getPoolList();
  const activeList = poolList.filter((p) => p.active !== false);

  // Fetch rich data for all pools
  const richResults = await Promise.all(
    activeList.map(async (item) => {
      try {
        const rich = await getRichPool(item.pool_id);
        return { item, rich };
      } catch {
        return null;
      }
    })
  );

  const validResults = richResults.filter(
    (r): r is { item: HodlmmPoolListItem; rich: HodlmmRichPool } => r !== null
  );

  // Build profiles and group by pair
  const profiles = validResults.map((r) => buildPoolProfile(r.item, r.rich));
  const pairGroups: Record<string, PoolProfile[]> = {};
  for (const p of profiles) {
    if (!pairGroups[p.pair]) pairGroups[p.pair] = [];
    pairGroups[p.pair].push(p);
  }

  // Only compare pairs with 2+ pools
  const multiPoolEntries = Object.entries(pairGroups).filter(
    ([, pools]) => pools.length >= 2
  );

  const comparisons = multiPoolEntries.map(([, pools]) =>
    buildPairComparison(pools)
  );

  const summary =
    `Scanned ${profiles.length} active HODLMM pools. ` +
    `Found ${comparisons.length} token pair(s) trading across multiple pools. ` +
    comparisons
      .map(
        (c) =>
          `${c.displayPair}: ${c.poolCount} pools, best swap routing → ${c.bestForSwap}, best LP → ${c.bestForLp}`
      )
      .join(". ") +
    ".";

  return {
    network: NETWORK,
    totalPools: profiles.length,
    multiPoolPairs: comparisons.length,
    comparisons,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-arb-scanner")
  .description(
    "Cross-pool HODLMM efficiency scanner: when the same pair trades in multiple pools " +
    "with different bin configurations, identifies which pool offers better swap execution " +
    "and which offers better LP returns. Read-only, no wallet required."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify API connectivity and multi-pool pair availability.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
      };

      try {
        const response = await fetchJson<{ pools?: HodlmmPoolListItem[] }>(
          `${BITFLOW_API}/api/quotes/v1/pools`
        );
        const pools = response?.pools ?? [];
        const pairMap: Record<string, string[]> = {};
        for (const p of pools) {
          const key = [p.token_x, p.token_y].sort().join("|");
          if (!pairMap[key]) pairMap[key] = [];
          pairMap[key].push(p.pool_id);
        }
        const multiPools = Object.values(pairMap).filter((ids) => ids.length >= 2);
        checks.quotesApi = { status: "ok", poolCount: pools.length };
        checks.multiPoolPairs = {
          count: multiPools.length,
          pools: multiPools,
        };
      } catch (e) {
        checks.quotesApi = { status: "error", error: String(e) };
      }

      try {
        const pool = await getRichPool("dlmm_1");
        checks.appApi = {
          status: "ok",
          hasVolume: pool.volumeUsd1d !== undefined,
          hasTvl: pool.tvlUsd !== undefined,
          hasApr: pool.apr !== undefined,
        };
      } catch (e) {
        checks.appApi = { status: "error", error: String(e) };
      }

      const allOk =
        (checks.quotesApi as Record<string, unknown>).status === "ok" &&
        (checks.appApi as Record<string, unknown>).status === "ok";

      printJson({ ...checks, healthy: allOk, timestamp: new Date().toISOString() });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description(
    "Full cross-pool scan: compare all multi-pool pairs by routing score, fees, depth, and volume."
  )
  .action(async () => {
    try {
      printJson(await runScan());
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// pair-detail
// ---------------------------------------------------------------------------
program
  .command("pair-detail")
  .description("Deep comparison of a specific token pair across all its HODLMM pools.")
  .requiredOption("--pair <pair>", "Token pair symbols (e.g. 'sBTC/USDCx')")
  .action(async (opts: { pair: string }) => {
    try {
      const result = await runScan();
      const inputPair = opts.pair.toLowerCase().split("/").sort().join("/");

      const match = result.comparisons.find((c) => {
        const norm = c.displayPair.toLowerCase().split("/").sort().join("/");
        return norm === inputPair;
      });

      if (!match) {
        const available = result.comparisons.map((c) => c.displayPair).join(", ");
        throw new Error(
          `Pair '${opts.pair}' not found in multi-pool pairs. Available: ${available || "none"}`
        );
      }

      printJson({
        network: NETWORK,
        ...match,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------
program
  .command("route")
  .description("Quick answer: which pool should I use for a swap on this pair?")
  .requiredOption("--pair <pair>", "Token pair symbols (e.g. 'sBTC/USDCx')")
  .action(async (opts: { pair: string }) => {
    try {
      const result = await runScan();
      const inputPair = opts.pair.toLowerCase().split("/").sort().join("/");

      const match = result.comparisons.find((c) => {
        const norm = c.displayPair.toLowerCase().split("/").sort().join("/");
        return norm === inputPair;
      });

      if (!match) {
        const available = result.comparisons.map((c) => c.displayPair).join(", ");
        throw new Error(
          `Pair '${opts.pair}' not found in multi-pool pairs. Available: ${available || "none"}`
        );
      }

      const best = match.pools[0]; // Already sorted by routing score
      const alt = match.pools.length > 1 ? match.pools[1] : null;

      printJson({
        network: NETWORK,
        pair: match.displayPair,
        recommendation: {
          swapPool: match.bestForSwap,
          lpPool: match.bestForLp,
        },
        bestPool: {
          poolId: best.poolId,
          routingScore: best.routingScore,
          tvlUsd: best.tvlUsd,
          effectiveFeePct: best.effectiveFeePct,
          binStep: best.binStep,
          volumeUsd1d: best.volumeUsd1d,
        },
        alternative: alt
          ? {
              poolId: alt.poolId,
              routingScore: alt.routingScore,
              tvlUsd: alt.tvlUsd,
              effectiveFeePct: alt.effectiveFeePct,
              binStep: alt.binStep,
              volumeUsd1d: alt.volumeUsd1d,
            }
          : null,
        edge: match.edgeSummary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
