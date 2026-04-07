#!/usr/bin/env bun
/**
 * HODLMM Depth Scanner skill CLI
 *
 * Liquidity depth analysis and slippage estimation for Bitflow HODLMM pools.
 * Maps the bin-by-bin liquidity distribution around the active price, computes
 * how much can be swapped before moving the price by X%, and rates each pool's
 * depth quality for swap execution.
 *
 * Self-contained: uses Bitflow APIs directly.
 * HODLMM bonus eligible: Yes — analyses HODLMM bin-level liquidity structure.
 *
 * Usage: bun run hodlmm-depth-scanner/hodlmm-depth-scanner.ts <subcommand>
 */
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_API = "https://bff.bitflowapis.finance";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;
const VERSION = "0.1.0";

// Depth scan radius: how many bins around active to analyze
const DEPTH_RADIUS_BINS = 50;

// Slippage tiers to report
const SLIPPAGE_TIERS_PCT = [0.5, 1.0, 2.0, 5.0];

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
  volumeUsd1d?: number;
  apr?: number;
  binStep?: string;
  baseFee?: number;
}

interface HodlmmPoolListItem {
  pool_id: string;
  token_x: string;
  token_y: string;
  active_bin: number;
  active?: boolean;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface BinListResponse {
  active_bin_id?: number;
  bins: BinData[];
}

interface DepthSide {
  binCount: number;
  totalReserveRaw: number;
  totalValueUsd: number;
  deepestBinOffset: number;
}

interface SlippageTier {
  slippagePct: number;
  binsConsumed: number;
  buyCapacityUsd: number;
  sellCapacityUsd: number;
}

interface DepthProfile {
  poolId: string;
  pair: string;
  activeBinId: number;
  binStep: number;
  tvlUsd: number;
  buySide: DepthSide;
  sellSide: DepthSide;
  slippageTiers: SlippageTier[];
  depthScore: number;
  depthGrade: "deep" | "moderate" | "shallow" | "empty";
  imbalanceRatio: number;
  imbalanceDirection: "buy-heavy" | "sell-heavy" | "balanced";
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

async function getPoolBins(poolId: string): Promise<BinListResponse> {
  return fetchJson<BinListResponse>(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`);
}

// ---------------------------------------------------------------------------
// Depth analysis
// ---------------------------------------------------------------------------

/**
 * Compute USD value of reserves in a bin, normalized by token decimals.
 */
function binValueUsd(
  reserveX: number,
  reserveY: number,
  xDecimals: number,
  yDecimals: number,
  xPriceUsd: number,
  yPriceUsd: number
): number {
  const normalizedX = reserveX / Math.pow(10, xDecimals);
  const normalizedY = reserveY / Math.pow(10, yDecimals);
  return normalizedX * xPriceUsd + normalizedY * yPriceUsd;
}

/**
 * Analyze depth around the active bin.
 *
 * Buy side: bins below active (hold tokenY — what buyers consume).
 * Sell side: bins above active (hold tokenX — what sellers consume).
 *
 * In HODLMM, bins below the active bin hold tokenY (the quote token),
 * and bins above hold tokenX (the base token). The active bin may hold both.
 */
function analyzeDepth(
  bins: BinData[],
  activeBinId: number,
  binStep: number,
  xDecimals: number,
  yDecimals: number,
  xPriceUsd: number,
  yPriceUsd: number
): { buySide: DepthSide; sellSide: DepthSide; slippageTiers: SlippageTier[]; imbalanceRatio: number } {
  // Filter bins within analysis radius
  const nearbyBins = bins
    .filter((b) => Math.abs(b.bin_id - activeBinId) <= DEPTH_RADIUS_BINS)
    .sort((a, b) => a.bin_id - b.bin_id);

  // Buy side: bins at or below active (tokenY reserves)
  const buyBins = nearbyBins.filter((b) => b.bin_id <= activeBinId);
  // Sell side: bins at or above active (tokenX reserves)
  const sellBins = nearbyBins.filter((b) => b.bin_id >= activeBinId);

  let buyTotalRaw = 0;
  let buyTotalUsd = 0;
  let buyNonEmpty = 0;
  for (const b of buyBins) {
    const ry = Number(b.reserve_y);
    if (ry > 0) {
      buyTotalRaw += ry;
      buyTotalUsd += (ry / Math.pow(10, yDecimals)) * yPriceUsd;
      buyNonEmpty++;
    }
  }

  let sellTotalRaw = 0;
  let sellTotalUsd = 0;
  let sellNonEmpty = 0;
  for (const b of sellBins) {
    const rx = Number(b.reserve_x);
    if (rx > 0) {
      sellTotalRaw += rx;
      sellTotalUsd += (rx / Math.pow(10, xDecimals)) * xPriceUsd;
      sellNonEmpty++;
    }
  }

  // Compute slippage tiers
  // Each bin crossed = binStep basis points of price impact
  const slippageTiers: SlippageTier[] = SLIPPAGE_TIERS_PCT.map((targetPct) => {
    const binsForSlippage = Math.floor((targetPct * 10000) / (binStep || 1));

    // Buy capacity: sum tokenY in bins below active, up to binsForSlippage
    let buyCapUsd = 0;
    const buySlice = buyBins
      .filter((b) => b.bin_id < activeBinId)
      .sort((a, b) => b.bin_id - a.bin_id) // closest to active first
      .slice(0, binsForSlippage);
    for (const b of buySlice) {
      buyCapUsd += (Number(b.reserve_y) / Math.pow(10, yDecimals)) * yPriceUsd;
    }
    // Include active bin's Y reserves
    const activeBin = bins.find((b) => b.bin_id === activeBinId);
    if (activeBin) {
      buyCapUsd += (Number(activeBin.reserve_y) / Math.pow(10, yDecimals)) * yPriceUsd;
    }

    // Sell capacity: sum tokenX in bins above active, up to binsForSlippage
    let sellCapUsd = 0;
    const sellSlice = sellBins
      .filter((b) => b.bin_id > activeBinId)
      .sort((a, b) => a.bin_id - b.bin_id) // closest to active first
      .slice(0, binsForSlippage);
    for (const b of sellSlice) {
      sellCapUsd += (Number(b.reserve_x) / Math.pow(10, xDecimals)) * xPriceUsd;
    }
    // Include active bin's X reserves
    if (activeBin) {
      sellCapUsd += (Number(activeBin.reserve_x) / Math.pow(10, xDecimals)) * xPriceUsd;
    }

    return {
      slippagePct: targetPct,
      binsConsumed: binsForSlippage,
      buyCapacityUsd: Number(buyCapUsd.toFixed(2)),
      sellCapacityUsd: Number(sellCapUsd.toFixed(2)),
    };
  });

  // Imbalance ratio: 0 = perfectly balanced, 1 = fully single-sided
  const totalUsd = buyTotalUsd + sellTotalUsd;
  const imbalanceRatio = totalUsd > 0
    ? Number((Math.abs(buyTotalUsd - sellTotalUsd) / totalUsd).toFixed(4))
    : 0;

  // Deepest non-empty bin offset from active
  const buyDeepest = buyBins.filter((b) => Number(b.reserve_y) > 0).length > 0
    ? activeBinId - Math.min(...buyBins.filter((b) => Number(b.reserve_y) > 0).map((b) => b.bin_id))
    : 0;
  const sellDeepest = sellBins.filter((b) => Number(b.reserve_x) > 0).length > 0
    ? Math.max(...sellBins.filter((b) => Number(b.reserve_x) > 0).map((b) => b.bin_id)) - activeBinId
    : 0;

  return {
    buySide: {
      binCount: buyNonEmpty,
      totalReserveRaw: buyTotalRaw,
      totalValueUsd: Number(buyTotalUsd.toFixed(2)),
      deepestBinOffset: buyDeepest,
    },
    sellSide: {
      binCount: sellNonEmpty,
      totalReserveRaw: sellTotalRaw,
      totalValueUsd: Number(sellTotalUsd.toFixed(2)),
      deepestBinOffset: sellDeepest,
    },
    slippageTiers,
    imbalanceRatio,
  };
}

/**
 * Depth score: 0-100 based on total USD depth and distribution.
 * Higher = deeper, more balanced liquidity.
 */
function computeDepthScore(
  buySideUsd: number,
  sellSideUsd: number,
  imbalanceRatio: number
): number {
  const totalUsd = buySideUsd + sellSideUsd;
  // Depth component: log scale, $100K = 50, $1M = 75, $10M = 100
  const depthComponent = totalUsd > 0
    ? Math.min(Math.log10(totalUsd) * 20 - 40, 80)
    : 0;
  // Balance component: 0-20 points, penalized by imbalance
  const balanceComponent = (1 - imbalanceRatio) * 20;

  return Math.max(0, Math.min(100, Math.round(depthComponent + balanceComponent)));
}

function classifyDepth(score: number): "deep" | "moderate" | "shallow" | "empty" {
  if (score >= 60) return "deep";
  if (score >= 35) return "moderate";
  if (score > 0) return "shallow";
  return "empty";
}

async function buildDepthProfile(
  poolId: string,
  richPool: HodlmmRichPool,
  binsData: BinListResponse
): Promise<DepthProfile> {
  const activeBinId = binsData.active_bin_id ?? 0;
  const binStep = Number(richPool.binStep ?? 10);
  const xDecimals = richPool.tokens?.tokenX?.decimals ?? 8;
  const yDecimals = richPool.tokens?.tokenY?.decimals ?? 6;
  const xPriceUsd = richPool.tokens?.tokenX?.priceUsd ?? 0;
  const yPriceUsd = richPool.tokens?.tokenY?.priceUsd ?? 0;
  const xSym = richPool.tokens?.tokenX?.symbol ?? "?";
  const ySym = richPool.tokens?.tokenY?.symbol ?? "?";

  const { buySide, sellSide, slippageTiers, imbalanceRatio } = analyzeDepth(
    binsData.bins,
    activeBinId,
    binStep,
    xDecimals, yDecimals,
    xPriceUsd, yPriceUsd
  );

  const depthScore = computeDepthScore(buySide.totalValueUsd, sellSide.totalValueUsd, imbalanceRatio);
  const imbalanceDirection = imbalanceRatio < 0.2
    ? "balanced" as const
    : buySide.totalValueUsd > sellSide.totalValueUsd
      ? "buy-heavy" as const
      : "sell-heavy" as const;

  return {
    poolId,
    pair: `${xSym}/${ySym}`,
    activeBinId,
    binStep,
    tvlUsd: richPool.tvlUsd ?? 0,
    buySide,
    sellSide,
    slippageTiers,
    depthScore,
    depthGrade: classifyDepth(depthScore),
    imbalanceRatio,
    imbalanceDirection,
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("hodlmm-depth-scanner")
  .description(
    "HODLMM liquidity depth analysis: maps bin-by-bin liquidity around the active price, " +
    "estimates swap capacity at each slippage tier, and grades pool depth quality. " +
    "Read-only, no wallet required."
  )
  .version(VERSION);

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Health check: verify API connectivity and bin data availability.")
  .action(async () => {
    try {
      const checks: Record<string, unknown> = {
        network: NETWORK,
        version: VERSION,
        config: {
          depthRadiusBins: DEPTH_RADIUS_BINS,
          slippageTiersPct: SLIPPAGE_TIERS_PCT,
        },
      };

      try {
        const response = await fetchJson<{ pools?: HodlmmPoolListItem[] }>(
          `${BITFLOW_API}/api/quotes/v1/pools`
        );
        checks.quotesApi = { status: "ok", poolCount: (response?.pools ?? []).length };
      } catch (e) {
        checks.quotesApi = { status: "error", error: String(e) };
      }

      try {
        const pool = await getRichPool("dlmm_1");
        checks.appApi = {
          status: "ok",
          hasTokenDecimals: pool.tokens?.tokenX?.decimals !== undefined,
          hasTokenPrices: pool.tokens?.tokenX?.priceUsd !== undefined,
        };
      } catch (e) {
        checks.appApi = { status: "error", error: String(e) };
      }

      try {
        const bins = await getPoolBins("dlmm_1");
        checks.binsApi = {
          status: "ok",
          binCount: bins.bins?.length ?? 0,
          hasActiveBin: bins.active_bin_id !== undefined,
        };
      } catch (e) {
        checks.binsApi = { status: "error", error: String(e) };
      }

      const allOk =
        (checks.quotesApi as Record<string, unknown>).status === "ok" &&
        (checks.appApi as Record<string, unknown>).status === "ok" &&
        (checks.binsApi as Record<string, unknown>).status === "ok";

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
  .description("Scan all pools: depth score, grade, and imbalance for each.")
  .action(async () => {
    try {
      const poolList = await getPoolList();
      const activeList = poolList.filter((p) => p.active !== false);

      const profiles = await Promise.all(
        activeList.map(async (item) => {
          try {
            const [rich, bins] = await Promise.all([
              getRichPool(item.pool_id),
              getPoolBins(item.pool_id),
            ]);
            if (!bins.bins || bins.bins.length === 0) return null;
            return await buildDepthProfile(item.pool_id, rich, bins);
          } catch (e) {
            process.stderr.write(
              JSON.stringify({ warning: `Failed to scan ${item.pool_id}`, error: String(e) }) + "\n"
            );
            return null;
          }
        })
      );

      const validProfiles = profiles.filter((p): p is DepthProfile => p !== null);
      validProfiles.sort((a, b) => b.depthScore - a.depthScore);

      const deepCount = validProfiles.filter((p) => p.depthGrade === "deep").length;
      const summary =
        `Scanned ${validProfiles.length} HODLMM pools. ` +
        `${deepCount} with deep liquidity. ` +
        (validProfiles.length > 0
          ? `Best depth: ${validProfiles[0].pair} (${validProfiles[0].poolId}) — score ${validProfiles[0].depthScore}, grade ${validProfiles[0].depthGrade}.`
          : "No pools with bin data available.");

      printResult({
        network: NETWORK,
        poolCount: validProfiles.length,
        profiles: validProfiles.map((p) => ({
          poolId: p.poolId,
          pair: p.pair,
          depthScore: p.depthScore,
          depthGrade: p.depthGrade,
          tvlUsd: p.tvlUsd,
          buySideUsd: p.buySide.totalValueUsd,
          sellSideUsd: p.sellSide.totalValueUsd,
          imbalanceDirection: p.imbalanceDirection,
          maxBuyAt1Pct: p.slippageTiers.find((t) => t.slippagePct === 1.0)?.buyCapacityUsd ?? 0,
          maxSellAt1Pct: p.slippageTiers.find((t) => t.slippagePct === 1.0)?.sellCapacityUsd ?? 0,
        })),
        summary,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// pool-depth
// ---------------------------------------------------------------------------
program
  .command("pool-depth")
  .description(
    "Deep liquidity analysis for a specific pool: bin distribution, slippage tiers, " +
    "buy/sell capacity, and depth grading."
  )
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [rich, bins] = await Promise.all([
        getRichPool(opts.poolId),
        getPoolBins(opts.poolId),
      ]);

      if (!bins.bins || bins.bins.length === 0) {
        throw new Error("No bins returned for this pool");
      }

      const profile = await buildDepthProfile(opts.poolId, rich, bins);

      const tier1 = profile.slippageTiers.find((t) => t.slippagePct === 1.0);
      const verdict = profile.depthGrade === "deep"
        ? `${profile.pair} has deep liquidity (score ${profile.depthScore}). Can absorb ~$${tier1?.buyCapacityUsd ?? 0} buy / ~$${tier1?.sellCapacityUsd ?? 0} sell within 1% slippage.`
        : profile.depthGrade === "moderate"
        ? `${profile.pair} has moderate depth (score ${profile.depthScore}). Larger swaps will move the price. ${profile.imbalanceDirection !== "balanced" ? `Liquidity is ${profile.imbalanceDirection}.` : ""}`
        : `${profile.pair} has shallow/empty depth (score ${profile.depthScore}). High slippage risk for any meaningful swap size.`;

      printResult({
        network: NETWORK,
        ...profile,
        verdict,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      printError(error);
    }
  });

// ---------------------------------------------------------------------------
// slippage
// ---------------------------------------------------------------------------
program
  .command("slippage")
  .description("Quick slippage estimate: how much can be swapped at each price impact tier?")
  .requiredOption("--pool-id <id>", "HODLMM pool identifier (e.g. dlmm_1)")
  .action(async (opts: { poolId: string }) => {
    try {
      const [rich, bins] = await Promise.all([
        getRichPool(opts.poolId),
        getPoolBins(opts.poolId),
      ]);

      if (!bins.bins || bins.bins.length === 0) {
        throw new Error("No bins returned for this pool");
      }

      const profile = await buildDepthProfile(opts.poolId, rich, bins);

      printResult({
        network: NETWORK,
        poolId: opts.poolId,
        pair: profile.pair,
        activeBinId: profile.activeBinId,
        binStep: profile.binStep,
        depthGrade: profile.depthGrade,
        slippageTiers: profile.slippageTiers,
        note: "buyCapacityUsd = max USD value of tokenY (quote) available before price moves by slippagePct. sellCapacityUsd = max USD value of tokenX (base) available.",
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
