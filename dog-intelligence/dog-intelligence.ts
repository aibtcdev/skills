#!/usr/bin/env bun
/**
 * dog-intelligence — On-chain intelligence for DOG•GO•TO•THE•MOON rune
 *
 * Powered by DOG DATA (dogdata.xyz) — Bitcoin Core + Ord full node.
 * Read-only. No chain writes. No wallet access.
 *
 * Usage:
 *   bun run dog-intelligence.ts doctor
 *   bun run dog-intelligence.ts run --action pulse
 *   bun run dog-intelligence.ts run --action whales
 *   bun run dog-intelligence.ts run --action diamond
 *   bun run dog-intelligence.ts run --action airdrop
 *   bun run dog-intelligence.ts run --action lth-sth
 *   bun run dog-intelligence.ts run --action markets
 *   bun run dog-intelligence.ts run --action multichain
 *   bun run dog-intelligence.ts run --action bitcoin
 *   bun run dog-intelligence.ts install-packs
 */

const DOGDATA_BASE = "https://www.dogdata.xyz/api";
const API_KEY = process.env.DOGDATA_API_KEY || "";
const TIMEOUT_MS = 10_000;

// --- Output envelope ---

interface Output {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown> | null;
  error: string | null;
  source: string;
  timestamp: string;
}

// Round a number to N decimals, preserving 0. Returns null only for non-numbers
// (typeof check avoids the truthy-null trap where `0 ? ... : null` returns null).
function num(x: unknown, decimals = 2): number | null {
  return typeof x === "number" && Number.isFinite(x) ? +x.toFixed(decimals) : null;
}

function out(status: Output["status"], action: string, data: Output["data"], error: string | null = null): void {
  const result: Output = {
    status,
    action,
    data,
    error,
    source: "dogdata.xyz",
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
}

// --- HTTP helpers ---

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Accept": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

async function get(path: string): Promise<{ ok: boolean; status: number; data: unknown; retryAfter?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DOGDATA_BASE}${path}`, {
      headers: headers(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "60", 10);
      return { ok: false, status: 429, data: null, retryAfter };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, data: text };
    }
    const json = await res.json();
    return { ok: true, status: res.status, data: json };
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null, retryAfter: undefined };
  }
}

async function fetchMultiple(paths: string[]): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled(paths.map((p) => get(p)));
  const output: Record<string, unknown> = {};
  for (let i = 0; i < paths.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      if (r.value.status === 429) {
        out("blocked", "rate_limited", null, `Rate limited on ${paths[i]}. Retry after ${r.value.retryAfter}s.`);
        process.exit(0);
      }
      output[paths[i]] = r.value.ok ? r.value.data : null;
    } else {
      output[paths[i]] = null;
    }
  }
  return output;
}

// --- Commands ---

async function doctor(): Promise<void> {
  const health = await get("/health");

  const checks: Record<string, unknown> = {
    api_reachable: health.ok,
    api_status: health.ok ? (health.data as Record<string, unknown>)?.status : "unreachable",
    api_key_configured: API_KEY ? "yes" : "no (using public tier — 20 req/hr)",
    api_key_masked: API_KEY ? `${API_KEY.slice(0, 10)}***` : "none",
  };

  if (health.ok) {
    const hd = health.data as Record<string, unknown>;
    const hChecks = hd.checks as Record<string, Record<string, unknown>> | undefined;
    if (hChecks) {
      checks.redis = hChecks.redis?.status || "unknown";
      checks.holders_data = hChecks.holders_data?.status || "unknown";
      checks.holders_details = hChecks.holders_data?.details || "";
      checks.transactions = hChecks.transactions?.status || "unknown";
    }
    checks.version = hd.version || "unknown";
    checks.uptime_seconds = hd.uptime_seconds || 0;
  }

  // Quick smoke-test new endpoints
  const smokeTests = await fetchMultiple(["/markets", "/whale-alerts", "/multichain/stats"]);
  checks.endpoint_markets = smokeTests["/markets"] ? "ok" : "unreachable";
  checks.endpoint_whale_alerts = smokeTests["/whale-alerts"] ? "ok" : "unreachable";
  checks.endpoint_multichain = smokeTests["/multichain/stats"] ? "ok" : "unreachable";

  const allOk = health.ok && checks.api_status === "healthy";
  out(
    allOk ? "success" : "error",
    allOk ? "All systems operational. Ready for queries." : "API health check failed. Investigate before running actions.",
    checks,
    allOk ? null : `API returned status: ${health.status}`,
  );
}

async function pulse(): Promise<void> {
  const raw = await fetchMultiple([
    "/dog-rune/stats",
    "/markets",
    "/metrics/realized-cap",
    "/forensic/summary",
    "/metrics/utxo-age",
  ]);

  const stats = raw["/dog-rune/stats"] as Record<string, unknown> | null;
  const marketsData = raw["/markets"] as Record<string, unknown> | null;
  const realized = raw["/metrics/realized-cap"] as Record<string, unknown> | null;
  const forensic = raw["/forensic/summary"] as Record<string, unknown> | null;
  const utxoAge = raw["/metrics/utxo-age"] as Record<string, unknown> | null;

  // Extract price from aggregated markets (use Kraken as primary, fallback to first ticker)
  const tickers = (marketsData?.tickers as Record<string, unknown>[]) ?? [];
  const krakenTicker = tickers.find((t) => (t.market as string)?.toLowerCase() === "kraken");
  const primaryTicker = krakenTicker ?? tickers[0] ?? null;
  const currentPrice = primaryTicker ? (primaryTicker.price as number) : null;

  // Aggregate volume across all exchanges
  const totalVolumeUsd = tickers.reduce((s, t) => s + ((t.volumeUsd as number) || 0), 0);

  // 24h price change from Kraken raw if available
  const krakenRaw = raw["/price/kraken"] as Record<string, unknown> | null;
  const krakenResult = krakenRaw?.result as Record<string, Record<string, unknown>> | undefined;
  const dogusd = krakenResult?.DOGUSD;
  const openPrice = dogusd?.o ? parseFloat(dogusd.o as string) : null;
  const change24hPct = currentPrice && openPrice ? ((currentPrice - openPrice) / openPrice) * 100 : null;

  // Exchange count
  const exchangeCount = tickers.length;

  // MVRV interpretation
  const mvrv = realized?.mvrv_ratio as number | null;
  let mvrvSignal = "neutral";
  if (mvrv !== null) {
    if (mvrv < 1.0) mvrvSignal = "undervalued — trading below realized value (accumulation zone)";
    else if (mvrv > 3.0) mvrvSignal = "overheated — distribution risk";
    else mvrvSignal = "fair value range";
  }

  // Forensic stats
  const forensicStats = forensic?.statistics as Record<string, unknown> | undefined;

  // LTH vs STH
  const lthPct = utxoAge?.lth_percentage as number | null;
  const sthPct = utxoAge?.sth_percentage as number | null;

  // Top exchanges by volume
  const topExchanges = tickers
    .sort((a, b) => ((b.volumeUsd as number) || 0) - ((a.volumeUsd as number) || 0))
    .slice(0, 5)
    .map((t) => ({
      market: t.market,
      pair: t.pair,
      price_usd: t.price,
      volume_usd: Math.round((t.volumeUsd as number) || 0),
    }));

  const lthSthRatio = typeof lthPct === "number" && typeof sthPct === "number" && sthPct !== 0
    ? +(lthPct / sthPct).toFixed(2)
    : null;

  out("success", "DOG pulse snapshot. Use this data for market analysis and signal generation.", {
    price: {
      usd: currentPrice,
      change_24h_pct: num(change24hPct, 2),
      total_volume_usd: Math.round(totalVolumeUsd),
      exchange_count: exchangeCount,
      top_exchanges: topExchanges,
    },
    fundamentals: {
      total_holders: stats?.totalHolders ?? null,
      circulating_supply: stats?.circulatingSupply ?? null,
      total_utxos: stats?.totalUtxos ?? null,
      market_cap: realized?.market_cap ?? null,
      realized_cap: realized?.realized_cap ?? null,
      mvrv_ratio: mvrv,
      mvrv_signal: mvrvSignal,
    },
    conviction: {
      lth_percentage: num(lthPct, 2),
      sth_percentage: num(sthPct, 2),
      lth_sth_ratio: lthSthRatio,
      median_utxo_age_days: num(utxoAge?.median_age_days, 1),
    },
    forensic: {
      diamond_paws: (forensicStats?.by_pattern as Record<string, number>)?.diamond_paws ?? forensicStats?.diamond_hands ?? null,
      dog_legends: (forensicStats?.by_pattern as Record<string, number>)?.dog_legend ?? null,
      paper_hands: (forensicStats?.by_pattern as Record<string, number>)?.paper_hands ?? null,
      retention_rate_pct: num(forensicStats?.retention_rate, 2),
      total_analyzed: forensicStats?.total_analyzed ?? null,
    },
  });
}

async function whales(): Promise<void> {
  const raw = await fetchMultiple([
    "/whale-alerts",
    "/dog-rune/top-holders",
  ]);

  const whaleData = raw["/whale-alerts"] as Record<string, unknown> | null;
  const topHoldersData = raw["/dog-rune/top-holders"] as Record<string, unknown> | null;

  // Parse whale alerts
  const alerts = (whaleData?.alerts as Record<string, unknown>[]) ?? [];

  // Format alerts by severity
  const criticalAlerts = alerts.filter((a) => a.severity === "CRITICAL");
  const highAlerts = alerts.filter((a) => a.severity === "HIGH");

  const formattedAlerts = alerts.slice(0, 25).map((a) => ({
    chain: a.chain,
    severity: a.severity,
    amount_dog: a.total_dog_formatted ?? a.total_dog_moved,
    amount_dog_raw: a.total_dog_moved,
    usd_value: a.usd_value,
    classification: a.classification,
    type: a.type,
    from: a.from_short ?? a.from,
    to: a.to_short ?? a.to,
    block: a.block_height,
    time_ago: a.time_ago,
    explorer_url: a.explorer_url,
  }));

  // Parse top holders from dedicated endpoint
  const holders = (topHoldersData?.topHolders as Record<string, unknown>[]) ?? [];
  const topHolders = holders.slice(0, 25).map((h: Record<string, unknown>, i: number) => ({
    rank: h.rank ?? i + 1,
    address: h.address,
    balance_dog: h.total_dog ?? (typeof h.total_amount === "number" ? h.total_amount / 1e5 : null),
    utxo_count: h.utxo_count ?? null,
  }));

  // Concentration
  const top10Sum = topHolders.slice(0, 10).reduce((s, h) => s + ((h.balance_dog as number) || 0), 0);
  const totalSupply = 100_000_000_000;
  const top10Pct = (top10Sum / totalSupply) * 100;

  out("success", "Whale intelligence report. Multi-chain large moves and top holder positions.", {
    whale_alerts: {
      total: whaleData?.total_alerts ?? alerts.length,
      critical_count: criticalAlerts.length,
      high_count: highAlerts.length,
      threshold: whaleData?.threshold ?? "1M DOG",
      chains_monitored: whaleData?.chains ?? ["bitcoin"],
      dog_price_usd: whaleData?.dog_price_usd ?? null,
      alerts_by_chain: whaleData?.alerts_by_chain ?? null,
    },
    recent_moves: formattedAlerts,
    top_holders: topHolders,
    concentration: {
      top_10_supply_pct: +top10Pct.toFixed(2),
      top_10_total_dog: Math.round(top10Sum),
    },
  });
}

async function diamond(): Promise<void> {
  const raw = await fetchMultiple([
    "/forensic/summary",
    "/forensic/profiles?limit=10&pattern=diamond_paws",
  ]);

  const summary = raw["/forensic/summary"] as Record<string, unknown> | null;
  const profilesRaw = raw["/forensic/profiles?limit=10&pattern=diamond_paws"];

  const stats = summary?.statistics as Record<string, unknown> | undefined;
  const patterns = stats?.by_pattern as Record<string, number> | undefined;

  // Profile data
  let sampleProfiles: unknown[] = [];
  if (Array.isArray(profilesRaw)) {
    sampleProfiles = profilesRaw.slice(0, 10);
  } else if (profilesRaw && typeof profilesRaw === "object") {
    const pr = profilesRaw as Record<string, unknown>;
    if (Array.isArray(pr.profiles)) sampleProfiles = pr.profiles.slice(0, 10);
  }

  out("success", "Diamond Score forensics. Holder conviction analysis across 14 behavioral categories.", {
    summary: {
      total_analyzed: stats?.total_analyzed ?? null,
      still_holding: stats?.still_holding ?? null,
      sold_everything: stats?.sold_everything ?? null,
      retention_rate_pct: num(stats?.retention_rate, 2),
      accumulator_rate_pct: num(stats?.accumulator_rate, 2),
      dumper_rate_pct: num(stats?.dumper_rate, 2),
    },
    categories: {
      diamond_paws: patterns?.diamond_paws ?? null,
      dog_legend: patterns?.dog_legend ?? null,
      hodl_hero: patterns?.hodl_hero ?? null,
      rune_master: patterns?.rune_master ?? null,
      ordinal_believer: patterns?.ordinal_believer ?? null,
      satoshi_visionary: patterns?.satoshi_visionary ?? null,
      steady_holder: patterns?.steady_holder ?? null,
      btc_maximalist: patterns?.btc_maximalist ?? null,
      profit_taker: patterns?.profit_taker ?? null,
      early_exit: patterns?.early_exit ?? null,
      panic_seller: patterns?.panic_seller ?? null,
      paper_hands: patterns?.paper_hands ?? null,
    },
    conviction_tiers: {
      diamond: (patterns?.diamond_paws ?? 0) + (patterns?.dog_legend ?? 0) + (patterns?.hodl_hero ?? 0) + (patterns?.rune_master ?? 0),
      neutral: (patterns?.steady_holder ?? 0) + (patterns?.ordinal_believer ?? 0) + (patterns?.btc_maximalist ?? 0) + (patterns?.satoshi_visionary ?? 0),
      weak: (patterns?.profit_taker ?? 0) + (patterns?.early_exit ?? 0) + (patterns?.panic_seller ?? 0) + (patterns?.paper_hands ?? 0),
    },
    sample_profiles: sampleProfiles,
  });
}

async function airdrop(): Promise<void> {
  const raw = await fetchMultiple([
    "/airdrop/summary",
    "/airdrop/recipients?limit=10",
  ]);

  const summary = raw["/airdrop/summary"] as Record<string, unknown> | null;
  const recipientsRaw = raw["/airdrop/recipients?limit=10"];

  let topRecipients: unknown[] = [];
  if (Array.isArray(recipientsRaw)) {
    topRecipients = recipientsRaw.slice(0, 10);
  } else if (recipientsRaw && typeof recipientsRaw === "object") {
    const rr = recipientsRaw as Record<string, unknown>;
    if (Array.isArray(rr.recipients)) topRecipients = rr.recipients.slice(0, 10);
  }

  const totalRecipients = summary?.total_recipients as number ?? 0;
  const stillHolding = summary?.still_holding as number ?? 0;
  const soldEverything = summary?.sold_everything as number ?? 0;
  const retentionRate = totalRecipients > 0 ? (stillHolding / totalRecipients) * 100 : 0;

  out("success", "Airdrop origin story. The largest fair rune distribution in Bitcoin history.", {
    origin: {
      event: "Runestone → DOG Airdrop",
      total_supply: "100,000,000,000 DOG",
      pre_sale: "zero",
      vc_allocation: "zero",
      mechanism: "Fair airdrop to Runestone holders at Bitcoin halving block 840,000",
      rune_id: "840000:3",
      date: "April 2024 (Bitcoin halving)",
    },
    distribution: {
      total_recipients: totalRecipients,
      still_holding: stillHolding,
      sold_everything: soldEverything,
      retention_rate_pct: +retentionRate.toFixed(2),
      recipients_with_multiple_airdrops: summary?.recipients_with_multiple ?? null,
      total_airdrop_events: summary?.total_airdrops ?? null,
      current_holder_balance_dog: summary?.total_current_balance ?? null,
    },
    narrative: `The largest fair rune distribution ever: 100 billion DOG tokens airdropped to ${totalRecipients.toLocaleString()} Runestone holders at Bitcoin's 4th halving. Zero pre-sale, zero VC, zero team allocation. ${retentionRate.toFixed(1)}% of original recipients still hold — ${stillHolding.toLocaleString()} diamond hands from day one.`,
    top_recipients: topRecipients,
  });
}

async function lthSth(): Promise<void> {
  const raw = await fetchMultiple([
    "/metrics/utxo-age",
    "/metrics/holder-concentration",
    "/metrics/supply-profit-loss",
  ]);

  const utxoAge = raw["/metrics/utxo-age"] as Record<string, unknown> | null;
  const concentration = raw["/metrics/holder-concentration"] as Record<string, unknown> | null;
  const profitLoss = raw["/metrics/supply-profit-loss"] as Record<string, unknown> | null;

  const lthPct = utxoAge?.lth_percentage as number | null;
  const sthPct = utxoAge?.sth_percentage as number | null;
  const lthSthRatio = typeof lthPct === "number" && typeof sthPct === "number" && sthPct > 0
    ? +(lthPct / sthPct).toFixed(2)
    : null;

  // Interpret
  let convictionSignal = "neutral";
  if (typeof lthPct === "number") {
    if (lthPct > 75) convictionSignal = "strong — majority of supply in long-term hands, structurally bullish";
    else if (lthPct > 50) convictionSignal = "moderate — more holders are long-term than short-term";
    else convictionSignal = "weak — short-term holders dominate, higher sell pressure risk";
  }

  // HODL waves — store as numeric percentages (consistent with other percentage fields)
  const ageDist = utxoAge?.age_distribution as Record<string, number> | undefined;
  const totalSupplyRaw = (utxoAge?.total_supply as number) ?? 1;
  const hodlWaves: Record<string, number> = {};
  if (ageDist) {
    for (const [range, supply] of Object.entries(ageDist)) {
      hodlWaves[range] = +((supply / totalSupplyRaw) * 100).toFixed(2);
    }
  }

  out("success", "LTH vs STH conviction analysis — the trademark DOG intelligence metric.", {
    lth_vs_sth: {
      lth_percentage: num(lthPct, 2),
      sth_percentage: num(sthPct, 2),
      lth_sth_ratio: lthSthRatio,
      conviction_signal: convictionSignal,
      lth_threshold_days: 155,
    },
    utxo_age: {
      total_utxos: utxoAge?.total_utxos ?? null,
      avg_age_days: num(utxoAge?.avg_age_days, 1),
      median_age_days: num(utxoAge?.median_age_days, 1),
    },
    hodl_waves: hodlWaves,
    concentration: {
      gini_coefficient: num(concentration?.gini_coefficient, 4),
      top_10_pct: num(concentration?.top10_supply_pct, 2),
      top_100_pct: num(concentration?.top100_supply_pct, 2),
      top_1000_pct: num(concentration?.top1000_supply_pct, 2),
      total_holders: concentration?.total_holders ?? null,
    },
    supply_health: {
      in_profit_pct: num(profitLoss?.supply_in_profit_pct, 2),
      in_loss_pct: num(profitLoss?.supply_in_loss_pct, 2),
      current_price_usd: profitLoss?.current_price ?? null,
    },
  });
}

async function markets(): Promise<void> {
  const raw = await fetchMultiple([
    "/markets",
    "/price/kraken",
  ]);

  const marketsData = raw["/markets"] as Record<string, unknown> | null;
  const krakenRaw = raw["/price/kraken"] as Record<string, unknown> | null;

  const tickers = (marketsData?.tickers as Record<string, unknown>[]) ?? [];

  // Sort by volume
  const byVolume = [...tickers].sort((a, b) => ((b.volumeUsd as number) || 0) - ((a.volumeUsd as number) || 0));

  // Aggregate stats
  const totalVolumeUsd = byVolume.reduce((s, t) => s + ((t.volumeUsd as number) || 0), 0);
  const prices = byVolume.map((t) => t.price as number).filter(Boolean);
  const highestPrice = prices.length ? Math.max(...prices) : null;
  const lowestPrice = prices.length ? Math.min(...prices) : null;
  const spread = highestPrice && lowestPrice ? ((highestPrice - lowestPrice) / lowestPrice) * 100 : null;

  // Kraken 24h data
  const krakenResult = krakenRaw?.result as Record<string, Record<string, unknown>> | undefined;
  const dogusd = krakenResult?.DOGUSD;
  const high24h = dogusd?.h ? parseFloat((dogusd.h as string[])[1]) : null;
  const low24h = dogusd?.l ? parseFloat((dogusd.l as string[])[1]) : null;
  const open24h = dogusd?.o ? parseFloat(dogusd.o as string) : null;

  const formattedTickers = byVolume.map((t) => ({
    market: t.market,
    pair: t.pair,
    price_usd: t.price,
    volume_usd: Math.round((t.volumeUsd as number) || 0),
    volume_dog: t.volume,
    spread_pct: t.spread,
    trust_score: t.trustScore,
    trade_url: t.tradeUrl,
  }));

  out("success", "Full market snapshot across all DOG exchanges.", {
    aggregate: {
      exchange_count: tickers.length,
      total_volume_usd_24h: Math.round(totalVolumeUsd),
      highest_price_usd: highestPrice,
      lowest_price_usd: lowestPrice,
      price_spread_pct: num(spread, 4),
      high_24h_kraken: high24h,
      low_24h_kraken: low24h,
      open_24h_kraken: open24h,
    },
    exchanges: formattedTickers,
  });
}

async function multichain(): Promise<void> {
  const raw = await fetchMultiple([
    "/multichain/stats",
    "/multichain/holders?limit=10",
  ]);

  const statsData = raw["/multichain/stats"] as Record<string, unknown> | null;
  const holdersData = raw["/multichain/holders?limit=10"] as Record<string, unknown> | null;

  const chains = (statsData?.chains as Record<string, unknown>[]) ?? [];

  // Parse per-chain stats
  const chainSummaries = chains.map((c) => ({
    chain: c.chain,
    symbol: c.symbol,
    price_usd: c.price_usd,
    price_change_24h_pct: num(c.price_change_24h, 2),
    market_cap_usd: typeof c.market_cap_usd === "number" ? Math.round(c.market_cap_usd) : null,
    volume_24h_usd: typeof c.volume_24h_usd === "number" ? Math.round(c.volume_24h_usd) : null,
    liquidity_usd: typeof c.liquidity_usd === "number" ? Math.round(c.liquidity_usd) : null,
    holder_count: c.holder_count,
    circulating_supply: c.circulating_supply,
    contract: c.address,
    last_updated: c.last_updated,
  }));

  // Top cross-chain holders
  let holders: unknown[] = [];
  if (Array.isArray(holdersData)) {
    holders = holdersData.slice(0, 10);
  } else if (holdersData && typeof holdersData === "object") {
    const hd = holdersData as Record<string, unknown>;
    if (Array.isArray(hd.holders)) holders = hd.holders.slice(0, 10);
  }

  out("success", "Cross-chain DOG intelligence. Stacks and Solana bridged supply overview.", {
    aggregate: {
      total_holders_all_chains: statsData?.total_holders ?? null,
      total_market_cap_usd: typeof statsData?.total_market_cap_usd === "number" ? Math.round(statsData.total_market_cap_usd) : null,
      total_volume_24h_usd: typeof statsData?.total_volume_24h_usd === "number" ? Math.round(statsData.total_volume_24h_usd) : null,
      total_supply_all_chains: statsData?.total_supply_all_chains ?? null,
      last_updated: statsData?.last_updated ?? null,
    },
    chains: chainSummaries,
    top_holders: holders,
  });
}

async function bitcoin(): Promise<void> {
  const btcData = await get("/bitcoin");
  if (!btcData.ok) {
    if (btcData.status === 429) {
      out("blocked", "rate_limited", null, `Rate limited on /bitcoin. Retry after ${btcData.retryAfter ?? 60}s.`);
      return;
    }
    out("error", "bitcoin", null, `Failed to fetch Bitcoin network data: HTTP ${btcData.status}`);
    return;
  }

  const d = btcData.data as Record<string, unknown>;
  const diff = d.difficultyAdjustment as Record<string, unknown> | undefined;
  const hashrate = d.hashrate as Record<string, unknown> | undefined;
  const mempool = d.mempool as Record<string, unknown> | undefined;
  const fees = d.fees as Record<string, unknown> | undefined;
  const blocks = d.blocks as Record<string, unknown>[] | undefined;
  const latestBlock = blocks?.[0] as Record<string, unknown> | undefined;

  // Current hashrate in EH/s
  const currentHashrateRaw = hashrate?.currentHashrate as number | null;
  const currentHashrateEH = typeof currentHashrateRaw === "number" ? currentHashrateRaw / 1e18 : null;

  // Fee recommendations
  const feeRec = fees?.recommended as Record<string, unknown> | undefined;

  out("success", "Bitcoin network status. Context for DOG L1 activity and on-chain conditions.", {
    network: {
      latest_block: latestBlock?.height ?? null,
      latest_block_time: latestBlock?.timestamp ?? null,
      hashrate_eh_s: num(currentHashrateEH, 2),
      difficulty: num(hashrate?.currentDifficulty, 0),
    },
    difficulty_adjustment: {
      progress_pct: num(diff?.progressPercent, 2),
      estimated_change_pct: num(diff?.difficultyChange, 2),
      blocks_remaining: diff?.remainingBlocks ?? null,
      next_retarget_height: diff?.nextRetargetHeight ?? null,
    },
    mempool: {
      tx_count: mempool?.count ?? null,
      size_vb: mempool?.vsize ?? null,
      total_fees_sat: mempool?.total_fee ?? null,
    },
    fees: {
      fastest_sat_vb: feeRec?.fastestFee ?? null,
      half_hour_sat_vb: feeRec?.halfHourFee ?? null,
      hour_sat_vb: feeRec?.hourFee ?? null,
      economy_sat_vb: feeRec?.economyFee ?? null,
      minimum_sat_vb: feeRec?.minimumFee ?? null,
    },
  });
}

async function installPacks(): Promise<void> {
  out("success", "No additional packages required. dog-intelligence uses fetch (built into Bun) and the DOG DATA REST API. Optionally set DOGDATA_API_KEY env var for higher rate limits.", {
    required_dependencies: [],
    optional: {
      env_var: "DOGDATA_API_KEY",
      get_key: "POST https://www.dogdata.xyz/api/keys/generate with {\"email\": \"...\", \"name\": \"...\"}",
      free_tier: "100 req/hr",
      pro_tier: "5,000 req/hr",
      enterprise_tier: "50,000 req/hr",
      public_tier: "20 req/hr (no key needed)",
    },
  });
}

// --- Main ---

import { Command } from "commander";

const program = new Command();
program
  .name("dog-intelligence")
  .description("On-chain intelligence for DOG•GO•TO•THE•MOON rune (read-only)")
  .version("0.1.0");

program
  .command("doctor")
  .description("Probe DOG DATA API health + endpoint reachability")
  .action(async () => { await doctor(); });

program
  .command("install-packs")
  .description("Report optional env vars and rate-limit tiers")
  .action(async () => { await installPacks(); });

program
  .command("run")
  .description("Run a read-only intelligence action")
  .requiredOption("--action <name>", "pulse | whales | diamond | airdrop | lth-sth | markets | multichain | bitcoin")
  .action(async (opts: { action: string }) => {
    switch (opts.action) {
      case "pulse":      await pulse();      break;
      case "whales":     await whales();     break;
      case "diamond":    await diamond();    break;
      case "airdrop":    await airdrop();    break;
      case "lth-sth":    await lthSth();     break;
      case "markets":    await markets();    break;
      case "multichain": await multichain(); break;
      case "bitcoin":    await bitcoin();    break;
      default:
        out("error", "Unknown action", null,
          `Unknown action: ${opts.action}. Valid: pulse, whales, diamond, airdrop, lth-sth, markets, multichain, bitcoin`);
        process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  out("error", "Fatal error", null, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
