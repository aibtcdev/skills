#!/usr/bin/env bun
/**
 * execution-guard — Multi-Layer Decision Engine for Stacks Agent Operations
 *
 * 4-layer quorum system that evaluates whether an agent should RUN, CAUTION,
 * SOFT_PAUSE, or HARD_STOP. Anti-replay protection prevents duplicate execution.
 *
 * Usage: bun run execution-guard/execution-guard.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getApiBaseUrl } from "../src/lib/config/networks.js";
import { getSponsorRelayUrl } from "../src/lib/config/sponsor.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ============ CONFIG ============

const HIRO_BASE = getApiBaseUrl(NETWORK);
const MEMPOOL_BASE = "https://mempool.space/api";
const X402_RELAY = getSponsorRelayUrl(NETWORK);
const SPONSOR_ADDRESS = "SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7";

interface LayerResult {
  name: string;
  status: string;
  score: number;
  signals: Record<string, unknown>;
}

interface Verdict {
  verdict: "RUN" | "CAUTION" | "SOFT_PAUSE" | "HARD_STOP";
  reason: string;
  quorum: string;
  avgScore: number;
  action: string;
  degradedLayers?: string[];
}

// Anti-replay store
const executedJobs = new Map<string, { timestamp: number; jobId: string }>();
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_MAX_SIZE = 1000;

// ============ UTILITY ============

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============ LAYER 1: CHAIN LIVENESS ============

async function evaluateChainLiveness(): Promise<LayerResult> {
  const layer: LayerResult = { name: "chain_liveness", status: "unknown", score: 0, signals: {} };

  try {
    const resp = await fetchWithTimeout(`${MEMPOOL_BASE}/blocks/tip/height`, 5000);
    if (resp.ok) {
      layer.signals.btcHeight = parseInt(await resp.text(), 10);
      layer.signals.btcReachable = true;
    } else {
      layer.signals.btcReachable = false;
    }
  } catch {
    layer.signals.btcReachable = false;
  }

  try {
    const resp = await fetchWithTimeout(`${HIRO_BASE}/v2/info`, 5000);
    if (resp.ok) {
      const info = await resp.json();
      layer.signals.stxHeight = info.stacks_tip_height;
      layer.signals.stxBurnHeight = info.burn_block_height;
      layer.signals.stxReachable = true;

      if (layer.signals.btcReachable && typeof layer.signals.btcHeight === "number") {
        const drift = layer.signals.btcHeight - info.burn_block_height;
        layer.signals.stxBtcDrift = drift;
        layer.signals.stxSynced = drift < 5;
      }
    } else {
      layer.signals.stxReachable = false;
    }
  } catch {
    layer.signals.stxReachable = false;
  }

  if (layer.signals.btcReachable && layer.signals.stxReachable) {
    layer.score = layer.signals.stxSynced !== false ? 100 : 60;
    layer.status = layer.score === 100 ? "healthy" : "degraded";
  } else if (layer.signals.btcReachable || layer.signals.stxReachable) {
    layer.score = 30;
    layer.status = "degraded";
  } else {
    layer.score = 0;
    layer.status = "dead";
  }

  return layer;
}

// ============ LAYER 2: PAYMENT HEALTH ============

async function evaluatePaymentHealth(): Promise<LayerResult> {
  const layer: LayerResult = { name: "payment_health", status: "unknown", score: 0, signals: {} };

  // x402 relay basic health
  try {
    const resp = await fetchWithTimeout(`${X402_RELAY}/health`, 8000);
    if (resp.ok) {
      const health = await resp.json();
      layer.signals.relayUp = true;
      layer.signals.relayVersion = health.version ?? "unknown";
    } else {
      layer.signals.relayUp = false;
      layer.signals.relayStatus = resp.status;
    }
  } catch {
    layer.signals.relayUp = false;
  }

  // Sponsor nonce state — query blockchain directly for ground truth
  try {
    const resp = await fetchWithTimeout(
      `${HIRO_BASE}/extended/v1/address/${SPONSOR_ADDRESS}/nonces`, 5000
    );
    if (resp.ok) {
      const nonces = await resp.json();
      const missing: number[] = nonces.detected_missing_nonces ?? [];
      const lastExec: number = nonces.last_executed_tx_nonce ?? 0;
      const lastMem: number = nonces.last_mempool_tx_nonce ?? 0;
      const desync = lastMem - lastExec;

      layer.signals.sponsorNonce = {
        lastExecuted: lastExec,
        lastMempool: lastMem,
        possibleNext: nonces.possible_next_nonce,
        detectedMissing: missing,
      };
      layer.signals.nonceGap = missing.length;
      layer.signals.mempoolDesync = desync > 10;
      layer.signals.desyncGap = desync;
    }
  } catch {
    // nonce check is supplementary
  }

  // Stacks mempool accessibility
  try {
    const resp = await fetchWithTimeout(`${HIRO_BASE}/extended/v1/tx/mempool?limit=1`, 5000);
    if (resp.ok) {
      const data = await resp.json();
      layer.signals.mempoolAccessible = true;
      layer.signals.mempoolTotal = data.total ?? 0;
    } else {
      layer.signals.mempoolAccessible = false;
    }
  } catch {
    layer.signals.mempoolAccessible = false;
  }

  // Score
  if (layer.signals.relayUp && !layer.signals.mempoolDesync) {
    const gap = (layer.signals.nonceGap as number) ?? 0;
    if (gap <= 2) { layer.score = 100; layer.status = "healthy"; }
    else if (gap <= 5) { layer.score = 60; layer.status = "degraded"; }
    else { layer.score = 25; layer.status = "unhealthy"; }
  } else if (layer.signals.relayUp) {
    layer.score = 40;
    layer.status = "degraded";
  } else {
    layer.score = layer.signals.mempoolAccessible ? 15 : 0;
    layer.status = layer.signals.mempoolAccessible ? "degraded" : "dead";
  }

  return layer;
}

// ============ LAYER 3: APP SIGNAL ============

async function evaluateAppSignal(address?: string): Promise<LayerResult> {
  const layer: LayerResult = { name: "app_signal", status: "unknown", score: 0, signals: {} };
  layer.signals.note = "Supplementary layer — does not drive decisions alone";

  if (address) {
    try {
      const resp = await fetchWithTimeout(
        `${HIRO_BASE}/extended/v1/address/${address}/transactions?limit=5`, 5000
      );
      if (resp.ok) {
        const data = await resp.json();
        layer.signals.apiReachable = true;
        layer.signals.recentTxCount = data.total ?? 0;

        if (data.results?.length > 0) {
          const lastTx = data.results[0];
          const lastTxTime = new Date(
            lastTx.burn_block_time_iso ?? lastTx.receipt_time_iso
          ).getTime();
          const age = Date.now() - lastTxTime;
          layer.signals.lastTxAgeMs = age;
          layer.signals.lastTxAgeHuman =
            age < 3600000
              ? `${Math.round(age / 60000)}m ago`
              : `${Math.round(age / 3600000)}h ago`;
          layer.signals.stale = age > 15 * 60 * 1000;
        }
      } else {
        layer.signals.apiReachable = false;
      }
    } catch {
      layer.signals.apiReachable = false;
    }
  } else {
    layer.signals.configured = false;
  }

  if (!address) {
    layer.score = 50;
    layer.status = "neutral";
  } else if (layer.signals.apiReachable && !layer.signals.stale) {
    layer.score = 100;
    layer.status = "healthy";
  } else if (layer.signals.apiReachable) {
    layer.score = 50;
    layer.status = "stale";
  } else {
    layer.score = 0;
    layer.status = "unreachable";
  }

  return layer;
}

// ============ LAYER 4: INTERNAL SANITY ============

async function evaluateInternalSanity(): Promise<LayerResult> {
  const layer: LayerResult = { name: "internal_sanity", status: "unknown", score: 0, signals: {} };

  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(`${HIRO_BASE}/v2/info`, 5000);
    const latencyMs = Date.now() - start;
    layer.signals.hiroLatencyMs = latencyMs;
    layer.signals.hiroResponsive = resp.ok;
    layer.signals.highLatency = latencyMs > 3000;
  } catch {
    layer.signals.hiroResponsive = false;
    layer.signals.hiroLatencyMs = Date.now() - start;
  }

  layer.signals.replayStoreSize = executedJobs.size;
  layer.signals.replayStoreHealthy = executedJobs.size < REPLAY_MAX_SIZE;

  if (typeof process !== "undefined" && process.memoryUsage) {
    const mem = process.memoryUsage();
    layer.signals.heapUsedMB = Math.round(mem.heapUsed / 1048576);
    layer.signals.heapTotalMB = Math.round(mem.heapTotal / 1048576);
    layer.signals.memoryPressure = mem.heapUsed / mem.heapTotal > 0.9;
  }

  let score = 100;
  if (!layer.signals.hiroResponsive) score -= 40;
  if (layer.signals.highLatency) score -= 20;
  if (!layer.signals.replayStoreHealthy) score -= 15;
  if (layer.signals.memoryPressure) score -= 25;

  layer.score = Math.max(0, score);
  layer.status =
    score >= 80 ? "healthy" : score >= 50 ? "degraded" : score >= 20 ? "unhealthy" : "critical";

  return layer;
}

// ============ QUORUM ENGINE ============

function computeVerdict(layers: LayerResult[]): Verdict {
  const okLayers = layers.filter((l) => l.score >= 60);
  const okCount = okLayers.length;
  const totalScore = layers.reduce((sum, l) => sum + l.score, 0);
  const avgScore = Math.round(totalScore / layers.length);

  const chainLayer = layers.find((l) => l.name === "chain_liveness");
  if (chainLayer && chainLayer.score === 0) {
    return {
      verdict: "HARD_STOP",
      reason: "Chain liveness dead — Bitcoin and Stacks unreachable",
      quorum: `${okCount}/4`,
      avgScore,
      action: "Freeze all operations. Do not execute transactions.",
      degradedLayers: layers.filter((l) => l.score < 60).map((l) => l.name),
    };
  }

  if (okCount >= 3) {
    return {
      verdict: "RUN",
      reason: `${okCount}/4 layers healthy`,
      quorum: `${okCount}/4`,
      avgScore,
      action: "Operate normally.",
    };
  }

  if (okCount === 2) {
    return {
      verdict: "CAUTION",
      reason: `Only ${okCount}/4 layers healthy — reduced confidence`,
      quorum: `${okCount}/4`,
      avgScore,
      degradedLayers: layers.filter((l) => l.score < 60).map((l) => l.name),
      action: "Proceed with reduced exposure. Avoid new large positions.",
    };
  }

  if (okCount === 1) {
    return {
      verdict: "SOFT_PAUSE",
      reason: `Only ${okCount}/4 layers healthy — most systems degraded`,
      quorum: `${okCount}/4`,
      avgScore,
      degradedLayers: layers.filter((l) => l.score < 60).map((l) => l.name),
      action: "Halt execution but preserve queue. Do not clear pending operations.",
    };
  }

  return {
    verdict: "HARD_STOP",
    reason: "0/4 layers healthy — full system failure",
    quorum: "0/4",
    avgScore,
    degradedLayers: layers.map((l) => l.name),
    action: "Freeze everything. Preserve queue. Wait for recovery.",
  };
}

// ============ FULL EVALUATION ============

async function evaluate(address?: string) {
  const startTime = Date.now();

  const [chainLayer, paymentLayer, appLayer] = await Promise.all([
    evaluateChainLiveness(),
    evaluatePaymentHealth(),
    evaluateAppSignal(address),
  ]);
  const internalLayer = await evaluateInternalSanity();

  const layers = [chainLayer, paymentLayer, appLayer, internalLayer];
  const verdict = computeVerdict(layers);

  return {
    verdict: verdict.verdict,
    reason: verdict.reason,
    quorum: verdict.quorum,
    avgScore: verdict.avgScore,
    action: verdict.action,
    degradedLayers: verdict.degradedLayers ?? [],
    layers,
    evaluationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    antiReplay: { tracked: executedJobs.size, windowMs: REPLAY_WINDOW_MS },
  };
}

// ============ ANTI-REPLAY ============

function hashJob(jobId: string, nonce: number, timestamp: number): string {
  const raw = `${jobId}:${nonce}:${timestamp}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return `job_${Math.abs(hash).toString(36)}`;
}

function checkAndRecordJob(jobId: string, nonce: number, timestamp: number) {
  const hash = hashJob(jobId, nonce, timestamp);
  const now = Date.now();

  for (const [key, entry] of executedJobs.entries()) {
    if (now - entry.timestamp > REPLAY_WINDOW_MS) executedJobs.delete(key);
  }

  if (executedJobs.has(hash)) {
    return {
      allowed: false,
      reason: "duplicate",
      hash,
      originalExecution: new Date(executedJobs.get(hash)!.timestamp).toISOString(),
    };
  }

  executedJobs.set(hash, { timestamp: now, jobId });
  return { allowed: true, hash, recorded: true };
}

// ============ DOCTOR ============

async function doctor() {
  const checks: Record<string, Record<string, unknown>> = {};

  try {
    const start = Date.now();
    const resp = await fetchWithTimeout(`${MEMPOOL_BASE}/blocks/tip/height`, 5000);
    checks.bitcoin = {
      status: resp.ok ? "ok" : "error",
      latencyMs: Date.now() - start,
      height: resp.ok ? parseInt(await resp.text(), 10) : null,
    };
  } catch (e: unknown) {
    checks.bitcoin = { status: "down", error: (e as Error).message };
  }

  try {
    const start = Date.now();
    const resp = await fetchWithTimeout(`${HIRO_BASE}/v2/info`, 5000);
    checks.stacks = { status: resp.ok ? "ok" : "error", latencyMs: Date.now() - start };
    if (resp.ok) {
      const info = await resp.json();
      checks.stacks.height = info.stacks_tip_height;
      checks.stacks.burnHeight = info.burn_block_height;
    }
  } catch (e: unknown) {
    checks.stacks = { status: "down", error: (e as Error).message };
  }

  try {
    const start = Date.now();
    const resp = await fetchWithTimeout(`${X402_RELAY}/health`, 8000);
    checks.x402Relay = { status: resp.ok ? "ok" : "error", latencyMs: Date.now() - start };
    if (resp.ok) {
      const health = await resp.json();
      checks.x402Relay.version = health.version;
    }
  } catch (e: unknown) {
    checks.x402Relay = { status: "down", error: (e as Error).message };
  }

  // Sponsor nonce health
  try {
    const resp = await fetchWithTimeout(
      `${HIRO_BASE}/extended/v1/address/${SPONSOR_ADDRESS}/nonces`, 5000
    );
    if (resp.ok) {
      const nonces = await resp.json();
      const missing: number[] = nonces.detected_missing_nonces ?? [];
      checks.sponsorNonce = {
        status: missing.length === 0 ? "ok" : "degraded",
        lastExecuted: nonces.last_executed_tx_nonce,
        lastMempool: nonces.last_mempool_tx_nonce,
        missingNonces: missing.length,
        desyncGap: (nonces.last_mempool_tx_nonce ?? 0) - (nonces.last_executed_tx_nonce ?? 0),
      };
    }
  } catch {
    checks.sponsorNonce = { status: "unavailable" };
  }

  const statuses = Object.values(checks).map((c) => c.status);
  const allOk = statuses.every((s) => s === "ok");
  const someOk = statuses.some((s) => s === "ok");

  return {
    overall: allOk ? "ok" : someOk ? "degraded" : "down",
    network: NETWORK,
    endpoints: checks,
  };
}

// ============ CLI ============

const program = new Command();
program
  .name("execution-guard")
  .description("Multi-Layer Decision Engine for Stacks Agent Operations")
  .version("1.0.0");

program
  .command("evaluate")
  .description("Run full 4-layer evaluation and return verdict")
  .option("--address <stx-address>", "Stacks address for app signal layer")
  .action(async (opts) => {
    try {
      const result = await evaluate(opts.address);
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("check-job")
  .description("Anti-replay check for a job hash")
  .requiredOption("--job-id <id>", "Job identifier")
  .requiredOption("--nonce <n>", "Job nonce", parseInt)
  .requiredOption("--timestamp <ts>", "Job timestamp (epoch ms)", parseInt)
  .action((opts) => {
    try {
      const result = checkAndRecordJob(opts.jobId, opts.nonce, opts.timestamp);
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("doctor")
  .description("Health check across all upstream dependencies")
  .action(async () => {
    try {
      const result = await doctor();
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

program.parse(process.argv);
