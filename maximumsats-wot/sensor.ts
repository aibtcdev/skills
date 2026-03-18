/**
 * maximumsats-wot/sensor.ts
 *
 * Monitors WoT scores for pubkeys listed in a watchlist file.
 * Fires an alert if any pubkey's score drops ≥ 10 points since last check.
 *
 * Watchlist format (MAXIMUMSATS_WOT_WATCHLIST env var, path to JSON file):
 *   [{ "pubkey": "npub1...", "label": "human-readable name" }]
 *
 * State file: path from MAXIMUMSATS_WOT_STATE env var (default: /tmp/maximumsats-wot-state.json)
 *
 * Run: bun run maximumsats-wot/sensor.ts
 * Exits 0 on skip/ok, 1 on unrecoverable error, 2 on score drop detected.
 */

import fs from "fs/promises";
import path from "path";

const BASE_URL = "https://wot.klabo.world";

interface WatchlistEntry {
  pubkey: string;
  label: string;
}

interface ScoreResponse {
  score?: number;
  wot_score?: number;
  [key: string]: unknown;
}

interface StateFile {
  scores: Record<string, number>;
  lastRun: string;
}

const watchlistPath = process.env.MAXIMUMSATS_WOT_WATCHLIST;
const statePath = process.env.MAXIMUMSATS_WOT_STATE ?? "/tmp/maximumsats-wot-state.json";
const l402Token = process.env.MAXIMUMSATS_L402_TOKEN;

async function fetchScore(pubkey: string): Promise<number | null> {
  try {
    const headers: Record<string, string> = {};
    if (l402Token) headers["Authorization"] = `L402 ${l402Token}`;

    const res = await fetch(`${BASE_URL}/score?pubkey=${encodeURIComponent(pubkey)}`, { headers });
    if (res.status === 402) {
      console.log(`[maximumsats-wot] free tier exhausted — skipping ${pubkey.slice(0, 12)}...`);
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json()) as ScoreResponse;
    const score = data.score ?? data.wot_score;
    return typeof score === "number" ? score : null;
  } catch {
    return null;
  }
}

async function loadState(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as StateFile;
  } catch {
    return { scores: {}, lastRun: "" };
  }
}

async function saveState(state: StateFile): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

async function run(): Promise<void> {
  if (!watchlistPath) {
    console.log("[maximumsats-wot] MAXIMUMSATS_WOT_WATCHLIST not set — skipping");
    process.exit(0);
  }

  let watchlist: WatchlistEntry[] = [];
  try {
    const raw = await fs.readFile(watchlistPath, "utf-8");
    watchlist = JSON.parse(raw) as WatchlistEntry[];
  } catch {
    console.log(`[maximumsats-wot] watchlist not found at ${watchlistPath} — skipping`);
    process.exit(0);
  }

  if (watchlist.length === 0) {
    console.log("[maximumsats-wot] watchlist is empty — skipping");
    process.exit(0);
  }

  const state = await loadState();
  const prevScores = state.scores;
  const newScores: Record<string, number> = {};
  const alerts: string[] = [];

  for (const entry of watchlist) {
    const score = await fetchScore(entry.pubkey);
    if (score === null) continue;

    newScores[entry.pubkey] = score;

    const prev = prevScores[entry.pubkey];
    if (prev !== undefined && prev - score >= 10) {
      alerts.push(`${entry.label} (${entry.pubkey.slice(0, 12)}...): ${prev} → ${score} (-${prev - score})`);
    }
  }

  await saveState({ scores: { ...prevScores, ...newScores }, lastRun: new Date().toISOString() });

  if (alerts.length === 0) {
    console.log(`[maximumsats-wot] checked ${Object.keys(newScores).length} pubkeys — no significant drops`);
    process.exit(0);
  }

  console.log(`[maximumsats-wot] ALERT — WoT score drop detected for ${alerts.length} pubkey(s):`);
  for (const alert of alerts) {
    console.log(`  - ${alert}`);
  }
  // Exit 2 to signal alert condition to caller
  process.exit(2);
}

run().catch((err) => {
  console.error(`[maximumsats-wot] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
