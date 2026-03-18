#!/usr/bin/env bun
/**
 * MaximumSats Web of Trust skill CLI
 * Nostr WoT trust scoring for counterparty risk assessment.
 * API: POST https://maximumsats.com/api/wot-report (100 sats via L402)
 *
 * Usage: bun run maximumsats-wot/maximumsats-wot.ts <subcommand> [options]
 */

import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { secp256k1 } from "@noble/curves/secp256k1";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WOT_API_URL = "https://maximumsats.com/api/wot-report";
const CONFIG_DIR = path.join(os.homedir(), ".aibtc");
const CACHE_FILE = path.join(CONFIG_DIR, "maximumsats-cache.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "maximumsats-config.json");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WotReport {
  pubkey: string;
  rank: number;
  position: number;
  in_top_100: boolean;
  report: string;
  graph: { nodes: number; edges: number };
}

interface CacheEntry {
  data: WotReport;
  fetchedAt: number;
}

interface WotCache {
  [hexPubkey: string]: CacheEntry;
}

interface WotConfig {
  minRank: number;
  requireTop100: boolean;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<WotConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as WotConfig;
  } catch {
    return { minRank: 10000, requireTop100: false };
  }
}

async function saveConfig(config: WotConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function loadCache(): Promise<WotCache> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw) as WotCache;
  } catch {
    return {};
  }
}

async function saveCache(cache: WotCache): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function getCached(hexPubkey: string): Promise<WotReport | null> {
  const cache = await loadCache();
  const entry = cache[hexPubkey];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.data;
}

async function setCache(hexPubkey: string, data: WotReport): Promise<void> {
  const cache = await loadCache();
  cache[hexPubkey] = { data, fetchedAt: Date.now() };
  // Prune expired entries
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (now - cache[key].fetchedAt > CACHE_TTL_MS) {
      delete cache[key];
    }
  }
  await saveCache(cache);
}

// ---------------------------------------------------------------------------
// Pubkey helpers
// ---------------------------------------------------------------------------

/**
 * Convert npub (bech32) to hex pubkey.
 * npub is bech32-encoded with HRP "npub" containing a 32-byte x-only pubkey.
 */
function npubToHex(npub: string): string {
  if (!npub.startsWith("npub1")) {
    throw new Error('Invalid npub: must start with "npub1"');
  }
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = npub.slice(5); // remove "npub1"

  // Decode bech32 to 5-bit words
  const words: number[] = [];
  for (const c of data) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid bech32 character: ${c}`);
    words.push(idx);
  }

  // Remove checksum (last 6 words), convert 5-bit to 8-bit
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

/** Resolve npub bech32 or hex pubkey to lowercase hex. */
function resolveHexPubkey(input: string): string {
  if (input.startsWith("npub1")) {
    return npubToHex(input);
  }
  if (!/^[0-9a-f]{64}$/i.test(input)) {
    throw new Error("Invalid pubkey: expected 64-char hex or npub1... bech32");
  }
  return input.toLowerCase();
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Fetch WoT report from MaximumSats API.
 * Requires L402 Lightning payment (100 sats) — returns HTTP 402 without payment.
 */
async function fetchWotReport(hexPubkey: string): Promise<WotReport> {
  const response = await fetch(WOT_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: hexPubkey }),
  });

  if (response.status === 402) {
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    throw new Error(
      `L402 payment required (100 sats via Lightning). ` +
        `An L402 client is needed to pay for this request. ` +
        `WWW-Authenticate: ${wwwAuth.substring(0, 200)}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${body.substring(0, 500)}`);
  }

  return (await response.json()) as WotReport;
}

// ---------------------------------------------------------------------------
// Threshold check
// ---------------------------------------------------------------------------

function checkThresholds(
  report: WotReport,
  config: WotConfig
): { trusted: boolean; reason?: string; rank: number; in_top_100: boolean; thresholds: WotConfig } {
  if (config.requireTop100 && !report.in_top_100) {
    return {
      trusted: false,
      reason: `Not in top 100 (rank: ${report.rank})`,
      rank: report.rank,
      in_top_100: report.in_top_100,
      thresholds: config,
    };
  }
  if (report.rank > config.minRank) {
    return {
      trusted: false,
      reason: `Rank ${report.rank} exceeds minRank threshold ${config.minRank}`,
      rank: report.rank,
      in_top_100: report.in_top_100,
      thresholds: config,
    };
  }
  return {
    trusted: true,
    rank: report.rank,
    in_top_100: report.in_top_100,
    thresholds: config,
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command()
  .name("maximumsats-wot")
  .description("MaximumSats Web of Trust — Nostr trust scoring for counterparty risk assessment")
  .version("1.0.0");

program
  .command("check")
  .description("Look up WoT trust score for a Nostr pubkey (hex or npub)")
  .option("--npub <npub>", "Nostr npub bech32 (npub1...)")
  .option("--pubkey <hex>", "Nostr pubkey (64-char hex)")
  .action(async (options: { npub?: string; pubkey?: string }) => {
    try {
      const input = options.npub ?? options.pubkey;
      if (!input) {
        throw new Error("Either --npub or --pubkey is required");
      }

      const hexPubkey = resolveHexPubkey(input);

      const cached = await getCached(hexPubkey);
      if (cached) {
        const config = await loadConfig();
        const threshold = checkThresholds(cached, config);
        printJson({
          success: true,
          cached: true,
          pubkey: hexPubkey,
          ...threshold,
          report: cached.report,
          graph: cached.graph,
        });
        return;
      }

      const report = await fetchWotReport(hexPubkey);
      await setCache(hexPubkey, report);
      const config = await loadConfig();
      const threshold = checkThresholds(report, config);
      printJson({
        success: true,
        cached: false,
        pubkey: hexPubkey,
        ...threshold,
        report: report.report,
        graph: report.graph,
      });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("check-agent")
  .description(
    "Derive Nostr pubkey from unlocked wallet (BTC-shared path m/84'/0'/0'/0/0) and look up WoT score"
  )
  .action(async () => {
    try {
      const walletManager = getWalletManager();
      const account = walletManager.getActiveAccount();
      if (!account) {
        throw new Error(
          "Wallet is not unlocked. Run: bun run wallet/wallet.ts unlock --password <password>"
        );
      }

      // Derive x-only Nostr pubkey from the BTC-shared BIP84 private key
      const compressedPub = secp256k1.getPublicKey(account.privateKey, true); // 33 bytes
      const xOnly = compressedPub.slice(1); // drop parity byte
      const hexPubkey = Buffer.from(xOnly).toString("hex");

      const cached = await getCached(hexPubkey);
      if (cached) {
        const config = await loadConfig();
        const threshold = checkThresholds(cached, config);
        printJson({
          success: true,
          cached: true,
          derivationPath: "m/84'/0'/0'/0/0",
          pubkey: hexPubkey,
          ...threshold,
          report: cached.report,
          graph: cached.graph,
        });
        return;
      }

      const report = await fetchWotReport(hexPubkey);
      await setCache(hexPubkey, report);
      const config = await loadConfig();
      const threshold = checkThresholds(report, config);
      printJson({
        success: true,
        cached: false,
        derivationPath: "m/84'/0'/0'/0/0",
        pubkey: hexPubkey,
        ...threshold,
        report: report.report,
        graph: report.graph,
      });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("config")
  .description("View or update trust threshold configuration")
  .option("--min-rank <n>", "Maximum acceptable rank (lower = more trusted, default: 10000)")
  .option("--require-top100", "Require pubkey to be in top 100")
  .option("--no-require-top100", "Remove top-100 requirement")
  .action(
    async (options: { minRank?: string; requireTop100?: boolean }) => {
      try {
        const config = await loadConfig();
        let changed = false;

        if (options.minRank !== undefined) {
          config.minRank = parseInt(options.minRank, 10);
          changed = true;
        }
        if (options.requireTop100 !== undefined) {
          config.requireTop100 = options.requireTop100;
          changed = true;
        }

        if (changed) {
          await saveConfig(config);
          printJson({ success: true, message: "Config updated", config });
        } else {
          printJson({ success: true, message: "Current config", config });
        }
      } catch (err) {
        handleError(err);
      }
    }
  );

program
  .command("cache-status")
  .description("Show cache statistics (results cached 1h to avoid redundant L402 payments)")
  .action(async () => {
    try {
      const cache = await loadCache();
      const now = Date.now();
      const entries = Object.entries(cache);
      const valid = entries.filter(([, v]) => now - v.fetchedAt < CACHE_TTL_MS);
      printJson({
        totalEntries: entries.length,
        validEntries: valid.length,
        expiredEntries: entries.length - valid.length,
        cacheFile: CACHE_FILE,
        ttlMinutes: CACHE_TTL_MS / 60000,
        entries: valid.map(([key, v]) => ({
          pubkey: key,
          rank: v.data.rank,
          in_top_100: v.data.in_top_100,
          ageMinutes: Math.round((now - v.fetchedAt) / 60000),
        })),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
