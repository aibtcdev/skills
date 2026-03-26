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
    "/price/kraken",
    "/metrics/realized-cap",
    "/forensic/summary",
    "/metrics/utxo-age",
  ]);

  const stats = raw["/dog-rune/stats"] as Record<string, unknown> | null;
  const price = raw["/price/kraken"] as Record<string, unknown> | null;
  const realized = raw["/metrics/realized-cap"] as Record<string, unknown> | null;
  const forensic = raw["/forensic/summary"] as Record<string, unknown> | null;
  const utxoAge = raw["/metrics/utxo-age"] as Record<string, unknown> | null;

  // Extract Kraken price
  const krakenResult = price?.result as Record<string, Record<string, unknown>> | undefined;
  const dogusd = krakenResult?.DOGUSD;
  const currentPrice = dogusd?.c ? parseFloat((dogusd.c as string[])[0]) : null;
  const volume24h = dogusd?.v ? parseFloat((dogusd.v as string[])[1]) : null;
  const high24h = dogusd?.h ? parseFloat((dogusd.h as string[])[1]) : null;
  const low24h = dogusd?.l ? parseFloat((dogusd.l as string[])[1]) : null;
  const openPrice = dogusd?.o ? parseFloat(dogusd.o as string) : null;
  const change24hPct = currentPrice && openPrice ? ((currentPrice - openPrice) / openPrice) * 100 : null;

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

  out("success", "DOG pulse snapshot. Use this data for market analysis and signal generation.", {
    price: {
      usd: currentPrice,
      change_24h_pct: change24hPct ? +change24hPct.toFixed(2) : null,
      high_24h: high24h,
      low_24h: low24h,
      volume_24h_dog: volume24h,
      exchange: "Kraken",
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
      lth_percentage: lthPct ? +lthPct.toFixed(2) : null,
      sth_percentage: sthPct ? +sthPct.toFixed(2) : null,
      lth_sth_ratio: lthPct && sthPct ? +(lthPct / sthPct).toFixed(2) : null,
      median_utxo_age_days: utxoAge?.median_age_days ? +(utxoAge.median_age_days as number).toFixed(1) : null,
    },
    forensic: {
      diamond_paws: forensicStats?.diamond_hands ?? null,
      dog_legends: (forensicStats?.by_pattern as Record<string, number>)?.dog_legend ?? null,
      paper_hands: (forensicStats?.by_pattern as Record<string, number>)?.paper_hands ?? null,
      retention_rate_pct: forensicStats?.retention_rate ? +(forensicStats.retention_rate as number).toFixed(2) : null,
      total_analyzed: forensicStats?.total_analyzed ?? null,
    },
  });
}

async function whales(): Promise<void> {
  const raw = await fetchMultiple([
    "/dog-rune/holders?limit=25",
    "/dog-rune/transactions-kv",
  ]);

  const holdersData = raw["/dog-rune/holders?limit=25"];
  const txData = raw["/dog-rune/transactions-kv"] as Record<string, unknown> | null;

  // Parse holders — may be array or object with holders key
  let holders: Record<string, unknown>[] = [];
  if (Array.isArray(holdersData)) {
    holders = holdersData;
  } else if (holdersData && typeof holdersData === "object") {
    const hd = holdersData as Record<string, unknown>;
    if (Array.isArray(hd.holders)) holders = hd.holders;
    else if (Array.isArray(hd.top10Holders)) holders = hd.top10Holders;
  }

  // Format top holders
  const topHolders = holders.slice(0, 25).map((h: Record<string, unknown>, i: number) => ({
    rank: h.rank ?? i + 1,
    address: h.address,
    balance_dog: h.total_dog ?? (typeof h.total_amount === "number" ? h.total_amount / 1e5 : null),
    utxo_count: h.utxo_count ?? null,
  }));

  // Extract large transactions (> 1M DOG)
  const WHALE_THRESHOLD = 1_000_000; // 1M DOG
  const txs = txData?.transactions as Record<string, unknown>[] | undefined;
  const whaleTxs = (txs || [])
    .filter((tx: Record<string, unknown>) => {
      const amount = tx.amount as number | undefined;
      const totalDog = tx.total_dog as number | undefined;
      const val = totalDog ?? (amount ? amount / 1e5 : 0);
      return val >= WHALE_THRESHOLD;
    })
    .slice(0, 20)
    .map((tx: Record<string, unknown>) => ({
      txid: tx.txid ?? tx.tx_id,
      block: tx.block_height ?? tx.block,
      amount_dog: tx.total_dog ?? (typeof tx.amount === "number" ? tx.amount / 1e5 : null),
      type: tx.type ?? "transfer",
      timestamp: tx.timestamp ?? null,
    }));

  // Concentration
  const top10Sum = topHolders.slice(0, 10).reduce((s, h) => s + ((h.balance_dog as number) || 0), 0);
  const totalSupply = 100_000_000_000;
  const top10Pct = (top10Sum / totalSupply) * 100;

  out("success", "Whale intelligence report. Top holders and large recent movements.", {
    top_holders: topHolders,
    whale_transactions: whaleTxs,
    whale_tx_count: whaleTxs.length,
    concentration: {
      top_10_supply_pct: +top10Pct.toFixed(2),
      top_10_total_dog: Math.round(top10Sum),
    },
    threshold_dog: WHALE_THRESHOLD,
    total_transactions_scanned: txs?.length ?? 0,
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
      retention_rate_pct: stats?.retention_rate ? +(stats.retention_rate as number).toFixed(2) : null,
      accumulator_rate_pct: stats?.accumulator_rate ? +(stats.accumulator_rate as number).toFixed(2) : null,
      dumper_rate_pct: stats?.dumper_rate ? +(stats.dumper_rate as number).toFixed(2) : null,
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
  const lthSthRatio = lthPct && sthPct && sthPct > 0 ? lthPct / sthPct : null;

  // Interpret
  let convictionSignal = "neutral";
  if (lthPct !== null) {
    if (lthPct > 75) convictionSignal = "strong — majority of supply in long-term hands, structurally bullish";
    else if (lthPct > 50) convictionSignal = "moderate — more holders are long-term than short-term";
    else convictionSignal = "weak — short-term holders dominate, higher sell pressure risk";
  }

  // HODL waves
  const ageDist = utxoAge?.age_distribution as Record<string, number> | undefined;
  const totalSupplyRaw = utxoAge?.total_supply as number ?? 1;
  const hodlWaves: Record<string, string> = {};
  if (ageDist) {
    for (const [range, supply] of Object.entries(ageDist)) {
      hodlWaves[range] = ((supply / totalSupplyRaw) * 100).toFixed(2) + "%";
    }
  }

  out("success", "LTH vs STH conviction analysis — the trademark DOG intelligence metric.", {
    lth_vs_sth: {
      lth_percentage: lthPct ? +lthPct.toFixed(2) : null,
      sth_percentage: sthPct ? +sthPct.toFixed(2) : null,
      lth_sth_ratio: lthSthRatio ? +lthSthRatio.toFixed(2) : null,
      conviction_signal: convictionSignal,
      lth_threshold_days: 155,
    },
    utxo_age: {
      total_utxos: utxoAge?.total_utxos ?? null,
      avg_age_days: utxoAge?.avg_age_days ? +(utxoAge.avg_age_days as number).toFixed(1) : null,
      median_age_days: utxoAge?.median_age_days ? +(utxoAge.median_age_days as number).toFixed(1) : null,
    },
    hodl_waves: hodlWaves,
    concentration: {
      gini_coefficient: concentration?.gini_coefficient ? +(concentration.gini_coefficient as number).toFixed(4) : null,
      top_10_pct: concentration?.top10_supply_pct ? +(concentration.top10_supply_pct as number).toFixed(2) : null,
      top_100_pct: concentration?.top100_supply_pct ? +(concentration.top100_supply_pct as number).toFixed(2) : null,
      top_1000_pct: concentration?.top1000_supply_pct ? +(concentration.top1000_supply_pct as number).toFixed(2) : null,
      total_holders: concentration?.total_holders ?? null,
    },
    supply_health: {
      in_profit_pct: profitLoss?.supply_in_profit_pct ? +(profitLoss.supply_in_profit_pct as number).toFixed(2) : null,
      in_loss_pct: profitLoss?.supply_in_loss_pct ? +(profitLoss.supply_in_loss_pct as number).toFixed(2) : null,
      current_price_usd: profitLoss?.current_price ?? null,
    },
  });
}

async function installPacks(): Promise<void> {
  out("success", "No additional packages required. dog-intelligence uses fetch (built into Bun) and the DOG DATA REST API. Optionally set DOGDATA_API_KEY env var for higher rate limits (100 req/hr).", {
    required_dependencies: [],
    optional: {
      env_var: "DOGDATA_API_KEY",
      get_key: "POST https://www.dogdata.xyz/api/keys/generate with {\"email\": \"...\", \"name\": \"...\"}",
      free_tier: "100 req/hr",
      public_tier: "20 req/hr (no key needed)",
    },
  });
}

// --- Main ---

async function main(): Promise<void> {
  const command = Bun.argv[2];
  const actionFlag = Bun.argv.indexOf("--action");
  const action = actionFlag !== -1 ? Bun.argv[actionFlag + 1] : "pulse";

  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "run":
      switch (action) {
        case "pulse":
          await pulse();
          break;
        case "whales":
          await whales();
          break;
        case "diamond":
          await diamond();
          break;
        case "airdrop":
          await airdrop();
          break;
        case "lth-sth":
          await lthSth();
          break;
        default:
          out("error", "Unknown action", null, `Unknown action: ${action}. Valid: pulse, whales, diamond, airdrop, lth-sth`);
      }
      break;
    case "install-packs":
      await installPacks();
      break;
    default:
      out("error", "Unknown command", null, `Unknown command: ${command}. Valid: doctor, run, install-packs`);
  }
}

main().catch((err) => {
  out("error", "Fatal error", null, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
