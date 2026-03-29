#!/usr/bin/env bun
/**
 * Hermetica Yield Rotator
 * Monitors Hermetica USDh staking APY vs Bitflow HODLMM dlmm_1 APR and
 * executes cross-protocol yield rotation on Stacks mainnet.
 *
 * Actions:
 *   assess          — recommend optimal allocation (default, read-only)
 *   stake           — stake USDh into Hermetica vault (requires --confirm)
 *   initiate-unstake — begin 7-day unstake cooldown (requires --confirm)
 *   complete-unstake — redeem USDh after cooldown (requires --confirm)
 *   rotate          — auto-rotate capital to higher-yielding protocol (requires --confirm)
 *
 * Usage:
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts doctor
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts install-packs
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet <STX_ADDRESS>
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet <STX_ADDRESS> --action=stake --amount=500 --confirm
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet <STX_ADDRESS> --action=initiate-unstake --amount=500 --confirm
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet <STX_ADDRESS> --action=complete-unstake --confirm
 *   bun run hermetica-yield-rotator/hermetica-yield-rotator.ts run --wallet <STX_ADDRESS> --action=rotate --confirm
 *
 * --amount is in human-readable USDh/sUSDh units (e.g. 500 = 500 USDh).
 * Omit --amount with stake/initiate-unstake to default to min(wallet balance, 500 USDh cap).
 *
 * Output: strict JSON { status, action, data, error }
 */

import { Command }      from "commander";
import { homedir }      from "os";
import { join }         from "path";
import { readFileSync, writeFileSync } from "fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS     = 30_000;
const EXCHANGE_RATE_SCALE  = 100_000_000n;    // 1e8 — Hermetica internal precision
const USDH_DECIMALS        = 8;
const ROTATE_THRESHOLD_PCT = 2.0;             // min yield differential to trigger rotation
const ROTATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between rotations
const MAX_AUTONOMOUS_STAKE_USDH = 500;        // hard ceiling for autonomous stake/unstake/rotate without explicit --amount
const MAX_AUTONOMOUS_STAKE_RAW  = BigInt(MAX_AUTONOMOUS_STAKE_USDH) * 10n ** BigInt(8); // 500 USDh in base units
const MIN_STX_GAS_USTX = 10_000n;             // 0.01 STX minimum balance for gas fees
const HODLMM_POOL          = "dlmm_1";        // sBTC/USDCx pool
const HIRO_API             = "https://api.mainnet.hiro.so";
const BITFLOW_API          = "https://bff.bitflowapis.finance";
const HERMETICA            = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const STATE_FILE           = join(homedir(), ".hermetica-yield-rotator-state.json");
const NULL_SENDER          = "SP000000000000000000002Q6VF78";

// ── Contract IDs ───────────────────────────────────────────────────────────────
const C = {
  STAKING:       `${HERMETICA}.staking-v1`,
  STAKING_STATE: `${HERMETICA}.staking-state-v1`,
  STAKING_SILO:  `${HERMETICA}.staking-silo-v1-1`,
  USDH:          `${HERMETICA}.usdh-token-v1`,
  SUSDH:         `${HERMETICA}.susdh-token-v1`,
} as const;

const TOKEN_USDH  = `${HERMETICA}.usdh-token-v1::usdh`;
const TOKEN_SUSDH = `${HERMETICA}.susdh-token-v1::susdh`;
const TOKEN_USDCX = "SP2XD7417HGPRTREMKF08VBER9H3QAKMO0CVT250Y.token-usdcx::usdcx"; // dlmm_1 accepts USDCx, not USDh

// ── Types ──────────────────────────────────────────────────────────────────────
interface CallReadResponse { okay: boolean; result: string }
interface HiroFtEntry { balance: string }
interface HiroBalances { stx?: { balance: string }; fungible_tokens?: Record<string, HiroFtEntry> }

interface AppPool {
  poolId:      string;
  apr24h:      number;
  tvlUsd:      number;
  volumeUsd1d: number;
}
interface AppPoolsResponse { data?: AppPool[] }

interface HodlmmBin { binId: number; liquidityShares?: number; amount?: number }
interface HodlmmPositionResponse { data?: HodlmmBin[] }
interface BinsApiResponse { active_bin_id?: number; activeBinId?: number }

interface RotatorState {
  last_run_at:           string;
  last_exchange_rate:    string;
  last_rotation_at:      string | null;
  last_action:           string | null;
  unstake_initiated_at:  string | null;   // ISO timestamp when initiate-unstake was last called
  unstake_amount_raw:    string | null;   // sUSDh raw amount submitted for unstaking
  baseline_run_at:       string | null;   // oldest exchange rate sample for APY window
  baseline_rate:         string | null;   // exchange rate at baseline_run_at
}

interface CheckResult { name: string; ok: boolean; detail: string }

interface McpCommand {
  step:        number;
  tool:        string;
  description: string;
  params:      Record<string, unknown>;
}

// ── Clarity encoding ───────────────────────────────────────────────────────────
function encodeUint(n: bigint): string {
  // Clarity serialized uint128: type tag 0x01 + 16 bytes big-endian
  if (n < 0n || n > 2n ** 128n - 1n) throw new Error(`encodeUint: value ${n} out of uint128 range`);
  return "0x01" + n.toString(16).padStart(32, "0");
}

function decodeUint128(hex: string): bigint {
  // Parse structurally: strip 0x, then read known tag bytes at fixed offsets.
  // Clarity wire format: [07 response-ok] [01 uint128] [16 bytes value]
  let h = hex.replace(/^0x/, "");
  // Unwrap outer (response ok ...) wrapper if present
  if (h.length >= 2 && h.slice(0, 2) === "07") h = h.slice(2);
  // Reject error response
  if (h.length >= 2 && h.slice(0, 2) === "08") throw new Error("Contract returned error response");
  // Strip uint128 type tag
  if (h.length >= 2 && h.slice(0, 2) === "01") h = h.slice(2);
  // Require at most 32 hex chars (16 bytes) after tag stripping
  if (h.length === 0) throw new Error(`decodeUint128: empty payload after tag strip (raw: ${hex})`);
  if (h.length > 32) throw new Error(`decodeUint128: oversized payload (${h.length} chars) — expected ≤32 (raw: ${hex})`);
  const val = BigInt("0x" + h.padStart(32, "0"));
  return val;
}

function decodeBool(hex: string): boolean {
  let h = hex.replace(/^0x/, "");
  // Unwrap outer (response ok ...) wrapper if present — mirrors decodeUint128 logic
  if (h.length >= 2 && h.slice(0, 2) === "07") h = h.slice(2);
  // Reject error response
  if (h.length >= 2 && h.slice(0, 2) === "08") throw new Error("Contract returned error response");
  if (h === "03") return true;
  if (h === "04") return false;
  throw new Error(`Cannot decode bool from: ${hex}`);
}

// ── Input validation helpers ───────────────────────────────────────────────────
const STX_ADDRESS_RE = /^SP[0-9A-Z]{38,39}$/;
const DECIMAL_AMOUNT_RE = /^\d+(\.\d{1,8})?$/;
const INTEGER_STRING_RE = /^\d+$/;
const ISO_TIMESTAMP_RE  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_SANE_APR = 500; // % — flag anything above as suspicious

function validateStxAddress(addr: string): void {
  if (!STX_ADDRESS_RE.test(addr))
    throw new Error(`Invalid STX address: "${addr}". Expected SP followed by 38–39 uppercase alphanumeric chars.`);
}

// F1: String-based raw amount conversion — avoids IEEE 754 precision loss
function parseAmountToRaw(humanStr: string, decimals: number): bigint {
  if (!DECIMAL_AMOUNT_RE.test(humanStr))
    throw new Error(`Invalid amount "${humanStr}": must be a positive decimal with up to ${decimals} decimal places`);
  const [intPart = "0", fracPart = ""] = humanStr.split(".");
  const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(paddedFrac);
}

// F10: Clamp Bitflow APR to a plausible range
function sanitiseApr(raw: number, label: string): number {
  if (!isFinite(raw) || raw < 0) throw new Error(`${label} APR is invalid: ${raw}`);
  if (raw > MAX_SANE_APR) throw new Error(`${label} APR ${raw.toFixed(2)}% exceeds sanity cap ${MAX_SANE_APR}% — possible API spoofing`);
  return raw;
}

// F11: Safe BigInt from Hiro balance string
function safeBalanceBigInt(raw: string | number | undefined, label: string): bigint {
  const s = String(raw ?? "0");
  if (!INTEGER_STRING_RE.test(s)) throw new Error(`Unexpected ${label} balance format: "${s}"`);
  return BigInt(s);
}

// ── State helpers ──────────────────────────────────────────────────────────────
function readState(): Partial<RotatorState> {
  // F2/F7: Validate all fields on read — reject malformed state rather than trusting it
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    const state: Partial<RotatorState> = {};
    if (typeof raw.last_run_at === "string" && ISO_TIMESTAMP_RE.test(raw.last_run_at))
      state.last_run_at = raw.last_run_at;
    if (typeof raw.last_exchange_rate === "string" && INTEGER_STRING_RE.test(raw.last_exchange_rate))
      state.last_exchange_rate = raw.last_exchange_rate;
    if (raw.last_rotation_at === null) {
      state.last_rotation_at = null;
    } else if (typeof raw.last_rotation_at === "string" && ISO_TIMESTAMP_RE.test(raw.last_rotation_at)) {
      // F7: Reject future timestamps — treat as no rotation
      const ts = new Date(raw.last_rotation_at).getTime();
      state.last_rotation_at = ts <= Date.now() ? raw.last_rotation_at : null;
    }
    if (typeof raw.last_action === "string") state.last_action = raw.last_action;
    if (raw.unstake_initiated_at === null) {
      state.unstake_initiated_at = null;
    } else if (typeof raw.unstake_initiated_at === "string" && ISO_TIMESTAMP_RE.test(raw.unstake_initiated_at)) {
      state.unstake_initiated_at = raw.unstake_initiated_at;
    }
    if (raw.unstake_amount_raw === null) {
      state.unstake_amount_raw = null;
    } else if (typeof raw.unstake_amount_raw === "string" && INTEGER_STRING_RE.test(raw.unstake_amount_raw)) {
      state.unstake_amount_raw = raw.unstake_amount_raw;
    }
    if (raw.baseline_run_at === null) {
      state.baseline_run_at = null;
    } else if (typeof raw.baseline_run_at === "string" && ISO_TIMESTAMP_RE.test(raw.baseline_run_at)) {
      state.baseline_run_at = raw.baseline_run_at;
    }
    if (raw.baseline_rate === null) {
      state.baseline_rate = null;
    } else if (typeof raw.baseline_rate === "string" && INTEGER_STRING_RE.test(raw.baseline_rate)) {
      state.baseline_rate = raw.baseline_rate;
    }
    return state;
  } catch { return {}; }
}

function writeState(s: RotatorState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hermetica-yield-rotator" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

async function fetchPostJson<T>(url: string, body: unknown): Promise<T> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method:  "POST",
      signal:  ctrl.signal,
      headers: {
        Accept:         "application/json",
        "Content-Type": "application/json",
        "User-Agent":   "bff-skills/hermetica-yield-rotator",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

// ── Contract read helpers ──────────────────────────────────────────────────────
async function callReadOnly(contractId: string, fn: string, args: string[] = []): Promise<string> {
  const [addr, name] = contractId.split(".");
  const url  = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`;
  const data = await fetchPostJson<CallReadResponse>(url, { sender: NULL_SENDER, arguments: args });
  if (!data.okay) throw new Error(`Contract call failed: ${contractId}::${fn}`);
  return data.result;
}

async function fetchExchangeRate(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.STAKING, "get-usdh-per-susdh"));
}

async function fetchStakingEnabled(): Promise<boolean> {
  return decodeBool(await callReadOnly(C.STAKING_STATE, "get-staking-enabled"));
}

async function fetchCooldownWindow(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.STAKING_STATE, "get-cooldown-window"));
}

async function fetchUsdhSupply(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.USDH, "get-total-supply"));
}

async function fetchSusdhSupply(): Promise<bigint> {
  return decodeUint128(await callReadOnly(C.SUSDH, "get-total-supply"));
}

async function fetchCurrentSiloTs(): Promise<bigint | null> {
  try { return decodeUint128(await callReadOnly(C.STAKING_SILO, "get-current-ts")); }
  catch { return null; }
}

async function fetchUserBalances(wallet: string): Promise<{ usdh: bigint; susdh: bigint; stx: bigint }> {
  const data = await fetchJson<HiroBalances>(`${HIRO_API}/extended/v1/address/${wallet}/balances`);
  const ft   = data.fungible_tokens ?? {};
  // F11: Use safeBalanceBigInt to handle numeric or scientific-notation responses
  return {
    usdh:  safeBalanceBigInt(ft[TOKEN_USDH]?.balance,  "USDh"),
    susdh: safeBalanceBigInt(ft[TOKEN_SUSDH]?.balance, "sUSDh"),
    stx:   safeBalanceBigInt(data.stx?.balance, "STX"),
  };
}

async function fetchHodlmmPool(): Promise<{ apr: number; tvlUsd: number } | null> {
  try {
    const data = await fetchJson<AppPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
    const pool = (data.data ?? []).find((p) => p.poolId === HODLMM_POOL);
    if (!pool) return null;
    // F10: Clamp APR to sane range — reject if API returns implausible value
    const apr = sanitiseApr(pool.apr24h, "HODLMM");
    return { apr, tvlUsd: pool.tvlUsd };
  } catch { return null; }
}

async function fetchHodlmmActiveBin(): Promise<number | null> {
  try {
    const data = await fetchJson<BinsApiResponse>(
      `${BITFLOW_API}/api/quotes/v1/bins/${HODLMM_POOL}`,
    );
    return data.active_bin_id ?? data.activeBinId ?? null;
  } catch { return null; }
}

async function fetchHodlmmPosition(wallet: string): Promise<HodlmmBin[]> {
  try {
    const data = await fetchJson<HodlmmPositionResponse>(
      `${BITFLOW_API}/api/app/v1/users/${wallet}/positions/${HODLMM_POOL}/bins`,
    );
    return (data.data ?? []).filter((b) => (b.liquidityShares ?? b.amount ?? 0) > 0);
  } catch { return []; }
}

// ── Maths ──────────────────────────────────────────────────────────────────────
function toHuman(raw: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const int   = raw / scale;
  const frac  = raw % scale;
  return parseFloat(`${int}.${frac.toString().padStart(decimals, "0")}`);
}

function accumulatedYieldPct(rate: bigint): number {
  return parseFloat(((Number(rate) / Number(EXCHANGE_RATE_SCALE) - 1) * 100).toFixed(4));
}

function estimateApy(current: bigint, prev: bigint, elapsedMs: number): number | null {
  if (elapsedMs < 3_600_000) return null;
  if (current <= prev)       return null;
  const delta  = Number(current - prev) / Number(EXCHANGE_RATE_SCALE);
  const annPct = delta * ((365 * 24 * 3600) / (elapsedMs / 1000)) * 100;
  return parseFloat(annPct.toFixed(2));
}

function updateBaseline(prev: Partial<RotatorState>, nowIso: string, rate: bigint): { baseline_run_at: string; baseline_rate: string } {
  // Keep baseline until it is > 24h old, then reset to accumulate a fresh window
  if (prev.baseline_run_at && prev.baseline_rate) {
    const age = Date.now() - new Date(prev.baseline_run_at).getTime();
    if (age < 86_400_000) return { baseline_run_at: prev.baseline_run_at, baseline_rate: prev.baseline_rate };
  }
  return { baseline_run_at: nowIso, baseline_rate: rate.toString() };
}

// ── MCP command builders ───────────────────────────────────────────────────────
function stakeCmd(amountRaw: bigint, wallet: string, step: number, exchangeRate?: bigint): McpCommand {
  const minSusdh = exchangeRate
    ? amountRaw * EXCHANGE_RATE_SCALE * 99n / (100n * exchangeRate)
    : 1n;
  return {
    step,
    tool:        "call_contract",
    description: `Stake ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} USDh → receive sUSDh (Hermetica staking-v1)`,
    params: {
      contract_address: HERMETICA,
      contract_name:    "staking-v1",
      function_name:    "stake",
      function_args:    [encodeUint(amountRaw)],
      // F5: Post-condition — sender must debit exactly amountRaw USDh
      post_conditions:  [
        {
          type:      "ft",
          address:   wallet,
          asset:     TOKEN_USDH,
          amount:    amountRaw.toString(),
          condition: "eq",
        },
        {
          type:      "ft",
          address:   wallet,
          asset:     TOKEN_SUSDH,
          amount:    minSusdh.toString(),
          condition: "gte",
        },
      ],
    },
  };
}

function initiateUnstakeCmd(amountRaw: bigint, wallet: string, cooldownDays: number, step: number): McpCommand {
  return {
    step,
    tool:        "call_contract",
    description: `Initiate unstake of ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} sUSDh — ${cooldownDays}-day cooldown starts`,
    params: {
      contract_address: HERMETICA,
      contract_name:    "staking-v1",
      function_name:    "initiate-unstake",
      function_args:    [encodeUint(amountRaw)],
      // F5: Post-condition — sender must debit exactly amountRaw sUSDh
      post_conditions:  [{
        type:      "ft",
        address:   wallet,
        asset:     TOKEN_SUSDH,
        amount:    amountRaw.toString(),
        condition: "eq",
      }],
    },
  };
}

function completeUnstakeCmd(wallet: string, step: number, minUsdhRaw: bigint = 1n): McpCommand {
  return {
    step,
    tool:        "call_contract",
    description: "Complete unstake — redeem USDh after cooldown window has elapsed",
    params: {
      contract_address: HERMETICA,
      contract_name:    "staking-v1",
      function_name:    "complete-unstake",
      function_args:    [],
      // F5: Post-condition — sender must receive at least minUsdhRaw USDh (gte guards against zero-return exploit)
      post_conditions:  [{
        type:      "ft",
        address:   wallet,
        asset:     TOKEN_USDH,
        amount:    minUsdhRaw.toString(),
        condition: "gte",
      }],
    },
  };
}

function swapUsdhToUsdcxCmd(amountUsdh: number, step: number): McpCommand {
  return {
    step,
    tool:        "bitflow_swap",
    description: `Swap ${amountUsdh.toFixed(2)} USDh → USDCx (required: dlmm_1 accepts USDCx, not USDh)`,
    params: {
      tokenIn:  TOKEN_USDH,
      tokenOut: TOKEN_USDCX,
      amount:   amountUsdh,
      slippage: 0.5,
    },
  };
}

function addLiquidityCmd(amountUsdcx: number, activeBinId: number, step: number): McpCommand {
  return {
    step,
    tool:        "bitflow_hodlmm_add_liquidity",
    description: `Add $${amountUsdcx.toFixed(2)} USDCx to HODLMM ${HODLMM_POOL} around active bin ${activeBinId}`,
    params: {
      poolId:      HODLMM_POOL,
      amountUsdcx,
      targetBinId: activeBinId,
      binRange:    5,
    },
  };
}

function removeLiquidityCmd(binIds: number[], step: number): McpCommand {
  return {
    step,
    tool:        "bitflow_hodlmm_remove_liquidity",
    description: `Remove liquidity from HODLMM ${HODLMM_POOL} bins: [${binIds.join(", ")}]`,
    params: {
      poolId: HODLMM_POOL,
      binIds,
    },
  };
}

// ── Error output ───────────────────────────────────────────────────────────────
function outputError(code: string, message: string, next: string): never {
  console.error(JSON.stringify({
    status: "error",
    action: `Blocked: ${message}`,
    data:   null,
    error:  { code, message, next },
  }, null, 2));
  process.exit(1);
  throw new Error(message); // unreachable — satisfies TypeScript never return
}

// ── Doctor ─────────────────────────────────────────────────────────────────────
async function doctor(): Promise<void> {
  const checks: CheckResult[] = [];

  try {
    const rate = await fetchExchangeRate();
    checks.push({ name: "Hermetica staking-v1", ok: true,
      detail: `exchange rate: ${toHuman(rate, USDH_DECIMALS).toFixed(8)} USDh/sUSDh` });
  } catch (e) {
    checks.push({ name: "Hermetica staking-v1", ok: false, detail: String(e) });
  }

  try {
    const [enabled, cooldown] = await Promise.all([fetchStakingEnabled(), fetchCooldownWindow()]);
    checks.push({ name: "Hermetica staking-state-v1", ok: true,
      detail: `staking enabled: ${enabled}, cooldown: ${(Number(cooldown) / 86_400).toFixed(1)} days` });
  } catch (e) {
    checks.push({ name: "Hermetica staking-state-v1", ok: false, detail: String(e) });
  }

  try {
    const [u, s] = await Promise.all([fetchUsdhSupply(), fetchSusdhSupply()]);
    checks.push({ name: "Hermetica token contracts (USDh + sUSDh)", ok: true,
      detail: `USDh supply: $${toHuman(u, USDH_DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 2 })}, sUSDh: ${toHuman(s, USDH_DECIMALS).toLocaleString("en-US", { maximumFractionDigits: 2 })}` });
  } catch (e) {
    checks.push({ name: "Hermetica token contracts (USDh + sUSDh)", ok: false, detail: String(e) });
  }

  try {
    const pool = await fetchHodlmmPool();
    if (!pool) throw new Error(`${HODLMM_POOL} not found in pool list`);
    checks.push({ name: `Bitflow HODLMM App API (${HODLMM_POOL})`, ok: true,
      detail: `APR: ${pool.apr.toFixed(2)}%, TVL: $${pool.tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}` });
  } catch (e) {
    checks.push({ name: `Bitflow HODLMM App API (${HODLMM_POOL})`, ok: false, detail: String(e) });
  }

  try {
    const bin = await fetchHodlmmActiveBin();
    if (bin === null) throw new Error("active bin not found");
    checks.push({ name: `Bitflow HODLMM Bins API (${HODLMM_POOL})`, ok: true,
      detail: `active bin: ${bin}` });
  } catch (e) {
    checks.push({ name: `Bitflow HODLMM Bins API (${HODLMM_POOL})`, ok: false, detail: String(e) });
  }

  const allOk = checks.every((c) => c.ok);
  console.log(JSON.stringify({
    status:  allOk ? "ok" : "degraded",
    checks,
    message: allOk
      ? "All data sources reachable. Ready to run."
      : "Some sources unavailable — rotation decisions may be incomplete.",
  }, null, 2));
}

async function installPacks(): Promise<void> {
  console.log(JSON.stringify({
    status:  "ok",
    message: "No packs required. hermetica-yield-rotator uses Hermetica contracts and Hiro/Bitflow public APIs only.",
    data:    { requires: [] },
  }, null, 2));
}

// ── Main run ───────────────────────────────────────────────────────────────────
async function run(opts: {
  wallet?:  string;
  action?:  string;
  amount?:  string;
  confirm?: boolean;
}): Promise<void> {
  const { wallet, action = "assess", amount, confirm = false } = opts;

  const writeActions = ["stake", "initiate-unstake", "complete-unstake", "rotate"];

  if (writeActions.includes(action) && !confirm) {
    outputError("CONFIRM_REQUIRED", `--confirm required for action '${action}'`, `Re-run with --confirm to execute.`);
  }
  if (writeActions.includes(action) && !wallet) {
    outputError("WALLET_REQUIRED", `--wallet required for action '${action}'`, "Provide --wallet <STX_ADDRESS>");
  }
  // F8: Validate wallet address format before any fetch or URL construction
  if (wallet) {
    try { validateStxAddress(wallet); }
    catch (e) { outputError("INVALID_WALLET", String(e), "Provide a valid Stacks mainnet address (SP...)"); }
  }
  // F9: Validate amount string before parseFloat
  if (amount !== undefined) {
    if (!DECIMAL_AMOUNT_RE.test(amount))
      outputError("INVALID_AMOUNT_FORMAT", `--amount "${amount}" is not a valid positive decimal (e.g. 500 or 500.00)`, "Use a positive number with up to 8 decimal places.");
  }

  try {
    // ── Parallel data fetch ────────────────────────────────────────────────
    const [rate, enabled, cooldownSecs, usdhSup, susdhSup, poolData, activeBin, siloTs] =
      await Promise.all([
        fetchExchangeRate(),
        fetchStakingEnabled(),
        fetchCooldownWindow(),
        fetchUsdhSupply(),
        fetchSusdhSupply(),
        fetchHodlmmPool(),
        fetchHodlmmActiveBin(),
        fetchCurrentSiloTs(),
      ]);

    // ── User position ──────────────────────────────────────────────────────
    let userUsdh:   bigint    = 0n;
    let userSusdh:  bigint    = 0n;
    let hodlmmBins: HodlmmBin[] = [];

    if (wallet) {
      const [bal, bins] = await Promise.all([
        fetchUserBalances(wallet),
        fetchHodlmmPosition(wallet),
      ]);
      userUsdh  = bal.usdh;
      userSusdh = bal.susdh;
      hodlmmBins = bins;
      // STX gas check: single fetch, reuse balance result already in hand
      if (writeActions.includes(action) && bal.stx < MIN_STX_GAS_USTX) {
        outputError(
          "INSUFFICIENT_GAS",
          `Wallet STX balance ${(Number(bal.stx) / 1_000_000).toFixed(6)} STX is below minimum ${Number(MIN_STX_GAS_USTX) / 1_000_000} STX required for transaction fees`,
          "Acquire STX for gas fees before executing write actions.",
        );
      }
    }

    // ── APY tracking via state ─────────────────────────────────────────────
    const prev   = readState();
    const nowIso = new Date().toISOString();
    let apyPct: number | null = null;
    try {
      if (prev.baseline_rate && prev.baseline_run_at) {
        const baseRate  = BigInt(prev.baseline_rate);
        const elapsedMs = Date.now() - new Date(prev.baseline_run_at).getTime();
        apyPct = estimateApy(rate, baseRate, elapsedMs);
      } else if (prev.last_exchange_rate && prev.last_run_at) {
        // Fallback to single-point until baseline window is established
        const prevRate  = BigInt(prev.last_exchange_rate);
        const elapsedMs = Date.now() - new Date(prev.last_run_at).getTime();
        apyPct = estimateApy(rate, prevRate, elapsedMs);
      }
    } catch { /* corrupted state — skip APY calculation safely */ }

    // ── Derived metrics ────────────────────────────────────────────────────
    const cooldownDays   = parseFloat((Number(cooldownSecs) / 86_400).toFixed(1));
    const hodlmmApr      = poolData?.apr ?? null;
    const hodlmmTvl      = poolData?.tvlUsd ?? null;
    const userUsdhHuman  = toHuman(userUsdh, USDH_DECIMALS);
    const userSusdhHuman = toHuman(userSusdh, USDH_DECIMALS);
    const userSusdhValue = toHuman((userSusdh * rate) / EXCHANGE_RATE_SCALE, USDH_DECIMALS);
    const hodlmmBinIds   = hodlmmBins.map((b) => b.binId);

    let yieldComparison: string | null = null;
    if (hodlmmApr !== null) {
      yieldComparison = apyPct !== null
        ? (apyPct >= hodlmmApr
            ? `USDh staking (${apyPct.toFixed(2)}% APY) ≥ HODLMM ${HODLMM_POOL} (${hodlmmApr.toFixed(2)}% APR) — staking preferred`
            : `HODLMM ${HODLMM_POOL} (${hodlmmApr.toFixed(2)}% APR) > USDh staking (${apyPct.toFixed(2)}% APY) — HODLMM preferred`)
        : `HODLMM ${HODLMM_POOL} APR: ${hodlmmApr.toFixed(2)}% | USDh staking APY: tracking started — check again in ≥1h`;
    }

    // Rotation cooldown
    const lastRotMs = prev.last_rotation_at ? new Date(prev.last_rotation_at).getTime() : 0;
    const rotCooldownRemaining = Math.max(0, ROTATION_COOLDOWN_MS - (Date.now() - lastRotMs));
    const canRotate = rotCooldownRemaining === 0;

    // ── ASSESS (default, read-only) ────────────────────────────────────────
    if (action === "assess") {
      const { baseline_run_at, baseline_rate } = updateBaseline(prev, nowIso, rate);
      writeState({
        last_run_at:           nowIso,
        last_exchange_rate:    rate.toString(),
        last_rotation_at:      prev.last_rotation_at ?? null,
        last_action:           prev.last_action ?? null,
        unstake_initiated_at:  prev.unstake_initiated_at ?? null,
        unstake_amount_raw:    prev.unstake_amount_raw ?? null,
        baseline_run_at,
        baseline_rate,
      });

      let recommendation: string;
      const refusalReasons: string[] = [];

      if (!enabled) {
        refusalReasons.push("staking disabled by protocol");
        recommendation = "HOLD — staking disabled. Do not stake until protocol re-enables it.";
      } else if (
        apyPct !== null && hodlmmApr !== null &&
        hodlmmApr > apyPct + ROTATE_THRESHOLD_PCT &&
        userSusdh > 0n
      ) {
        recommendation = `ROTATE_TO_HODLMM — HODLMM ${HODLMM_POOL} APR (${hodlmmApr.toFixed(2)}%) exceeds USDh staking APY (${apyPct.toFixed(2)}%) by >${ROTATE_THRESHOLD_PCT}%. Run --action=rotate --confirm to execute.`;
      } else if (
        apyPct !== null && hodlmmApr !== null &&
        apyPct > hodlmmApr + ROTATE_THRESHOLD_PCT &&
        hodlmmBinIds.length > 0
      ) {
        recommendation = `ROTATE_TO_STAKING — USDh staking APY (${apyPct.toFixed(2)}%) exceeds HODLMM APR (${hodlmmApr.toFixed(2)}%) by >${ROTATE_THRESHOLD_PCT}%. Run --action=rotate --confirm to execute.`;
      } else if (userUsdh > 0n && userSusdh === 0n && enabled) {
        recommendation = `STAKE — ${userUsdhHuman.toFixed(2)} USDh idle. Run --action=stake --confirm to stake full balance.`;
      } else if (userSusdh > 0n) {
        recommendation = `HOLD — ${userSusdhHuman.toFixed(2)} sUSDh staked (~$${userSusdhValue.toFixed(2)} USDh). Yield accruing.`;
      } else {
        recommendation = "CHECK — staking enabled, protocol healthy. Provide --wallet to check position.";
      }

      console.log(JSON.stringify({
        status: "success",
        action: recommendation,
        data: {
          staking_enabled:        enabled,
          exchange_rate:          parseFloat(toHuman(rate, USDH_DECIMALS).toFixed(8)),
          accumulated_yield_pct:  accumulatedYieldPct(rate),
          estimated_apy_pct:      apyPct,
          cooldown_days:          cooldownDays,
          usdh_total_supply:      parseFloat(toHuman(usdhSup, USDH_DECIMALS).toFixed(2)),
          susdh_total_supply:     parseFloat(toHuman(susdhSup, USDH_DECIMALS).toFixed(2)),
          hodlmm_apr_pct:         hodlmmApr,
          hodlmm_tvl_usd:         hodlmmTvl,
          hodlmm_active_bin:      activeBin,
          yield_comparison:       yieldComparison,
          user_usdh:              wallet ? parseFloat(userUsdhHuman.toFixed(2)) : null,
          user_susdh:             wallet ? parseFloat(userSusdhHuman.toFixed(2)) : null,
          user_susdh_value_usdh:  wallet ? parseFloat(userSusdhValue.toFixed(2)) : null,
          hodlmm_position_bins:   hodlmmBinIds.length > 0 ? hodlmmBinIds : null,
          rotation_cooldown_ok:   canRotate,
          rotate_threshold_pct:   ROTATE_THRESHOLD_PCT,
          refusal_reasons:        refusalReasons.length > 0 ? refusalReasons : null,
          silo_epoch_ts:          siloTs !== null ? Number(siloTs) : null,
        },
        error: null,
      }, null, 2));
      return;
    }

    // ── STAKE ──────────────────────────────────────────────────────────────
    if (action === "stake") {
      if (!enabled) outputError("STAKE_BLOCKED", "Staking is currently disabled by protocol", "Wait for protocol to re-enable staking.");

      // F1: Use string-based parseAmountToRaw to avoid IEEE 754 precision loss
      // Safety cap: autonomous default is capped at MAX_AUTONOMOUS_STAKE_USDH — pass --amount to exceed
      const amountRaw = amount
        ? parseAmountToRaw(amount, USDH_DECIMALS)
        : userUsdh < MAX_AUTONOMOUS_STAKE_RAW ? userUsdh : MAX_AUTONOMOUS_STAKE_RAW;

      if (amountRaw <= 0n) outputError("INVALID_AMOUNT", "Amount must be > 0 USDh", "Pass --amount=<usdh> or ensure wallet has USDh balance.");
      if (wallet && amountRaw > userUsdh) outputError("INSUFFICIENT_BALANCE", `Amount ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} USDh exceeds wallet balance ${userUsdhHuman.toFixed(2)}`, "Reduce --amount or acquire more USDh.");

      const cmd = stakeCmd(amountRaw, wallet!, 1, rate);
      const { baseline_run_at, baseline_rate } = updateBaseline(prev, nowIso, rate);
      console.log(JSON.stringify({
        status: "success",
        action: `STAKE — ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} USDh queued. Execute MCP command to proceed.`,
        data: {
          mcp_commands:      [cmd],
          amount_usdh:       parseFloat(toHuman(amountRaw, USDH_DECIMALS).toFixed(2)),
          amount_raw:        amountRaw.toString(),
          estimated_apy_pct: apyPct,
          cooldown_days:     cooldownDays,
          hodlmm_apr_pct:    hodlmmApr,
          yield_comparison:  yieldComparison,
        },
        error: null,
      }, null, 2));
      writeState({ last_run_at: nowIso, last_exchange_rate: rate.toString(), last_rotation_at: prev.last_rotation_at ?? null, last_action: "stake", unstake_initiated_at: prev.unstake_initiated_at ?? null, unstake_amount_raw: prev.unstake_amount_raw ?? null, baseline_run_at, baseline_rate });
      return;
    }

    // ── INITIATE-UNSTAKE ───────────────────────────────────────────────────
    if (action === "initiate-unstake") {
      // F1: String-based conversion
      // Safety cap: autonomous default is capped at MAX_AUTONOMOUS_STAKE_USDH — pass --amount to exceed
      const amountRaw = amount
        ? parseAmountToRaw(amount, USDH_DECIMALS)
        : userSusdh < MAX_AUTONOMOUS_STAKE_RAW ? userSusdh : MAX_AUTONOMOUS_STAKE_RAW;

      if (amountRaw <= 0n) outputError("INVALID_AMOUNT", "Amount must be > 0 sUSDh", "Pass --amount=<susdh> or ensure wallet has sUSDh balance.");
      if (wallet && amountRaw > userSusdh) outputError("INSUFFICIENT_BALANCE", `Amount ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} sUSDh exceeds balance ${userSusdhHuman.toFixed(2)}`, "Reduce --amount.");

      const cmd = initiateUnstakeCmd(amountRaw, wallet!, cooldownDays, 1);

      const { baseline_run_at, baseline_rate } = updateBaseline(prev, nowIso, rate);
      console.log(JSON.stringify({
        status: "success",
        action: `INITIATE_UNSTAKE — ${toHuman(amountRaw, USDH_DECIMALS).toFixed(2)} sUSDh queued for unstake. ${cooldownDays}-day cooldown begins on execution. Run --action=complete-unstake after cooldown.`,
        data: {
          mcp_commands:  [cmd],
          amount_susdh:  parseFloat(toHuman(amountRaw, USDH_DECIMALS).toFixed(2)),
          amount_raw:    amountRaw.toString(),
          cooldown_days: cooldownDays,
          ready_after:   `~${cooldownDays} days after execution`,
        },
        error: null,
      }, null, 2));
      writeState({
        last_run_at:           nowIso,
        last_exchange_rate:    rate.toString(),
        last_rotation_at:      prev.last_rotation_at ?? null,
        last_action:           "initiate-unstake",
        unstake_initiated_at:  nowIso,                // record when cooldown starts
        unstake_amount_raw:    amountRaw.toString(),   // record how much was submitted
        baseline_run_at,
        baseline_rate,
      });
      return;
    }

    // ── COMPLETE-UNSTAKE ───────────────────────────────────────────────────
    if (action === "complete-unstake") {
      // Guard: verify cooldown has elapsed since initiate-unstake
      if (prev.unstake_initiated_at) {
        const initiatedAt  = new Date(prev.unstake_initiated_at).getTime();
        const cooldownMs   = Number(cooldownSecs) * 1000;
        const remainingMs  = cooldownMs - (Date.now() - initiatedAt);
        if (remainingMs > 0) {
          const remainDays = (remainingMs / 86_400_000).toFixed(1);
          const readyAt    = new Date(initiatedAt + cooldownMs).toISOString();
          outputError(
            "COOLDOWN_NOT_ELAPSED",
            `Unstake cooldown not elapsed — ${remainDays} day(s) remaining. Ready at ${readyAt}`,
            `Wait until ${readyAt} before running complete-unstake.`,
          );
        }
      }

      // Compute expected minimum USDh from tracked unstake amount × current exchange rate (1% slippage)
      const minUsdhRaw = (prev.unstake_amount_raw && rate > 0n)
        ? BigInt(prev.unstake_amount_raw) * rate * 99n / (EXCHANGE_RATE_SCALE * 100n)
        : 1n;

      const cmd = completeUnstakeCmd(wallet!, 1, minUsdhRaw > 0n ? minUsdhRaw : 1n);

      const { baseline_run_at, baseline_rate } = updateBaseline(prev, nowIso, rate);
      console.log(JSON.stringify({
        status: "success",
        action: "COMPLETE_UNSTAKE — Redeem USDh from completed cooldown. Execute MCP command to proceed.",
        data: {
          mcp_commands:    [cmd],
          min_usdh_expected: prev.unstake_amount_raw
            ? parseFloat(toHuman(minUsdhRaw, USDH_DECIMALS).toFixed(8))
            : null,
          note: "Post-condition enforces minimum USDh return based on tracked unstake amount and current exchange rate.",
        },
        error: null,
      }, null, 2));
      writeState({
        last_run_at:           nowIso,
        last_exchange_rate:    rate.toString(),
        last_rotation_at:      prev.last_rotation_at ?? null,
        last_action:           "complete-unstake",
        unstake_initiated_at:  null,   // clear — unstake completed
        unstake_amount_raw:    null,
        baseline_run_at,
        baseline_rate,
      });
      return;
    }

    // ── ROTATE ─────────────────────────────────────────────────────────────
    if (action === "rotate") {
      if (!canRotate) {
        const remainMin = Math.ceil(rotCooldownRemaining / 60_000);
        outputError("ROTATION_COOLDOWN", `Rotation cooldown active — ${remainMin} min remaining`, "Wait for cooldown to clear before rotating.");
      }
      if (apyPct === null || hodlmmApr === null) {
        outputError("INSUFFICIENT_YIELD_DATA", "Cannot rotate without both USDh APY and HODLMM APR data. APY requires ≥1h of exchange rate observations.", "Run in assess mode for ≥1h, then retry --action=rotate.");
      }

      const diff = Math.abs(hodlmmApr - apyPct);
      if (diff < ROTATE_THRESHOLD_PCT) {
        console.log(JSON.stringify({
          status: "success",
          action: `HOLD — yield differential ${diff.toFixed(2)}% is below ${ROTATE_THRESHOLD_PCT}% rotation threshold. No rotation warranted.`,
          data: {
            hodlmm_apr_pct:    hodlmmApr,
            estimated_apy_pct: apyPct,
            differential_pct:  parseFloat(diff.toFixed(2)),
            threshold_pct:     ROTATE_THRESHOLD_PCT,
            yield_comparison:  yieldComparison,
          },
          error: null,
        }, null, 2));
        return;
      }

      const cmds: McpCommand[] = [];
      let rotateAction: string;
      let nextStep = 1;

      // Safety cap for rotate: autonomous rotate is capped at MAX_AUTONOMOUS_STAKE_USDH per operation
      const rotateSusdhCapped = userSusdh < MAX_AUTONOMOUS_STAKE_RAW ? userSusdh : MAX_AUTONOMOUS_STAKE_RAW;
      const rotateUsdhCapped  = userUsdh  < MAX_AUTONOMOUS_STAKE_RAW ? userUsdh  : MAX_AUTONOMOUS_STAKE_RAW;
      const rotateSusdhCappedHuman = toHuman(rotateSusdhCapped, USDH_DECIMALS);
      const rotateUsdhCappedHuman  = toHuman(rotateUsdhCapped,  USDH_DECIMALS);
      const capNote = (userSusdh > MAX_AUTONOMOUS_STAKE_RAW || userUsdh > MAX_AUTONOMOUS_STAKE_RAW)
        ? ` (capped at ${MAX_AUTONOMOUS_STAKE_USDH} USDh — use --action=stake --amount=X or --action=initiate-unstake --amount=X for larger positions)`
        : "";

      if (hodlmmApr > apyPct + ROTATE_THRESHOLD_PCT) {
        // ── HODLMM wins ────────────────────────────────────────────────────
        if (rotateSusdhCapped > 0n) {
          cmds.push(initiateUnstakeCmd(rotateSusdhCapped, wallet!, cooldownDays, nextStep++));
          rotateAction = `ROTATE_TO_HODLMM — HODLMM APR (${hodlmmApr.toFixed(2)}%) beats staking APY (${apyPct.toFixed(2)}%) by ${(hodlmmApr - apyPct).toFixed(2)}%. Step 1: initiate unstake of ${rotateSusdhCappedHuman.toFixed(2)} sUSDh${capNote}. After ${cooldownDays}-day cooldown, run --action=complete-unstake then --action=rotate again to deploy to HODLMM.`;
        } else if (rotateUsdhCapped > 0n && activeBin !== null) {
          cmds.push(swapUsdhToUsdcxCmd(rotateUsdhCappedHuman, nextStep++));
          cmds.push(addLiquidityCmd(rotateUsdhCappedHuman, activeBin, nextStep++));
          rotateAction = `ROTATE_TO_HODLMM — idle ${rotateUsdhCappedHuman.toFixed(2)} USDh swapped to USDCx then deployed to HODLMM ${HODLMM_POOL} around active bin ${activeBin}${capNote}. HODLMM APR (${hodlmmApr.toFixed(2)}%) > staking APY (${apyPct.toFixed(2)}%).`;
        } else {
          rotateAction = `ROTATE_TO_HODLMM — recommended but no deployable position found. Acquire USDh or wait for unstake cooldown.`;
        }
      } else {
        // ── Staking wins ───────────────────────────────────────────────────
        if (hodlmmBinIds.length > 0) {
          // F6: Remove HODLMM first, then stake idle USDh only.
          cmds.push(removeLiquidityCmd(hodlmmBinIds, nextStep++));
          if (rotateUsdhCapped > 0n) cmds.push(stakeCmd(rotateUsdhCapped, wallet!, nextStep++, rate));
          const extraNote = rotateUsdhCapped > 0n
            ? ` Step 2 stakes pre-existing idle ${rotateUsdhCappedHuman.toFixed(2)} USDh${capNote}. After step 1 settles, re-run --action=stake to stake USDh received from LP removal.`
            : ` No idle USDh to stake now. After step 1 settles, re-run --action=stake to stake USDh received from LP removal.`;
          rotateAction = `ROTATE_TO_STAKING — USDh staking APY (${apyPct.toFixed(2)}%) beats HODLMM APR (${hodlmmApr.toFixed(2)}%) by ${(apyPct - hodlmmApr).toFixed(2)}%. Step 1: remove HODLMM bins [${hodlmmBinIds.join(", ")}].${extraNote}`;
        } else if (rotateUsdhCapped > 0n) {
          cmds.push(stakeCmd(rotateUsdhCapped, wallet!, nextStep++, rate));
          rotateAction = `ROTATE_TO_STAKING — idle ${rotateUsdhCappedHuman.toFixed(2)} USDh staked in Hermetica${capNote}. Staking APY (${apyPct.toFixed(2)}%) > HODLMM APR (${hodlmmApr.toFixed(2)}%).`;
        } else {
          rotateAction = `ROTATE_TO_STAKING — recommended but no deployable position found. Acquire USDh first.`;
        }
      }

      const { baseline_run_at, baseline_rate } = updateBaseline(prev, nowIso, rate);
      console.log(JSON.stringify({
        status: "success",
        action: rotateAction,
        data: {
          mcp_commands:        cmds.length > 0 ? cmds : null,
          hodlmm_apr_pct:      hodlmmApr,
          estimated_apy_pct:   apyPct,
          differential_pct:    parseFloat(diff.toFixed(2)),
          threshold_pct:       ROTATE_THRESHOLD_PCT,
          yield_comparison:    yieldComparison,
          user_usdh:           parseFloat(userUsdhHuman.toFixed(2)),
          user_susdh:          parseFloat(userSusdhHuman.toFixed(2)),
          hodlmm_bins_acted:   hodlmmBinIds.length > 0 ? hodlmmBinIds : null,
          hodlmm_active_bin:   activeBin,
          cooldown_days:       cooldownDays,
        },
        error: null,
      }, null, 2));
      writeState({
        last_run_at:           nowIso,
        last_exchange_rate:    rate.toString(),
        last_rotation_at:      cmds.length > 0 ? nowIso : prev.last_rotation_at ?? null,
        last_action:           "rotate",
        unstake_initiated_at:  cmds.some(c => c.tool === "call_contract" && c.params.function_name === "initiate-unstake")
          ? nowIso
          : prev.unstake_initiated_at ?? null,
        unstake_amount_raw:    cmds.some(c => c.tool === "call_contract" && c.params.function_name === "initiate-unstake")
          ? rotateSusdhCapped.toString()
          : prev.unstake_amount_raw ?? null,
        baseline_run_at,
        baseline_rate,
      });
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isWrite = writeActions.includes(action);
    console.error(JSON.stringify({
      status: "error",
      action: `Error: ${msg}`,
      data:   null,
      error:  {
        code:    isWrite ? "PREFLIGHT_FAILED" : "FETCH_ERROR",
        message: msg,
        next:    isWrite
          ? "Run the 'doctor' command to diagnose connectivity, then retry."
          : "Check network connectivity and retry.",
      },
    }, null, 2));
    process.exit(1);
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();
program
  .name("hermetica-yield-rotator")
  .description("Cross-protocol yield rotator: Hermetica USDh staking ↔ Bitflow HODLMM dlmm_1");

program
  .command("doctor")
  .description("Check all data sources are reachable")
  .action(() => doctor().catch((e: unknown) => { console.error(e); process.exit(1); }));

program
  .command("install-packs")
  .description("Install required skill packs (none needed)")
  .option("--pack <pack>")
  .action(() => installPacks());

program
  .command("run")
  .description("Assess yield allocation or execute rotation action")
  .option("--wallet <address>",  "STX wallet address")
  .option("--action <action>",   "assess|stake|initiate-unstake|complete-unstake|rotate (default: assess)")
  .option("--amount <usdh>",     "Human-readable USDh/sUSDh amount (e.g. 500). Omit to use full balance.")
  .option("--confirm",           "Required for write actions")
  .action((opts: { wallet?: string; action?: string; amount?: string; confirm?: boolean }) =>
    run(opts).catch((e: unknown) => { console.error(e); process.exit(1); }),
  );

program.parse(process.argv);
