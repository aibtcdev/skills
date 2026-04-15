#!/usr/bin/env bun
/**
 * hodlmm-arb-executor — Detects sBTC/STX spread between Bitflow XYK and HODLMM (DLMM),
 * executes LP-based arb via MCP command objects. Entry: swap STX→sBTC on XYK + add liquidity
 * to DLMM. Exit: withdraw from DLMM + swap sBTC→STX. Requires --confirm for live execution.
 *
 * Pipeline: doctor → scan → spread check → cap check → cooldown check → confirm gate → emit MCP commands → write state
 * Exit trigger: spread reversal OR 2-hour max hold.
 *
 * Usage: bun run skills/hodlmm-arb-executor/hodlmm-arb-executor.ts <command> [options]
 */

import { Command } from "commander";
import { deserializeCV, cvToJSON } from "@stacks/transactions";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTH_HERMES = "https://hermes.pyth.network";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_API_KEY = process.env.BITFLOW_API_KEY ?? "";
const FETCH_TIMEOUT_MS = 15_000;
const NETWORK = "mainnet";

// Pyth price feed IDs (mainnet)
const PYTH_BTC_USD = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const PYTH_STX_USD = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

// Bitflow XYK pool contract (sBTC/STX)
const XYK_POOL_ADDR = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR";
const XYK_POOL_NAME = "xyk-pool-sbtc-stx-v-1-1";

// HODLMM pool ID for sBTC/STX (SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15)
const DLMM_POOL_ID = "dlmm_6";

// Token IDs (Bitflow SDK identifiers)
const TOKEN_STX = "token-stx";
const TOKEN_SBTC = "token-sbtc";

// Fee estimates (bps)
const FEE_BPS = {
  xyk: 30,  // 0.30% Bitflow XYK fee
  dlmm: 25, // 0.25% HODLMM fee (variable, typical)
};

// Safety limits — HARD CAPS enforced in code, not just documentation
const MAX_AUTONOMOUS_SATS = 100_000; // 0.001 BTC (~$85 at $85k BTC) — absolute ceiling
const DEFAULT_MAX_SATS = 100_000;
const COOLDOWN_MS = 10 * 60 * 1000;   // 10 minutes between execute runs
const MAX_HOLD_MS = 2 * 60 * 60 * 1000; // 2-hour max LP position hold
const MIN_SPREAD_PCT = 0.55;           // Entry threshold: must exceed XYK (0.30%) + DLMM (0.25%) fees

// State file
const STATE_FILE = join(homedir(), ".hodlmm-arb-executor-state.json");
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PythParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface OraclePrices {
  btcUsd: number;
  stxUsd: number;
  stxPerBtc: number;
  confidence: { btc: number; stx: number };
  publishTime: number;
}

interface XykReserves {
  xBalanceSats: number;
  yBalanceMicro: number;
  stxPerBtc: number;
  liquidityUsd: number;
}

interface DlmmData {
  stxPerBtc: number;
  activeBinId: number;
  totalBins: number;
  source: "bitflow-api" | "unavailable";
}

interface McpCommand {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  postConditions: string[];
}

interface LpPosition {
  entryTimestamp: string;
  entrySpreadPct: number;
  entryBinId: number;
  satsSent: number;
  estimatedEntryUsd: number;
}

interface ExecutionRecord {
  timestamp: string;
  action: "entry" | "exit" | "exit-timeout" | "skipped";
  reason: string;
  spreadPct: number;
  satsSent?: number;
  commands: McpCommand[];
}

interface ExecutorState {
  version: 1;
  lastExecutionAt: string | null;  // Only stamped when cmds.length > 0
  lastRunAt: string;
  openPosition: LpPosition | null;
  history: ExecutionRecord[];
  cumulativeEstPnlUsd: number;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function loadState(): ExecutorState {
  if (!existsSync(STATE_FILE)) {
    return {
      version: 1,
      lastExecutionAt: null,
      lastRunAt: new Date().toISOString(),
      openPosition: null,
      history: [],
      cumulativeEstPnlUsd: 0,
    };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ExecutorState;
  } catch {
    return {
      version: 1,
      lastExecutionAt: null,
      lastRunAt: new Date().toISOString(),
      openPosition: null,
      history: [],
      cumulativeEstPnlUsd: 0,
    };
  }
}

function saveState(state: ExecutorState): void {
  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status} at ${url}`);
  return res.json() as Promise<T>;
}

function round(n: number, decimals: number = 4): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Data source 1: Pyth Hermes — BTC/USD + STX/USD oracle prices
// ---------------------------------------------------------------------------

async function fetchOraclePrices(): Promise<OraclePrices> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD}&ids[]=${PYTH_STX_USD}`;
  const data = await fetchJson<{ parsed: PythParsedPrice[] }>(url);

  if (!data.parsed || data.parsed.length < 2) {
    throw new Error("Pyth returned fewer than 2 price feeds");
  }

  const btcFeed = data.parsed.find((p) => p.id === PYTH_BTC_USD);
  const stxFeed = data.parsed.find((p) => p.id === PYTH_STX_USD);
  if (!btcFeed || !stxFeed) throw new Error("Missing BTC or STX price feed from Pyth");

  const btcUsd = Number(btcFeed.price.price) * Math.pow(10, btcFeed.price.expo);
  const stxUsd = Number(stxFeed.price.price) * Math.pow(10, stxFeed.price.expo);
  const btcConf = Number(btcFeed.price.conf) * Math.pow(10, btcFeed.price.expo);
  const stxConf = Number(stxFeed.price.conf) * Math.pow(10, stxFeed.price.expo);

  return {
    btcUsd: round(btcUsd, 2),
    stxUsd: round(stxUsd, 6),
    stxPerBtc: round(btcUsd / stxUsd, 2),
    confidence: { btc: round(btcConf, 2), stx: round(stxConf, 6) },
    publishTime: btcFeed.price.publish_time,
  };
}

// ---------------------------------------------------------------------------
// Data source 2: Hiro Stacks API — on-chain XYK pool reserves
// ---------------------------------------------------------------------------

function decodeClarityPool(hex: string): { xBalance: bigint; yBalance: bigint } {
  // Use @stacks/transactions deserializer — safe against field reordering.
  // get-pool returns (ok (tuple ...)) — ResponseOK wraps the tuple, so fields are at json.value.value.
  const cv = deserializeCV(Buffer.from(hex, "hex"));
  const json = cvToJSON(cv) as { success: boolean; value: { value: Record<string, { value: string }> } };
  const fields = json.value.value;
  const xBalance = BigInt(fields["x-balance"].value);
  const yBalance = BigInt(fields["y-balance"].value);
  return { xBalance, yBalance };
}

async function fetchXykReserves(oracle: OraclePrices): Promise<XykReserves> {
  const url = `${HIRO_API}/v2/contracts/call-read/${XYK_POOL_ADDR}/${XYK_POOL_NAME}/get-pool`;
  const data = await fetchJson<{ okay: boolean; result: string }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: XYK_POOL_ADDR, arguments: [] }),
  });

  if (!data.okay) throw new Error(`Contract call failed: ${JSON.stringify(data)}`);

  const hex = data.result.startsWith("0x") ? data.result.substring(2) : data.result;
  const { xBalance, yBalance } = decodeClarityPool(hex);

  const xBalanceSats = Number(xBalance);
  const yBalanceMicro = Number(yBalance);
  const xBtc = xBalanceSats / 1e8;
  const yStx = yBalanceMicro / 1e6;
  if (xBtc === 0) throw new Error("XYK pool is empty (xBalance = 0)");

  return {
    xBalanceSats,
    yBalanceMicro,
    stxPerBtc: round(yStx / xBtc, 2),
    liquidityUsd: round(xBtc * oracle.btcUsd + yStx * oracle.stxUsd, 2),
  };
}

// ---------------------------------------------------------------------------
// Data source 3: Bitflow API — HODLMM pool bins
// ---------------------------------------------------------------------------

interface HodlmmBin {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price?: string;
}

interface HodlmmBinsResponse {
  active_bin_id?: number;
  bins: HodlmmBin[];
}

async function fetchDlmmBins(): Promise<DlmmData> {
  try {
    const bins = await fetchJson<HodlmmBinsResponse>(
      `${BITFLOW_QUOTES_API}/bins/${DLMM_POOL_ID}`,
      BITFLOW_API_KEY ? { headers: { "x-api-key": BITFLOW_API_KEY } } : undefined
    );

    const activeBinId = bins.active_bin_id ?? 0;
    const activeBin = bins.bins?.find((b) => b.bin_id === activeBinId);

    // price field unit verified empirically against Pyth oracle (2026-04-07):
    //   dlmm_6 active bin 301, price = "30785" → 30785 × 10 = 307,850 STX/BTC
    //   Pyth oracle implied: $68,892 / $0.2178 = 316,309 STX/BTC (~2.7% spread)
    // Multiplier is 10. Arc0btc note: nano-STX/sat algebra gives ×0.1 (=3,078),
    // which does not match — the field is in a Bitflow-internal unit, not nano-STX/sat.
    const rawPrice = activeBin?.price ? Number(activeBin.price) : 0;
    const stxPerBtc = rawPrice * 10;

    return {
      stxPerBtc: round(stxPerBtc, 2),
      activeBinId,
      totalBins: bins.bins?.length ?? 0,
      source: stxPerBtc > 0 ? "bitflow-api" : "unavailable",
    };
  } catch {
    return { stxPerBtc: 0, activeBinId: 0, totalBins: 0, source: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// Spread analysis
// ---------------------------------------------------------------------------

interface SpreadSignal {
  grossSpreadPct: number;
  estFeePct: number;
  netSpreadPct: number;
  confidenceBuffer: number;
  profitable: boolean;
  xykStxPerBtc: number;
  dlmmStxPerBtc: number;
}

function analyzeSpread(oracle: OraclePrices, xyk: XykReserves, dlmm: DlmmData): SpreadSignal | null {
  if (dlmm.source === "unavailable" || dlmm.stxPerBtc === 0) return null;

  const grossSpread = Math.abs(((xyk.stxPerBtc - dlmm.stxPerBtc) / dlmm.stxPerBtc) * 100);
  const estFee = (FEE_BPS.xyk + FEE_BPS.dlmm) / 100;
  const netSpread = grossSpread - estFee;
  // Confidence buffer: STX feed uncertainty as % of price.
  // stxPerBtc = btcUsd / stxUsd — latency between publishes creates noise.
  const confidenceBuffer = (oracle.confidence.stx / oracle.stxUsd) * 100;

  return {
    grossSpreadPct: round(grossSpread, 4),
    estFeePct: round(estFee, 4),
    netSpreadPct: round(netSpread, 4),
    confidenceBuffer: round(confidenceBuffer, 4),
    profitable: netSpread > confidenceBuffer,
    xykStxPerBtc: xyk.stxPerBtc,
    dlmmStxPerBtc: dlmm.stxPerBtc,
  };
}

// ---------------------------------------------------------------------------
// MCP command generation — entry
// ---------------------------------------------------------------------------

function buildEntryCommands(oracle: OraclePrices, activeBinId: number, satsCapped: number): McpCommand[] {
  const sbtcAmount = satsCapped / 1e8;
  const stxForSwap = round(sbtcAmount * oracle.stxPerBtc * 1.015, 6);

  return [
    {
      tool: "bitflow_swap",
      args: {
        token_x: TOKEN_STX,
        token_y: TOKEN_SBTC,
        amount_in: String(stxForSwap),
        slippage_tolerance: "0.015",
      },
      description: `Swap ${stxForSwap} STX for ~${sbtcAmount} sBTC on Bitflow XYK (entry: buy cheap sBTC)`,
      postConditions: [
        `FT debit STX eq ${Math.round(stxForSwap * 1e6)} micro-STX`,
        `FT credit sBTC gte ${Math.round(satsCapped * 0.985)} sats (1.5% slippage)`,
      ],
    },
    {
      tool: "bitflow_hodlmm_add_liquidity",
      args: {
        pool_id: DLMM_POOL_ID,
        bins: JSON.stringify([
          {
            activeBinOffset: 1,   // one bin above active = pricing at premium
            xAmount: String(satsCapped),
            yAmount: "0",         // one-sided sBTC deposit above active bin
          },
        ]),
        active_bin_tolerance: JSON.stringify({ expectedBinId: activeBinId, maxDeviation: "2" }),
        slippage_tolerance: "1.5",
      },
      description: `Add ${sbtcAmount} sBTC to DLMM pool ${DLMM_POOL_ID} bin +1 (LP entry at premium)`,
      postConditions: [
        `FT debit sBTC eq ${satsCapped} sats`,
        `LP tokens credited for pool ${DLMM_POOL_ID}`,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// MCP command generation — exit
// ---------------------------------------------------------------------------

function buildExitCommands(position: LpPosition, currentActiveBinId: number, oracle: OraclePrices): McpCommand[] {
  // entryBinId stores the actual LP bin (activeBin + 1 at entry time).
  // currentOffset = LP bin relative to current active bin.
  const currentOffset = position.entryBinId - currentActiveBinId;
  const sbtcAmount = position.satsSent / 1e8;
  const minSatsOut = Math.round(position.satsSent * 0.98);
  const estStxOut = round(sbtcAmount * oracle.stxPerBtc * 0.985, 6);

  return [
    {
      tool: "bitflow_hodlmm_withdraw_liquidity",
      args: {
        pool_id: DLMM_POOL_ID,
        positions: JSON.stringify([
          {
            activeBinOffset: currentOffset,
            amount: "100%",
            minXAmount: String(minSatsOut),
            minYAmount: "0",
          },
        ]),
      },
      description: `Withdraw LP from DLMM pool ${DLMM_POOL_ID} at bin offset ${currentOffset}`,
      postConditions: [
        `FT credit sBTC gte ${minSatsOut} sats (2% slippage buffer)`,
        `LP tokens debited for pool ${DLMM_POOL_ID}`,
      ],
    },
    {
      tool: "bitflow_swap",
      args: {
        token_x: TOKEN_SBTC,
        token_y: TOKEN_STX,
        amount_in: String(sbtcAmount),
        slippage_tolerance: "0.015",
      },
      description: `Swap ~${sbtcAmount} sBTC → ~${estStxOut} STX on Bitflow XYK (exit: realise in STX)`,
      postConditions: [
        `FT debit sBTC eq ${position.satsSent} sats`,
        `FT credit STX gte ${Math.round(estStxOut * 1e6 * 0.985)} micro-STX`,
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("hodlmm-arb-executor")
  .description("Detects sBTC/STX spread and executes LP-based arb via MCP command objects");

// --- doctor ---
program
  .command("doctor")
  .description("Preflight: check all data sources + cooldown + open position")
  .action(async () => {
    try {
      const checks: Array<{ name: string; status: "ok" | "warn" | "error"; detail: string }> = [];
      let oracleResult: OraclePrices | null = null;

      // 1. Pyth Hermes
      try {
        oracleResult = await fetchOraclePrices();
        const age = Math.round(Date.now() / 1000 - oracleResult.publishTime);
        checks.push({
          name: "pyth_hermes",
          status: "ok",
          detail: `BTC=$${oracleResult.btcUsd} STX=$${oracleResult.stxUsd} | age ${age}s | conf STX=$${oracleResult.confidence.stx}`,
        });
      } catch (e) {
        checks.push({ name: "pyth_hermes", status: "error", detail: e instanceof Error ? e.message : String(e) });
      }

      // 2. Hiro XYK (on-chain)
      try {
        if (!oracleResult) throw new Error("Oracle unavailable — skipping XYK check");
        const xyk = await fetchXykReserves(oracleResult);
        checks.push({
          name: "hiro_xyk_pool",
          status: "ok",
          detail: `${round(xyk.stxPerBtc, 2)} STX/BTC | $${round(xyk.liquidityUsd / 1000, 1)}k TVL`,
        });
      } catch (e) {
        checks.push({ name: "hiro_xyk_pool", status: "error", detail: e instanceof Error ? e.message : String(e) });
      }

      // 3. Bitflow HODLMM
      try {
        const dlmm = await fetchDlmmBins();
        // Calibration: log rawPrice alongside computed stxPerBtc so unit can be
        // verified against oracle. Raw bin price × 10 = stxPerBtc (empirically verified
        // 2026-04-07: bin 301 price "30785" → 307,850 STX/BTC vs oracle 316,309, ~2.7% spread).
        const oracleImplied = oracleResult ? round(oracleResult.btcUsd / oracleResult.stxUsd, 2) : 0;
        checks.push({
          name: "bitflow_hodlmm",
          status: dlmm.source === "unavailable" ? (!BITFLOW_API_KEY ? "warn" : "error") : "ok",
          detail: dlmm.source === "unavailable"
            ? (!BITFLOW_API_KEY
                ? "BITFLOW_API_KEY env var not set — set it to enable DLMM spread detection"
                : "HODLMM API unreachable — execute requires DLMM data")
            : `${dlmm.stxPerBtc} STX/BTC | active bin ${dlmm.activeBinId} | ${dlmm.totalBins} bins | oracle implied ${oracleImplied} STX/BTC`,
        });
      } catch (e) {
        checks.push({ name: "bitflow_hodlmm", status: "error", detail: e instanceof Error ? e.message : String(e) });
      }

      // 4. Cooldown
      const state = loadState();
      const now = Date.now();
      const lastExec = state.lastExecutionAt ? new Date(state.lastExecutionAt).getTime() : 0;
      const cooldownRemaining = Math.max(0, COOLDOWN_MS - (now - lastExec));
      checks.push({
        name: "cooldown",
        status: cooldownRemaining > 0 ? "warn" : "ok",
        detail: cooldownRemaining > 0 ? `COOLING DOWN — ${Math.ceil(cooldownRemaining / 60000)}m remaining` : "ready",
      });

      // 5. Open position
      if (state.openPosition) {
        const heldMs = now - new Date(state.openPosition.entryTimestamp).getTime();
        checks.push({
          name: "open_position",
          status: "warn",
          detail: `Open LP: ${state.openPosition.satsSent} sats | held ${Math.round(heldMs / 60000)}m | timeout in ${Math.ceil((MAX_HOLD_MS - heldMs) / 60000)}m`,
        });
      } else {
        checks.push({ name: "open_position", status: "ok", detail: "No open LP position" });
      }

      const hasError = checks.some((c) => c.status === "error");
      printJson({
        network: NETWORK,
        status: hasError ? "error" : "ok",
        checks,
        note: hasError ? "PREFLIGHT_FAILED — fix errors before running execute." : "All systems go.",
        maxAutonomousSats: MAX_AUTONOMOUS_SATS,
        timestamp: new Date().toISOString(),
      });

      if (hasError) process.exit(1);
    } catch (e) {
      handleError(e);
    }
  });

// --- simulate ---
program
  .command("simulate")
  .description("Dry-run: show what execute would do — commands, amounts, fees — no state changes")
  .option("--max-sats <n>", "Max sBTC sats to deploy", String(DEFAULT_MAX_SATS))
  .action(async (opts) => {
    try {
      const maxSats = Math.min(parseInt(opts.maxSats) || DEFAULT_MAX_SATS, MAX_AUTONOMOUS_SATS);

      let oracle: OraclePrices;
      let dlmm: DlmmData;
      let xyk: XykReserves;

      try {
        [oracle, dlmm] = await Promise.all([fetchOraclePrices(), fetchDlmmBins()]);
        xyk = await fetchXykReserves(oracle);
      } catch (e) {
        printJson({ status: "PREFLIGHT_FAILED", error: e instanceof Error ? e.message : String(e) });
        return;
      }

      const signal = analyzeSpread(oracle, xyk, dlmm);
      const state = loadState();
      const now = Date.now();
      const lastExec = state.lastExecutionAt ? new Date(state.lastExecutionAt).getTime() : 0;
      const cooldownRemaining = Math.max(0, COOLDOWN_MS - (now - lastExec));

      let entryCommands: McpCommand[] = [];
      let exitCommands: McpCommand[] = [];
      let wouldExecute = false;
      let skipReason = "";

      if (state.openPosition) {
        const heldMs = now - new Date(state.openPosition.entryTimestamp).getTime();
        const isTimeout = heldMs >= MAX_HOLD_MS;
        const spreadReversed = !signal || !signal.profitable;
        wouldExecute = isTimeout || spreadReversed;
        if (wouldExecute) {
          exitCommands = buildExitCommands(state.openPosition, dlmm.activeBinId, oracle);
        } else {
          skipReason = "Position open, spread still holding — no exit yet";
        }
      } else {
        if (!signal) {
          skipReason = "DLMM_UNAVAILABLE — cannot evaluate spread";
        } else if (!signal.profitable) {
          skipReason = `Net spread ${signal.netSpreadPct}% ≤ confidence buffer ${signal.confidenceBuffer}%`;
        } else if (signal.grossSpreadPct < MIN_SPREAD_PCT) {
          skipReason = `Gross spread ${signal.grossSpreadPct}% < ${MIN_SPREAD_PCT}% threshold`;
        } else if (cooldownRemaining > 0) {
          skipReason = `Cooling down — ${Math.ceil(cooldownRemaining / 60000)}m remaining`;
        } else {
          wouldExecute = true;
          entryCommands = buildEntryCommands(oracle, dlmm.activeBinId, maxSats);
        }
      }

      printJson({
        network: NETWORK,
        mode: "simulate",
        pair: "sBTC/STX",
        oracle: { btcUsd: oracle.btcUsd, stxUsd: oracle.stxUsd, stxPerBtc: oracle.stxPerBtc },
        xyk: { stxPerBtc: xyk.stxPerBtc },
        dlmm: { stxPerBtc: dlmm.stxPerBtc, activeBinId: dlmm.activeBinId, source: dlmm.source },
        spread: signal,
        openPosition: state.openPosition,
        wouldExecute,
        skipReason: skipReason || null,
        entryCommands: entryCommands.length > 0 ? entryCommands : undefined,
        exitCommands: exitCommands.length > 0 ? exitCommands : undefined,
        maxSats,
        cooldownRemainingMs: cooldownRemaining,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- execute ---
program
  .command("execute")
  .description("Full pipeline. Requires --confirm to emit live MCP commands.")
  .option("--confirm", "Authorize live MCP command emission (required)")
  .option("--max-sats <n>", "Max sBTC sats to deploy", String(DEFAULT_MAX_SATS))
  .action(async (opts) => {
    try {
      const confirmed = !!opts.confirm;
      const maxSats = Math.min(parseInt(opts.maxSats) || DEFAULT_MAX_SATS, MAX_AUTONOMOUS_SATS);

      // 1. CONFIRM GATE
      if (!confirmed) {
        printJson({
          status: "CONFIRM_REQUIRED",
          message: "Add --confirm to authorize MCP command emission.",
          network: NETWORK,
          note: `Max spend: ${maxSats} sats (hard cap: ${MAX_AUTONOMOUS_SATS} sats)`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 2. DOCTOR-FIRST PREFLIGHT
      let oracle: OraclePrices;
      let dlmm: DlmmData;
      let xyk: XykReserves;

      try {
        [oracle, dlmm] = await Promise.all([fetchOraclePrices(), fetchDlmmBins()]);
        xyk = await fetchXykReserves(oracle);
      } catch (e) {
        printJson({
          status: "PREFLIGHT_FAILED",
          error: e instanceof Error ? e.message : String(e),
          network: NETWORK,
          timestamp: new Date().toISOString(),
        });
        process.exit(1);
        return;
      }

      if (dlmm.source === "unavailable") {
        printJson({
          status: "PREFLIGHT_FAILED",
          reason: "DLMM_UNAVAILABLE",
          message: "HODLMM data required for execute. Run simulate or wait for Bitflow API.",
          network: NETWORK,
          timestamp: new Date().toISOString(),
        });
        process.exit(1);
        return;
      }

      const state = loadState();
      const now = Date.now();
      state.lastRunAt = new Date().toISOString();

      // 3. SPREAD ANALYSIS
      const signal = analyzeSpread(oracle, xyk, dlmm);

      // 4. OPEN POSITION — exit path takes priority
      if (state.openPosition) {
        const heldMs = now - new Date(state.openPosition.entryTimestamp).getTime();
        const isTimeout = heldMs >= MAX_HOLD_MS;
        const spreadReversed = !signal || !signal.profitable;

        if (isTimeout || spreadReversed) {
          const cmds = buildExitCommands(state.openPosition, dlmm.activeBinId, oracle);
          const exitReason = isTimeout ? "exit-timeout" : "exit";

          // Stamp lastExecutionAt ONLY because cmds.length > 0
          state.lastExecutionAt = new Date().toISOString();
          state.history.push({
            timestamp: state.lastExecutionAt,
            action: exitReason,
            reason: isTimeout ? "2-hour max hold reached" : "spread reversed or unprofitable",
            spreadPct: signal?.netSpreadPct ?? 0,
            satsSent: state.openPosition.satsSent,
            commands: cmds,
          });
          state.openPosition = null;
          saveState(state);

          printJson({
            status: "EXIT_COMMANDS_EMITTED",
            network: NETWORK,
            reason: exitReason,
            commandCount: cmds.length,
            commands: cmds,
            timestamp: state.lastExecutionAt,
          });
          return;
        }

        saveState(state);
        printJson({
          status: "HOLDING",
          message: "LP position open. Spread still holds. Waiting for reversal or timeout.",
          openPosition: state.openPosition,
          spread: signal,
          heldMinutes: Math.round(heldMs / 60000),
          timeoutInMinutes: Math.ceil((MAX_HOLD_MS - heldMs) / 60000),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 5. ENTRY: evaluate spread
      if (!signal || !signal.profitable) {
        saveState(state);
        printJson({
          status: "SKIPPED",
          reason: !signal ? "DLMM_UNAVAILABLE" : "SPREAD_NOT_PROFITABLE",
          spread: signal,
          message: !signal ? "No DLMM data." : `Net spread ${signal.netSpreadPct}% ≤ confidence buffer ${signal.confidenceBuffer}%`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (signal.grossSpreadPct < MIN_SPREAD_PCT) {
        saveState(state);
        printJson({
          status: "SKIPPED",
          reason: "SPREAD_TOO_SMALL",
          spread: signal,
          message: `Gross spread ${signal.grossSpreadPct}% < ${MIN_SPREAD_PCT}% threshold`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 6. COOLDOWN CHECK
      const lastExec = state.lastExecutionAt ? new Date(state.lastExecutionAt).getTime() : 0;
      const cooldownRemaining = Math.max(0, COOLDOWN_MS - (now - lastExec));
      if (cooldownRemaining > 0) {
        saveState(state);
        printJson({
          status: "SKIPPED",
          reason: "COOLDOWN_ACTIVE",
          cooldownRemainingMinutes: Math.ceil(cooldownRemaining / 60000),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 7. EMIT ENTRY COMMANDS
      const satsCapped = Math.min(maxSats, MAX_AUTONOMOUS_SATS);
      const cmds = buildEntryCommands(oracle, dlmm.activeBinId, satsCapped);

      // Stamp lastExecutionAt ONLY because cmds.length > 0
      state.lastExecutionAt = new Date().toISOString();
      state.openPosition = {
        entryTimestamp: state.lastExecutionAt,
        entrySpreadPct: signal.grossSpreadPct,
        entryBinId: dlmm.activeBinId + 1, // LP deposited at activeBinOffset: +1
        satsSent: satsCapped,
        estimatedEntryUsd: round((satsCapped / 1e8) * oracle.btcUsd, 2),
      };
      state.history.push({
        timestamp: state.lastExecutionAt,
        action: "entry",
        reason: `Spread ${signal.grossSpreadPct}% gross / ${signal.netSpreadPct}% net profitable`,
        spreadPct: signal.grossSpreadPct,
        satsSent: satsCapped,
        commands: cmds,
      });
      saveState(state);

      printJson({
        status: "ENTRY_COMMANDS_EMITTED",
        network: NETWORK,
        spread: signal,
        satsCapped,
        maxAutonomousSats: MAX_AUTONOMOUS_SATS,
        commandCount: cmds.length,
        commands: cmds,
        openPosition: state.openPosition,
        timestamp: state.lastExecutionAt,
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- watch ---
program
  .command("watch")
  .description("Continuous polling. Alerts when spread > threshold. Always read-only.")
  .option("--interval <seconds>", "Scan interval in seconds", "60")
  .option("--min-spread <pct>", "Minimum spread % to trigger alert", "0.3")
  .option("--max-scans <n>", "Max scans before exit", "60")
  .action(async (opts) => {
    try {
      const interval = (parseInt(opts.interval) || 60) * 1000;
      const minSpread = parseFloat(opts.minSpread) || MIN_SPREAD_PCT;
      const maxScans = parseInt(opts.maxScans) || 60;
      let scanCount = 0;

      printJson({
        status: "watching",
        interval: `${opts.interval}s`,
        minSpread: `${minSpread}%`,
        maxScans,
        startedAt: new Date().toISOString(),
      });

      while (scanCount < maxScans) {
        scanCount++;
        try {
          const [oracle, dlmm] = await Promise.all([fetchOraclePrices(), fetchDlmmBins()]);
          const xyk = await fetchXykReserves(oracle);
          const signal = analyzeSpread(oracle, xyk, dlmm);
          const state = loadState();

          const hasAlert = signal && signal.grossSpreadPct >= minSpread;
          if (hasAlert && signal) {
            printJson({
              scan: scanCount, alert: true, network: NETWORK, pair: "sBTC/STX",
              oracle: { btcUsd: oracle.btcUsd, stxUsd: oracle.stxUsd, stxPerBtc: oracle.stxPerBtc },
              xyk: { stxPerBtc: xyk.stxPerBtc },
              dlmm: { stxPerBtc: dlmm.stxPerBtc, activeBinId: dlmm.activeBinId },
              spread: signal,
              openPosition: state.openPosition,
              timestamp: new Date().toISOString(),
            });
          } else {
            printJson({
              scan: scanCount, alert: false,
              xykStxPerBtc: xyk.stxPerBtc,
              dlmmStxPerBtc: dlmm.source !== "unavailable" ? dlmm.stxPerBtc : "n/a",
              oracleStxPerBtc: oracle.stxPerBtc,
              grossSpreadPct: signal?.grossSpreadPct ?? null,
              dlmmSource: dlmm.source,
              openPosition: state.openPosition ? "yes" : "no",
              timestamp: new Date().toISOString(),
            });
          }
        } catch (e) {
          printJson({ scan: scanCount, error: e instanceof Error ? e.message : String(e) });
        }

        if (scanCount < maxScans) {
          await new Promise((r) => setTimeout(r, interval));
        }
      }

      printJson({ status: "complete", totalScans: scanCount });
    } catch (e) {
      handleError(e);
    }
  });

program.parse();
