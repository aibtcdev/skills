#!/usr/bin/env bun
/**
 * HODLMM Yield Compare skill CLI
 *
 * Capital allocation intelligence for Stacks DeFi agents.
 * Answers: "Should I LP in a HODLMM pool, or lend on Zest, or stack STX?"
 *
 * Fetches real APR, volume, fees, and TVL from Bitflow HODLMM pools via the
 * app/v1 API, reads Zest Protocol lending rates from on-chain contract state,
 * and ranks all yield sources by both raw APR and risk-adjusted return.
 *
 * Self-contained: uses Bitflow and Hiro APIs directly.
 * HODLMM bonus eligible: Yes — directly analyses and ranks HODLMM pools.
 *
 * Usage: bun run hodlmm-yield-compare/hodlmm-yield-compare.ts <subcommand>
 */
import { Command } from "commander";
import {
  serializeCV,
  contractPrincipalCV,
  hexToCV,
  cvToValue,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://bff.bitflowapis.finance";
const HIRO_API = "https://api.mainnet.hiro.so";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// Zest V1 contracts (active on mainnet)
const ZEST_POOL_CONTRACT = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N";
const ZEST_POOL_NAME = "pool-borrow-v2-3";
const SBTC_TOKEN_ADDR = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_TOKEN_NAME = "sbtc-token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rich pool data from the Bitflow app/v1 endpoint */
interface HodlmmRichPool {
  poolId: string;
  poolContract?: string;
  poolStatus?: boolean;
  tokens?: {
    tokenX?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
    tokenY?: { contract?: string; symbol?: string; decimals?: number; priceUsd?: number };
  };
  tvlUsd?: number;
  tvlBtc?: number;
  volumeUsd1d?: number;
  volumeUsd7d?: number;
  volumeUsd30d?: number;
  feesUsd1d?: number;
  feesUsd7d?: number;
  feesUsd30d?: number;
  apr?: number;
  apr24h?: number;
  binStep?: string;
  baseFee?: number;
  poolComposition?: {
    tokenX?: { liquidity?: number; liquidityUsd?: number; percentage?: number };
    tokenY?: { liquidity?: number; liquidityUsd?: number; percentage?: number };
  };
  sbtcIncentives?: boolean;
}

/** Lightweight pool listing from quotes/v1 */
interface HodlmmPoolListItem {
  pool_id: string;
  token_x: string;
  token_y: string;
  active_bin: number;
  active?: boolean;
  x_total_fee_bps?: string;
  y_total_fee_bps?: string;
  bin_step?: number;
  pool_name?: string;
  pool_symbol?: string;
}

interface YieldSource {
  source: string;
  protocol: string;
  asset: string;
  aprPct: number;
  dataAvailable: boolean;
  riskScore: number;
  riskLabel: "low" | "medium" | "high";
  tvlUsd: number;
  details: Record<string, unknown>;
}

/** YieldSource with risk-adjusted score promoted to a top-level typed field */
interface RankedYieldSource extends YieldSource {
  riskAdjustedScore: number;
}

interface ComparisonResult {
  network: string;
  hodlmmPools: YieldSource[];
  alternatives: YieldSource[];
  ranked: RankedYieldSource[];
  bestOverall: YieldSource;
  bestRiskAdjusted: RankedYieldSource;
  summary: string;
  timestamp: string;
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

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText} (${url})`);
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

/**
 * Risk-adjusted score: APR / risk.
 * Higher is better. Risk floor of 5 prevents division explosion.
 */
function riskAdjustedScore(apr: number, riskScore: number): number {
  return Number((apr / Math.max(riskScore, 5)).toFixed(4));
}

function classifyRisk(score: number): "low" | "medium" | "high" {
  if (score <= 25) return "low";
  if (score <= 55) return "medium";
  return "high";
}

/**
 * Dynamic risk score for HODLMM pools based on observable pool characteristics.
 * Base: 35 (concentrated LP inherent IL risk).
 * Adjustments: low TVL (+10), high composition imbalance (+5-10), stablecoin pair (-10).
 */
function computeHodlmmRisk(pool: HodlmmRichPool): number {
  let risk = 35;

  // Low TVL = higher risk (thin liquidity, slippage)
  if ((pool.tvlUsd ?? 0) < 1000) risk += 10;
  else if ((pool.tvlUsd ?? 0) < 10000) risk += 5;

  // Composition imbalance
  const pctX = pool.poolComposition?.tokenX?.percentage ?? 50;
  const imbalance = Math.abs(pctX - 50);
  if (imbalance > 30) risk += 10;
  else if (imbalance > 15) risk += 5;

  // Stablecoin pair discount (both tokens are stablecoins = lower IL risk)
  const xSym = (pool.tokens?.tokenX?.symbol ?? "").toLowerCase();
  const ySym = (pool.tokens?.tokenY?.symbol ?? "").toLowerCase();
  const stables = ["usdc", "usdcx", "usdt", "usdh", "aeusdc", "dai"];
  if (stables.some((s) => xSym.includes(s)) && stables.some((s) => ySym.includes(s))) {
    risk -= 10;
  }

  return Math.max(10, Math.min(risk, 80));
}

// ---------------------------------------------------------------------------
// HODLMM pool data (real APR from app/v1)
// ---------------------------------------------------------------------------

async function getHodlmmPoolIds(): Promise<string[]> {
  const response = await fetchJson<{ pools?: HodlmmPoolListItem[] }>(
    `${BITFLOW_API}/api/quotes/v1/pools`
  );
  const pools = Array.isArray(response?.pools) ? response.pools : [];
  return pools.filter((p) => p.active !== false).map((p) => p.pool_id);
}

async function getHodlmmRichPool(poolId: string): Promise<HodlmmRichPool> {
  return fetchJson<HodlmmRichPool>(`${BITFLOW_API}/api/app/v1/pools/${poolId}`);
}

function hodlmmPoolToYieldSource(pool: HodlmmRichPool): YieldSource {
  const xSym = pool.tokens?.tokenX?.symbol ?? "?";
  const ySym = pool.tokens?.tokenY?.symbol ?? "?";
  const riskScore = computeHodlmmRisk(pool);

  return {
    source: `hodlmm-${pool.poolId}`,
    protocol: "Bitflow HODLMM",
    asset: `${xSym}/${ySym}`,
    aprPct: pool.apr ?? 0,
    dataAvailable: pool.apr !== undefined,
    riskScore,
    riskLabel: classifyRisk(riskScore),
    tvlUsd: pool.tvlUsd ?? 0,
    details: {
      poolId: pool.poolId,
      apr24h: pool.apr24h ?? 0,
      tvlBtc: pool.tvlBtc ?? 0,
      volumeUsd1d: pool.volumeUsd1d ?? 0,
      volumeUsd7d: pool.volumeUsd7d ?? 0,
      feesUsd1d: pool.feesUsd1d ?? 0,
      feesUsd7d: pool.feesUsd7d ?? 0,
      binStep: pool.binStep ?? "unknown",
      baseFee: pool.baseFee ?? 0,
      compositionPctX: pool.poolComposition?.tokenX?.percentage ?? 0,
      compositionPctY: pool.poolComposition?.tokenY?.percentage ?? 0,
      sbtcIncentives: pool.sbtcIncentives ?? false,
      dataSource: "Bitflow app/v1 API (real APR, volume, fees)",
    },
  };
}

// ---------------------------------------------------------------------------
// Alternative yield sources
// ---------------------------------------------------------------------------

async function getZestLendingApy(): Promise<YieldSource> {
  const source: YieldSource = {
    source: "zest-lending",
    protocol: "Zest Protocol",
    asset: "sBTC",
    aprPct: 0,
    dataAvailable: false,
    riskScore: 20,
    riskLabel: "low",
    tvlUsd: 0,
    details: {},
  };

  try {
    // serializeCV returns a hex string in current @stacks/transactions
    const principalArg = "0x" + serializeCV(
      contractPrincipalCV(SBTC_TOKEN_ADDR, SBTC_TOKEN_NAME)
    );

    const res = await postJson<{ okay: boolean; result: string }>(
      `${HIRO_API}/v2/contracts/call-read/${ZEST_POOL_CONTRACT}/${ZEST_POOL_NAME}/get-reserve-state`,
      { sender: "SP000000000000000000002Q6VF78", arguments: [principalArg] }
    );

    if (res.okay) {
      const raw = res.result.startsWith("0x") ? res.result.slice(2) : res.result;
      const decoded = cvToValue(hexToCV(raw), true) as Record<string, unknown>;

      // cvToValue with true returns nested { type, value } structure
      const rateEntry = decoded.value
        ? (decoded.value as Record<string, Record<string, unknown>>)["current-liquidity-rate"]
        : undefined;
      const rateValue = rateEntry?.value;

      if (rateValue !== undefined && rateValue !== null) {
        const rate = Number(rateValue);
        // Zest uses ray-like units but scaled differently on Stacks.
        // current-liquidity-rate of ~162937 observed = low utilization.
        // Variable borrow rate ~5307021. These are annual rates in 1e8 fixed-point.
        if (rate > 0) {
          source.aprPct = Number((rate / 1e6).toFixed(2));
        }
      }

      // Extract total borrows for context
      const borrowsVar = decoded.value
        ? (decoded.value as Record<string, Record<string, unknown>>)["total-borrows-variable"]
        : undefined;
      const borrowsStable = decoded.value
        ? (decoded.value as Record<string, Record<string, unknown>>)["total-borrows-stable"]
        : undefined;

      source.details.totalBorrowsVariable = String(borrowsVar?.value ?? 0);
      source.details.totalBorrowsStable = String(borrowsStable?.value ?? 0);
      source.details.rawLiquidityRate = String(rateValue ?? 0);
      source.details.dataSource = "on-chain read-only call (Zest pool-borrow-v2-3)";
      source.dataAvailable = true;
    }
  } catch (e) {
    source.details.error = String(e);
    source.details.dataSource = "on-chain call failed";
  }

  return source;
}

function getStackingYield(): YieldSource {
  return {
    source: "stx-stacking",
    protocol: "STX Stacking (PoX)",
    asset: "STX",
    aprPct: 8.0,
    dataAvailable: true,
    riskScore: 10,
    riskLabel: "low",
    tvlUsd: 0,
    details: {
      lockPeriod: "~2 weeks per cycle",
      note: "Yields BTC rewards. APR varies per cycle; 8% is a current-cycle estimate.",
      dataSource: "static estimate (PoX cycle rewards)",
    },
  };
}

// ---------------------------------------------------------------------------
// Core comparison logic
// ---------------------------------------------------------------------------
async function buildComparison(): Promise<ComparisonResult> {
  // Step 1: Get pool IDs and alternative yields in parallel
  const [poolIds, zest] = await Promise.all([
    getHodlmmPoolIds(),
    getZestLendingApy(),
  ]);

  const stacking = getStackingYield();

  // Step 2: Fetch rich data for each HODLMM pool
  const richPools = await Promise.all(
    poolIds.map(async (id) => {
      try {
        return await getHodlmmRichPool(id);
      } catch {
        return null;
      }
    })
  );

  // Build HODLMM yield sources from real data
  const hodlmmSources: YieldSource[] = [];
  for (const pool of richPools) {
    if (pool && pool.poolId) {
      hodlmmSources.push(hodlmmPoolToYieldSource(pool));
    }
  }

  const alternatives = [zest, stacking];

  // Rank all sources by risk-adjusted score
  const allSources = [...hodlmmSources, ...alternatives];
  const ranked: RankedYieldSource[] = allSources
    .map((s) => ({
      ...s,
      riskAdjustedScore: riskAdjustedScore(s.aprPct, s.riskScore),
    }))
    .sort((a, b) => b.riskAdjustedScore - a.riskAdjustedScore);

  const bestOverall = [...allSources].sort((a, b) => b.aprPct - a.aprPct)[0];
  const bestRiskAdjusted = ranked[0];

  // Summary
  const hodlmmCount = hodlmmSources.length;
  const activeHodlmm = hodlmmSources.filter((h) => h.aprPct > 0);
  const hodlmmBetterThanZest = hodlmmSources.filter(
    (h) => h.aprPct > zest.aprPct
  ).length;

  const summary =
    `Compared ${hodlmmCount} HODLMM pool(s) (${activeHodlmm.length} with active volume) against ${alternatives.length} alternative yield sources. ` +
    `${hodlmmBetterThanZest} HODLMM pool(s) outperform Zest lending (${zest.aprPct}% APR). ` +
    `Best overall: ${bestOverall.protocol} ${bestOverall.asset} at ${bestOverall.aprPct}% APR. ` +
    `Best risk-adjusted: ${bestRiskAdjusted.protocol} ${bestRiskAdjusted.asset} (score: ${bestRiskAdjusted.riskAdjustedScore.toFixed(2)}).`;

  return {
    network: NETWORK,
    hodlmmPools: hodlmmSources,
    alternatives,
    ranked,
    bestOverall,
    bestRiskAdjusted,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-yield-compare")
  .description(
    "Capital allocation intelligence for Stacks DeFi: compare Bitflow HODLMM pool yields " +
    "against Zest lending and STX stacking using real APR, volume, and fee data. " +
    "Ranks by raw APR and risk-adjusted return. Read-only, no wallet required."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify API connectivity and data availability.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
      };

      // Check Bitflow HODLMM quotes API
      try {
        const response = await fetchJson<{ pools?: unknown[] }>(
          `${BITFLOW_API}/api/quotes/v1/pools`
        );
        const pools = response?.pools ?? [];
        checks.bitflowQuotesApi = { status: "ok", poolCount: pools.length };
      } catch (e) {
        checks.bitflowQuotesApi = { status: "error", error: String(e) };
      }

      // Check Bitflow app/v1 API (rich pool data with APR)
      try {
        const pool = await fetchJson<HodlmmRichPool>(
          `${BITFLOW_API}/api/app/v1/pools/dlmm_1`
        );
        checks.bitflowAppApi = {
          status: "ok",
          hasApr: pool.apr !== undefined,
          hasVolume: pool.volumeUsd1d !== undefined,
          hasFees: pool.feesUsd1d !== undefined,
        };
      } catch (e) {
        checks.bitflowAppApi = { status: "error", error: String(e) };
      }

      // Check Hiro API
      try {
        const res = await fetch(`${HIRO_API}/v2/info`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        checks.hiroApi = {
          status: res.ok ? "ok" : "error",
          httpStatus: res.status,
        };
      } catch (e) {
        checks.hiroApi = { status: "error", error: String(e) };
      }

      // Check Zest contract read
      try {
        const principalArg = "0x" + serializeCV(
          contractPrincipalCV(SBTC_TOKEN_ADDR, SBTC_TOKEN_NAME)
        );
        const res = await postJson<{ okay: boolean; result: string }>(
          `${HIRO_API}/v2/contracts/call-read/${ZEST_POOL_CONTRACT}/${ZEST_POOL_NAME}/get-reserve-state`,
          { sender: "SP000000000000000000002Q6VF78", arguments: [principalArg] }
        );
        checks.zestContract = { status: res.okay ? "ok" : "error" };
      } catch (e) {
        checks.zestContract = { status: "error", error: String(e) };
      }

      const allOk =
        (checks.bitflowQuotesApi as Record<string, unknown>).status === "ok" &&
        (checks.bitflowAppApi as Record<string, unknown>).status === "ok" &&
        (checks.hiroApi as Record<string, unknown>).status === "ok";

      printJson({
        ...checks,
        healthy: allOk,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------
program
  .command("compare")
  .description(
    "Full comparison: all HODLMM pools vs alternative yields, ranked by risk-adjusted return."
  )
  .action(async () => {
    try {
      const result = await buildComparison();
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// rank
// ---------------------------------------------------------------------------
program
  .command("rank")
  .description(
    "Ranked yield table sorted by risk-adjusted score. Compact output for quick decisions."
  )
  .option("--top <n>", "Show only top N results", "10")
  .action(async (opts: { top: string }) => {
    try {
      const topN = parseInt(opts.top, 10) || 10;
      const result = await buildComparison();
      const ranked = result.ranked.slice(0, topN).map((s, i) => ({
        rank: i + 1,
        source: s.source,
        protocol: s.protocol,
        asset: s.asset,
        aprPct: s.aprPct,
        dataAvailable: s.dataAvailable,
        riskScore: s.riskScore,
        riskLabel: s.riskLabel,
        riskAdjustedScore: s.riskAdjustedScore,
        tvlUsd: s.tvlUsd,
      }));

      printJson({
        network: NETWORK,
        topN,
        ranked,
        summary: result.summary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// hodlmm-detail
// ---------------------------------------------------------------------------
program
  .command("hodlmm-detail")
  .description(
    "Deep-dive on a specific HODLMM pool: real APR, volume, fees, composition, " +
    "and head-to-head verdict against the best alternative."
  )
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_6)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [poolData, zest] = await Promise.all([
        getHodlmmRichPool(opts.poolId),
        getZestLendingApy(),
      ]);

      const stacking = getStackingYield();
      const alternatives = [zest, stacking];
      const hodlmmSource = hodlmmPoolToYieldSource(poolData);

      const bestAlt = [...alternatives].sort(
        (a, b) =>
          riskAdjustedScore(b.aprPct, b.riskScore) -
          riskAdjustedScore(a.aprPct, a.riskScore)
      )[0];

      const hodlmmRiskAdj = riskAdjustedScore(hodlmmSource.aprPct, hodlmmSource.riskScore);
      const bestAltRiskAdj = riskAdjustedScore(bestAlt.aprPct, bestAlt.riskScore);

      const verdict =
        hodlmmRiskAdj > bestAltRiskAdj
          ? `HODLMM ${opts.poolId} (${hodlmmSource.asset}) outperforms ${bestAlt.protocol} on a risk-adjusted basis (${hodlmmRiskAdj.toFixed(2)} vs ${bestAltRiskAdj.toFixed(2)}).`
          : `${bestAlt.protocol} offers better risk-adjusted yield than HODLMM ${opts.poolId} (${bestAltRiskAdj.toFixed(2)} vs ${hodlmmRiskAdj.toFixed(2)}). Consider alternatives unless you have a directional view on this pair.`;

      printJson({
        network: NETWORK,
        poolId: opts.poolId,
        pair: hodlmmSource.asset,
        hodlmm: {
          aprPct: poolData.apr ?? 0,
          apr24h: poolData.apr24h ?? 0,
          riskScore: hodlmmSource.riskScore,
          riskLabel: hodlmmSource.riskLabel,
          riskAdjustedScore: hodlmmRiskAdj,
          tvlUsd: poolData.tvlUsd ?? 0,
          tvlBtc: poolData.tvlBtc ?? 0,
          volumeUsd1d: poolData.volumeUsd1d ?? 0,
          volumeUsd7d: poolData.volumeUsd7d ?? 0,
          feesUsd1d: poolData.feesUsd1d ?? 0,
          feesUsd7d: poolData.feesUsd7d ?? 0,
          binStep: poolData.binStep ?? "unknown",
          baseFee: poolData.baseFee ?? 0,
          compositionPctX: poolData.poolComposition?.tokenX?.percentage ?? 0,
          compositionPctY: poolData.poolComposition?.tokenY?.percentage ?? 0,
          sbtcIncentives: poolData.sbtcIncentives ?? false,
        },
        bestAlternative: {
          source: bestAlt.source,
          protocol: bestAlt.protocol,
          asset: bestAlt.asset,
          aprPct: bestAlt.aprPct,
          riskScore: bestAlt.riskScore,
          riskAdjustedScore: bestAltRiskAdj,
        },
        allAlternatives: alternatives.map((a) => ({
          protocol: a.protocol,
          asset: a.asset,
          aprPct: a.aprPct,
          riskScore: a.riskScore,
          riskAdjustedScore: riskAdjustedScore(a.aprPct, a.riskScore),
        })),
        verdict,
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
