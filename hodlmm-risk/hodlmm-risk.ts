/**
 * hodlmm-risk.ts — Read-only volatility risk monitoring for Bitflow HODLMM pools
 *
 * Computes volatility score (0-100), regime (calm/elevated/crisis), and
 * position-sizing signals. No wallet or funds required. Mainnet only.
 *
 * Usage:
 *   bun run hodlmm-risk/hodlmm-risk.ts <subcommand> [options]
 */

import { Command } from "commander";

const HODLMM_API_BASE = "https://bff.bitflowapis.finance";
const PRICE_SCALE = 1e8; // prices are in 1e8 fixed point

// ─── Types ────────────────────────────────────────────────────────────────────

interface HodlmmPool {
  pool_id: string;
  amm_type: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  active: boolean;
  pool_status: string;
}

interface HodlmmPoolDetail {
  poolId: string;
  poolContract: string;
  poolStatus: boolean;
  tokens: {
    tokenX: { symbol: string; decimals: number; priceUsd: number };
    tokenY: { symbol: string; decimals: number; priceUsd: number };
  };
  reserveX?: string;
  reserveY?: string;
  tvlUsd?: number;
  activeBin?: number;
}

interface HodlmmBin {
  pool_id: string;
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

type Regime = "calm" | "elevated" | "crisis";

interface RiskAssessment {
  poolId: string;
  pair: string;
  activeBin: number;
  volatilityScore: number;
  regime: Regime;
  metrics: {
    binSpread: number;
    reserveImbalance: number;
    activeBinConcentration: number;
  };
  signals: {
    recommendation: "proceed" | "caution" | "stop";
    maxExposurePct: number;
    reason: string;
  };
  fetchedAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchPools(): Promise<HodlmmPool[]> {
  const res = await fetch(`${HODLMM_API_BASE}/api/quotes/v1/pools`);
  if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
  const data = (await res.json()) as { pools?: HodlmmPool[] };
  return Array.isArray(data.pools) ? data.pools : [];
}

async function fetchPoolDetail(poolId: string): Promise<HodlmmPoolDetail> {
  const res = await fetch(`${HODLMM_API_BASE}/api/app/v1/pools/${poolId}`);
  if (!res.ok) throw new Error(`Pool ${poolId} not found: ${res.status}`);
  return res.json() as Promise<HodlmmPoolDetail>;
}

async function fetchBins(poolId: string): Promise<{ bins: HodlmmBin[]; active_bin_id: number }> {
  const res = await fetch(`${HODLMM_API_BASE}/api/quotes/v1/bins/${poolId}`);
  if (!res.ok) throw new Error(`Failed to fetch bins for ${poolId}: ${res.status}`);
  const data = (await res.json()) as { bins?: HodlmmBin[]; active_bin_id?: number };
  return {
    bins: Array.isArray(data.bins) ? data.bins : [],
    active_bin_id: data.active_bin_id ?? 0,
  };
}

function shortName(contract: string): string {
  const parts = contract.split(".");
  return parts[parts.length - 1] ?? contract;
}

/**
 * Compute composite volatility risk score (0-100) from bin distribution data.
 *
 * Metrics (all normalized 0-1, higher = riskier):
 * - Bin spread (30%): fraction of bins with liquidity. Low spread = high risk.
 * - Reserve imbalance (40%): |X_usd - Y_usd| / total_usd. High = skewed pool.
 * - Active bin concentration (30%): active bin liquidity / total. High = IL risk.
 */
function computeRiskScore(
  bins: HodlmmBin[],
  activeBin: number,
  priceXUsd: number,
  priceYUsd: number,
  decimalsX: number,
  decimalsY: number
): {
  score: number;
  binSpread: number;
  reserveImbalance: number;
  activeBinConcentration: number;
} {
  const nonEmptyBins = bins.filter(
    (b) => parseFloat(b.reserve_x) > 0 || parseFloat(b.reserve_y) > 0
  );

  // Bin spread: fraction of non-empty bins (inverted — more spread = safer)
  const totalBins = bins.length;
  const binSpreadRaw = totalBins > 0 ? nonEmptyBins.length / totalBins : 0;
  const binSpreadRisk = 1 - Math.min(binSpreadRaw * 10, 1); // scale: 10% fill = 0 risk

  // Reserve imbalance
  let totalXUsd = 0;
  let totalYUsd = 0;
  for (const b of nonEmptyBins) {
    const rx = parseFloat(b.reserve_x) / Math.pow(10, decimalsX);
    const ry = parseFloat(b.reserve_y) / Math.pow(10, decimalsY);
    totalXUsd += rx * priceXUsd;
    totalYUsd += ry * priceYUsd;
  }
  const totalUsd = totalXUsd + totalYUsd;
  const reserveImbalanceRisk =
    totalUsd > 0 ? Math.abs(totalXUsd - totalYUsd) / totalUsd : 0;

  // Active bin concentration
  const activeBinData = bins.find((b) => b.bin_id === activeBin);
  let activeBinConcentrationRisk = 0;
  if (activeBinData && totalUsd > 0) {
    const abRx = parseFloat(activeBinData.reserve_x) / Math.pow(10, decimalsX);
    const abRy = parseFloat(activeBinData.reserve_y) / Math.pow(10, decimalsY);
    const abUsd = abRx * priceXUsd + abRy * priceYUsd;
    activeBinConcentrationRisk = abUsd / totalUsd;
  }

  // Weighted composite score
  const score = Math.round(
    (binSpreadRisk * 0.3 + reserveImbalanceRisk * 0.4 + activeBinConcentrationRisk * 0.3) * 100
  );

  return {
    score: Math.min(100, Math.max(0, score)),
    binSpread: Math.round(binSpreadRisk * 1000) / 1000,
    reserveImbalance: Math.round(reserveImbalanceRisk * 1000) / 1000,
    activeBinConcentration: Math.round(activeBinConcentrationRisk * 1000) / 1000,
  };
}

function classifyRegime(score: number): Regime {
  if (score <= 33) return "calm";
  if (score <= 66) return "elevated";
  return "crisis";
}

function buildSignals(
  score: number,
  regime: Regime,
  metrics: { binSpread: number; reserveImbalance: number; activeBinConcentration: number }
): RiskAssessment["signals"] {
  if (regime === "crisis") {
    return {
      recommendation: "stop",
      maxExposurePct: 0,
      reason:
        metrics.reserveImbalance > 0.5
          ? "Pool heavily imbalanced — active bin near edge, high IL risk"
          : "High volatility detected across multiple metrics",
    };
  }
  if (regime === "elevated") {
    const maxExp = Math.round(100 - score);
    let reason = "Elevated risk";
    if (metrics.reserveImbalance > 0.3) reason = "Reserve imbalance suggests active bin approaching edge";
    else if (metrics.activeBinConcentration > 0.5) reason = "High active-bin concentration — IL exposure if price moves";
    else if (metrics.binSpread < 0.3) reason = "Narrow bin spread — liquidity concentrated, drift risk elevated";
    return { recommendation: "caution", maxExposurePct: maxExp, reason };
  }
  return {
    recommendation: "proceed",
    maxExposurePct: 100,
    reason: "Pool metrics within normal range",
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-risk")
  .description("Read-only volatility risk monitoring for Bitflow HODLMM pools. No wallet required.")
  .version("1.0.0");

// list-pools
program
  .command("list-pools")
  .description("List all active HODLMM pools.")
  .action(async () => {
    try {
      const pools = await fetchPools();
      const active = pools.filter((p) => p.active);
      console.log(
        JSON.stringify({
          success: true,
          count: active.length,
          pools: active.map((p) => ({
            poolId: p.pool_id,
            tokenX: shortName(p.token_x),
            tokenY: shortName(p.token_y),
            activeBin: p.active_bin,
            binStep: p.bin_step,
            active: p.active,
          })),
        })
      );
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: String(err) }));
      process.exit(1);
    }
  });

// assess-pool
program
  .command("assess-pool")
  .description("Compute volatility risk score for a pool. Run before adding liquidity.")
  .requiredOption("--pool-id <id>", "Pool ID (e.g. dlmm_2)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [detail, binsData] = await Promise.all([
        fetchPoolDetail(opts.poolId),
        fetchBins(opts.poolId),
      ]);

      const { bins } = binsData;
      const priceXUsd = detail.tokens.tokenX.priceUsd ?? 0;
      const priceYUsd = detail.tokens.tokenY.priceUsd ?? 0;
      const decimalsX = detail.tokens.tokenX.decimals ?? 8;
      const decimalsY = detail.tokens.tokenY.decimals ?? 6;
      // active_bin_id comes from the bins API response
      const activeBin = binsData.active_bin_id || detail.activeBin || 0;

      const { score, binSpread, reserveImbalance, activeBinConcentration } =
        computeRiskScore(bins, activeBin, priceXUsd, priceYUsd, decimalsX, decimalsY);

      const regime = classifyRegime(score);
      const metrics = { binSpread, reserveImbalance, activeBinConcentration };

      const result: RiskAssessment = {
        poolId: opts.poolId,
        pair: `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`,
        activeBin,
        volatilityScore: score,
        regime,
        metrics,
        signals: buildSignals(score, regime, metrics),
        fetchedAt: new Date().toISOString(),
      };

      console.log(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      // Fail safe: return crisis on API error
      console.log(
        JSON.stringify({
          success: false,
          poolId: opts.poolId,
          regime: "crisis",
          volatilityScore: 100,
          signals: { recommendation: "stop", maxExposurePct: 0, reason: `API unreachable — defaulting to safe mode: ${String(err)}` },
          error: String(err),
        })
      );
      process.exit(1);
    }
  });

// assess-position
program
  .command("assess-position")
  .description("Evaluate an LP position's drift and concentration risk.")
  .requiredOption("--pool-id <id>", "Pool ID")
  .requiredOption("--address <stxAddress>", "Stacks address of the LP")
  .action(async (opts: { poolId: string; address: string }) => {
    try {
      const [detail, binsData] = await Promise.all([
        fetchPoolDetail(opts.poolId),
        fetchBins(opts.poolId),
      ]);

      const { bins } = binsData;
      const activeBin = binsData.active_bin_id || detail.activeBin || 0;
      const nonEmptyBins = bins.filter(
        (b) => parseFloat(b.reserve_x) > 0 || parseFloat(b.reserve_y) > 0
      );

      // Compute bin range center
      const binIds = nonEmptyBins.map((b) => b.bin_id).sort((a, b) => a - b);
      const minBin = binIds[0] ?? activeBin;
      const maxBin = binIds[binIds.length - 1] ?? activeBin;
      const centerBin = Math.round((minBin + maxBin) / 2);
      const rangeWidth = maxBin - minBin;

      // Drift: how far active bin has moved from center of liquidity range
      const drift = Math.abs(activeBin - centerBin);
      const driftPct = rangeWidth > 0 ? drift / rangeWidth : 0;

      let driftRisk: "low" | "medium" | "high";
      let recommendation: "hold" | "rebalance" | "withdraw";
      let reason: string;

      if (driftPct < 0.2) {
        driftRisk = "low";
        recommendation = "hold";
        reason = "Active bin near center of position range";
      } else if (driftPct < 0.5) {
        driftRisk = "medium";
        recommendation = "rebalance";
        reason = `Active bin has drifted ${Math.round(driftPct * 100)}% from position center — consider rebalancing`;
      } else {
        driftRisk = "high";
        recommendation = "withdraw";
        reason = `Active bin has drifted ${Math.round(driftPct * 100)}% from position center — high IL risk, consider withdrawing`;
      }

      console.log(
        JSON.stringify({
          success: true,
          poolId: opts.poolId,
          address: opts.address,
          pair: `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`,
          activeBin,
          positionRange: { minBin, maxBin, centerBin, rangeWidth },
          drift: { bins: drift, pct: Math.round(driftPct * 1000) / 1000, risk: driftRisk },
          recommendation,
          reason,
          fetchedAt: new Date().toISOString(),
        })
      );
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: String(err) }));
      process.exit(1);
    }
  });

// regime-history
program
  .command("regime-history")
  .description("Scan all active pools for current volatility regime, sorted by risk.")
  .action(async () => {
    try {
      const pools = await fetchPools();
      const active = pools.filter((p) => p.active);

      const results = await Promise.allSettled(
        active.map(async (pool) => {
          const [detail, binsData] = await Promise.all([
            fetchPoolDetail(pool.pool_id),
            fetchBins(pool.pool_id),
          ]);

          const { bins } = binsData;
          const priceXUsd = detail.tokens.tokenX.priceUsd ?? 0;
          const priceYUsd = detail.tokens.tokenY.priceUsd ?? 0;
          const decimalsX = detail.tokens.tokenX.decimals ?? 8;
          const decimalsY = detail.tokens.tokenY.decimals ?? 6;
          const activeBin = binsData.active_bin_id || detail.activeBin || pool.active_bin;

          const { score } = computeRiskScore(bins, activeBin, priceXUsd, priceYUsd, decimalsX, decimalsY);

          return {
            poolId: pool.pool_id,
            pair: `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`,
            activeBin,
            volatilityScore: score,
            regime: classifyRegime(score),
          };
        })
      );

      const snapshot = results
        .filter((r): r is PromiseFulfilledResult<ReturnType<typeof classifyRegime> extends infer _ ? {
          poolId: string; pair: string; activeBin: number; volatilityScore: number; regime: Regime;
        } : never> => r.status === "fulfilled")
        .map((r) => r.value)
        .sort((a, b) => b.volatilityScore - a.volatilityScore);

      const summary = {
        crisis: snapshot.filter((p) => p.regime === "crisis").length,
        elevated: snapshot.filter((p) => p.regime === "elevated").length,
        calm: snapshot.filter((p) => p.regime === "calm").length,
      };

      console.log(
        JSON.stringify({
          success: true,
          fetchedAt: new Date().toISOString(),
          summary,
          pools: snapshot,
        })
      );
    } catch (err) {
      console.log(JSON.stringify({ success: false, error: String(err) }));
      process.exit(1);
    }
  });

program.parse(process.argv);
