#!/usr/bin/env bun
/**
 * BTC Macro Signals CLI
 * Bitcoin macro intelligence pipeline: on-chain data + news feeds -> aibtc.news signals
 *
 * Usage: bun run btc-macro-signals/btc-macro-signals.ts <subcommand> [options]
 */

import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FeeData {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

interface MempoolData {
  count: number;
  vsize: number;
  total_fee: number;
}

interface HashrateData {
  currentHashrate: number;
  currentDifficulty: number;
}

interface DifficultyData {
  remainingBlocks: number;
  estimatedRetargetDate: number;
  progressPercent: number;
  expectedBlocks: number;
  difficultyChange: number;
}

interface PriceData {
  USD: {
    last: number;
    buy: number;
    sell: number;
    symbol: string;
  };
}

interface FngData {
  value: string;
  value_classification: string;
  timestamp: string;
}

interface NewsItem {
  feed: string;
  title: string;
  link: string;
  pubDate: string;
}

interface ScanResult {
  timestamp: string;
  onchain: {
    fees: FeeData | null;
    mempool: MempoolData | null;
    hashrate: HashrateData | null;
    difficulty: DifficultyData | null;
  };
  market: {
    price: PriceData | null;
  };
  sentiment: {
    fng: FngData | null;
  };
  news: NewsItem[];
  errors: string[];
}

interface Signal {
  beat_slug: string;
  btc_address: string;
  headline: string;
  body: string;
  tags: string[];
  sources: Array<{ url: string; title: string }>;
  disclosure: string;
  signal_type: string;
  generated_at: string;
}

interface FilingState {
  filed_today: number;
  last_filed_at: string | null;
  last_headline: string | null;
  total_filed: number;
  last_date_utc: string;
  cooldown_until: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMPOOL_API = "https://mempool.space/api";
const BLOCKCHAIN_INFO = "https://blockchain.info/ticker";
const FNG_API = "https://api.alternative.me/fng/";
const AIBTC_NEWS_API =
  process.env.AIBTC_NEWS_API ?? "https://aibtc.news/api/signals";
const DAILY_LIMIT = 6;
const COOLDOWN_MINUTES = 75;

const RSS_FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  {
    name: "Bitcoin Magazine",
    url: "https://bitcoinmagazine.com/.rss/full/",
  },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

const STATE_DIR = join(homedir(), ".aibtc");
const STATE_FILE = join(STATE_DIR, "btc-macro-signals-state.json");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(
    JSON.stringify(
      data,
      (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      2
    )
  );
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(): FilingState {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const defaultState: FilingState = {
    filed_today: 0,
    last_filed_at: null,
    last_headline: null,
    total_filed: 0,
    last_date_utc: todayUtc,
    cooldown_until: null,
  };

  if (!existsSync(STATE_FILE)) return defaultState;

  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as FilingState;
    // Reset daily count if it's a new UTC day
    if (state.last_date_utc !== todayUtc) {
      state.filed_today = 0;
      state.last_date_utc = todayUtc;
    }
    return state;
  } catch {
    console.error(
      JSON.stringify({ warning: "state_reset", reason: "corrupt_state_file" })
    );
    return defaultState;
  }
}

function saveState(state: FilingState): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getCooldownStatus(state: FilingState): {
  clear: boolean;
  remaining_minutes: number;
  next_allowed: string | null;
} {
  const now = Date.now();

  if (state.cooldown_until) {
    const until = new Date(state.cooldown_until).getTime();
    if (until > now) {
      return {
        clear: false,
        remaining_minutes: Math.ceil((until - now) / 60000),
        next_allowed: state.cooldown_until,
      };
    }
  }

  if (!state.last_filed_at) {
    return { clear: true, remaining_minutes: 0, next_allowed: null };
  }

  const lastFiled = new Date(state.last_filed_at).getTime();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const nextAllowed = lastFiled + cooldownMs;

  if (nextAllowed > now) {
    return {
      clear: false,
      remaining_minutes: Math.ceil((nextAllowed - now) / 60000),
      next_allowed: new Date(nextAllowed).toISOString(),
    };
  }

  return { clear: true, remaining_minutes: 0, next_allowed: null };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  retries = 2
): Promise<Response | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "btc-macro-signals/1.0 (aibtc.news skill)" },
      });
      if (res.ok) return res;
    } catch {
      if (i < retries) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchFees(): Promise<FeeData | null> {
  const res = await fetchWithRetry(`${MEMPOOL_API}/v1/fees/recommended`);
  if (!res) return null;
  return res.json() as Promise<FeeData>;
}

async function fetchMempool(): Promise<MempoolData | null> {
  const res = await fetchWithRetry(`${MEMPOOL_API}/mempool`);
  if (!res) return null;
  return res.json() as Promise<MempoolData>;
}

async function fetchHashrate(): Promise<HashrateData | null> {
  const res = await fetchWithRetry(`${MEMPOOL_API}/v1/mining/hashrate/1d`);
  if (!res) return null;
  const data = (await res.json()) as {
    currentHashrate: number;
    currentDifficulty: number;
  };
  return {
    currentHashrate: data.currentHashrate,
    currentDifficulty: data.currentDifficulty,
  };
}

async function fetchDifficulty(): Promise<DifficultyData | null> {
  const res = await fetchWithRetry(`${MEMPOOL_API}/v1/difficulty-adjustment`);
  if (!res) return null;
  return res.json() as Promise<DifficultyData>;
}

async function fetchPrice(): Promise<PriceData | null> {
  const res = await fetchWithRetry(BLOCKCHAIN_INFO);
  if (!res) return null;
  return res.json() as Promise<PriceData>;
}

async function fetchFng(): Promise<FngData | null> {
  const res = await fetchWithRetry(FNG_API);
  if (!res) return null;
  const data = (await res.json()) as { data: FngData[] };
  return data.data?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// RSS parsing
// ---------------------------------------------------------------------------

function parseRssItems(xml: string, feedName: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
    const content = match[1];
    const title = extractTag(content, "title");
    const link = extractTag(content, "link") || extractAtomLink(content);
    const pubDate = extractTag(content, "pubDate") || extractTag(content, "dc:date");

    if (title && link) {
      items.push({
        feed: feedName,
        title: cleanCdata(title),
        link: cleanCdata(link).trim(),
        pubDate: pubDate ? cleanCdata(pubDate) : "",
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1].trim() : "";
}

function extractAtomLink(xml: string): string {
  const match = /href="([^"]+)"/.exec(xml);
  return match ? match[1] : "";
}

function cleanCdata(str: string): string {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

async function fetchNewsFeeds(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const res = await fetchWithRetry(feed.url);
      if (!res) return [];
      const xml = await res.text();
      return parseRssItems(xml, feed.name);
    })
  );

  const items: NewsItem[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Signal generation
// ---------------------------------------------------------------------------

function formatHashrate(h: number): string {
  if (h >= 1e21) return `${(h / 1e21).toFixed(1)} ZH/s`;
  if (h >= 1e18) return `${(h / 1e18).toFixed(0)} EH/s`;
  if (h >= 1e15) return `${(h / 1e15).toFixed(0)} PH/s`;
  return `${h} H/s`;
}

function scoreScanData(scan: ScanResult): Array<{
  type: string;
  score: number;
  reason: string;
}> {
  const scores: Array<{ type: string; score: number; reason: string }> = [];

  // Score onchain signals
  if (scan.onchain.fees) {
    const { fastestFee } = scan.onchain.fees;
    if (fastestFee > 50)
      scores.push({ type: "onchain", score: 90, reason: "high_fees" });
    else if (fastestFee > 20)
      scores.push({ type: "onchain", score: 70, reason: "elevated_fees" });
    else
      scores.push({ type: "onchain", score: 40, reason: "normal_fees" });
  }

  if (scan.onchain.mempool) {
    const { count } = scan.onchain.mempool;
    if (count > 50000)
      scores.push({ type: "onchain", score: 95, reason: "mempool_congestion" });
    else if (count > 20000)
      scores.push({ type: "onchain", score: 75, reason: "mempool_busy" });
    else if (count < 2000)
      scores.push({ type: "onchain", score: 55, reason: "mempool_clear" });
  }

  if (scan.onchain.difficulty) {
    const { remainingBlocks, difficultyChange } = scan.onchain.difficulty;
    if (remainingBlocks < 200)
      scores.push({
        type: "onchain",
        score: 85,
        reason: "difficulty_adjustment_imminent",
      });
    if (Math.abs(difficultyChange) > 5)
      scores.push({
        type: "onchain",
        score: 80,
        reason: "large_difficulty_change",
      });
  }

  // Score market signals
  if (scan.market.price) {
    const price = scan.market.price.USD.last;
    // Round numbers get attention
    const roundThresholds = [100000, 90000, 80000, 70000, 60000, 50000];
    for (const threshold of roundThresholds) {
      if (Math.abs(price - threshold) < threshold * 0.005) {
        scores.push({
          type: "market",
          score: 92,
          reason: `price_near_${threshold}`,
        });
        break;
      }
    }
    scores.push({ type: "market", score: 50, reason: "price_update" });
  }

  // Score sentiment signals
  if (scan.sentiment.fng) {
    const val = parseInt(scan.sentiment.fng.value);
    if (val >= 80)
      scores.push({ type: "market", score: 88, reason: "extreme_greed" });
    else if (val <= 20)
      scores.push({ type: "market", score: 88, reason: "extreme_fear" });
    else if (val >= 65)
      scores.push({ type: "market", score: 60, reason: "greed" });
    else if (val <= 35)
      scores.push({ type: "market", score: 60, reason: "fear" });
  }

  // Score ecosystem/news signals
  if (scan.news.length > 0) {
    scores.push({ type: "ecosystem", score: 65, reason: "news_available" });
  }

  return scores.sort((a, b) => b.score - a.score);
}

function generateOnchainSignal(scan: ScanResult, reason: string): Signal | null {
  const { fees, mempool, hashrate, difficulty } = scan.onchain;
  const price = scan.market.price?.USD.last ?? 0;
  const priceStr = price > 0 ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "";

  const sources: Array<{ url: string; title: string }> = [
    { url: `${MEMPOOL_API}/v1/fees/recommended`, title: "mempool.space fee estimates" },
  ];

  if (reason === "mempool_congestion" || reason === "mempool_busy" || reason === "mempool_clear") {
    if (!mempool) return null;
    const vmbStr = (mempool.vsize / 1e6).toFixed(1);
    const headline = `Bitcoin mempool holds ${mempool.count.toLocaleString()} transactions (${vmbStr} MB) at ${fees?.fastestFee ?? "?"} sat/vB fastest fee`;

    let body = `The Bitcoin mempool contains ${mempool.count.toLocaleString()} unconfirmed transactions occupying ${vmbStr} MB as of ${new Date(scan.timestamp).toUTCString().slice(0, 22)} UTC.`;
    if (fees) {
      body += ` Fee tiers: fastest ${fees.fastestFee} sat/vB, 1h ${fees.hourFee} sat/vB, economy ${fees.economyFee} sat/vB.`;
    }
    if (priceStr) body += ` BTC at ${priceStr}.`;

    sources.push({ url: `${MEMPOOL_API}/mempool`, title: "mempool.space mempool stats" });

    return {
      beat_slug: "bitcoin-macro",
      btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
      headline: headline.slice(0, 118),
      body,
      tags: ["mempool", "fees", "onchain", "congestion"],
      sources,
      disclosure: "btc-macro-signals CLI v1.0, mempool.space public API",
      signal_type: "onchain",
      generated_at: new Date().toISOString(),
    };
  }

  if (reason === "high_fees" || reason === "elevated_fees") {
    if (!fees) return null;
    const headline = `Bitcoin fees hit ${fees.fastestFee} sat/vB (fastest), ${fees.hourFee} sat/vB (1h) as mempool holds ${mempool?.count.toLocaleString() ?? "?"} txs`;

    let body = `Bitcoin fee rates as of ${new Date(scan.timestamp).toUTCString().slice(0, 22)} UTC - fastest: ${fees.fastestFee} sat/vB, 30 min: ${fees.halfHourFee} sat/vB, 1 hour: ${fees.hourFee} sat/vB, economy: ${fees.economyFee} sat/vB.`;
    if (mempool) body += ` Mempool: ${mempool.count.toLocaleString()} transactions, ${(mempool.vsize / 1e6).toFixed(1)} MB.`;
    if (priceStr) body += ` BTC price: ${priceStr}.`;

    return {
      beat_slug: "bitcoin-macro",
      btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
      headline: headline.slice(0, 118),
      body,
      tags: ["fees", "mempool", "onchain"],
      sources,
      disclosure: "btc-macro-signals CLI v1.0, mempool.space public API",
      signal_type: "onchain",
      generated_at: new Date().toISOString(),
    };
  }

  if (reason === "difficulty_adjustment_imminent" || reason === "large_difficulty_change") {
    if (!difficulty) return null;
    const direction = difficulty.difficultyChange > 0 ? "increase" : "decrease";
    const absChange = Math.abs(difficulty.difficultyChange).toFixed(1);
    const headline = `Bitcoin difficulty adjustment in ${difficulty.remainingBlocks} blocks: projected ${absChange}% ${direction} at ${difficulty.progressPercent.toFixed(0)}% through epoch`;

    let body = `The Bitcoin network is ${difficulty.progressPercent.toFixed(1)}% through the current difficulty epoch with ${difficulty.remainingBlocks} blocks remaining. Projected difficulty ${direction}: ${absChange}%.`;
    if (hashrate) body += ` Current hashrate: ${formatHashrate(hashrate.currentHashrate)}.`;
    if (priceStr) body += ` BTC at ${priceStr}.`;

    sources.push({ url: `${MEMPOOL_API}/v1/difficulty-adjustment`, title: "mempool.space difficulty adjustment" });

    return {
      beat_slug: "bitcoin-macro",
      btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
      headline: headline.slice(0, 118),
      body,
      tags: ["difficulty", "hashrate", "mining", "onchain"],
      sources,
      disclosure: "btc-macro-signals CLI v1.0, mempool.space public API",
      signal_type: "onchain",
      generated_at: new Date().toISOString(),
    };
  }

  // Default: hashrate snapshot
  if (!hashrate) return null;
  const hashrateStr = formatHashrate(hashrate.currentHashrate);
  const headline = `Bitcoin network hashrate: ${hashrateStr} at difficulty ${hashrate.currentDifficulty.toExponential(2)}`;

  let body = `Bitcoin network hashrate stands at ${hashrateStr} with current difficulty ${hashrate.currentDifficulty.toLocaleString()} as of ${new Date(scan.timestamp).toUTCString().slice(0, 22)} UTC.`;
  if (difficulty) body += ` Difficulty adjustment in ${difficulty.remainingBlocks} blocks (${difficulty.progressPercent.toFixed(0)}% through epoch), projected change: ${difficulty.difficultyChange.toFixed(1)}%.`;
  if (priceStr) body += ` BTC at ${priceStr}.`;

  sources.push({ url: `${MEMPOOL_API}/v1/mining/hashrate/1d`, title: "mempool.space hashrate" });

  return {
    beat_slug: "bitcoin-macro",
    btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
    headline: headline.slice(0, 118),
    body,
    tags: ["hashrate", "mining", "difficulty", "onchain"],
    sources,
    disclosure: "btc-macro-signals CLI v1.0, mempool.space public API",
    signal_type: "onchain",
    generated_at: new Date().toISOString(),
  };
}

function generateMarketSignal(scan: ScanResult, reason: string): Signal | null {
  const price = scan.market.price?.USD.last ?? 0;
  const fng = scan.sentiment.fng;

  if (!price && !fng) return null;

  const priceStr = price > 0 ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "";
  const fngStr = fng ? `${fng.value} (${fng.value_classification})` : "";

  const sources: Array<{ url: string; title: string }> = [];
  if (price) sources.push({ url: BLOCKCHAIN_INFO, title: "blockchain.info BTC/USD ticker" });
  if (fng) sources.push({ url: FNG_API, title: "alternative.me Fear & Greed Index" });

  if (reason === "extreme_greed" || reason === "extreme_fear" || reason === "greed" || reason === "fear") {
    if (!fng) return null;
    const sentiment = fng.value_classification;
    const headline = `Bitcoin Fear & Greed Index at ${fng.value}/100 (${sentiment})${priceStr ? ` — BTC ${priceStr}` : ""}`;

    let body = `The Crypto Fear & Greed Index reads ${fng.value}/100, classified as ${sentiment}, as of ${new Date(parseInt(fng.timestamp) * 1000).toUTCString().slice(0, 16)} UTC.`;
    if (price) body += ` Bitcoin is currently trading at ${priceStr}.`;
    if (scan.onchain.fees) body += ` On-chain fee environment: ${scan.onchain.fees.fastestFee} sat/vB fastest.`;

    return {
      beat_slug: "bitcoin-macro",
      btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
      headline: headline.slice(0, 118),
      body,
      tags: ["sentiment", "fear-greed", "market", "macro"],
      sources,
      disclosure: "btc-macro-signals CLI v1.0, alternative.me Fear & Greed API, blockchain.info ticker",
      signal_type: "market",
      generated_at: new Date().toISOString(),
    };
  }

  // Default price + sentiment snapshot
  const headline = `Bitcoin at ${priceStr}${fngStr ? ` with Fear & Greed at ${fngStr}` : ""} — mempool ${scan.onchain.mempool?.count.toLocaleString() ?? "?"} txs`;

  let body = `Bitcoin is trading at ${priceStr} as of ${new Date(scan.timestamp).toUTCString().slice(0, 22)} UTC.`;
  if (fng) body += ` Market sentiment: Fear & Greed Index at ${fng.value}/100 (${fng.value_classification}).`;
  if (scan.onchain.fees) body += ` Transaction fees: ${scan.onchain.fees.fastestFee} sat/vB fastest, ${scan.onchain.fees.economyFee} sat/vB economy.`;

  return {
    beat_slug: "bitcoin-macro",
    btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
    headline: headline.slice(0, 118),
    body,
    tags: ["price", "sentiment", "market", "macro"],
    sources,
    disclosure: "btc-macro-signals CLI v1.0, blockchain.info ticker, alternative.me Fear & Greed API",
    signal_type: "market",
    generated_at: new Date().toISOString(),
  };
}

function generateEcosystemSignal(scan: ScanResult): Signal | null {
  if (scan.news.length === 0) return null;

  // Pick the most recent Bitcoin-relevant headline
  const btcKeywords = ["bitcoin", "btc", "lightning", "mempool", "halving", "etf", "satoshi", "ordinals", "runes"];
  const relevant = scan.news.filter((n) =>
    btcKeywords.some((kw) =>
      n.title.toLowerCase().includes(kw)
    )
  );

  const item = relevant[0] ?? scan.news[0];
  if (!item) return null;

  const headline = `[${item.feed}] ${item.title}`.slice(0, 118);
  const price = scan.market.price?.USD.last ?? 0;
  const priceStr = price > 0 ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "";
  const fng = scan.sentiment.fng;

  let body = `${item.title} (via ${item.feed}${item.pubDate ? `, ${item.pubDate.slice(0, 16)}` : ""}).`;
  if (priceStr) body += ` BTC at ${priceStr}.`;
  if (fng) body += ` Market sentiment: ${fng.value_classification} (${fng.value}/100).`;

  return {
    beat_slug: "bitcoin-macro",
    btc_address: process.env.AIBTC_BTC_ADDRESS ?? "",
    headline,
    body,
    tags: ["news", "ecosystem", item.feed.toLowerCase().replace(/\s+/g, "-")],
    sources: [
      { url: item.link, title: `${item.feed}: ${item.title.slice(0, 60)}` },
    ],
    disclosure: `btc-macro-signals CLI v1.0, ${item.feed} RSS feed`,
    signal_type: "ecosystem",
    generated_at: new Date().toISOString(),
  };
}

function generateSignalFromScan(
  scan: ScanResult,
  forceType?: string
): Signal | null {
  const scores = scoreScanData(scan);

  let type = forceType;
  let reason = "";

  if (!type) {
    const top = scores[0];
    type = top?.type ?? "market";
    reason = top?.reason ?? "price_update";
  } else {
    const match = scores.find((s) => s.type === type);
    reason = match?.reason ?? "";
  }

  switch (type) {
    case "onchain":
      return generateOnchainSignal(scan, reason);
    case "market":
      return generateMarketSignal(scan, reason);
    case "ecosystem":
      return generateEcosystemSignal(scan);
    case "regulatory": {
      // For regulatory: use news feed with regulatory keywords
      const regKeywords = ["sec", "regulation", "law", "congress", "senate", "ban", "approve", "etf", "policy"];
      const regItem = scan.news.find((n) =>
        regKeywords.some((kw) => n.title.toLowerCase().includes(kw))
      );
      if (regItem) {
        const sig = generateEcosystemSignal({ ...scan, news: [regItem, ...scan.news.filter(n => n !== regItem)] });
        if (sig) return { ...sig, signal_type: "regulatory", tags: ["regulatory", "policy", ...sig.tags] };
      }
      return generateMarketSignal(scan, "price_update");
    }
    default:
      return generateMarketSignal(scan, "price_update");
  }
}

function validateSignal(signal: Signal): string[] {
  const errors: string[] = [];
  if (signal.headline.length > 118) errors.push("headline_too_long");
  if (!/\d/.test(signal.headline)) errors.push("headline_missing_number");
  if (signal.body.length < 200) errors.push("body_too_short");
  if (signal.body.length > 1000) errors.push("body_too_long");
  if (signal.sources.length === 0) errors.push("missing_sources");
  if (!signal.disclosure) errors.push("missing_disclosure");
  if (!signal.btc_address) errors.push("missing_btc_address");
  return errors;
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aWords = new Set(a.toLowerCase().split(/\s+/));
  const bWords = b.toLowerCase().split(/\s+/);
  const matches = bWords.filter((w) => aWords.has(w)).length;
  return matches / Math.max(aWords.size, bWords.length);
}

// ---------------------------------------------------------------------------
// Shared scan
// ---------------------------------------------------------------------------

async function runScan(trackErrors = false): Promise<ScanResult> {
  const timestamp = new Date().toISOString();
  const errors: string[] = [];

  const [fees, mempoolData, hashrate, difficulty, price, fng, news] =
    await Promise.allSettled([
      fetchFees(),
      fetchMempool(),
      fetchHashrate(),
      fetchDifficulty(),
      fetchPrice(),
      fetchFng(),
      fetchNewsFeeds(),
    ]);

  const getVal = <T>(
    result: PromiseSettledResult<T | null>,
    name?: string
  ): T | null => {
    if (result.status === "rejected") {
      if (trackErrors && name) errors.push(`${name}_fetch_failed`);
      return null;
    }
    if (result.value === null && trackErrors && name) {
      errors.push(`${name}_unavailable`);
    }
    return result.value;
  };

  return {
    timestamp,
    onchain: {
      fees: getVal(fees, "fees"),
      mempool: getVal(mempoolData, "mempool"),
      hashrate: getVal(hashrate, "hashrate"),
      difficulty: getVal(difficulty, "difficulty"),
    },
    market: { price: getVal(price, "price") },
    sentiment: { fng: getVal(fng, "fng") },
    news: news.status === "fulfilled" ? news.value : [],
    errors,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("btc-macro-signals")
  .description(
    "Bitcoin macro intelligence pipeline: on-chain data + news -> aibtc.news signals"
  )
  .version("1.0.0");

// ---- scan ----
program
  .command("scan")
  .description("Fetch live Bitcoin on-chain data and crypto news")
  .action(async () => {
    try {
      const result = await runScan(true);
      printJson(result);
    } catch (err) {
      handleError(err);
    }
  });

// ---- generate ----
program
  .command("generate")
  .description("Generate a market signal from scan data")
  .option(
    "--type <type>",
    "Signal type: onchain|market|ecosystem|regulatory"
  )
  .action(async (opts: { type?: string }) => {
    try {
      const scan = await runScan();

      const signal = generateSignalFromScan(scan, opts.type);

      if (!signal) {
        handleError(
          "Could not generate signal: insufficient data from all sources"
        );
      }

      printJson(signal);
    } catch (err) {
      handleError(err);
    }
  });

// ---- file ----
program
  .command("file")
  .description("File generated signal to aibtc.news")
  .option("--dry-run", "Preview without filing")
  .option("--btc-address <address>", "BTC address for filing")
  .option("--type <type>", "Force signal type: onchain|market|ecosystem|regulatory")
  .action(async (opts: { dryRun?: boolean; btcAddress?: string; type?: string }) => {
    try {
      const state = loadState();
      const cooldown = getCooldownStatus(state);

      // Check daily limit
      if (state.filed_today >= DAILY_LIMIT) {
        printJson({
          status: "rate_limited",
          reason: "daily_limit",
          filed_today: state.filed_today,
          daily_limit: DAILY_LIMIT,
          resets_at: new Date(
            new Date().setUTCHours(24, 0, 0, 0)
          ).toISOString(),
        });
        process.exit(0);
      }

      // Check cooldown
      if (!cooldown.clear) {
        printJson({
          status: "rate_limited",
          reason: "cooldown",
          next_allowed: cooldown.next_allowed,
          cooldown_remaining_minutes: cooldown.remaining_minutes,
        });
        process.exit(0);
      }

      // Set BTC address
      if (opts.btcAddress) {
        process.env.AIBTC_BTC_ADDRESS = opts.btcAddress;
      }

      if (!process.env.AIBTC_BTC_ADDRESS) {
        handleError(
          "BTC address required. Set AIBTC_BTC_ADDRESS env var or use --btc-address flag."
        );
      }

      // Generate signal
      const scan = await runScan();

      let signal = generateSignalFromScan(scan, opts.type);

      if (!signal) {
        handleError(
          "Could not generate signal: insufficient data from all sources"
        );
      }

      // Dedup check
      if (
        state.last_headline &&
        similarity(signal.headline, state.last_headline) > 0.8
      ) {
        // Rotate type and regenerate
        const types = ["onchain", "market", "ecosystem", "regulatory"];
        const current = signal.signal_type;
        const alt = types.find((t) => t !== current) ?? "market";
        const altSignal = generateSignalFromScan(scan, alt);
        if (altSignal) signal = altSignal;
      }

      // Validate
      const validationErrors = validateSignal(signal);
      if (validationErrors.length > 0) {
        printJson({ status: "validation_failed", reasons: validationErrors, signal });
        process.exit(1);
      }

      if (opts.dryRun) {
        printJson({
          status: "dry_run",
          signal,
          would_file_to: AIBTC_NEWS_API,
          validation: "passed",
        });
        process.exit(0);
      }

      // File to aibtc.news
      const payload = {
        beat_slug: signal.beat_slug,
        btc_address: signal.btc_address,
        headline: signal.headline,
        body: signal.body,
        tags: signal.tags,
        sources: signal.sources,
        disclosure: signal.disclosure,
      };

      const res = await fetch(AIBTC_NEWS_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "btc-macro-signals/1.0 (aibtc.news skill)",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const cooldownUntil = retryAfter
          ? new Date(Date.now() + parseInt(retryAfter) * 1000).toISOString()
          : new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString();

        state.cooldown_until = cooldownUntil;
        saveState(state);

        printJson({
          status: "rate_limited_by_server",
          retry_after: retryAfter,
          cooldown_until: cooldownUntil,
        });
        process.exit(0);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        handleError(`API error ${res.status}: ${body.slice(0, 200)}`);
      }

      const result = (await res.json()) as { id?: string; signal_id?: string };
      const signalId = result.id ?? result.signal_id ?? "unknown";
      const now = new Date().toISOString();

      // Update state
      state.filed_today += 1;
      state.total_filed += 1;
      state.last_filed_at = now;
      state.last_headline = signal.headline;
      state.cooldown_until = null;
      saveState(state);

      const nextAllowed = new Date(
        Date.now() + COOLDOWN_MINUTES * 60 * 1000
      ).toISOString();

      printJson({
        status: "filed",
        signal_id: signalId,
        headline: signal.headline,
        filed_at: now,
        filed_today: state.filed_today,
        next_allowed: nextAllowed,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ---- status ----
program
  .command("status")
  .description("Show current filing status")
  .action(() => {
    try {
      const state = loadState();
      const cooldown = getCooldownStatus(state);

      printJson({
        beat: "bitcoin-macro",
        filed_today: state.filed_today,
        daily_limit: DAILY_LIMIT,
        last_filed_at: state.last_filed_at,
        cooldown_remaining_minutes: cooldown.remaining_minutes,
        cooldown_clear: cooldown.clear,
        next_allowed: cooldown.next_allowed,
        last_headline: state.last_headline,
        total_filed: state.total_filed,
        state_file: STATE_FILE,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
