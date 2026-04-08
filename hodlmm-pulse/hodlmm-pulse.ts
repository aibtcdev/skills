#!/usr/bin/env bun
/**
 * hodlmm-pulse — Fee velocity & volume momentum tracker for Bitflow HODLMM pools.
 *
 * Detects fee spikes and volume acceleration by comparing today's activity
 * against the 7-day rolling baseline. Builds a local time-series via `track`
 * so trend direction (accelerating / stable / cooling) improves with each poll.
 *
 * The natural complement to hodlmm-advisor: advisor answers "where", pulse
 * answers "when". Use pulse to detect entry windows; advisor to plan the trade.
 *
 * Usage:
 *   bun run skills/hodlmm-pulse/hodlmm-pulse.ts doctor
 *   bun run skills/hodlmm-pulse/hodlmm-pulse.ts scan [--min-tvl 1000]
 *   bun run skills/hodlmm-pulse/hodlmm-pulse.ts track --pool-id dlmm_1
 *   bun run skills/hodlmm-pulse/hodlmm-pulse.ts report [--pool-id dlmm_1]
 */

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const FETCH_TIMEOUT_MS = 30_000;
const NETWORK = "mainnet";
const STATE_FILE = join(homedir(), ".hodlmm-pulse-state.json");
const STATE_VERSION = 1;

/** How many snapshots to keep per pool (last 288 = 24h at 5-min intervals) */
const MAX_SNAPSHOTS_PER_POOL = 288;

/** Momentum thresholds: ratio of today's activity vs 7-day daily average */
const THRESHOLD_SPIKE = 3.0;      // 3x average → spike
const THRESHOLD_ELEVATED = 1.5;   // 1.5x → elevated
const THRESHOLD_COOLING = 0.5;    // below 0.5x → cooling
const MIN_BASELINE_USD = 0.01;    // avoid div/0 on brand-new pools

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr: number;
  apr24h: number;
  tokens: {
    tokenX: { symbol: string; priceUsd: number; decimals: number };
    tokenY: { symbol: string; priceUsd: number; decimals: number };
  };
}

interface AppPoolsResponse {
  data: AppPool[];
  nextCursor?: string;
  hasMore?: boolean;
}

type MomentumSignal = "spike" | "elevated" | "normal" | "cooling" | "flat";
type TrendDirection = "accelerating" | "stable" | "cooling" | "new" | "flat";

interface MomentumMetrics {
  feeVelocity: number;      // feesUsd1d / (feesUsd7d / 7) — 1.0 = average day
  volumeVelocity: number;   // volumeUsd1d / (volumeUsd7d / 7)
  aprSpike: number;         // apr24h / max(apr, 0.01) — recent vs long-run APR
  momentumScore: number;    // weighted composite 0–100+
  signal: MomentumSignal;
}

interface PulseSnapshot {
  ts: string;
  aprFull: number;
  apr24h: number;
  feesUsd1d: number;
  feesUsd7d: number;
  volumeUsd1d: number;
  volumeUsd7d: number;
  tvlUsd: number;
  metrics: MomentumMetrics;
  trend: TrendDirection;
  deltaFeeVelocity: number | null;   // change from previous snapshot
  deltaApr24h: number | null;
}

interface PulseState {
  version: number;
  pools: Record<string, PulseSnapshot[]>;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function getAllPools(): Promise<AppPool[]> {
  const data = await fetchJson<AppPoolsResponse>(`${BITFLOW_APP_API}/pools`);
  return data.data ?? [];
}

async function getPool(poolId: string): Promise<AppPool> {
  return fetchJson<AppPool>(`${BITFLOW_APP_API}/pools/${poolId}`);
}

// ---------------------------------------------------------------------------
// Momentum computation
// ---------------------------------------------------------------------------

function computeMomentum(pool: AppPool): MomentumMetrics {
  const dailyAvgFees = pool.feesUsd7d / 7;
  const dailyAvgVol = pool.volumeUsd7d / 7;

  const feeVelocity = pool.feesUsd1d / Math.max(dailyAvgFees, MIN_BASELINE_USD);
  const volumeVelocity = pool.volumeUsd1d / Math.max(dailyAvgVol, MIN_BASELINE_USD);
  const aprSpike = pool.apr24h / Math.max(pool.apr, MIN_BASELINE_USD);

  // Momentum score: fee velocity is the primary signal (60%),
  // volume velocity secondary (30%), apr spike tertiary (10%).
  // Anchored to 1.0 = average day → score 50.
  const momentumScore =
    feeVelocity * 0.6 * 50 +
    volumeVelocity * 0.3 * 50 +
    aprSpike * 0.1 * 50;

  let signal: MomentumSignal;
  if (pool.feesUsd1d < 0.01 && pool.volumeUsd1d < 0.01) {
    signal = "flat";
  } else if (feeVelocity >= THRESHOLD_SPIKE) {
    signal = "spike";
  } else if (feeVelocity >= THRESHOLD_ELEVATED) {
    signal = "elevated";
  } else if (feeVelocity < THRESHOLD_COOLING) {
    signal = "cooling";
  } else {
    signal = "normal";
  }

  return {
    feeVelocity: round(feeVelocity, 3),
    volumeVelocity: round(volumeVelocity, 3),
    aprSpike: round(aprSpike, 3),
    momentumScore: round(momentumScore, 1),
    signal,
  };
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Trend from snapshot history
// ---------------------------------------------------------------------------

function computeTrendFromHistory(
  history: PulseSnapshot[],
  current: MomentumMetrics
): TrendDirection {
  if (history.length === 0) return "new";
  if (history.length < 2) {
    // One prior snapshot: simple delta
    const prev = history[history.length - 1]!.metrics.feeVelocity;
    if (current.feeVelocity > prev * 1.1) return "accelerating";
    if (current.feeVelocity < prev * 0.9) return "cooling";
    return "stable";
  }

  const recent = history.slice(-3).map((s) => s.metrics.feeVelocity);
  recent.push(current.feeVelocity);

  const deltas = recent.slice(1).map((v, i) => v - recent[i]!);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  if (current.signal === "flat") return "flat";
  if (avgDelta > 0.1) return "accelerating";
  if (avgDelta < -0.1) return "cooling";
  return "stable";
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function loadState(): PulseState {
  if (!existsSync(STATE_FILE)) {
    return { version: STATE_VERSION, pools: {} };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as PulseState;
    if (parsed.version !== STATE_VERSION) {
      return { version: STATE_VERSION, pools: {} };
    }
    return parsed;
  } catch {
    return { version: STATE_VERSION, pools: {} };
  }
}

function saveState(state: PulseState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function appendSnapshot(
  state: PulseState,
  poolId: string,
  snapshot: PulseSnapshot
): void {
  if (!state.pools[poolId]) state.pools[poolId] = [];
  state.pools[poolId]!.push(snapshot);
  // Trim to rolling window
  if (state.pools[poolId]!.length > MAX_SNAPSHOTS_PER_POOL) {
    state.pools[poolId] = state.pools[poolId]!.slice(-MAX_SNAPSHOTS_PER_POOL);
  }
}

// ---------------------------------------------------------------------------
// Snapshot factory
// ---------------------------------------------------------------------------

function buildSnapshot(pool: AppPool, history: PulseSnapshot[]): PulseSnapshot {
  const metrics = computeMomentum(pool);
  const trend = computeTrendFromHistory(history, metrics);
  const prev = history.length > 0 ? history[history.length - 1]! : null;

  return {
    ts: new Date().toISOString(),
    aprFull: pool.apr,
    apr24h: pool.apr24h,
    feesUsd1d: pool.feesUsd1d,
    feesUsd7d: pool.feesUsd7d,
    volumeUsd1d: pool.volumeUsd1d,
    volumeUsd7d: pool.volumeUsd7d,
    tvlUsd: pool.tvlUsd,
    metrics,
    trend,
    deltaFeeVelocity: prev
      ? round(metrics.feeVelocity - prev.metrics.feeVelocity, 3)
      : null,
    deltaApr24h: prev ? round(pool.apr24h - prev.apr24h, 2) : null,
  };
}

// ---------------------------------------------------------------------------
// Signal emoji & action text
// ---------------------------------------------------------------------------

function signalEmoji(signal: MomentumSignal): string {
  return {
    spike: "🔥",
    elevated: "📈",
    normal: "〰️",
    cooling: "📉",
    flat: "⬜",
  }[signal];
}

function trendEmoji(trend: TrendDirection): string {
  return {
    accelerating: "⬆️",
    stable: "↔️",
    cooling: "⬇️",
    new: "🆕",
    flat: "—",
  }[trend];
}

function actionText(signal: MomentumSignal, trend: TrendDirection): string {
  if (signal === "spike" && trend === "accelerating")
    return "ENTRY WINDOW — fee spike accelerating. Run hodlmm-advisor entry-plan immediately.";
  if (signal === "spike")
    return "WATCH CLOSELY — fee spike detected. Verify with hodlmm-advisor before acting.";
  if (signal === "elevated" && trend === "accelerating")
    return "MONITOR — elevated fees trending up. Potential entry window forming.";
  if (signal === "elevated")
    return "MONITOR — above-average fee capture. Watch next 2–3 polls.";
  if (signal === "cooling")
    return "HOLD — fee velocity declining. Not an entry window.";
  if (signal === "flat")
    return "SKIP — no meaningful activity.";
  return "HOLD — activity within normal range.";
}

// ---------------------------------------------------------------------------
// Subcommand: doctor
// ---------------------------------------------------------------------------

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; status: "ok" | "fail"; detail: string }> =
    [];

  // 1. App pools API
  try {
    const data = await fetchJson<AppPoolsResponse>(`${BITFLOW_APP_API}/pools`);
    const count = data.data?.length ?? 0;
    checks.push({
      check: "bitflow_app_api",
      status: "ok",
      detail: `${BITFLOW_APP_API}/pools reachable — ${count} pools returned`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_app_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 2. App single-pool detail (used by track)
  try {
    const p = await fetchJson<AppPool>(`${BITFLOW_APP_API}/pools/dlmm_1`);
    checks.push({
      check: "bitflow_pool_detail",
      status: "ok",
      detail: `dlmm_1 feesUsd1d: $${p.feesUsd1d}, apr24h: ${p.apr24h}%`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_pool_detail",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. Quotes pool list (sanity cross-check)
  try {
    const data = await fetchJson<{ pools: unknown[] }>(
      `${BITFLOW_QUOTES_API}/pools`
    );
    checks.push({
      check: "bitflow_quotes_api",
      status: "ok",
      detail: `${BITFLOW_QUOTES_API}/pools reachable — ${data.pools?.length ?? 0} pools`,
    });
  } catch (e) {
    checks.push({
      check: "bitflow_quotes_api",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 4. State file writability
  try {
    const state = loadState();
    saveState(state);
    const trackedCount = Object.keys(state.pools).length;
    const totalSnaps = Object.values(state.pools).reduce(
      (a, arr) => a + arr.length,
      0
    );
    checks.push({
      check: "state_file",
      status: "ok",
      detail: `${STATE_FILE} readable/writable — ${trackedCount} pools tracked, ${totalSnaps} snapshots`,
    });
  } catch (e) {
    checks.push({
      check: "state_file",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const allOk = checks.every((c) => c.status === "ok");
  out({
    status: allOk ? "ready" : "degraded",
    network: NETWORK,
    checks,
    note: "Read-only skill — no wallet required",
  });
  if (!allOk) process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: scan
// ---------------------------------------------------------------------------

async function scan(opts: { minTvl: number }): Promise<void> {
  const allPools = await getAllPools();
  const eligible = allPools.filter((p) => p.tvlUsd >= opts.minTvl);

  const ranked = eligible
    .map((pool) => {
      const metrics = computeMomentum(pool);
      return { pool, metrics };
    })
    .sort((a, b) => b.metrics.momentumScore - a.metrics.momentumScore);

  const results = ranked.map(({ pool, metrics }) => ({
    poolId: pool.poolId,
    pair: `${pool.tokens.tokenX.symbol}-${pool.tokens.tokenY.symbol}`,
    signal: `${signalEmoji(metrics.signal)} ${metrics.signal}`,
    action: actionText(metrics.signal, "new"),
    metrics: {
      feeVelocity: metrics.feeVelocity,
      volumeVelocity: metrics.volumeVelocity,
      momentumScore: metrics.momentumScore,
    },
    raw: {
      feesUsd1d: `$${pool.feesUsd1d.toFixed(2)}`,
      feesUsd7dAvg: `$${(pool.feesUsd7d / 7).toFixed(2)}/day`,
      volumeUsd1d: `$${pool.volumeUsd1d.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      apr24h: `${pool.apr24h.toFixed(2)}%`,
      aprFull: `${pool.apr.toFixed(2)}%`,
      tvlUsd: `$${pool.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    },
  }));

  const topAlert = results.find(
    (r) =>
      r.signal.includes("spike") ||
      r.signal.includes("elevated")
  );

  out({
    status: "success",
    network: NETWORK,
    timestamp: new Date().toISOString(),
    scannedPools: results.length,
    topAlert: topAlert
      ? `${topAlert.poolId} (${topAlert.pair}): ${topAlert.action}`
      : "No active momentum signals — all pools near baseline.",
    ranked: results,
    note: "Run `track --pool-id <id>` repeatedly to build time-series and unlock trend direction.",
  });
}

// ---------------------------------------------------------------------------
// Subcommand: track
// ---------------------------------------------------------------------------

async function track(opts: { poolId: string }): Promise<void> {
  const state = loadState();
  const history = state.pools[opts.poolId] ?? [];

  const pool = await getPool(opts.poolId);
  const snapshot = buildSnapshot(pool, history);

  appendSnapshot(state, opts.poolId, snapshot);
  saveState(state);

  const snapshotCount = state.pools[opts.poolId]!.length;
  const firstTs = state.pools[opts.poolId]![0]!.ts;

  out({
    status: "success",
    network: NETWORK,
    timestamp: snapshot.ts,
    poolId: opts.poolId,
    pair: `${pool.tokens.tokenX.symbol}-${pool.tokens.tokenY.symbol}`,
    signal: `${signalEmoji(snapshot.metrics.signal)} ${snapshot.metrics.signal}`,
    trend: `${trendEmoji(snapshot.trend)} ${snapshot.trend}`,
    action: actionText(snapshot.metrics.signal, snapshot.trend),
    metrics: {
      feeVelocity: snapshot.metrics.feeVelocity,
      volumeVelocity: snapshot.metrics.volumeVelocity,
      aprSpike: snapshot.metrics.aprSpike,
      momentumScore: snapshot.metrics.momentumScore,
    },
    delta: {
      feeVelocity:
        snapshot.deltaFeeVelocity !== null
          ? (snapshot.deltaFeeVelocity >= 0 ? "+" : "") +
            snapshot.deltaFeeVelocity.toFixed(3)
          : null,
      apr24h:
        snapshot.deltaApr24h !== null
          ? (snapshot.deltaApr24h >= 0 ? "+" : "") +
            snapshot.deltaApr24h.toFixed(2) +
            "%"
          : null,
    },
    raw: {
      feesUsd1d: `$${pool.feesUsd1d.toFixed(2)}`,
      feesUsd7dDailyAvg: `$${(pool.feesUsd7d / 7).toFixed(2)}`,
      volumeUsd1d: `$${pool.volumeUsd1d.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      apr24h: `${pool.apr24h.toFixed(2)}%`,
      aprFull: `${pool.apr.toFixed(2)}%`,
      tvlUsd: `$${pool.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    },
    tracking: {
      snapshotCount,
      trackingSince: firstTs,
      stateFile: STATE_FILE,
    },
  });
}

// ---------------------------------------------------------------------------
// Subcommand: report
// ---------------------------------------------------------------------------

async function report(opts: { poolId?: string }): Promise<void> {
  const state = loadState();
  const poolIds = opts.poolId
    ? [opts.poolId]
    : Object.keys(state.pools);

  if (poolIds.length === 0) {
    out({
      status: "success",
      network: NETWORK,
      timestamp: new Date().toISOString(),
      message:
        "No pools tracked yet. Run `track --pool-id <id>` to start building a time-series.",
      pools: [],
    });
    return;
  }

  const summaries = poolIds
    .map((id) => {
      const history = state.pools[id];
      if (!history || history.length === 0) return null;

      const latest = history[history.length - 1]!;
      const oldest = history[0]!;
      const peakSnapshot = history.reduce((best, s) =>
        s.metrics.momentumScore > best.metrics.momentumScore ? s : best
      );

      // Trend over full history
      const velocities = history.map((s) => s.metrics.feeVelocity);
      const firstHalf = velocities
        .slice(0, Math.floor(velocities.length / 2))
        .reduce((a, b) => a + b, 0) / Math.max(Math.floor(velocities.length / 2), 1);
      const secondHalf = velocities
        .slice(Math.floor(velocities.length / 2))
        .reduce((a, b) => a + b, 0) /
        Math.max(velocities.length - Math.floor(velocities.length / 2), 1);
      const overallTrend =
        velocities.length < 2
          ? "insufficient data"
          : secondHalf > firstHalf * 1.1
            ? "accelerating ⬆️"
            : secondHalf < firstHalf * 0.9
              ? "cooling ⬇️"
              : "stable ↔️";

      return {
        poolId: id,
        snapshotCount: history.length,
        trackingSince: oldest.ts,
        latest: {
          ts: latest.ts,
          signal: `${signalEmoji(latest.metrics.signal)} ${latest.metrics.signal}`,
          trend: `${trendEmoji(latest.trend)} ${latest.trend}`,
          action: actionText(latest.metrics.signal, latest.trend),
          feeVelocity: latest.metrics.feeVelocity,
          apr24h: `${latest.apr24h.toFixed(2)}%`,
          feesUsd1d: `$${latest.feesUsd1d.toFixed(2)}`,
        },
        peak: {
          ts: peakSnapshot.ts,
          feeVelocity: peakSnapshot.metrics.feeVelocity,
          apr24h: `${peakSnapshot.apr24h.toFixed(2)}%`,
          signal: `${signalEmoji(peakSnapshot.metrics.signal)} ${peakSnapshot.metrics.signal}`,
        },
        overallTrend,
      };
    })
    .filter(Boolean);

  // Prioritise pools with active signals at top
  summaries.sort((a, b) => {
    if (!a || !b) return 0;
    const priority = { spike: 3, elevated: 2, normal: 1, cooling: 0, flat: -1 };
    const aSignal = (a.latest.signal.match(/\w+$/) ?? ["normal"])[0] as MomentumSignal;
    const bSignal = (b.latest.signal.match(/\w+$/) ?? ["normal"])[0] as MomentumSignal;
    return (priority[bSignal] ?? 0) - (priority[aSignal] ?? 0);
  });

  const actionableAlerts = summaries.filter((s) =>
    s?.latest.signal.includes("spike") || s?.latest.signal.includes("elevated")
  );

  out({
    status: "success",
    network: NETWORK,
    timestamp: new Date().toISOString(),
    summary: {
      poolsTracked: summaries.length,
      activeAlerts: actionableAlerts.length,
      recommendation:
        actionableAlerts.length > 0
          ? `${actionableAlerts.length} pool(s) with elevated/spike signals — run hodlmm-advisor best-pools for entry planning.`
          : "All tracked pools within normal range. Continue monitoring.",
    },
    pools: summaries,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-pulse")
  .description(
    "Fee velocity and volume momentum tracker for Bitflow HODLMM pools. " +
      "Detects entry windows by comparing today's fee capture against the 7-day baseline. " +
      "Read-only, no wallet required."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify API connectivity and state file readiness")
  .action(async () => {
    try {
      await doctor();
    } catch (e) {
      fail(e);
    }
  });

program
  .command("scan")
  .description(
    "Snapshot all pools, compute momentum scores, rank by fee velocity"
  )
  .option(
    "--min-tvl <usd>",
    "Minimum pool TVL in USD to include",
    (v) => parseFloat(v),
    500
  )
  .action(async (opts: { minTvl: number }) => {
    try {
      await scan(opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("track")
  .description(
    "Append a timestamped snapshot for a pool and output trend direction. " +
      "Run repeatedly (e.g. every 5 min via cron) to build time-series."
  )
  .requiredOption("--pool-id <id>", "Pool identifier (e.g. dlmm_1)")
  .action(async (opts: { poolId: string }) => {
    try {
      await track(opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("report")
  .description(
    "Summarise all tracked pools from local state: current signal, trend over time, peak momentum."
  )
  .option("--pool-id <id>", "Limit report to a single pool")
  .action(async (opts: { poolId?: string }) => {
    try {
      await report(opts);
    } catch (e) {
      fail(e);
    }
  });

program.parse(process.argv);
