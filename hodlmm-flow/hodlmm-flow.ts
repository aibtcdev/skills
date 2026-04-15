#!/usr/bin/env bun
/**
 * HODLMM Flow — Swap Flow Intelligence for Bitflow HODLMM
 *
 * Market microstructure analysis for concentrated liquidity pools.
 * Analyzes on-chain swap transactions to compute direction bias, flow toxicity,
 * bin velocity, whale concentration, liquidation pressure, and bot/organic classification.
 *
 * Usage:
 *   bun run skills/hodlmm-flow/hodlmm-flow.ts doctor
 *   bun run skills/hodlmm-flow/hodlmm-flow.ts flow --pool-id dlmm_3
 *   bun run skills/hodlmm-flow/hodlmm-flow.ts flow --pool-id dlmm_3 --window 24h
 *   bun run skills/hodlmm-flow/hodlmm-flow.ts flow --all
 */

import { Command } from "commander";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIRO_API = "https://api.hiro.so";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1";
const FETCH_TIMEOUT_MS = 30_000;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 300;
const DEFAULT_SWAP_COUNT = 100;
const TX_PAGE_SIZE = 50;
const DLMM_CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const LIQUIDATOR_PREFIX = "SP16B5ZKHJAK4CSHQ1WYSZE57NWMKW0KDX6YZKH4J.liquidator";
const CACHE_DIR = join(process.env.HOME ?? "/tmp", ".hodlmm-flow-cache");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const POOL_CONTRACTS: Record<string, string> = {
  dlmm_1: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
  dlmm_2: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",
  dlmm_3: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",
  dlmm_4: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-4",
  dlmm_5: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-1",
  dlmm_6: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",
  dlmm_7: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1",
  dlmm_8: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",
};

// All HODLMM pools (used for --all protocol-wide summary)
const PRIMARY_POOLS = ["dlmm_1", "dlmm_2", "dlmm_3", "dlmm_4", "dlmm_5", "dlmm_6", "dlmm_7", "dlmm_8"];

// Swap function names on the router contracts
const SWAP_FUNCTIONS = [
  "swap-x-for-y-simple-multi",
  "swap-y-for-x-simple-multi",
  "swap-simple-multi",
  "liquidate-with-swap",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HiroTx {
  tx_id: string;
  tx_status: string;
  tx_type: string;
  sender_address: string;
  block_time: number;
  block_height: number;
  contract_call?: {
    contract_id: string;
    function_name: string;
  };
}

interface SwapBinHop {
  action: string; // "swap-x-for-y" or "swap-y-for-x"
  caller: string;
  activeBinId: number;
  binId: number;
  binPrice: number;
  dx: bigint;
  dy: bigint;
}

interface SwapRecord {
  txId: string;
  sender: string;
  blockTime: number;
  blockHeight: number;
  direction: "buy-x" | "buy-y" | "unknown";
  isLiquidation: boolean;
  functionName: string;
  hops: SwapBinHop[];
  totalDx: bigint;
  totalDy: bigint;
  activeBinStart: number;
  activeBinEnd: number;
}

interface ActorProfile {
  address: string;
  swapCount: number;
  totalVolumeX: bigint;
  totalVolumeY: bigint;
  label: "bot" | "organic" | "liquidator" | "router";
  avgSwapsPerHour: number;
}

interface FlowMetrics {
  directionBias: number;        // [-1, +1] — negative = net selling X, positive = net buying X
  directionBiasLabel: string;
  flowToxicity: number;         // [0, 1] — ratio of consecutive same-direction runs
  flowToxicityLabel: string;
  binVelocity: number;          // bins per hour
  binVelocityLabel: string;
  whaleConcentration: number;   // Herfindahl index [0, 1]
  whaleConcentrationLabel: string;
  liquidationPressure: number;  // [0, 1] — liquidation volume / total volume
  liquidationPressureLabel: string;
  botFlowRatio: number;         // [0, 1] — bot volume / total volume
  botFlowRatioLabel: string;
}

interface FlowVerdict {
  lpSafety: "safe" | "caution" | "danger";
  score: number; // 0-100
  reasoning: string;
  recommendation: string;
  rangeLifespanHours: number | null;
}

interface FlowAnalysis {
  status: "success";
  network: "mainnet";
  timestamp: string;
  poolId: string;
  pair: string;
  swapsAnalyzed: number;
  timeSpanHours: number;
  metrics: FlowMetrics;
  verdict: FlowVerdict;
  topActors: Array<{
    address: string;
    swapCount: number;
    volumeShare: number;
    label: string;
  }>;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cacheKey(poolId: string, swapCount: number, windowSeconds?: number): string {
  return `${poolId}_${swapCount}_${windowSeconds ?? "all"}`;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.json`);
}

function readCache(key: string): FlowAnalysis | null {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const cached = JSON.parse(raw) as FlowAnalysis & { _cachedAt: number };
    if (Date.now() - cached._cachedAt > CACHE_TTL_MS) return null;
    delete (cached as unknown as Record<string, unknown>)._cachedAt;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(key: string, data: FlowAnalysis): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(key), JSON.stringify({ ...data, _cachedAt: Date.now() }));
  } catch {
    // Cache write failure is non-fatal
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

let hiroApiKey: string | undefined;

function hiroHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (hiroApiKey) h["x-hiro-api-key"] = hiroApiKey;
  return h;
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json", ...headers },
  });
  if (res.status === 429) {
    throw new Error(
      `Rate limited by ${new URL(url).hostname}. Use --hiro-api-key for elevated limits.`
    );
  }
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}: ${url}`);
  return res.json() as Promise<T>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Clarity repr parsing
// ---------------------------------------------------------------------------

function extractReprField(repr: string, field: string): string | null {
  // Match (field value) or (field "value")
  const patterns = [
    new RegExp(`\\(${field}\\s+"([^"]*)"\\)`),          // string: (field "value")
    new RegExp(`\\(${field}\\s+'([A-Z0-9]+[^)]*?)\\)`), // principal: (field 'SP...)
    new RegExp(`\\(${field}\\s+u(\\d+)\\)`),             // uint: (field u123)
    new RegExp(`\\(${field}\\s+(-?\\d+)\\)`),            // int: (field -123)
  ];
  for (const pat of patterns) {
    const m = repr.match(pat);
    if (m) return m[1];
  }
  return null;
}

function parseSwapEvent(repr: string): SwapBinHop | null {
  const action = extractReprField(repr, "action");
  if (!action || !action.startsWith("swap-")) return null;

  const caller = extractReprField(repr, "caller");
  const activeBinIdStr = extractReprField(repr, "active-bin-id");
  const binIdStr = extractReprField(repr, "bin-id");
  const binPriceStr = extractReprField(repr, "bin-price");
  const dxStr = extractReprField(repr, "dx");
  const dyStr = extractReprField(repr, "dy");

  if (!caller || !dxStr || !dyStr) return null;

  return {
    action,
    caller,
    activeBinId: activeBinIdStr ? parseInt(activeBinIdStr, 10) : 0,
    binId: binIdStr ? parseInt(binIdStr, 10) : 0,
    binPrice: binPriceStr ? parseInt(binPriceStr, 10) : 0,
    dx: BigInt(dxStr),
    dy: BigInt(dyStr),
  };
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

async function fetchSwapTransactions(
  poolContract: string,
  targetSwapCount: number,
  windowSeconds?: number
): Promise<HiroTx[]> {
  const swapTxs: HiroTx[] = [];
  let offset = 0;
  const maxPages = 20; // safety limit
  const now = Math.floor(Date.now() / 1000);

  for (let page = 0; page < maxPages; page++) {
    const url = `${HIRO_API}/extended/v1/address/${poolContract}/transactions?limit=${TX_PAGE_SIZE}&offset=${offset}`;
    const data = await fetchJson<{ results: HiroTx[]; total: number }>(url, hiroHeaders());

    for (const tx of data.results) {
      if (tx.tx_status !== "success") continue;
      if (tx.tx_type !== "contract_call") continue;
      if (!tx.contract_call) continue;

      const fn = tx.contract_call.function_name;
      if (!SWAP_FUNCTIONS.includes(fn)) continue;

      // Window filter
      if (windowSeconds && (now - tx.block_time) > windowSeconds) {
        return swapTxs; // Past the window — we're done
      }

      swapTxs.push(tx);
      if (swapTxs.length >= targetSwapCount) return swapTxs;
    }

    // No more results
    if (data.results.length < TX_PAGE_SIZE) break;
    offset += TX_PAGE_SIZE;
  }

  return swapTxs;
}

async function fetchTxEvents(txId: string): Promise<SwapBinHop[]> {
  const url = `${HIRO_API}/extended/v1/tx/events?tx_id=${txId}&limit=96`;
  const data = await fetchJson<{
    events: Array<{
      event_type: string;
      contract_log?: {
        contract_id: string;
        value: { repr: string };
      };
    }>;
  }>(url, hiroHeaders());

  const hops: SwapBinHop[] = [];
  for (const ev of data.events) {
    if (ev.event_type !== "smart_contract_log") continue;
    if (!ev.contract_log?.contract_id?.includes("dlmm-core")) continue;
    const repr = ev.contract_log.value?.repr;
    if (!repr) continue;
    const hop = parseSwapEvent(repr);
    if (hop) hops.push(hop);
  }
  return hops;
}

async function enrichSwaps(txs: HiroTx[]): Promise<SwapRecord[]> {
  const records: SwapRecord[] = [];
  const errors: string[] = [];

  // Batch fetch events
  for (let i = 0; i < txs.length; i += BATCH_SIZE) {
    const batch = txs.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((tx) => fetchTxEvents(tx.tx_id))
    );

    for (let j = 0; j < batch.length; j++) {
      const tx = batch[j];
      const result = results[j];

      if (result.status === "rejected") {
        errors.push(tx.tx_id);
        continue;
      }

      const hops = result.value;
      if (hops.length === 0) {
        // Infer direction from function name alone
        const fn = tx.contract_call!.function_name;
        let direction: SwapRecord["direction"] = "unknown";
        if (fn.includes("x-for-y")) direction = "buy-y";
        else if (fn.includes("y-for-x")) direction = "buy-x";

        records.push({
          txId: tx.tx_id,
          sender: tx.sender_address,
          blockTime: tx.block_time,
          blockHeight: tx.block_height,
          direction,
          isLiquidation: fn === "liquidate-with-swap",
          functionName: fn,
          hops: [],
          totalDx: 0n,
          totalDy: 0n,
          activeBinStart: 0,
          activeBinEnd: 0,
        });
        continue;
      }

      const totalDx = hops.reduce((s, h) => s + h.dx, 0n);
      const totalDy = hops.reduce((s, h) => s + h.dy, 0n);
      const action = hops[0].action;
      let direction: SwapRecord["direction"] = "unknown";
      if (action === "swap-x-for-y") direction = "buy-y";
      else if (action === "swap-y-for-x") direction = "buy-x";

      // Bin movement: first hop's activeBinId vs last hop's
      const activeBinStart = hops[0].activeBinId;
      const activeBinEnd = hops[hops.length - 1].activeBinId;

      records.push({
        txId: tx.tx_id,
        sender: tx.sender_address,
        blockTime: tx.block_time,
        blockHeight: tx.block_height,
        direction,
        isLiquidation: tx.contract_call!.function_name === "liquidate-with-swap",
        functionName: tx.contract_call!.function_name,
        hops,
        totalDx,
        totalDy,
        activeBinStart,
        activeBinEnd,
      });
    }

    // Rate limit delay between batches
    if (i + BATCH_SIZE < txs.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      `Warning: failed to fetch events for ${errors.length} txs\n`
    );
  }

  return records;
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

function computeDirectionBias(swaps: SwapRecord[]): { value: number; label: string } {
  if (swaps.length === 0) return { value: 0, label: "No data" };

  // Volume-weighted direction bias
  let buyXVolume = 0n;
  let buyYVolume = 0n;

  for (const s of swaps) {
    const vol = s.totalDx + s.totalDy; // combined as proxy
    if (s.direction === "buy-x") buyXVolume += vol;
    else if (s.direction === "buy-y") buyYVolume += vol;
  }

  const total = buyXVolume + buyYVolume;
  if (total === 0n) {
    // Fall back to count-based
    let buyX = 0, buyY = 0;
    for (const s of swaps) {
      if (s.direction === "buy-x") buyX++;
      else if (s.direction === "buy-y") buyY++;
    }
    const t = buyX + buyY;
    if (t === 0) return { value: 0, label: "No directional swaps" };
    const bias = (buyX - buyY) / t;
    return { value: Math.round(bias * 1000) / 1000, label: biasLabel(bias) };
  }

  const bias = Number(buyXVolume - buyYVolume) / Number(total);
  return { value: Math.round(bias * 1000) / 1000, label: biasLabel(bias) };
}

function biasLabel(bias: number): string {
  if (bias > 0.5) return "Strong buy-X pressure";
  if (bias > 0.2) return "Moderate buy-X pressure";
  if (bias > 0.05) return "Slight buy-X pressure";
  if (bias > -0.05) return "Balanced";
  if (bias > -0.2) return "Slight sell-X pressure";
  if (bias > -0.5) return "Moderate sell-X pressure";
  return "Strong sell-X pressure";
}

function computeFlowToxicity(swaps: SwapRecord[]): { value: number; label: string } {
  if (swaps.length < 3) return { value: 0, label: "Insufficient data" };

  // Toxicity = ratio of swaps that continue the same direction as the previous swap
  // High toxicity = informed flow (adverse selection for LPs)
  let sameDirection = 0;
  let comparisons = 0;

  for (let i = 1; i < swaps.length; i++) {
    if (swaps[i].direction === "unknown" || swaps[i - 1].direction === "unknown") continue;
    comparisons++;
    if (swaps[i].direction === swaps[i - 1].direction) sameDirection++;
  }

  if (comparisons === 0) return { value: 0, label: "No directional data" };
  const toxicity = sameDirection / comparisons;
  const rounded = Math.round(toxicity * 1000) / 1000;

  let label: string;
  if (toxicity > 0.75) label = "Toxic — heavy informed flow, LPs getting picked off";
  else if (toxicity > 0.6) label = "Elevated — directional momentum present";
  else if (toxicity > 0.45) label = "Normal — mixed flow, healthy for LPs";
  else label = "Low — mean-reverting flow, favorable for LPs";

  return { value: rounded, label };
}

function computeBinVelocity(swaps: SwapRecord[]): { value: number; label: string } {
  if (swaps.length < 2) return { value: 0, label: "Insufficient data" };

  // Count distinct active bin changes across consecutive swaps
  const swapsWithBins = swaps.filter((s) => s.hops.length > 0);
  if (swapsWithBins.length < 2) return { value: 0, label: "No bin data" };

  let binChanges = 0;
  for (let i = 1; i < swapsWithBins.length; i++) {
    const prevBin = swapsWithBins[i - 1].activeBinEnd || swapsWithBins[i - 1].activeBinStart;
    const currBin = swapsWithBins[i].activeBinStart;
    if (prevBin !== 0 && currBin !== 0 && prevBin !== currBin) {
      binChanges += Math.abs(currBin - prevBin);
    }
  }

  // Time span in hours
  const earliest = swapsWithBins[swapsWithBins.length - 1].blockTime;
  const latest = swapsWithBins[0].blockTime;
  const hours = Math.max((latest - earliest) / 3600, 0.01);

  const velocity = binChanges / hours;
  const rounded = Math.round(velocity * 100) / 100;

  let label: string;
  if (velocity > 50) label = "Extreme — price whipsawing, narrow ranges will get shredded";
  else if (velocity > 20) label = "High — active price discovery, widen your range";
  else if (velocity > 5) label = "Moderate — normal volatility";
  else label = "Low — price stable, tight ranges viable";

  return { value: rounded, label };
}

function computeWhaleConcentration(swaps: SwapRecord[]): { value: number; label: string } {
  if (swaps.length === 0) return { value: 0, label: "No data" };

  // Herfindahl index on swap volume per address
  const volumeByAddress: Record<string, bigint> = {};
  let totalVolume = 0n;

  for (const s of swaps) {
    const vol = s.totalDx + s.totalDy;
    const addr = s.sender;
    volumeByAddress[addr] = (volumeByAddress[addr] ?? 0n) + vol;
    totalVolume += vol;
  }

  if (totalVolume === 0n) {
    // Fall back to count-based HHI
    const countByAddress: Record<string, number> = {};
    for (const s of swaps) {
      countByAddress[s.sender] = (countByAddress[s.sender] ?? 0) + 1;
    }
    const total = swaps.length;
    let hhi = 0;
    for (const count of Object.values(countByAddress)) {
      const share = count / total;
      hhi += share * share;
    }
    return { value: Math.round(hhi * 1000) / 1000, label: hhiLabel(hhi) };
  }

  let hhi = 0;
  for (const vol of Object.values(volumeByAddress)) {
    const share = Number(vol) / Number(totalVolume);
    hhi += share * share;
  }

  return { value: Math.round(hhi * 1000) / 1000, label: hhiLabel(hhi) };
}

function hhiLabel(hhi: number): string {
  if (hhi > 0.5) return "Monopolistic — single actor dominates flow";
  if (hhi > 0.25) return "Concentrated — few actors drive most volume";
  if (hhi > 0.1) return "Moderate — some concentration";
  return "Dispersed — healthy mix of participants";
}

function computeLiquidationPressure(swaps: SwapRecord[]): { value: number; label: string } {
  if (swaps.length === 0) return { value: 0, label: "No data" };

  let liqVolume = 0n;
  let totalVolume = 0n;
  let liqCount = 0;

  for (const s of swaps) {
    const vol = s.totalDx + s.totalDy;
    totalVolume += vol;
    if (s.isLiquidation) {
      liqVolume += vol;
      liqCount++;
    }
  }

  if (totalVolume === 0n) {
    // Count-based fallback
    const ratio = liqCount / swaps.length;
    return { value: Math.round(ratio * 1000) / 1000, label: liqLabel(ratio, liqCount) };
  }

  const ratio = Number(liqVolume) / Number(totalVolume);
  return { value: Math.round(ratio * 1000) / 1000, label: liqLabel(ratio, liqCount) };
}

function liqLabel(ratio: number, count: number): string {
  if (count === 0) return "None — no liquidation flow detected";
  if (ratio > 0.3) return `Heavy — ${count} liquidations, ${(ratio * 100).toFixed(1)}% of volume`;
  if (ratio > 0.1) return `Moderate — ${count} liquidations present`;
  return `Low — ${count} liquidation(s), minimal impact`;
}

function computeBotFlowRatio(swaps: SwapRecord[], actors: ActorProfile[]): { value: number; label: string } {
  const botAddresses = new Set(
    actors.filter((a) => a.label === "bot" || a.label === "router").map((a) => a.address)
  );

  let botVolume = 0n;
  let totalVolume = 0n;

  for (const s of swaps) {
    const vol = s.totalDx + s.totalDy;
    totalVolume += vol;
    if (botAddresses.has(s.sender)) botVolume += vol;
  }

  if (totalVolume === 0n) {
    let botCount = 0;
    for (const s of swaps) {
      if (botAddresses.has(s.sender)) botCount++;
    }
    const ratio = swaps.length > 0 ? botCount / swaps.length : 0;
    return { value: Math.round(ratio * 1000) / 1000, label: botLabel(ratio) };
  }

  const ratio = Number(botVolume) / Number(totalVolume);
  return { value: Math.round(ratio * 1000) / 1000, label: botLabel(ratio) };
}

function botLabel(ratio: number): string {
  if (ratio > 0.8) return "Bot-dominated — organic flow nearly absent";
  if (ratio > 0.5) return "Bot-heavy — majority of flow is automated";
  if (ratio > 0.2) return "Mixed — bots present but organic flow significant";
  return "Organic-dominant — mostly human/natural flow";
}

// ---------------------------------------------------------------------------
// Actor classification
// ---------------------------------------------------------------------------

function classifyActors(swaps: SwapRecord[]): ActorProfile[] {
  const actorMap: Record<string, {
    count: number;
    volumeX: bigint;
    volumeY: bigint;
    isLiquidator: boolean;
    times: number[];
  }> = {};

  for (const s of swaps) {
    if (!actorMap[s.sender]) {
      actorMap[s.sender] = { count: 0, volumeX: 0n, volumeY: 0n, isLiquidator: false, times: [] };
    }
    const a = actorMap[s.sender];
    a.count++;
    a.volumeX += s.totalDx;
    a.volumeY += s.totalDy;
    a.times.push(s.blockTime);
    if (s.isLiquidation) a.isLiquidator = true;
  }

  const timeSpanHours = swaps.length > 1
    ? Math.max((swaps[0].blockTime - swaps[swaps.length - 1].blockTime) / 3600, 0.01)
    : 1;

  const profiles: ActorProfile[] = [];
  for (const [address, data] of Object.entries(actorMap)) {
    const avgSwapsPerHour = data.count / timeSpanHours;

    let label: ActorProfile["label"];
    if (data.isLiquidator) {
      label = "liquidator";
    } else if (avgSwapsPerHour > 10 || data.count > swaps.length * 0.3) {
      label = "bot";
    } else if (avgSwapsPerHour > 3) {
      label = "router";
    } else {
      label = "organic";
    }

    profiles.push({
      address,
      swapCount: data.count,
      totalVolumeX: data.volumeX,
      totalVolumeY: data.volumeY,
      label,
      avgSwapsPerHour: Math.round(avgSwapsPerHour * 100) / 100,
    });
  }

  // Sort by swap count descending
  profiles.sort((a, b) => b.swapCount - a.swapCount);
  return profiles;
}

// ---------------------------------------------------------------------------
// Verdict generation
// ---------------------------------------------------------------------------

function generateVerdict(
  metrics: FlowMetrics,
  swaps: SwapRecord[],
  binStep: number
): FlowVerdict {
  // Score components (0-100 scale, higher = safer for LPs)
  let score = 100;

  // Direction bias penalty: extreme bias = danger
  const biasPenalty = Math.abs(metrics.directionBias) * 30;
  score -= biasPenalty;

  // Toxicity penalty: high toxicity = informed flow hurting LPs
  const toxicityPenalty = metrics.flowToxicity * 30;
  score -= toxicityPenalty;

  // Bin velocity penalty: high velocity = narrow ranges get destroyed
  const velocityPenalty = Math.min(20, metrics.binVelocity * 0.4);
  score -= velocityPenalty;

  // Whale concentration penalty: concentrated = manipulable
  const whalePenalty = Math.max(0, (metrics.whaleConcentration - 0.15) * 30);
  score -= whalePenalty;

  // Liquidation bonus: some liquidation flow is actually good for LPs (volume + fees)
  // But heavy liquidation means underlying assets are stressed
  const liqPenalty = metrics.liquidationPressure > 0.2
    ? (metrics.liquidationPressure - 0.2) * 25
    : -metrics.liquidationPressure * 5; // slight bonus
  score -= liqPenalty;

  // Bot penalty: bot-dominated flow is only harmful when toxic.
  // Mean-reverting arb bots in low-toxicity pools are LP-friendly; informed bots in high-toxicity pools amplify adverse selection.
  // Scale the base penalty by (0.5 + toxicity): half weight at toxicity=0, 1.5x at toxicity=1.
  const botPenaltyBase = Math.max(0, (metrics.botFlowRatio - 0.5) * 20);
  const botPenalty = botPenaltyBase * (0.5 + metrics.flowToxicity);
  score -= botPenalty;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let lpSafety: FlowVerdict["lpSafety"];
  if (score >= 65) lpSafety = "safe";
  else if (score >= 40) lpSafety = "caution";
  else lpSafety = "danger";

  // Build reasoning
  const reasons: string[] = [];
  if (Math.abs(metrics.directionBias) > 0.3) {
    reasons.push(`Strong directional pressure (${metrics.directionBias > 0 ? "buying" : "selling"} X)`);
  }
  if (metrics.flowToxicity > 0.6) {
    reasons.push("Elevated flow toxicity — informed traders may be front-running LPs");
  }
  if (metrics.binVelocity > 20) {
    reasons.push("High bin velocity — price moving fast, narrow positions at risk");
  }
  if (metrics.whaleConcentration > 0.25) {
    reasons.push("Concentrated flow — few actors dominating volume");
  }
  if (metrics.liquidationPressure > 0.2) {
    reasons.push("Significant liquidation flow — collateral stress in lending markets");
  }
  if (metrics.botFlowRatio > 0.7) {
    reasons.push("Bot-dominated — organic trading minimal");
  }
  if (reasons.length === 0) {
    reasons.push("Flow conditions normal across all metrics");
  }

  // Range lifespan estimate
  let rangeLifespanHours: number | null = null;
  if (metrics.binVelocity > 0) {
    // Estimate: how long until a ±radius position goes out of range
    const radius = Math.max(5, Math.round(50 / binStep));
    rangeLifespanHours = Math.round((radius * 2) / metrics.binVelocity * 10) / 10;
    if (rangeLifespanHours > 720) rangeLifespanHours = null; // >30 days = effectively infinite
  }

  // Recommendation
  let recommendation: string;
  if (lpSafety === "safe") {
    recommendation = "Conditions favorable for LPs. Standard range width appropriate.";
  } else if (lpSafety === "caution") {
    recommendation = rangeLifespanHours && rangeLifespanHours < 24
      ? `Consider widening range — current velocity exhausts ±${Math.max(5, Math.round(50 / binStep))}-bin position in ~${rangeLifespanHours}h.`
      : "Monitor flow direction. Consider asymmetric range if bias persists.";
  } else {
    recommendation = "Unfavorable conditions for passive LPs. Consider reducing exposure or waiting for flow normalization.";
  }

  return {
    lpSafety,
    score,
    reasoning: reasons.join(". ") + ".",
    recommendation,
    rangeLifespanHours,
  };
}

// ---------------------------------------------------------------------------
// Pool info helpers
// ---------------------------------------------------------------------------

interface PoolInfo {
  poolId: string;
  pair: string;
  binStep: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

async function getPoolInfo(poolId: string): Promise<PoolInfo> {
  const [poolList, detail] = await Promise.all([
    fetchJson<{ pools: Array<{ pool_id: string; bin_step: number }> }>(`${BITFLOW_QUOTES_API}/pools`),
    fetchJson<{
      tokens: {
        tokenX: { symbol: string; decimals: number };
        tokenY: { symbol: string; decimals: number };
      };
    }>(`${BITFLOW_APP_API}/pools/${poolId}`),
  ]);

  const pool = poolList.pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool ${poolId} not found in Bitflow API`);

  return {
    poolId,
    pair: `${detail.tokens.tokenX.symbol}/${detail.tokens.tokenY.symbol}`,
    binStep: pool.bin_step,
    tokenXSymbol: detail.tokens.tokenX.symbol,
    tokenYSymbol: detail.tokens.tokenY.symbol,
    tokenXDecimals: detail.tokens.tokenX.decimals,
    tokenYDecimals: detail.tokens.tokenY.decimals,
  };
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

function parseDuration(input: string): number {
  const m = input.match(/^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|m|min|mins|minutes?)$/i);
  if (!m) throw new Error(`Invalid duration: "${input}". Use e.g. 24h, 1d, 30m.`);
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("h")) return n * 3600;
  if (unit.startsWith("d")) return n * 86400;
  if (unit.startsWith("m")) return n * 60;
  throw new Error(`Unknown time unit: ${unit}`);
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function analyzePool(
  poolId: string,
  swapCount: number,
  windowSeconds?: number,
  skipCache = false
): Promise<FlowAnalysis> {
  const contract = POOL_CONTRACTS[poolId];
  if (!contract) throw new Error(`Unknown pool: ${poolId}. Valid: ${Object.keys(POOL_CONTRACTS).join(", ")}`);

  // Check cache (5-min TTL — avoids redundant Hiro crawls for repeated calls)
  const key = cacheKey(poolId, swapCount, windowSeconds);
  if (!skipCache) {
    const cached = readCache(key);
    if (cached) return cached;
  }

  const poolInfo = await getPoolInfo(poolId);

  // Fetch swap transactions
  const txs = await fetchSwapTransactions(contract, swapCount, windowSeconds);
  if (txs.length === 0) {
    throw new Error(`No swap transactions found for ${poolId}${windowSeconds ? ` in the specified window` : ""}`);
  }

  // Enrich with event data
  const swaps = await enrichSwaps(txs);
  if (swaps.length === 0) {
    throw new Error(`Failed to parse any swap data for ${poolId}`);
  }

  // Classify actors
  const actors = classifyActors(swaps);

  // Compute metrics
  const dirBias = computeDirectionBias(swaps);
  const toxicity = computeFlowToxicity(swaps);
  const velocity = computeBinVelocity(swaps);
  const whale = computeWhaleConcentration(swaps);
  const liq = computeLiquidationPressure(swaps);
  const botFlow = computeBotFlowRatio(swaps, actors);

  const metrics: FlowMetrics = {
    directionBias: dirBias.value,
    directionBiasLabel: dirBias.label,
    flowToxicity: toxicity.value,
    flowToxicityLabel: toxicity.label,
    binVelocity: velocity.value,
    binVelocityLabel: velocity.label,
    whaleConcentration: whale.value,
    whaleConcentrationLabel: whale.label,
    liquidationPressure: liq.value,
    liquidationPressureLabel: liq.label,
    botFlowRatio: botFlow.value,
    botFlowRatioLabel: botFlow.label,
  };

  // Generate verdict
  const verdict = generateVerdict(metrics, swaps, poolInfo.binStep);

  // Time span
  const earliest = swaps[swaps.length - 1].blockTime;
  const latest = swaps[0].blockTime;
  const timeSpanHours = Math.round(((latest - earliest) / 3600) * 10) / 10;

  // Top actors (top 5 by volume share)
  const totalVol = swaps.reduce((s, sw) => s + sw.totalDx + sw.totalDy, 0n);
  const topActors = actors.slice(0, 5).map((a) => ({
    address: a.address,
    swapCount: a.swapCount,
    volumeShare: totalVol > 0n
      ? Math.round(Number(a.totalVolumeX + a.totalVolumeY) / Number(totalVol) * 1000) / 10
      : Math.round((a.swapCount / swaps.length) * 1000) / 10,
    label: a.label,
  }));

  const result: FlowAnalysis = {
    status: "success",
    network: "mainnet",
    timestamp: new Date().toISOString(),
    poolId,
    pair: poolInfo.pair,
    swapsAnalyzed: swaps.length,
    timeSpanHours,
    metrics,
    verdict,
    topActors,
  };

  writeCache(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("hodlmm-flow")
  .description("Swap flow intelligence for Bitflow HODLMM concentrated liquidity pools");

program
  .command("doctor")
  .description("Check API connectivity")
  .action(async () => {
    try {
      const checks: Record<string, string> = {};

      // Hiro API
      try {
        await fetchJson<unknown>(`${HIRO_API}/v2/info`);
        checks["hiro-api"] = "ok";
      } catch (e) {
        checks["hiro-api"] = `fail: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Hiro transactions API (specific to our use case)
      try {
        const contract = POOL_CONTRACTS.dlmm_3;
        await fetchJson<unknown>(
          `${HIRO_API}/extended/v1/address/${contract}/transactions?limit=1`,
          hiroHeaders()
        );
        checks["hiro-transactions"] = "ok";
      } catch (e) {
        checks["hiro-transactions"] = `fail: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Hiro events API
      try {
        // Use a known tx to test events endpoint
        const contract = POOL_CONTRACTS.dlmm_3;
        const txData = await fetchJson<{ results: HiroTx[] }>(
          `${HIRO_API}/extended/v1/address/${contract}/transactions?limit=1`,
          hiroHeaders()
        );
        if (txData.results.length > 0) {
          await fetchJson<unknown>(
            `${HIRO_API}/extended/v1/tx/events?tx_id=${txData.results[0].tx_id}&limit=1`,
            hiroHeaders()
          );
          checks["hiro-events"] = "ok";
        } else {
          checks["hiro-events"] = "skip: no txs to test";
        }
      } catch (e) {
        checks["hiro-events"] = `fail: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Bitflow quotes API
      try {
        await fetchJson<unknown>(`${BITFLOW_QUOTES_API}/pools`);
        checks["bitflow-quotes"] = "ok";
      } catch (e) {
        checks["bitflow-quotes"] = `fail: ${e instanceof Error ? e.message : String(e)}`;
      }

      // Bitflow app API
      try {
        await fetchJson<unknown>(`${BITFLOW_APP_API}/pools/dlmm_3`);
        checks["bitflow-app"] = "ok";
      } catch (e) {
        checks["bitflow-app"] = `fail: ${e instanceof Error ? e.message : String(e)}`;
      }

      const allOk = Object.values(checks).every((v) => v === "ok");
      printJson({
        status: allOk ? "success" : "degraded",
        result: allOk ? "All APIs reachable" : "Some APIs unreachable",
        checks,
        pools: Object.keys(POOL_CONTRACTS).length,
        note: "Flow analysis requires Hiro transactions + events APIs. Free tier supports ~100 swaps per run. Use --hiro-api-key for higher throughput.",
      });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("flow")
  .description("Analyze swap flow for a HODLMM pool")
  .option("--pool-id <id>", "Pool ID (e.g. dlmm_3)")
  .option("--window <duration>", "Time window (e.g. 24h, 7d)")
  .option("--swaps <count>", "Number of swaps to analyze", String(DEFAULT_SWAP_COUNT))
  .option("--all", "Analyze all primary pools")
  .option("--hiro-api-key <key>", "Hiro API key for elevated rate limits")
  .option("--no-cache", "Bypass cache and force fresh analysis")
  .action(async (opts) => {
    try {
      if (opts.hiroApiKey) hiroApiKey = opts.hiroApiKey;
      const skipCache = opts.cache === false;

      const swapCount = parseInt(opts.swaps, 10) || DEFAULT_SWAP_COUNT;
      const windowSeconds = opts.window ? parseDuration(opts.window) : undefined;

      if (opts.all) {
        // Analyze all primary pools
        const results: FlowAnalysis[] = [];
        const errors: Array<{ poolId: string; error: string }> = [];

        for (const poolId of PRIMARY_POOLS) {
          try {
            const analysis = await analyzePool(poolId, swapCount, windowSeconds, skipCache);
            results.push(analysis);
          } catch (e) {
            errors.push({
              poolId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        // Summary
        const avgScore = results.length > 0
          ? Math.round(results.reduce((s, r) => s + r.verdict.score, 0) / results.length)
          : 0;

        printJson({
          status: "success",
          network: "mainnet",
          timestamp: new Date().toISOString(),
          mode: "protocol-wide",
          poolsAnalyzed: results.length,
          poolsFailed: errors.length,
          protocolSafetyScore: avgScore,
          pools: results.map((r) => ({
            poolId: r.poolId,
            pair: r.pair,
            swapsAnalyzed: r.swapsAnalyzed,
            timeSpanHours: r.timeSpanHours,
            safetyScore: r.verdict.score,
            lpSafety: r.verdict.lpSafety,
            directionBias: r.metrics.directionBias,
            flowToxicity: r.metrics.flowToxicity,
            binVelocity: r.metrics.binVelocity,
            topActor: r.topActors[0]
              ? `${r.topActors[0].address.slice(0, 8)}... (${r.topActors[0].label}, ${r.topActors[0].volumeShare}%)`
              : "none",
          })),
          errors: errors.length > 0 ? errors : undefined,
        });
      } else {
        // Single pool
        const poolId = opts.poolId;
        if (!poolId) {
          printJson({ error: "Specify --pool-id <id> or use --all. Valid pools: " + Object.keys(POOL_CONTRACTS).join(", ") });
          process.exit(1);
        }

        const analysis = await analyzePool(poolId, swapCount, windowSeconds, skipCache);
        printJson(analysis);
      }
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("install-packs")
  .description("No-op: registry compatibility. This skill has no additional packs to install.")
  .action(() => {
    printJson({
      status: "success",
      result: "No packs to install — hodlmm-flow has no external dependencies beyond bun + node_modules.",
      packs: [],
    });
  });

program.parse();
