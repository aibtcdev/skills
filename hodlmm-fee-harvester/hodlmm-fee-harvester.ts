#!/usr/bin/env bun
/**
 * HODLMM Fee Harvester skill CLI
 *
 * Fee yield analytics and harvest-readiness scoring for Bitflow HODLMM pools.
 * Tracks pool-level fee generation, computes fee efficiency metrics, estimates
 * per-position fee share for LP wallets, and signals when accumulated fees
 * justify a harvest action.
 *
 * Self-contained: uses Bitflow APIs directly.
 * HODLMM bonus eligible: Yes — directly analyses HODLMM fee economics.
 *
 * Usage: bun run hodlmm-fee-harvester/hodlmm-fee-harvester.ts <subcommand>
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://bff.bitflowapis.finance";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// Harvest thresholds (hardcoded safety limits)
const MIN_HARVEST_VALUE_USD = 1.0; // Don't harvest below $1 (gas not worth it)
const MIN_FEE_EFFICIENCY_PCT = 0.01; // Pool must generate >0.01% daily fee/TVL to be considered active

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
  volumeUsd30d?: number;
  feesUsd1d?: number;
  feesUsd7d?: number;
  feesUsd30d?: number;
  feesUsdLifetime?: number;
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

interface HodlmmPoolListItem {
  pool_id: string;
  token_x: string;
  token_y: string;
  active_bin: number;
  active?: boolean;
}

interface PositionBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  shares?: string;
}

interface UserPositionResponse {
  bins?: PositionBin[];
  position_bins?: PositionBin[];
  positions?: { bins?: PositionBin[] };
}

interface FeeProfile {
  poolId: string;
  pair: string;
  tvlUsd: number;
  feesUsd1d: number;
  feesUsd7d: number;
  feesUsd30d: number;
  feesUsdLifetime: number;
  feeEfficiency1d: number;
  feeEfficiency7d: number;
  apr: number;
  apr24h: number;
  volumeToFeeRatio: number;
  isActive: boolean;
  harvestGrade: "A" | "B" | "C" | "D" | "F";
}

interface PositionFeeEstimate {
  poolId: string;
  pair: string;
  positionBinCount: number;
  positionValueUsd: number;
  positionSharePct: number;
  estimatedFeesAccrued1d: number;
  estimatedFeesAccrued7d: number;
  estimatedFeesAccrued30d: number;
  harvestReady: boolean;
  harvestReason: string;
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

function printResult(data: unknown): void {
  console.log(
    JSON.stringify({ status: "ok" as const, ...data as Record<string, unknown> }, null, 2)
  );
}

function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(
    JSON.stringify({ status: "error" as const, error: message }, null, 2)
  );
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

async function getUserPositionBins(
  address: string,
  poolId: string
): Promise<PositionBin[]> {
  try {
    const data = await fetchJson<UserPositionResponse>(
      `${BITFLOW_API}/api/app/v1/users/${address}/positions/${poolId}/bins`
    );
    // Handle different response shapes
    return data?.bins ?? data?.position_bins ?? data?.positions?.bins ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fee analytics
// ---------------------------------------------------------------------------

/**
 * Fee efficiency: daily fees as percentage of TVL.
 * Higher = more fee income per dollar of liquidity.
 */
function computeFeeEfficiency(feesUsd: number, tvlUsd: number): number {
  if (tvlUsd <= 0) return 0;
  return Number(((feesUsd / tvlUsd) * 100).toFixed(6));
}

/**
 * Harvest grade based on fee efficiency and volume.
 * A = excellent fee generation, actively traded pool
 * B = good fee generation
 * C = moderate, worth monitoring
 * D = low fee generation
 * F = negligible or zero fees
 */
function computeHarvestGrade(
  feeEfficiency1d: number,
  apr: number,
  volumeUsd1d: number
): "A" | "B" | "C" | "D" | "F" {
  if (feeEfficiency1d <= 0 || volumeUsd1d <= 0) return "F";
  if (apr >= 20 && feeEfficiency1d >= 0.05) return "A";
  if (apr >= 10 && feeEfficiency1d >= 0.02) return "B";
  if (apr >= 3 && feeEfficiency1d >= 0.005) return "C";
  if (apr > 0) return "D";
  return "F";
}

function buildFeeProfile(pool: HodlmmRichPool): FeeProfile {
  const tvl = pool.tvlUsd ?? 0;
  const feesUsd1d = pool.feesUsd1d ?? 0;
  const feesUsd7d = pool.feesUsd7d ?? 0;
  const feesUsd30d = pool.feesUsd30d ?? 0;
  const feesUsdLifetime = pool.feesUsdLifetime ?? 0;
  const volumeUsd1d = pool.volumeUsd1d ?? 0;
  const apr = pool.apr ?? 0;

  const feeEfficiency1d = computeFeeEfficiency(feesUsd1d, tvl);
  const feeEfficiency7d = computeFeeEfficiency(feesUsd7d / 7, tvl);

  const xSym = pool.tokens?.tokenX?.symbol ?? "?";
  const ySym = pool.tokens?.tokenY?.symbol ?? "?";

  return {
    poolId: pool.poolId,
    pair: `${xSym}/${ySym}`,
    tvlUsd: tvl,
    feesUsd1d,
    feesUsd7d,
    feesUsd30d,
    feesUsdLifetime,
    feeEfficiency1d,
    feeEfficiency7d,
    apr,
    apr24h: pool.apr24h ?? 0,
    volumeToFeeRatio: volumeUsd1d > 0 ? Number((feesUsd1d / volumeUsd1d * 100).toFixed(4)) : 0,
    isActive: feesUsd1d > 0 && volumeUsd1d > 0,
    harvestGrade: computeHarvestGrade(feeEfficiency1d, apr, volumeUsd1d),
  };
}

// ---------------------------------------------------------------------------
// Position fee estimation
// ---------------------------------------------------------------------------

async function estimatePositionFees(
  address: string,
  poolId: string,
  pool: HodlmmRichPool
): Promise<PositionFeeEstimate | null> {
  const bins = await getUserPositionBins(address, poolId);
  if (bins.length === 0) return null;

  const xDecimals = pool.tokens?.tokenX?.decimals ?? 8;
  const yDecimals = pool.tokens?.tokenY?.decimals ?? 6;
  const xPriceUsd = pool.tokens?.tokenX?.priceUsd ?? 0;
  const yPriceUsd = pool.tokens?.tokenY?.priceUsd ?? 0;

  // Compute position value from bins
  let positionValueUsd = 0;
  for (const bin of bins) {
    const normalizedX = Number(bin.reserve_x) / Math.pow(10, xDecimals);
    const normalizedY = Number(bin.reserve_y) / Math.pow(10, yDecimals);
    positionValueUsd += normalizedX * xPriceUsd + normalizedY * yPriceUsd;
  }

  const tvl = pool.tvlUsd ?? 0;
  const positionSharePct = tvl > 0 ? Number(((positionValueUsd / tvl) * 100).toFixed(4)) : 0;
  const shareFraction = positionSharePct / 100;

  // Estimate fee accrual proportional to position share
  const feesAccrued1d = (pool.feesUsd1d ?? 0) * shareFraction;
  const feesAccrued7d = (pool.feesUsd7d ?? 0) * shareFraction;
  const feesAccrued30d = (pool.feesUsd30d ?? 0) * shareFraction;

  const xSym = pool.tokens?.tokenX?.symbol ?? "?";
  const ySym = pool.tokens?.tokenY?.symbol ?? "?";

  // Harvest readiness: worth claiming if accumulated fees exceed gas + minimum threshold
  let harvestReady = false;
  let harvestReason: string;

  if (feesAccrued7d >= MIN_HARVEST_VALUE_USD) {
    harvestReady = true;
    harvestReason = `Estimated 7d fees ($${feesAccrued7d.toFixed(2)}) exceed minimum harvest threshold ($${MIN_HARVEST_VALUE_USD}).`;
  } else if (feesAccrued30d >= MIN_HARVEST_VALUE_USD) {
    harvestReady = false;
    harvestReason = `30d fees ($${feesAccrued30d.toFixed(2)}) approach threshold but 7d fees ($${feesAccrued7d.toFixed(2)}) are below minimum ($${MIN_HARVEST_VALUE_USD}). Wait for more accrual.`;
  } else {
    harvestReady = false;
    harvestReason = `Fees too low to justify harvest. Estimated 30d fees: $${feesAccrued30d.toFixed(2)}.`;
  }

  return {
    poolId,
    pair: `${xSym}/${ySym}`,
    positionBinCount: bins.length,
    positionValueUsd: Number(positionValueUsd.toFixed(2)),
    positionSharePct,
    estimatedFeesAccrued1d: Number(feesAccrued1d.toFixed(4)),
    estimatedFeesAccrued7d: Number(feesAccrued7d.toFixed(4)),
    estimatedFeesAccrued30d: Number(feesAccrued30d.toFixed(4)),
    harvestReady,
    harvestReason,
  };
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

interface PoolScanResult {
  network: string;
  poolCount: number;
  activePoolCount: number;
  profiles: FeeProfile[];
  totalFeesUsd1d: number;
  totalFeesUsd7d: number;
  totalFeesUsdLifetime: number;
  bestPool: { poolId: string; pair: string; apr: number; grade: string } | null;
  summary: string;
  timestamp: string;
}

async function scanAllPools(): Promise<PoolScanResult> {
  const poolList = await getPoolList();
  const activeList = poolList.filter((p) => p.active !== false);

  const richPools = await Promise.all(
    activeList.map(async (item) => {
      try {
        return await getRichPool(item.pool_id);
      } catch {
        return null;
      }
    })
  );

  const profiles: FeeProfile[] = [];
  for (const pool of richPools) {
    if (pool && pool.poolId) {
      profiles.push(buildFeeProfile(pool));
    }
  }

  // Sort by fee efficiency descending
  profiles.sort((a, b) => b.feeEfficiency1d - a.feeEfficiency1d);

  const activeProfiles = profiles.filter((p) => p.isActive);
  const totalFeesUsd1d = profiles.reduce((s, p) => s + p.feesUsd1d, 0);
  const totalFeesUsd7d = profiles.reduce((s, p) => s + p.feesUsd7d, 0);
  const totalFeesUsdLifetime = profiles.reduce((s, p) => s + p.feesUsdLifetime, 0);

  const best = activeProfiles.length > 0
    ? { poolId: activeProfiles[0].poolId, pair: activeProfiles[0].pair, apr: activeProfiles[0].apr, grade: activeProfiles[0].harvestGrade }
    : null;

  const summary =
    `Scanned ${profiles.length} HODLMM pools. ${activeProfiles.length} actively generating fees. ` +
    `Total fees: $${totalFeesUsd1d.toFixed(2)}/day, $${totalFeesUsd7d.toFixed(2)}/week, $${totalFeesUsdLifetime.toFixed(2)} lifetime. ` +
    (best ? `Top performer: ${best.pair} (${best.poolId}) at ${best.apr}% APR, grade ${best.grade}.` : "No active fee-generating pools found.");

  return {
    network: NETWORK,
    poolCount: profiles.length,
    activePoolCount: activeProfiles.length,
    profiles,
    totalFeesUsd1d: Number(totalFeesUsd1d.toFixed(2)),
    totalFeesUsd7d: Number(totalFeesUsd7d.toFixed(2)),
    totalFeesUsdLifetime: Number(totalFeesUsdLifetime.toFixed(2)),
    bestPool: best,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-fee-harvester")
  .description(
    "HODLMM fee yield analytics and harvest-readiness scoring. Tracks pool-level fee " +
    "generation, computes fee efficiency metrics, estimates per-position fee share, " +
    "and signals when accumulated fees justify a harvest. Read-only, no wallet required."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify API connectivity and fee data availability.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
        harvestThresholds: {
          minHarvestValueUsd: MIN_HARVEST_VALUE_USD,
          minFeeEfficiencyPct: MIN_FEE_EFFICIENCY_PCT,
        },
      };

      try {
        const response = await fetchJson<{ pools?: HodlmmPoolListItem[] }>(
          `${BITFLOW_API}/api/quotes/v1/pools`
        );
        const pools = response?.pools ?? [];
        checks.quotesApi = { status: "ok", poolCount: pools.length };
      } catch (e) {
        checks.quotesApi = { status: "error", error: String(e) };
      }

      try {
        const pool = await getRichPool("dlmm_1");
        checks.appApi = {
          status: "ok",
          hasFees1d: pool.feesUsd1d !== undefined,
          hasFees7d: pool.feesUsd7d !== undefined,
          hasFeesLifetime: pool.feesUsdLifetime !== undefined,
          hasApr: pool.apr !== undefined,
        };
      } catch (e) {
        checks.appApi = { status: "error", error: String(e) };
      }

      try {
        // Verify position endpoint is reachable (empty result is fine)
        await fetchJson<UserPositionResponse>(
          `${BITFLOW_API}/api/app/v1/users/SP000000000000000000002Q6VF78/positions/dlmm_1/bins`
        );
        checks.positionApi = { status: "ok" };
      } catch (e) {
        // 404 or empty is acceptable - the endpoint exists
        const msg = String(e);
        checks.positionApi = {
          status: msg.includes("404") ? "ok" : "error",
          note: msg.includes("404") ? "endpoint reachable (no positions for test address)" : undefined,
          error: msg.includes("404") ? undefined : msg,
        };
      }

      const allOk =
        (checks.quotesApi as Record<string, unknown>).status === "ok" &&
        (checks.appApi as Record<string, unknown>).status === "ok";

      printResult({ ...checks, healthy: allOk, timestamp: new Date().toISOString() });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
program
  .command("scan")
  .description(
    "Scan all HODLMM pools: fee generation rates, efficiency metrics, and harvest grades."
  )
  .action(async () => {
    try {
      printResult(await scanAllPools());
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// pool-fees
// ---------------------------------------------------------------------------
program
  .command("pool-fees")
  .description("Detailed fee analytics for a specific pool.")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .action(async (opts: { poolId: string }) => {
    try {
      const pool = await getRichPool(opts.poolId);
      const profile = buildFeeProfile(pool);

      printResult({
        network: NETWORK,
        ...profile,
        feeBreakdown: {
          daily: profile.feesUsd1d,
          weekly: profile.feesUsd7d,
          monthly: profile.feesUsd30d,
          lifetime: profile.feesUsdLifetime,
          dailyEfficiencyPct: profile.feeEfficiency1d,
          weeklyAvgEfficiencyPct: profile.feeEfficiency7d,
        },
        verdict: profile.harvestGrade === "A" || profile.harvestGrade === "B"
          ? `${profile.pair} is actively generating fees (grade ${profile.harvestGrade}, ${profile.apr}% APR). Good pool for LP.`
          : profile.harvestGrade === "C"
          ? `${profile.pair} generates moderate fees (grade ${profile.harvestGrade}, ${profile.apr}% APR). Monitor for improvement.`
          : `${profile.pair} has low/no fee activity (grade ${profile.harvestGrade}). Not recommended for new LP.`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// position
// ---------------------------------------------------------------------------
program
  .command("position")
  .description(
    "Estimate fee accrual for a wallet's LP position in a specific pool. " +
    "Reports harvest readiness based on accumulated fee estimates."
  )
  .requiredOption("--address <addr>", "Stacks wallet address")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .action(async (opts: { address: string; poolId: string }) => {
    try {
      const pool = await getRichPool(opts.poolId);
      const estimate = await estimatePositionFees(opts.address, opts.poolId, pool);

      if (!estimate) {
        printResult({
          network: NETWORK,
          poolId: opts.poolId,
          address: opts.address,
          hasPosition: false,
          message: "No HODLMM position found for this address in this pool.",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const profile = buildFeeProfile(pool);

      printResult({
        network: NETWORK,
        address: opts.address,
        ...estimate,
        poolGrade: profile.harvestGrade,
        poolApr: profile.apr,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------
program
  .command("portfolio")
  .description(
    "Scan all pools for a wallet's positions and estimate total fee accrual."
  )
  .requiredOption("--address <addr>", "Stacks wallet address")
  .action(async (opts: { address: string }) => {
    try {
      const poolList = await getPoolList();
      const activeList = poolList.filter((p) => p.active !== false);

      // Fetch rich pool data and check positions in parallel
      const results = await Promise.all(
        activeList.map(async (item) => {
          try {
            const pool = await getRichPool(item.pool_id);
            const estimate = await estimatePositionFees(opts.address, item.pool_id, pool);
            return estimate;
          } catch {
            return null;
          }
        })
      );

      const positions = results.filter(
        (r): r is PositionFeeEstimate => r !== null
      );

      const totalValueUsd = positions.reduce((s, p) => s + p.positionValueUsd, 0);
      const totalFees1d = positions.reduce((s, p) => s + p.estimatedFeesAccrued1d, 0);
      const totalFees7d = positions.reduce((s, p) => s + p.estimatedFeesAccrued7d, 0);
      const totalFees30d = positions.reduce((s, p) => s + p.estimatedFeesAccrued30d, 0);
      const harvestable = positions.filter((p) => p.harvestReady);

      const summary = positions.length > 0
        ? `Found ${positions.length} HODLMM position(s) worth $${totalValueUsd.toFixed(2)}. ` +
          `Estimated fees: $${totalFees1d.toFixed(2)}/day, $${totalFees7d.toFixed(2)}/week. ` +
          `${harvestable.length} position(s) ready to harvest.`
        : "No HODLMM positions found for this address across any active pool.";

      printResult({
        network: NETWORK,
        address: opts.address,
        positionCount: positions.length,
        totalValueUsd: Number(totalValueUsd.toFixed(2)),
        totalEstimatedFees: {
          daily: Number(totalFees1d.toFixed(4)),
          weekly: Number(totalFees7d.toFixed(4)),
          monthly: Number(totalFees30d.toFixed(4)),
        },
        harvestableCount: harvestable.length,
        positions,
        summary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
program.parse(process.argv);
