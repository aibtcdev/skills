#!/usr/bin/env bun
/**
 * nostr-wot — Nostr Web of Trust trust scoring and sybil detection
 *
 * Free tier: wot.klabo.world (50 req/day per IP)
 * Paid fallback: maximumsats.com/api/wot-report (100 sats via L402)
 *
 * Usage: bun run nostr-wot/nostr-wot.ts <subcommand> [options]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- Constants ----

const FREE_API_BASE = "https://wot.klabo.world";
const PAID_API_URL = "https://maximumsats.com/api/wot-report";
const STATE_DIR = join(process.env.HOME ?? "~", ".aibtc", "nostr-wot");
const CACHE_PATH = join(STATE_DIR, "cache.json");
const CONFIG_PATH = join(STATE_DIR, "config.json");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---- Types ----

interface WotScoreResponse {
  normalized_score: number;
  rank: number;
  percentile: number;
}

interface SybilResponse {
  classification: string;
  follower_quality?: number;
  mutual_trust_ratio?: number;
}

interface TrustPathResponse {
  connected: boolean;
  combined_trust: number;
  paths: Array<{ pubkeys: string[]; trust: number }>;
}

interface NetworkHealthResponse {
  graph_nodes: number;
  graph_edges: number;
  gini_coefficient: number;
  power_law_alpha: number;
}

interface PaidWotReport {
  pubkey: string;
  rank: number;
  position: number;
  in_top_100: boolean;
  report: string;
  graph: { nodes: number; edges: number };
}

interface CacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

interface WotCache {
  [key: string]: CacheEntry;
}

interface WotConfig {
  minRank: number;
  requireTop100: boolean;
}

// ---- Helpers ----

function ensureDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function loadConfig(): WotConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as WotConfig;
    }
  } catch {
    // defaults
  }
  return { minRank: 10000, requireTop100: false };
}

function saveConfig(config: WotConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function loadCache(): WotCache {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as WotCache;
    }
  } catch {
    // fresh cache
  }
  return {};
}

function saveCache(cache: WotCache): void {
  ensureDir();
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function getCached(key: string): Record<string, unknown> | null {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.data;
}

function setCache(key: string, data: Record<string, unknown>): void {
  const cache = loadCache();
  cache[key] = { data, fetchedAt: Date.now() };
  // Prune expired entries
  const now = Date.now();
  for (const k of Object.keys(cache)) {
    if (now - cache[k].fetchedAt > CACHE_TTL_MS) delete cache[k];
  }
  saveCache(cache);
}

// ---- Bech32 npub decode ----

function npubToHex(npub: string): string {
  if (!npub.startsWith("npub1")) {
    throw new Error('Invalid npub: must start with "npub1"');
  }
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = npub.slice(5);
  const words: number[] = [];
  for (const c of data) {
    const charIndex = CHARSET.indexOf(c);
    if (charIndex === -1) throw new Error(`Invalid bech32 character: ${c}`);
    words.push(charIndex);
  }
  const payload = words.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of payload) {
    acc = (acc << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) {
    throw new Error(`Invalid npub: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resolvePubkey(input: string): string {
  if (input.startsWith("npub1")) return npubToHex(input);
  if (!/^[0-9a-f]{64}$/i.test(input)) {
    throw new Error("Invalid pubkey: expected 64-char hex or npub1... bech32");
  }
  return input.toLowerCase();
}

// ---- API calls ----

async function freeGet(
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = new URL(FREE_API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 402) throw new Error("FREE_TIER_EXHAUSTED");
  if (response.status === 530) throw new Error("API_UNAVAILABLE_530");
  if (response.status === 404) throw new Error("PUBKEY_NOT_FOUND");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function paidWotReport(hexPubkey: string): Promise<PaidWotReport> {
  const response = await fetch(PAID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: hexPubkey }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 402) {
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    throw new Error(
      `L402 payment required (100 sats). WWW-Authenticate: ${wwwAuth.slice(0, 200)}`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Paid API error ${response.status}: ${text.slice(0, 200)}`);
  }
  return (await response.json()) as PaidWotReport;
}

// ---- Commands ----

async function cmdTrustScore(pubkeyInput: string): Promise<void> {
  const hex = resolvePubkey(pubkeyInput);
  const cacheKey = `score:${hex}`;

  const cached = getCached(cacheKey);
  if (cached) {
    const config = loadConfig();
    const trusted =
      (cached.rank as number) <= config.minRank &&
      (!config.requireTop100 || (cached.in_top_100 as boolean));
    console.log(
      JSON.stringify({ success: true, cached: true, pubkey: hex, trusted, ...cached }, null, 2)
    );
    return;
  }

  // Try free API first
  try {
    const data = (await freeGet("/score", { pubkey: hex })) as unknown as WotScoreResponse;
    const result = {
      normalized_score: data.normalized_score,
      rank: data.rank,
      percentile: data.percentile,
    };
    setCache(cacheKey, result as unknown as Record<string, unknown>);
    const config = loadConfig();
    const trusted = data.rank <= config.minRank;
    console.log(
      JSON.stringify(
        { success: true, cached: false, api: "free", pubkey: hex, trusted, ...result },
        null,
        2
      )
    );
    return;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "PUBKEY_NOT_FOUND") {
      console.log(
        JSON.stringify({
          success: false,
          pubkey: hex,
          error: "Pubkey not found in WoT graph (52K+ pubkeys indexed)",
        }, null, 2)
      );
      process.exit(1);
    }
    process.stderr.write(`Free API failed (${msg}), trying paid endpoint...\n`);
  }

  // Fallback to paid API
  try {
    const report = await paidWotReport(hex);
    const result = {
      rank: report.rank,
      position: report.position,
      in_top_100: report.in_top_100,
      report: report.report,
      graph: report.graph,
    };
    setCache(cacheKey, result as unknown as Record<string, unknown>);
    const config = loadConfig();
    const trusted =
      report.rank <= config.minRank && (!config.requireTop100 || report.in_top_100);
    console.log(
      JSON.stringify(
        { success: true, cached: false, api: "paid", pubkey: hex, trusted, ...result },
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        success: false,
        pubkey: hex,
        error: error instanceof Error ? error.message : String(error),
        hint: "Free tier may be exhausted. L402 payment requires Lightning.",
      }, null, 2)
    );
    process.exit(1);
  }
}

async function cmdSybilCheck(pubkeyInput: string): Promise<void> {
  const hex = resolvePubkey(pubkeyInput);
  const cacheKey = `sybil:${hex}`;

  const cached = getCached(cacheKey);
  if (cached) {
    console.log(JSON.stringify({ success: true, cached: true, pubkey: hex, ...cached }, null, 2));
    return;
  }

  try {
    const data = (await freeGet("/sybil", { pubkey: hex })) as unknown as SybilResponse;
    const classification = data.classification;
    const result = {
      classification,
      is_sybil: classification === "likely_sybil",
      is_suspicious: classification === "suspicious" || classification === "likely_sybil",
      follower_quality: data.follower_quality,
      mutual_trust_ratio: data.mutual_trust_ratio,
    };
    setCache(cacheKey, result as unknown as Record<string, unknown>);
    console.log(
      JSON.stringify({ success: true, cached: false, pubkey: hex, ...result }, null, 2)
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        success: false,
        pubkey: hex,
        error: msg === "PUBKEY_NOT_FOUND" ? "Pubkey not found in WoT graph" : msg,
        hint: msg !== "PUBKEY_NOT_FOUND" ? "Sybil check only available via free tier (wot.klabo.world)" : undefined,
      }, null, 2)
    );
    process.exit(1);
  }
}

async function cmdNeighbors(pubkeyInput: string): Promise<void> {
  const hex = resolvePubkey(pubkeyInput);
  const cacheKey = `neighbors:${hex}`;

  const cached = getCached(cacheKey);
  if (cached) {
    console.log(JSON.stringify({ success: true, cached: true, pubkey: hex, ...cached }, null, 2));
    return;
  }

  try {
    const data = (await freeGet("/trust-path", { pubkey: hex })) as unknown as TrustPathResponse;
    const result = {
      connected: data.connected,
      combined_trust: data.combined_trust,
      paths: data.paths,
    };
    setCache(cacheKey, result as unknown as Record<string, unknown>);
    console.log(
      JSON.stringify({ success: true, cached: false, pubkey: hex, ...result }, null, 2)
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "PUBKEY_NOT_FOUND") {
      console.log(
        JSON.stringify({ success: false, pubkey: hex, error: "Pubkey not found in WoT graph" }, null, 2)
      );
      process.exit(1);
    }
    // Paid API fallback for graph summary
    try {
      process.stderr.write(`Free API failed (${msg}), trying paid endpoint...\n`);
      const report = await paidWotReport(hex);
      const result = {
        graph: report.graph,
        rank: report.rank,
        note: "Detailed neighbor list requires direct Nostr relay queries. WoT report provides graph summary.",
      };
      setCache(cacheKey, result as unknown as Record<string, unknown>);
      console.log(
        JSON.stringify({ success: true, cached: false, api: "paid", pubkey: hex, ...result }, null, 2)
      );
    } catch (paidErr) {
      console.log(
        JSON.stringify({
          success: false,
          pubkey: hex,
          error: paidErr instanceof Error ? paidErr.message : String(paidErr),
          hint: "Neighbor discovery requires free tier (wot.klabo.world) or L402 payment",
        }, null, 2)
      );
      process.exit(1);
    }
  }
}

async function cmdNetworkHealth(): Promise<void> {
  const cacheKey = "network-health";
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(JSON.stringify({ success: true, cached: true, ...cached }, null, 2));
    return;
  }

  try {
    const data = (await freeGet("/network-health", {})) as unknown as NetworkHealthResponse;
    const result = {
      graph_nodes: data.graph_nodes,
      graph_edges: data.graph_edges,
      gini_coefficient: data.gini_coefficient,
      power_law_alpha: data.power_law_alpha,
    };
    setCache(cacheKey, result as unknown as Record<string, unknown>);
    console.log(JSON.stringify({ success: true, cached: false, ...result }, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2)
    );
    process.exit(1);
  }
}

function cmdConfig(args: string[]): void {
  const config = loadConfig();
  let changed = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-rank" && i + 1 < args.length) {
      config.minRank = parseInt(args[i + 1], 10);
      changed = true;
      i++;
    } else if (args[i] === "--require-top100") {
      config.requireTop100 = true;
      changed = true;
    } else if (args[i] === "--no-require-top100") {
      config.requireTop100 = false;
      changed = true;
    }
  }

  if (changed) {
    saveConfig(config);
    console.log(JSON.stringify({ success: true, message: "Config updated", config }, null, 2));
  } else {
    console.log(JSON.stringify({ success: true, message: "Current config", config }, null, 2));
  }
}

function cmdCacheStatus(): void {
  const cache = loadCache();
  const now = Date.now();
  const entries = Object.entries(cache);
  const valid = entries.filter(([, v]) => now - v.fetchedAt < CACHE_TTL_MS);
  const expired = entries.length - valid.length;
  console.log(
    JSON.stringify(
      {
        totalEntries: entries.length,
        validEntries: valid.length,
        expiredEntries: expired,
        cachePath: CACHE_PATH,
        ttlMinutes: CACHE_TTL_MS / 60000,
        entries: valid.map(([key, v]) => ({
          key,
          ageMinutes: Math.round((now - v.fetchedAt) / 60000),
        })),
      },
      null,
      2
    )
  );
}

// ---- Arg parser ----

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function printUsage(): void {
  console.log(`nostr-wot — Nostr Web of Trust via MaximumSats

Usage: bun run nostr-wot/nostr-wot.ts <subcommand> [options]

Subcommands:
  trust-score    --pubkey <hex> | --npub <npub>   WoT trust score, rank, threshold check
  sybil-check    --pubkey <hex> | --npub <npub>   Sybil classification (normal/suspicious/likely_sybil)
  neighbors      --pubkey <hex> | --npub <npub>   Trust graph neighbors and paths
  network-health                                  Graph-wide stats (nodes, edges, Gini)
  config         [--min-rank N] [--require-top100] View/update threshold config
  cache-status                                    Show cache statistics

APIs:
  Free:  wot.klabo.world        (50 req/day, no auth)
  Paid:  maximumsats.com        (100 sats via L402)
  Cache: ~/.aibtc/nostr-wot/    (1h TTL)
`);
}

// ---- Main ----

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  printUsage();
  process.exit(0);
}

const flags = parseFlags(args.slice(1));
const pubkeyInput = flags.pubkey ?? flags.npub;

try {
  switch (command) {
    case "trust-score":
      if (!pubkeyInput) { console.error("--pubkey or --npub required"); process.exit(1); }
      await cmdTrustScore(pubkeyInput);
      break;

    case "sybil-check":
      if (!pubkeyInput) { console.error("--pubkey or --npub required"); process.exit(1); }
      await cmdSybilCheck(pubkeyInput);
      break;

    case "neighbors":
      if (!pubkeyInput) { console.error("--pubkey or --npub required"); process.exit(1); }
      await cmdNeighbors(pubkeyInput);
      break;

    case "network-health":
      await cmdNetworkHealth();
      break;

    case "config":
      cmdConfig(args.slice(1));
      break;

    case "cache-status":
      cmdCacheStatus();
      break;

    default:
      console.error(`Unknown subcommand: ${command}`);
      printUsage();
      process.exit(1);
  }
} catch (error) {
  console.error(JSON.stringify({ success: false, error: String(error) }));
  process.exit(1);
}
