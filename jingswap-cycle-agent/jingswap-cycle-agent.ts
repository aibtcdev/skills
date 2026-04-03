#!/usr/bin/env bun
/**
 * jingswap-cycle-agent — JingSwap STX↔sBTC auction cycle monitor and participant
 *
 * Monitors active JingSwap auction cycles, evaluates whether the oracle settlement
 * price offers a favourable entry relative to live DEX prices, and optionally deposits
 * STX to participate in the current cycle.
 *
 * Uses Stacks contract read-only calls via Hiro API (no API key required).
 * Uses Pyth Hermes API for oracle prices (no API key required).
 *
 * Usage:
 *   bun jingswap-cycle-agent/jingswap-cycle-agent.ts doctor
 *   bun jingswap-cycle-agent/jingswap-cycle-agent.ts status
 *   bun jingswap-cycle-agent/jingswap-cycle-agent.ts analyze [--min-discount 1.0]
 *   bun jingswap-cycle-agent/jingswap-cycle-agent.ts participate --amount-stx 100 [--min-discount 1.0] [--dry-run]
 */

import { Command } from "commander";

// ─── Constants ───────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const PYTH_HERMES = "https://hermes.pyth.network";

// JingSwap v2 contract (STX/sBTC market)
const JING_CONTRACT_ADDR = "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22";
const JING_CONTRACT_NAME = "sbtc-stx-jing-v2";
const JING_CONTRACT = `${JING_CONTRACT_ADDR}.${JING_CONTRACT_NAME}`;

// Pyth price feed IDs
const PYTH_BTC_USD = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const PYTH_STX_USD = "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17";

// Clarity read-only call sender (any valid address works for reads)
const READ_SENDER = "SP000000000000000000002Q6VF78";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CycleState {
  currentCycle: number;
  phase: number;          // 0=deposit, 1=buffer, 2=settle
  blocksElapsed: number;
  cycleTotals: {
    totalStx: number;     // micro-STX
    totalSbtc: number;    // satoshis
  };
  minDeposits: {
    minStx: number;       // micro-STX
    minSbtc: number;      // satoshis
  };
}

interface Prices {
  pyth: {
    btcUsd: { price: number; confidence: number };
    stxUsd: { price: number; confidence: number };
  };
  dex: {
    dlmmStxPerBtc: number;
    xykStxPerBtc: number;
  };
}

interface Opportunity {
  cyclePhase: string;
  currentCycle: number;
  sbtcAvailable: number;
  stxDeposited: number;
  oracleStxPerSbtc: number;
  dexStxPerSbtc: number;
  discountPct: number;
  isFavourable: boolean;
  rationale: string;
  action: "PARTICIPATE" | "MONITOR" | "WAIT_FOR_DEPOSIT_PHASE" | "NO_SBTC_AVAILABLE";
  confidence: "high" | "medium" | "low";
}

// ─── Clarity Helpers ─────────────────────────────────────────────────────────

/** Decode a Clarity uint response hex to a JS number */
function decodeUint(hex: string): number {
  if (!hex || !hex.startsWith("0x01")) return 0;
  // hex = "0x01" + 32 hex chars (16 bytes big-endian)
  // slice(4) removes "0x" (2) + type byte "01" (2)
  return parseInt(hex.slice(4), 16);
}

/** Encode a JS number as a Clarity uint argument (0x01 + 16 bytes big-endian) */
function encodeUint(n: number): string {
  return "0x01" + n.toString(16).padStart(32, "0");
}

/** Decode a Clarity tuple { total-sbtc, total-stx } from hex */
function decodeCycleTotals(hex: string): { totalStx: number; totalSbtc: number } {
  // Tuple: 0c + field_count(4) + [name_len(1) + name + value...]
  if (!hex || !hex.startsWith("0x0c")) return { totalStx: 0, totalSbtc: 0 };
  const buf = Buffer.from(hex.slice(2), "hex");
  let offset = 5; // skip 0c + 4-byte field count
  const result: Record<string, number> = {};
  for (let i = 0; i < 2; i++) {
    const nameLen = buf[offset++];
    const name = buf.subarray(offset, offset + nameLen).toString("ascii");
    offset += nameLen;
    // uint value: 0x01 + 16 bytes
    offset++; // skip 0x01 type byte
    const val = parseInt(buf.subarray(offset, offset + 16).toString("hex"), 16);
    offset += 16;
    result[name] = val;
  }
  return { totalSbtc: result["total-sbtc"] ?? 0, totalStx: result["total-stx"] ?? 0 };
}

/** Decode a Clarity tuple { min-sbtc, min-stx } from hex */
function decodeMinDeposits(hex: string): { minStx: number; minSbtc: number } {
  if (!hex || !hex.startsWith("0x0c")) return { minStx: 1_000_000, minSbtc: 1_000 };
  const buf = Buffer.from(hex.slice(2), "hex");
  let offset = 5;
  const result: Record<string, number> = {};
  for (let i = 0; i < 2; i++) {
    const nameLen = buf[offset++];
    const name = buf.subarray(offset, offset + nameLen).toString("ascii");
    offset += nameLen;
    offset++; // skip type byte
    const val = parseInt(buf.subarray(offset, offset + 16).toString("hex"), 16);
    offset += 16;
    result[name] = val;
  }
  return { minSbtc: result["min-sbtc"] ?? 1_000, minStx: result["min-stx"] ?? 1_000_000 };
}

// ─── Contract Calls ──────────────────────────────────────────────────────────

async function contractRead(fnName: string, args: string[] = []): Promise<any> {
  const url = `${HIRO_API}/v2/contracts/call-read/${JING_CONTRACT_ADDR}/${JING_CONTRACT_NAME}/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender: READ_SENDER, arguments: args }),
  }).catch(() => null);
  if (!res?.ok) throw new Error(`Hiro contract read failed (${res?.status ?? "network error"}): ${fnName}`);
  const data = await res.json();
  if (!data.okay) throw new Error(`Contract call error on ${fnName}: ${data.cause ?? "unknown"}`);
  return data.result as string;
}

async function fetchCycleState(): Promise<CycleState> {
  const [cycleHex, phaseHex, elapsedHex, minsHex] = await Promise.all([
    contractRead("get-current-cycle"),
    contractRead("get-cycle-phase"),
    contractRead("get-blocks-elapsed"),
    contractRead("get-min-deposits"),
  ]);

  const currentCycle = decodeUint(cycleHex);
  const phase = decodeUint(phaseHex);
  const blocksElapsed = decodeUint(elapsedHex);
  const minDeposits = decodeMinDeposits(minsHex);

  const totalsHex = await contractRead("get-cycle-totals", [encodeUint(currentCycle)]);
  const cycleTotals = decodeCycleTotals(totalsHex);

  return { currentCycle, phase, blocksElapsed, cycleTotals, minDeposits };
}

async function fetchPrices(): Promise<Prices> {
  // Oracle prices from Pyth Hermes
  const pythRes = await fetch(
    `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD}&ids[]=${PYTH_STX_USD}&parsed=true`
  ).catch(() => null);
  if (!pythRes?.ok) throw new Error(`Pyth Hermes API failed: ${pythRes?.status ?? "network error"}`);
  const pythData = await pythRes.json();
  const parsed = pythData.parsed as any[];

  function pythPrice(feedId: string) {
    const entry = parsed.find((p: any) => p.id === feedId);
    if (!entry) throw new Error(`Pyth feed not found: ${feedId}`);
    const price = parseFloat(entry.price.price) * Math.pow(10, entry.price.expo);
    const confidence = parseFloat(entry.price.conf) * Math.pow(10, entry.price.expo);
    return { price, confidence };
  }

  const btcUsd = pythPrice(PYTH_BTC_USD);
  const stxUsd = pythPrice(PYTH_STX_USD);

  // DEX prices from contract
  const [dlmmHex, xykHex] = await Promise.all([
    contractRead("get-dlmm-price"),
    contractRead("get-xyk-price"),
  ]);

  // DLMM: raw is inverse-price * 1e10 → STX/sBTC = 1e10 / dlmmRaw
  const dlmmRaw = decodeUint(dlmmHex);
  const dlmmStxPerBtc = dlmmRaw > 0 ? 1e10 / dlmmRaw : 0;

  // XYK: raw is STX/sBTC * 1e8 (direct price, different scale from DLMM)
  const xykRaw = decodeUint(xykHex);
  const xykStxPerBtc = xykRaw > 0 ? xykRaw / 1e8 : dlmmStxPerBtc;

  return {
    pyth: { btcUsd, stxUsd },
    dex: { dlmmStxPerBtc, xykStxPerBtc },
  };
}

// ─── Core Analysis ────────────────────────────────────────────────────────────

function phaseName(phase: number): string {
  return ["deposit", "buffer", "settle"][phase] ?? "unknown";
}

function analyzeOpportunity(
  state: CycleState,
  prices: Prices,
  minDiscountPct: number
): Opportunity {
  const phase = phaseName(state.phase);
  const sbtcAvailable = state.cycleTotals.totalSbtc / 1e8;
  const stxDeposited = state.cycleTotals.totalStx / 1e6;

  // Oracle rate: BTC/USD ÷ STX/USD = STX per BTC
  const oracleStxPerSbtc = prices.pyth.btcUsd.price / prices.pyth.stxUsd.price;

  // Best DEX rate — DLMM is more precise for active price
  const dexStxPerSbtc = prices.dex.dlmmStxPerBtc || prices.dex.xykStxPerBtc;

  // Guard: if both DEX prices are 0 (uninitialized pool), we cannot compute a meaningful discount
  if (dexStxPerSbtc === 0) {
    return {
      cyclePhase: phase,
      currentCycle: state.currentCycle,
      sbtcAvailable,
      stxDeposited,
      oracleStxPerSbtc,
      dexStxPerSbtc: 0,
      discountPct: 0,
      isFavourable: false,
      rationale: "DEX price unavailable (both DLMM and XYK returned 0). Cannot compute oracle discount. Verify pool is initialized.",
      action: "MONITOR",
      confidence: "low",
    };
  }

  // Discount: positive = oracle cheaper than DEX → favourable for STX depositor
  const discountPct = ((dexStxPerSbtc - oracleStxPerSbtc) / dexStxPerSbtc) * 100;
  const isFavourable = discountPct >= minDiscountPct;

  // Phase check first: if deposits are closed, retry interval is ~1 hour (not 30 min)
  if (state.phase !== 0) {
    return {
      cyclePhase: phase,
      currentCycle: state.currentCycle,
      sbtcAvailable,
      stxDeposited,
      oracleStxPerSbtc,
      dexStxPerSbtc,
      discountPct,
      isFavourable: false,
      rationale: `Cycle is in ${phase} phase — deposits are closed. Wait for next cycle.`,
      action: "WAIT_FOR_DEPOSIT_PHASE",
      confidence: "high",
    };
  }

  if (sbtcAvailable === 0) {
    return {
      cyclePhase: phase,
      currentCycle: state.currentCycle,
      sbtcAvailable,
      stxDeposited,
      oracleStxPerSbtc,
      dexStxPerSbtc,
      discountPct,
      isFavourable: false,
      rationale: "No sBTC deposited in current cycle. Wait for sBTC depositors to enter.",
      action: "NO_SBTC_AVAILABLE",
      confidence: "high",
    };
  }

  if (isFavourable) {
    const confidence: "high" | "medium" | "low" =
      discountPct >= 2 ? "high" : discountPct >= 1 ? "medium" : "low";
    return {
      cyclePhase: phase,
      currentCycle: state.currentCycle,
      sbtcAvailable,
      stxDeposited,
      oracleStxPerSbtc,
      dexStxPerSbtc,
      discountPct,
      isFavourable: true,
      rationale: `Oracle settlement rate (${oracleStxPerSbtc.toFixed(0)} STX/sBTC) is ${discountPct.toFixed(2)}% cheaper than DEX (${dexStxPerSbtc.toFixed(0)} STX/sBTC). Depositing STX now acquires ${sbtcAvailable.toFixed(6)} sBTC at a discount.`,
      action: "PARTICIPATE",
      confidence,
    };
  }

  return {
    cyclePhase: phase,
    currentCycle: state.currentCycle,
    sbtcAvailable,
    stxDeposited,
    oracleStxPerSbtc,
    dexStxPerSbtc,
    discountPct,
    isFavourable: false,
    rationale: `Oracle rate (${oracleStxPerSbtc.toFixed(0)} STX/sBTC) is ${Math.abs(discountPct).toFixed(2)}% ${discountPct < 0 ? "MORE expensive" : "cheaper"} than DEX (${dexStxPerSbtc.toFixed(0)} STX/sBTC). Spread does not meet minimum discount threshold of ${minDiscountPct}%.`,
    action: "MONITOR",
    confidence: "high",
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

const program = new Command();
program.name("jingswap-cycle-agent").version("2.0.0");

// doctor
program
  .command("doctor")
  .description("Check API connectivity (Hiro contract reads + Pyth oracle)")
  .action(async () => {
    const checks: Record<string, string> = {};
    try {
      await contractRead("get-current-cycle");
      checks.hiro_contract_api = "ok";
    } catch (e: any) {
      checks.hiro_contract_api = `error: ${e.message}`;
    }
    try {
      const r = await fetch(`${PYTH_HERMES}/v2/updates/price/latest?ids[]=${PYTH_BTC_USD}&parsed=true`).catch(() => null);
      if (!r?.ok) throw new Error(`status ${r?.status}`);
      checks.pyth_hermes_api = "ok";
    } catch (e: any) {
      checks.pyth_hermes_api = `error: ${e.message}`;
    }
    const allOk = Object.values(checks).every((v) => v === "ok");
    console.log(JSON.stringify({ result: allOk ? "ready" : "degraded", checks, contract: JING_CONTRACT }, null, 2));
    if (!allOk) process.exit(1);
  });

// status
program
  .command("status")
  .description("Show current cycle state and price analysis")
  .action(async () => {
    const [state, prices] = await Promise.all([fetchCycleState(), fetchPrices()]);

    const oracleStxPerSbtc = prices.pyth.btcUsd.price / prices.pyth.stxUsd.price;
    const dexStxPerSbtc = prices.dex.dlmmStxPerBtc || prices.dex.xykStxPerBtc;
    const discountPct = ((dexStxPerSbtc - oracleStxPerSbtc) / dexStxPerSbtc) * 100;

    console.log(
      JSON.stringify(
        {
          skill: "jingswap-cycle-agent",
          timestamp: new Date().toISOString(),
          contract: JING_CONTRACT,
          cycle: {
            id: state.currentCycle,
            phase: phaseName(state.phase),
            blocks_elapsed: state.blocksElapsed,
            sbtc_deposited: (state.cycleTotals.totalSbtc / 1e8).toFixed(8) + " sBTC",
            stx_deposited: (state.cycleTotals.totalStx / 1e6).toFixed(2) + " STX",
            min_stx_deposit: (state.minDeposits.minStx / 1e6).toFixed(2) + " STX",
            min_sbtc_deposit: (state.minDeposits.minSbtc / 1e8).toFixed(8) + " sBTC",
          },
          prices: {
            btc_usd: prices.pyth.btcUsd.price.toFixed(2),
            stx_usd: prices.pyth.stxUsd.price.toFixed(6),
            oracle_stx_per_sbtc: oracleStxPerSbtc.toFixed(2),
            dex_stx_per_sbtc_dlmm: prices.dex.dlmmStxPerBtc.toFixed(2),
            dex_stx_per_sbtc_xyk: prices.dex.xykStxPerBtc.toFixed(2),
            oracle_vs_dex_discount_pct: discountPct.toFixed(3),
          },
          summary: `Cycle ${state.currentCycle} in ${phaseName(state.phase)} phase. Oracle ${discountPct >= 0 ? discountPct.toFixed(2) + "% CHEAPER" : Math.abs(discountPct).toFixed(2) + "% MORE EXPENSIVE"} than DEX.`,
        },
        null,
        2
      )
    );
  });

// analyze
program
  .command("analyze")
  .description("Evaluate whether current cycle offers a favourable sBTC acquisition opportunity")
  .option("--min-discount <pct>", "Minimum oracle discount vs DEX to trigger PARTICIPATE (default: 1.0)", "1.0")
  .action(async (opts) => {
    const minDiscount = parseFloat(opts.minDiscount);
    const [state, prices] = await Promise.all([fetchCycleState(), fetchPrices()]);
    const opportunity = analyzeOpportunity(state, prices, minDiscount);
    console.log(
      JSON.stringify(
        {
          skill: "jingswap-cycle-agent",
          timestamp: new Date().toISOString(),
          contract: JING_CONTRACT,
          input: { min_discount_pct: minDiscount },
          cycle: {
            id: opportunity.currentCycle,
            phase: opportunity.cyclePhase,
            sbtc_available: opportunity.sbtcAvailable.toFixed(8) + " sBTC",
            stx_deposited: opportunity.stxDeposited.toFixed(2) + " STX",
          },
          pricing: {
            oracle_stx_per_sbtc: opportunity.oracleStxPerSbtc.toFixed(2),
            dex_stx_per_sbtc: opportunity.dexStxPerSbtc.toFixed(2),
            discount_pct: opportunity.discountPct.toFixed(3),
          },
          action: opportunity.action,
          confidence: opportunity.confidence,
          is_favourable: opportunity.isFavourable,
          rationale: opportunity.rationale,
          summary: `${opportunity.action} (${opportunity.confidence} confidence) — cycle ${opportunity.currentCycle} (${opportunity.cyclePhase}), oracle ${opportunity.discountPct >= 0 ? opportunity.discountPct.toFixed(2) + "% discount" : Math.abs(opportunity.discountPct).toFixed(2) + "% premium"} vs DEX.`,
        },
        null,
        2
      )
    );
  });

// participate
program
  .command("participate")
  .description("Deposit STX into current JingSwap cycle if opportunity is favourable")
  .requiredOption("--amount-stx <amount>", "STX amount to deposit (e.g. 100)")
  .option("--min-discount <pct>", "Minimum oracle discount vs DEX required to proceed (default: 1.0)", "1.0")
  .option("--dry-run", "Analyse opportunity but do not execute deposit", false)
  .action(async (opts) => {
    const amountStx = parseFloat(opts.amountStx);
    const minDiscount = parseFloat(opts.minDiscount);
    if (isNaN(amountStx) || amountStx <= 0) {
      console.log(JSON.stringify({ error: "--amount-stx must be a positive number" }));
      process.exit(1);
    }

    const [state, prices] = await Promise.all([fetchCycleState(), fetchPrices()]);
    const opportunity = analyzeOpportunity(state, prices, minDiscount);

    if (!opportunity.isFavourable) {
      console.log(
        JSON.stringify(
          {
            skill: "jingswap-cycle-agent",
            timestamp: new Date().toISOString(),
            action: "SKIPPED",
            reason: opportunity.rationale,
            opportunity,
          },
          null,
          2
        )
      );
      return;
    }

    if (opts.dryRun) {
      console.log(
        JSON.stringify(
          {
            skill: "jingswap-cycle-agent",
            timestamp: new Date().toISOString(),
            action: "DRY_RUN",
            would_deposit_stx: amountStx,
            contract: JING_CONTRACT,
            opportunity,
            note: "Dry run — no transaction submitted. Remove --dry-run to execute.",
          },
          null,
          2
        )
      );
      return;
    }

    // Output deposit parameters for parent agent to execute via aibtc MCP jingswap_deposit_stx
    console.log(
      JSON.stringify(
        {
          skill: "jingswap-cycle-agent",
          timestamp: new Date().toISOString(),
          action: "DEPOSIT_READY",
          deposit_params: {
            amount_stx: amountStx,
            amount_micro_stx: Math.round(amountStx * 1e6),
            market: "sbtc-stx",
            cycle: opportunity.currentCycle,
          },
          opportunity,
          instruction:
            "Parent agent: call jingswap_deposit_stx with amount=" +
            Math.round(amountStx * 1e6) +
            " and market=sbtc-stx to execute this deposit. Confirm before proceeding.",
        },
        null,
        2
      )
    );
  });

program.parseAsync(process.argv).catch((e) => {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
});
