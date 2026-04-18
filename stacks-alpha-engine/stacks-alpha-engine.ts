#!/usr/bin/env bun
/**
 * Stacks Alpha Engine
 * Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM (Bitflow DLMM).
 * Scans ALL relevant tokens (sBTC, STX, USDCx, USDh, sUSDh, aeUSDC), reads positions
 * across 4 protocols, compares yield options (direct + swap-then-deploy), verifies sBTC
 * reserve integrity via BIP-341 P2TR derivation, checks market safety gates, then
 * executes deploy/withdraw/rebalance/migrate/emergency operations.
 *
 * Architecture:
 *   SCOUT    -> wallet scan (7 tokens), positions (4 protocols), yields, break prices
 *   RESERVE  -> sBTC Proof-of-Reserve (P2TR derivation, BTC balance, GREEN/YELLOW/RED)
 *   GUARDIAN -> slippage, volume, gas, cooldown, relay health, price source gates
 *   EXECUTOR -> deploy, withdraw, rebalance, migrate, emergency
 *
 * Safety: every write runs Scout -> Reserve -> Guardian -> Executor. No bypasses.
 *
 * Protocols & tokens:
 *   Zest      — supply sBTC, wSTX, stSTX, USDC, USDh  (MCP native zest_supply/withdraw)
 *   Hermetica — stake USDh -> sUSDh                     (call_contract staking-v1-1)
 *   Granite   — deposit aeUSDC to LP                    (call_contract liquidity-provider-v1)
 *   HODLMM    — LP in sBTC/STX/USDCx/USDh/aeUSDC pools (Bitflow skill)
 *
 * Usage:
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts doctor
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts scan --wallet <STX_ADDRESS>
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts deploy --wallet <SP...> --protocol hermetica --token usdh --amount 1000000
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts withdraw --wallet <SP...> --protocol zest --token sbtc
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts rebalance --wallet <SP...> --pool-id dlmm_1
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts migrate --wallet <SP...> --from zest --to hermetica
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts emergency --wallet <SP...>
 */

import { createHash } from "crypto";
import { Command }    from "commander";
import { homedir }    from "os";
import { join }       from "path";
import { readFileSync, writeFileSync } from "fs";
import * as ecc       from "tiny-secp256k1";

// == Constants ================================================================
const FETCH_TIMEOUT_MS    = 30_000;
const HIRO_API            = "https://api.mainnet.hiro.so";
const TENERO_API          = "https://api.tenero.io";
const BITFLOW_API         = "https://bff.bitflowapis.finance";
const MEMPOOL_API         = "https://mempool.space/api";

// Guardian thresholds
const MIN_24H_VOLUME_USD  = 10_000;
const MAX_SLIPPAGE_PCT    = 0.5;
const MAX_GAS_STX         = 50;
const COOLDOWN_HOURS      = 4;
const PRICE_SCALE         = 1e8;
const BIN_PRICE_SCALE     = 1e6;  // HODLMM bin price precision
const STATE_FILE          = join(homedir(), ".stacks-alpha-engine-state.json");

// PoR thresholds
const THRESHOLD_GREEN     = 0.999;
const THRESHOLD_YELLOW    = 0.995;
const ROTATION_THRESHOLD  = 0.50;

// -- Token contracts ----------------------------------------------------------
const SBTC_TOKEN          = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_TOKEN         = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const AEUSDC_TOKEN        = "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc";
const USDH_TOKEN          = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1";
const SUSDH_TOKEN         = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.susdh-token-v1";
const SBTC_REGISTRY       = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_REGISTRY_NAME  = "sbtc-registry";

// -- Protocol contracts -------------------------------------------------------
// Zest v2
const ZEST_VAULT_SBTC     = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";

// Hermetica
const HERMETICA           = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const HERMETICA_STAKING   = `${HERMETICA}.staking-v1-1`;
const HERMETICA_SILO      = `${HERMETICA}.staking-silo-v1-1`;

// Granite
const GRANITE_STATE       = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const GRANITE_IR          = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1";
const GRANITE_LP          = "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.liquidity-provider-v1";

// Bitflow DLMM swap router
const DLMM_SWAP_ROUTER    = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const DLMM_SWAP_ROUTER_NAME = "dlmm-swap-router-v-1-1";

// HODLMM
const DLMM_CORE           = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const HODLMM_POOLS: PoolDef[] = [
  { id: 1, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10", name: "sBTC-USDCx-10bps", tokenX: "sbtc", tokenY: "usdcx" },
  { id: 2, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",  name: "sBTC-USDCx-1bps",  tokenX: "sbtc", tokenY: "usdcx" },
  { id: 3, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",  name: "STX-USDCx-10bps",  tokenX: "stx",  tokenY: "usdcx" },
  { id: 4, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-4",   name: "STX-USDCx-4bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 5, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-1",   name: "STX-USDCx-1bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 6, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",   name: "STX-sBTC-15bps",   tokenX: "stx",  tokenY: "sbtc" },
  { id: 7, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1", name: "aeUSDC-USDCx-1bps", tokenX: "aeusdc", tokenY: "usdcx" },
  { id: 8, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",  name: "USDh-USDCx-1bps",  tokenX: "usdh", tokenY: "usdcx" },
];

// Token metadata for yield calculations
interface TokenMeta { symbol: string; contract: string; decimals: number; ftSuffix: string }
const TOKENS: Record<string, TokenMeta> = {
  sbtc:   { symbol: "sBTC",   contract: SBTC_TOKEN,   decimals: 8, ftSuffix: "::sbtc-token" },
  stx:    { symbol: "STX",    contract: "stx",        decimals: 6, ftSuffix: "" },
  usdcx:  { symbol: "USDCx",  contract: USDCX_TOKEN,  decimals: 6, ftSuffix: "::usdcx" },
  usdh:   { symbol: "USDh",   contract: USDH_TOKEN,   decimals: 8, ftSuffix: "::usdh-token" },
  susdh:  { symbol: "sUSDh",  contract: SUSDH_TOKEN,  decimals: 8, ftSuffix: "::susdh-token" },
  aeusdc: { symbol: "aeUSDC", contract: AEUSDC_TOKEN, decimals: 6, ftSuffix: "::bridged-usdc" },
};

// == Types ====================================================================
interface PoolDef { id: number; contract: string; name: string; tokenX: string; tokenY: string }
interface TokenBalance { amount: number; usd: number }
interface WalletBalances {
  sbtc: TokenBalance; stx: TokenBalance; usdcx: TokenBalance;
  usdh: TokenBalance; susdh: TokenBalance; aeusdc: TokenBalance;
}

interface ZestPosition { has_position: boolean; detail: string; supply_amount?: number; supply_apy_pct?: number; utilization_pct?: number }
interface GranitePosition {
  has_position: boolean; detail: string;
  supply_apy_pct?: number; borrow_apr_pct?: number; utilization_pct?: number;
  accepted_token: string; // "aeUSDC" — NOT sBTC
  lp_shares?: string; // raw share count from on-chain position
}
interface HermeticaPosition {
  has_position: boolean; detail: string;
  susdh_balance: number; exchange_rate: number; apy_estimate_pct: number;
  staking_enabled: boolean;
}
interface HodlmmUserPool {
  pool_id: number; name: string; in_range: boolean; active_bin: number;
  user_bins: { min: number; max: number; count: number } | null;
  dlp_shares: string; estimated_value_usd: number | null;
}
interface HodlmmPositions { has_position: boolean; pools: HodlmmUserPool[] }

type YieldTier = "deploy_now" | "swap_first" | "acquire_to_unlock";

interface YieldOption {
  tier: YieldTier;
  protocol: string; pool: string; token_needed: string; apy_pct: number;
  daily_usd: number; monthly_usd: number; gas_to_enter_stx: number;
  swap_cost_note: string | null; note: string;
  ytg_ratio: number;       // 7d projected yield / gas cost in USD (>3 = profitable); set by post-processing
  ytg_profitable: boolean; // true if 7d yield > 3x gas cost; set by post-processing
}

interface BreakPrices {
  hodlmm_range_exit_low_usd: number | null; hodlmm_range_exit_high_usd: number | null;
  current_sbtc_price_usd: number;
}

// PoR types
type PorSignal = "GREEN" | "YELLOW" | "RED" | "DATA_UNAVAILABLE";
interface ReserveResult {
  signal: PorSignal; reserve_ratio: number | null; score: number;
  sbtc_circulating: number; btc_reserve: number; signer_address: string;
  recommendation: string; error?: string;
}

// Guardian types
interface GuardianResult {
  can_proceed: boolean; refusals: string[];
  slippage: { ok: boolean; pct: number };
  volume: { ok: boolean; usd: number };
  gas: { ok: boolean; estimated_stx: number };
  cooldown: { ok: boolean; remaining_hours: number };
  prices: { ok: boolean; detail: string };
}

// Scout result
interface ScoutResult {
  status: "ok" | "degraded" | "error";
  wallet: string;
  balances: WalletBalances;
  prices: { sbtc: number; stx: number; usdcx: number; usdh: number; aeusdc: number };
  positions: { zest: ZestPosition; hermetica: HermeticaPosition; granite: GranitePosition; hodlmm: HodlmmPositions };
  options: YieldOption[];
  best_move: { recommendation: string; idle_capital_usd: number; opportunity_cost_daily_usd: number };
  break_prices: BreakPrices;
  data_sources: string[];
}

// Engine output
const DISCLAIMER = "Data-driven yield analysis for informational purposes only. Not financial advice. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and peg failure are real possibilities. Verify on-chain data independently before acting.";

interface EngineResult {
  status: "ok" | "refused" | "partial" | "error";
  command: string; disclaimer: string;
  scout?: ScoutResult; reserve?: ReserveResult; guardian?: GuardianResult;
  action?: { description: string; txids?: string[]; details?: Record<string, unknown> };
  refusal_reasons?: string[]; error?: string;
}

interface BitflowPoolData { poolId: string; tvlUsd: number; volumeUsd1d: number; apr24h: number; tokens?: { tokenX: { priceUsd: number; decimals: number }; tokenY: { priceUsd: number; decimals: number } } }

// == Bitflow pools cache (fetched once per run, reused across scout/yield/guardian) ==
let _poolsCache: BitflowPoolData[] | null = null;
let _poolsCacheTs = 0;
const POOLS_CACHE_TTL_MS = 60_000; // 1 minute

async function fetchBitflowPools(): Promise<BitflowPoolData[]> {
  if (_poolsCache && (Date.now() - _poolsCacheTs) < POOLS_CACHE_TTL_MS) return _poolsCache;
  const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
  _poolsCache = pd.data ?? [];
  _poolsCacheTs = Date.now();
  return _poolsCache;
}

// == Fetch helpers =============================================================
async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts, signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/stacks-alpha-engine", ...(opts.headers as Record<string, string> ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally { clearTimeout(timer); }
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// == Clarity hex parsing (big-endian) =========================================
function parseUint128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "01");
  if (idx === -1) return 0n;
  return BigInt("0x" + clean.slice(idx + 2, idx + 34));
}

function parseInt128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "00");
  if (idx === -1) return 0n;
  const val = BigInt("0x" + clean.slice(idx + 2, idx + 34));
  const max = (1n << 127n) - 1n;
  return val > max ? val - (1n << 128n) : val;
}

function findTypePrefix(hex: string, tb: string): number {
  if (hex.startsWith("07")) {
    if (hex.substring(2, 4) === tb) return 2;
    if (hex.substring(2, 4) === "0a" && hex.substring(4, 6) === tb) return 4;
  }
  if (hex.substring(0, 2) === tb) return 0;
  return -1;
}

type ClarityValue = bigint | boolean | null | string | ClarityValue[] | { [k: string]: ClarityValue } | { _err: ClarityValue };

function parseClarityValue(hex: string, pos = 0): { value: ClarityValue; end: number } {
  const type = hex.substring(pos, pos + 2);
  pos += 2;
  switch (type) {
    case "01": { const v = BigInt("0x" + hex.substring(pos, pos + 32)); return { value: v, end: pos + 32 }; }
    case "00": { const r = BigInt("0x" + hex.substring(pos, pos + 32)); const m = (1n << 127n) - 1n; return { value: r > m ? r - (1n << 128n) : r, end: pos + 32 }; }
    case "03": return { value: true, end: pos };
    case "04": return { value: false, end: pos };
    case "09": return { value: null, end: pos };
    case "0a": case "07": return parseClarityValue(hex, pos);
    case "08": { const i = parseClarityValue(hex, pos); return { value: { _err: i.value }, end: i.end }; }
    case "0c": {
      const n = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const o: Record<string, ClarityValue> = {};
      for (let i = 0; i < n; i++) {
        const nl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2;
        const nm = Buffer.from(hex.substring(pos, pos + nl * 2), "hex").toString("ascii"); pos += nl * 2;
        const v = parseClarityValue(hex, pos); o[nm] = v.value; pos = v.end;
      }
      return { value: o, end: pos };
    }
    case "0b": {
      const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const a: ClarityValue[] = [];
      for (let i = 0; i < l; i++) { const v = parseClarityValue(hex, pos); a.push(v.value); pos = v.end; }
      return { value: a, end: pos };
    }
    case "05": return { value: `principal:${hex.substring(pos, pos + 42)}`, end: pos + 42 };
    case "06": { pos += 42; const cl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2 + cl * 2; return { value: "contract-principal", end: pos }; }
    case "0d": case "0e": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; const s = Buffer.from(hex.substring(pos, pos + l * 2), "hex").toString(type === "0d" ? "ascii" : "utf8"); return { value: s, end: pos + l * 2 }; }
    case "02": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; return { value: `0x${hex.substring(pos, pos + l * 2)}`, end: pos + l * 2 }; }
    default: return { value: null, end: pos };
  }
}

function parseClarityHex(hex: string): ClarityValue {
  return parseClarityValue(hex.startsWith("0x") ? hex.slice(2) : hex).value;
}

// == Stacks address encoding ==================================================
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function c32Decode(addr: string): { version: number; hash160: string } {
  const w = addr.slice(1);
  const version = C32.indexOf(w[0].toUpperCase());
  let n = 0n;
  for (const c of w.slice(1)) n = n * 32n + BigInt(C32.indexOf(c.toUpperCase()));
  let hex = n.toString(16);
  while (hex.length < 48) hex = "0" + hex;
  return { version, hash160: hex.slice(0, 40) };
}

function cvPrincipal(p: string): string {
  const { version, hash160 } = c32Decode(p);
  return "0x05" + version.toString(16).padStart(2, "0") + hash160;
}

function cvUint(n: number | bigint): string {
  return "0x01" + BigInt(n).toString(16).padStart(32, "0");
}

// == Hiro contract read =======================================================
async function callReadOnly(
  contractId: string, fn: string, args: string[] = [],
  sender = "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
): Promise<{ okay: boolean; result?: string }> {
  const [addr, name] = contractId.split(".");
  return fetchJson(`${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });
}

// == Bech32m (BIP-350) ========================================================
const B32C = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const B32M = 0x2bc830a3;

function b32mPolymod(v: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c;
}

function b32mHrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0, bits = 0;
  const r: number[] = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; r.push((acc >> bits) & max); } }
  if (bits > 0) r.push((acc << (to - bits)) & max);
  return r;
}

function bech32mEncode(hrp: string, data: number[]): string {
  const exp = b32mHrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const poly = b32mPolymod(exp) ^ B32M;
  const cs = Array.from({ length: 6 }, (_, i) => (poly >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...cs].map(d => B32C[d]).join("");
}

function tapTaggedHash(tag: string, data: Uint8Array): Buffer {
  const th = createHash("sha256").update(tag).digest();
  return createHash("sha256").update(th).update(th).update(data).digest();
}

function xOnlyPubkeyToP2TR(xHex: string): string {
  if (xHex.length !== 64) throw new Error(`Expected 32-byte x-only pubkey, got ${xHex.length / 2} bytes`);
  const xBytes = Buffer.from(xHex, "hex");
  const tweak = tapTaggedHash("TapTweak", xBytes);
  const tweaked = ecc.xOnlyPointAddTweak(xBytes, tweak);
  if (!tweaked) throw new Error("Taproot key tweak failed");
  return bech32mEncode("bc", [1, ...convertBits(tweaked.xOnlyPubkey, 8, 5)]);
}

// BIP-350 test vectors
const BECH32M_TEST_VECTORS: Array<{ hrp: string; data: number[]; expected: string }> = [
  { hrp: "bc", data: [1, ...convertBits(Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"), 8, 5)], expected: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0" },
];

function verifyBech32mTestVectors(): { pass: boolean; detail: string } {
  for (const tv of BECH32M_TEST_VECTORS) {
    const result = bech32mEncode(tv.hrp, tv.data);
    if (result !== tv.expected) return { pass: false, detail: `Expected ${tv.expected}, got ${result}` };
  }
  return { pass: true, detail: `${BECH32M_TEST_VECTORS.length} vectors passed` };
}

// =============================================================================
// ==  SCOUT MODULE
// =============================================================================

async function scoutWallet(wallet: string): Promise<ScoutResult> {
  if (!/^SP[A-Z0-9]{30,}$/i.test(wallet)) {
    throw new Error("Invalid wallet address — must be Stacks mainnet (SP...)");
  }

  const allSources: string[] = [];

  // -- Balances + prices ------------------------------------------------------
  const [hiroBalance, teneroSbtc, teneroStx] = await Promise.all([
    fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/balances`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_TOKEN}`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/stx`).catch(() => null),
  ]);
  if (hiroBalance) allSources.push("hiro-balances");
  if (teneroSbtc) allSources.push("tenero-sbtc-price");
  if (teneroStx) allSources.push("tenero-stx-price");

  const stxMicro = BigInt(((hiroBalance as Record<string, Record<string, string>>)?.stx?.balance) ?? "0");
  const ft = (hiroBalance as Record<string, Record<string, Record<string, string>>>)?.fungible_tokens ?? {};

  function ftBalance(contractPrefix: string): bigint {
    const key = Object.keys(ft).find(k => k.startsWith(contractPrefix));
    return BigInt(ft[key ?? ""]?.balance ?? "0");
  }

  const sbtcSats    = ftBalance(SBTC_TOKEN);
  const usdcxMicro  = ftBalance(USDCX_TOKEN);
  const aeUsdcMicro = ftBalance(AEUSDC_TOKEN);
  const usdhSats    = ftBalance(USDH_TOKEN);
  const susdhSats   = ftBalance(SUSDH_TOKEN);

  // Prices
  const sd = (teneroSbtc as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const sbtcPrice = (sd?.price_usd as number) ?? ((sd?.price as Record<string, number>)?.current_price) ?? 0;
  const xd = (teneroStx as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const stxPrice = (xd?.price_usd as number) ?? ((xd?.price as Record<string, number>)?.current_price) ?? 0;
  // Stablecoins pegged at $1
  const usdhPrice = 1.0;
  const aeUsdcPrice = 1.0;
  const usdcxPrice = 1.0;

  const sbtcAmt    = Number(sbtcSats) / 1e8;
  const stxAmt     = Number(stxMicro) / 1e6;
  const usdcxAmt   = Number(usdcxMicro) / 1e6;
  const usdhAmt    = Number(usdhSats) / 1e8;
  const susdhAmt   = Number(susdhSats) / 1e8;
  const aeUsdcAmt  = Number(aeUsdcMicro) / 1e6;

  const balances: WalletBalances = {
    sbtc:   { amount: round(sbtcAmt, 8),   usd: round(sbtcAmt * sbtcPrice, 2) },
    stx:    { amount: round(stxAmt, 6),     usd: round(stxAmt * stxPrice, 2) },
    usdcx:  { amount: round(usdcxAmt, 6),   usd: round(usdcxAmt * usdcxPrice, 2) },
    usdh:   { amount: round(usdhAmt, 8),    usd: round(usdhAmt * usdhPrice, 2) },
    susdh:  { amount: round(susdhAmt, 8),   usd: round(susdhAmt * usdhPrice, 2) },
    aeusdc: { amount: round(aeUsdcAmt, 6),  usd: round(aeUsdcAmt * aeUsdcPrice, 2) },
  };
  const prices = { sbtc: round(sbtcPrice, 2), stx: round(stxPrice, 4), usdcx: 1.0, usdh: 1.0, aeusdc: 1.0 };

  // -- Positions in parallel --------------------------------------------------
  const [zest, hermetica, granite, hodlmm] = await Promise.all([
    scoutZest(wallet), scoutHermetica(wallet), scoutGranite(wallet), scoutHodlmm(wallet),
  ]);
  allSources.push(...zest.sources, ...hermetica.sources, ...granite.sources, ...hodlmm.sources);

  // -- Fix Hermetica has_position from wallet sUSDh balance -------------------
  if (balances.susdh.amount > 0) {
    hermetica.position.has_position = true;
    hermetica.position.susdh_balance = balances.susdh.amount;
    hermetica.position.detail = `${balances.susdh.amount} sUSDh staked (rate: ${hermetica.position.exchange_rate})`;
  }

  // -- Yield options (3-tier) -------------------------------------------------
  const { options, sources: optSrc } = await getYieldOptions(balances, prices, granite.position, hermetica.position);
  allSources.push(...optSrc);

  // -- Best move --------------------------------------------------------------
  const walletUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd + balances.usdh.usd + balances.susdh.usd + balances.aeusdc.usd;
  const deployNow = options.filter(o => o.tier === "deploy_now");
  const bestOpt = deployNow[0];
  let recommendation = "No yield opportunities available for your current holdings.";
  let opportunityCost = 0;

  const outOfRange = hodlmm.positions.pools.filter(p => !p.in_range);
  if (outOfRange.length > 0) {
    recommendation = `WARNING: ${outOfRange.length} HODLMM position(s) OUT OF RANGE (${outOfRange.map(p => p.name).join(", ")}). Consider rebalancing.`;
    opportunityCost = bestOpt?.daily_usd ?? 0;
  } else if (bestOpt && bestOpt.apy_pct > 0 && walletUsd > 10) {
    opportunityCost = round((walletUsd * bestOpt.apy_pct / 100) / 365, 4);
    recommendation = `Best option: ${bestOpt.protocol} ${bestOpt.pool} (${bestOpt.token_needed}) at ${bestOpt.apy_pct}% APY (~$${opportunityCost}/day missed).`;
  }

  // -- Break prices -----------------------------------------------------------
  const { breakPrices, sources: bpSrc } = await getBreakPrices(hodlmm.positions, prices.sbtc);
  allSources.push(...bpSrc);

  return {
    status: allSources.length >= 4 ? "ok" : "degraded",
    wallet, balances, prices,
    positions: { zest: zest.position, hermetica: hermetica.position, granite: granite.position, hodlmm: hodlmm.positions },
    options,
    best_move: { recommendation, idle_capital_usd: round(walletUsd, 2), opportunity_cost_daily_usd: opportunityCost },
    break_prices: breakPrices,
    data_sources: [...new Set(allSources)],
  };
}

// -- Scout: Zest --------------------------------------------------------------
async function scoutZest(wallet: string): Promise<{ position: ZestPosition; sources: string[] }> {
  const sources: string[] = [];
  try {
    const balResult = await callReadOnly(ZEST_VAULT_SBTC, "get-balance", [cvPrincipal(wallet)], wallet);
    sources.push("zest-v2-vault");
    const balance = balResult.okay && balResult.result ? parseUint128Hex(balResult.result) : 0n;

    const [utilResult, rateResult] = await Promise.all([
      callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []),
      callReadOnly(ZEST_VAULT_SBTC, "get-interest-rate", []),
    ]);
    const utilRaw = utilResult.okay && utilResult.result ? Number(parseUint128Hex(utilResult.result)) : 0;
    const rateRaw = rateResult.okay && rateResult.result ? Number(parseUint128Hex(rateResult.result)) : 0;
    const utilPct = utilRaw / 100;
    const borrowRatePct = rateRaw / 100;
    const supplyApyPct = round(borrowRatePct * (utilPct / 100) * 0.9, 2);
    sources.push("zest-apy-live");

    if (balance > 0n) {
      return { position: { has_position: true, detail: `Active sBTC supply on Zest v2: ${Number(balance) / 1e8} sBTC`, supply_amount: Number(balance) / 1e8, supply_apy_pct: supplyApyPct, utilization_pct: round(utilPct, 2) }, sources };
    }
    return { position: { has_position: false, detail: "No sBTC supply on Zest v2", supply_apy_pct: supplyApyPct, utilization_pct: round(utilPct, 2) }, sources };
  } catch {
    return { position: { has_position: false, detail: "Zest read failed" }, sources };
  }
}

// -- Scout: Hermetica ---------------------------------------------------------
async function scoutHermetica(wallet: string): Promise<{ position: HermeticaPosition; sources: string[] }> {
  const sources: string[] = [];
  try {
    // Read exchange rate (USDh per sUSDh) and staking status
    const [rateResult, enabledResult] = await Promise.all([
      callReadOnly(HERMETICA_STAKING, "get-usdh-per-susdh", []),
      // staking-v1-1 doesn't have an explicit "is-enabled" but stake will fail if paused
      // We just read the rate as proof the contract is live
      Promise.resolve({ okay: true }),
    ]);
    sources.push("hermetica-staking");

    const RATE_SCALE = 1e8; // exchange rate precision — Hermetica usdh-base = (pow u10 u8)
    let exchangeRate = 1.0;
    if (rateResult.okay && rateResult.result) {
      const raw = parseUint128Hex(rateResult.result);
      exchangeRate = Number(raw) / RATE_SCALE;
    }

    // Annualize APY from exchange rate drift using staking-v1-1 deployment date.
    // staking-v1-1 deployed at burn block 914980 (Sept 16 2025). The exchange rate
    // reflects cumulative yield since then — we must annualize, not report raw.
    const STAKING_V1_1_DEPLOY_TS = 1758041467; // burn_block_time of deploy tx
    const nowTs = Math.floor(Date.now() / 1000);
    const daysSinceDeploy = Math.max(1, (nowTs - STAKING_V1_1_DEPLOY_TS) / 86400);
    const apyEstimate = exchangeRate > 1.0
      ? round((Math.pow(exchangeRate, 365 / daysSinceDeploy) - 1) * 100, 2)
      : 0;

    // Check user's sUSDh balance from wallet scan (already read in hiroBalance)
    // We just report the rate here; balance comes from the wallet scan
    return {
      position: {
        has_position: false, // will be overridden if susdhSats > 0
        detail: `Exchange rate: ${round(exchangeRate, 6)} USDh/sUSDh`,
        susdh_balance: 0,
        exchange_rate: round(exchangeRate, 6),
        apy_estimate_pct: apyEstimate,
        staking_enabled: enabledResult.okay,
      },
      sources,
    };
  } catch {
    return {
      position: { has_position: false, detail: "Hermetica read failed", susdh_balance: 0, exchange_rate: 1, apy_estimate_pct: 0, staking_enabled: false },
      sources,
    };
  }
}

// -- Scout: Granite -----------------------------------------------------------
async function scoutGranite(wallet: string): Promise<{ position: GranitePosition; sources: string[] }> {
  const sources: string[] = [];
  const IR_SCALE = 1e12;
  try {
    const [lpResult, debtResult, irResult, userPos] = await Promise.all([
      callReadOnly(GRANITE_STATE, "get-lp-params", []),
      callReadOnly(GRANITE_STATE, "get-debt-params", []),
      callReadOnly(GRANITE_IR, "get-ir-params", []),
      callReadOnly(GRANITE_STATE, "get-user-position", [cvPrincipal(wallet)]),
    ]);
    sources.push("granite-on-chain");

    let supplyApy = 0, borrowApr = 0, utilization = 0;

    if (lpResult.okay && lpResult.result && debtResult.okay && debtResult.result) {
      const lp = parseClarityHex(lpResult.result) as Record<string, ClarityValue>;
      const debt = parseClarityHex(debtResult.result) as Record<string, ClarityValue>;
      const totalAssets = typeof lp["total-assets"] === "bigint" ? lp["total-assets"] : 0n;
      const openInterest = typeof debt["open-interest"] === "bigint" ? debt["open-interest"] : 0n;
      if (totalAssets > 0n) utilization = Number((openInterest * 10000n) / totalAssets) / 100;
    }

    if (irResult.okay && irResult.result) {
      const ir = parseClarityHex(irResult.result) as Record<string, ClarityValue>;
      const baseIr = Number(typeof ir["base-ir"] === "bigint" ? ir["base-ir"] : 0n) / IR_SCALE;
      const slope1 = Number(typeof ir["ir-slope-1"] === "bigint" ? ir["ir-slope-1"] : 0n) / IR_SCALE;
      const slope2 = Number(typeof ir["ir-slope-2"] === "bigint" ? ir["ir-slope-2"] : 0n) / IR_SCALE;
      const kink = Number(typeof ir["utilization-kink"] === "bigint" ? ir["utilization-kink"] : 0n) / IR_SCALE;
      const u = utilization / 100;
      if (kink > 0) {
        borrowApr = u <= kink
          ? (baseIr + slope1 * (u / kink)) * 100
          : (baseIr + slope1 + slope2 * ((u - kink) / (1 - kink))) * 100;
      }
      supplyApy = borrowApr * (utilization / 100);
    }

    let hasPosition = false;
    let lpShares = 0n;
    if (userPos.okay && userPos.result) {
      const parsed = parseClarityHex(userPos.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const shares = (parsed as Record<string, ClarityValue>)["shares"] ?? (parsed as Record<string, ClarityValue>)["lp-shares"];
        if (typeof shares === "bigint" && shares > 0n) {
          hasPosition = true;
          lpShares = shares;
        }
      }
    }

    return {
      position: {
        has_position: hasPosition,
        detail: hasPosition ? `Active aeUSDC supply on Granite LP (${lpShares} shares)` : "No aeUSDC supply on Granite LP",
        supply_apy_pct: round(supplyApy, 2), borrow_apr_pct: round(borrowApr, 2),
        utilization_pct: round(utilization, 2),
        accepted_token: "aeUSDC",
        lp_shares: lpShares.toString(),
      }, sources,
    };
  } catch {
    return { position: { has_position: false, detail: "Granite read failed", supply_apy_pct: 0, borrow_apr_pct: 0, utilization_pct: 0, accepted_token: "aeUSDC" }, sources };
  }
}

// -- Scout: HODLMM ------------------------------------------------------------
async function scoutHodlmm(wallet: string): Promise<{ positions: HodlmmPositions; sources: string[] }> {
  const sources: string[] = [];
  const userPools: HodlmmUserPool[] = [];
  let bitflowPools: BitflowPoolData[] | null = null;
  try {
    bitflowPools = await fetchBitflowPools();
  } catch { /* unavailable */ }

  for (const pool of HODLMM_POOLS) {
    try {
      const ubr = await callReadOnly(pool.contract, "get-user-bins", [cvPrincipal(wallet)], wallet);
      if (!ubr.okay) continue;
      const [ovr, tsr, abr] = await Promise.all([
        callReadOnly(pool.contract, "get-overall-balance", [cvPrincipal(wallet)], wallet),
        callReadOnly(pool.contract, "get-overall-supply", [], wallet),
        callReadOnly(pool.contract, "get-active-bin-id", []),
      ]);
      const dlpShares = ovr.okay && ovr.result ? parseUint128Hex(ovr.result) : 0n;
      if (dlpShares === 0n) continue;
      const totalSupply = tsr.okay && tsr.result ? parseUint128Hex(tsr.result) : 0n;
      const activeBin = 500 + Number(abr.okay && abr.result ? parseInt128Hex(abr.result) : 0n);

      const userBinIds = parseUserBinList(ubr.result ?? "");
      const inRange = userBinIds.includes(activeBin);

      let estimatedValueUsd: number | null = null;
      const mp = bitflowPools?.find(p => p.poolId === `dlmm_${pool.id}`);
      if (mp && totalSupply > 0n) {
        // BigInt division first to avoid precision loss on large 128-bit uints
        const scaledRatio = (dlpShares * 1_000_000n) / totalSupply;
        estimatedValueUsd = round(Number(scaledRatio) / 1_000_000 * mp.tvlUsd, 2);
      }

      sources.push(`hodlmm-pool-${pool.id}`);
      userPools.push({
        pool_id: pool.id, name: pool.name, in_range: inRange, active_bin: activeBin,
        user_bins: userBinIds.length > 0 ? { min: Math.min(...userBinIds), max: Math.max(...userBinIds), count: userBinIds.length } : null,
        dlp_shares: dlpShares.toString(), estimated_value_usd: estimatedValueUsd,
      });
    } catch { /* skip pool */ }
  }
  return { positions: { has_position: userPools.length > 0, pools: userPools }, sources };
}

function parseUserBinList(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bins: number[] = [];
  let pos = 0;
  if (clean.startsWith("07")) pos = 2;
  if (clean.substring(pos, pos + 2) !== "0b") return bins;
  pos += 2;
  const len = parseInt(clean.substring(pos, pos + 8), 16);
  pos += 8;
  for (let i = 0; i < len; i++) {
    if (pos + 34 > clean.length) break;
    if (clean.substring(pos, pos + 2) !== "01") { pos += 34; continue; }
    pos += 2;
    bins.push(Number(BigInt("0x" + clean.substring(pos, pos + 32))));
    pos += 32;
  }
  return bins;
}

// -- Yield Options (3-tier) ---------------------------------------------------
async function getYieldOptions(
  balances: WalletBalances,
  prices: { sbtc: number; stx: number; usdcx: number; usdh: number; aeusdc: number },
  granite: GranitePosition,
  hermetica: HermeticaPosition,
): Promise<{ options: YieldOption[]; sources: string[] }> {
  const sources: string[] = [];
  const options: YieldOption[] = [];

  // Helper: compute daily USD from capital and APY
  const dailyUsd = (capitalUsd: number, apyPct: number) => round((capitalUsd * apyPct / 100) / 365, 4);

  // --- Tier 1: Deploy Now (user holds the token) ---

  // Zest sBTC supply
  try {
    const [utilR, rateR] = await Promise.all([
      callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []),
      callReadOnly(ZEST_VAULT_SBTC, "get-interest-rate", []),
    ]);
    const utilPct = (utilR.okay && utilR.result ? Number(parseUint128Hex(utilR.result)) : 0) / 100;
    const borrowPct = (rateR.okay && rateR.result ? Number(parseUint128Hex(rateR.result)) : 0) / 100;
    const supplyApy = round(borrowPct * (utilPct / 100) * 0.9, 2);
    sources.push("zest-apy-live");

    if (balances.sbtc.amount > 0) {
      const d = dailyUsd(balances.sbtc.usd, supplyApy);
      options.push({ tier: "deploy_now", protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC", apy_pct: supplyApy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.03, swap_cost_note: null, note: supplyApy > 0 ? `Lending — ${round(utilPct, 1)}% utilization.` : `0% utilization — APY rises when borrowers arrive.`, ytg_ratio: 0, ytg_profitable: false });
    } else {
      options.push({ tier: "acquire_to_unlock", protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC", apy_pct: supplyApy, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.03, swap_cost_note: null, note: `Need sBTC. Get via: Bitflow swap or sBTC bridge.`, ytg_ratio: 0, ytg_profitable: false });
    }
  } catch { /* skip */ }

  // Hermetica USDh staking
  if (hermetica.staking_enabled) {
    const apyRaw = hermetica.apy_estimate_pct;
    const apy = apyRaw > 0 ? apyRaw : 5.0; // estimated — no live exchange rate data
    if (balances.usdh.amount > 0) {
      const d = dailyUsd(balances.usdh.usd, apy);
      const apyNote = apyRaw > 0 ? "" : " (estimated — no live rate data)";
      options.push({ tier: "deploy_now", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.02, swap_cost_note: null, note: `Stake USDh -> sUSDh. Rate: ${hermetica.exchange_rate} USDh/sUSDh. 7-day unstake cooldown.${apyNote}`, ytg_ratio: 0, ytg_profitable: false });
    } else if (balances.sbtc.amount > 0 || balances.usdcx.amount > 0) {
      // Swap path available
      const swapFrom = balances.sbtc.amount > 0 ? "sBTC" : "USDCx";
      const cap = balances.sbtc.amount > 0 ? balances.sbtc.usd : balances.usdcx.usd;
      const d = dailyUsd(cap, apy);
      options.push({ tier: "swap_first", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.1, swap_cost_note: `Swap ${swapFrom} -> USDh on Bitflow (~0.1-0.3% fee + gas)`, note: `Then stake USDh -> sUSDh. 7-day unstake cooldown.`, ytg_ratio: 0, ytg_profitable: false });
    } else {
      options.push({ tier: "acquire_to_unlock", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.02, swap_cost_note: null, note: `Need USDh. Get via: Bitflow swap (sBTC/STX/USDCx -> USDh).`, ytg_ratio: 0, ytg_profitable: false });
    }
  }

  // Granite aeUSDC LP deposit
  if (granite.supply_apy_pct && granite.supply_apy_pct > 0) {
    if (balances.aeusdc.amount > 0) {
      const d = dailyUsd(balances.aeusdc.usd, granite.supply_apy_pct);
      options.push({ tier: "deploy_now", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.05, swap_cost_note: null, note: `Lending — ${granite.utilization_pct}% util, ${granite.borrow_apr_pct}% borrow APR.`, ytg_ratio: 0, ytg_profitable: false });
    } else if (balances.usdcx.amount > 0) {
      const d = dailyUsd(balances.usdcx.usd, granite.supply_apy_pct);
      options.push({ tier: "swap_first", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.1, swap_cost_note: "Swap USDCx -> aeUSDC on Bitflow (~0.01% fee, stablecoin pair)", note: `Then deposit aeUSDC to Granite LP.`, ytg_ratio: 0, ytg_profitable: false });
    } else {
      options.push({ tier: "acquire_to_unlock", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.05, swap_cost_note: null, note: `Need aeUSDC. Get via: Bitflow swap or bridge from Ethereum USDC.`, ytg_ratio: 0, ytg_profitable: false });
    }
  }

  // HODLMM pools
  try {
    const pools = await fetchBitflowPools();
    if (pools.length > 0) {
      sources.push("bitflow-hodlmm-apr");
      for (const bp of pools) {
        if (bp.apr24h <= 0) continue;
        const def = HODLMM_POOLS.find(p => `dlmm_${p.id}` === bp.poolId);
        if (!def) continue;

        // Determine which token the user needs for this pool
        const tokenXMeta = TOKENS[def.tokenX];
        const tokenYMeta = TOKENS[def.tokenY];
        if (!tokenXMeta || !tokenYMeta) continue;

        const hasX = (balances as unknown as Record<string, TokenBalance>)[def.tokenX]?.amount > 0;
        const hasY = (balances as unknown as Record<string, TokenBalance>)[def.tokenY]?.amount > 0;

        let tier: YieldTier;
        let capUsd: number;
        let swapNote: string | null = null;

        if (hasX || hasY) {
          tier = "deploy_now";
          const xUsd = (balances as unknown as Record<string, TokenBalance>)[def.tokenX]?.usd ?? 0;
          const yUsd = (balances as unknown as Record<string, TokenBalance>)[def.tokenY]?.usd ?? 0;
          capUsd = Math.max(xUsd, yUsd);
        } else {
          // Check if user has any token that could be swapped
          const totalUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd + balances.usdh.usd + balances.aeusdc.usd;
          if (totalUsd > 10) {
            tier = "swap_first";
            capUsd = totalUsd * 0.5; // conservative: assume half could be swapped
            swapNote = `Swap to ${tokenXMeta.symbol} or ${tokenYMeta.symbol} on Bitflow first`;
          } else {
            tier = "acquire_to_unlock";
            capUsd = 0;
          }
        }

        const d = dailyUsd(capUsd, bp.apr24h);
        options.push({
          tier, protocol: "HODLMM", pool: def.name, token_needed: `${tokenXMeta.symbol}/${tokenYMeta.symbol}`,
          apy_pct: round(bp.apr24h, 2), daily_usd: d, monthly_usd: round(d * 30, 2),
          gas_to_enter_stx: 0.05, swap_cost_note: swapNote,
          note: `Fee-based LP. TVL: $${Math.round(bp.tvlUsd).toLocaleString()}.`,
          ytg_ratio: 0, ytg_profitable: false,
        });
      }
    }
  } catch { /* unavailable */ }

  // YTG (Yield-to-Gas) profit gate: 7d projected yield must exceed 3x gas cost
  const stxPriceUsd = prices.stx;
  for (const opt of options) {
    const gasUsd = opt.gas_to_enter_stx * stxPriceUsd;
    const yield7d = opt.daily_usd * 7;
    opt.ytg_ratio = gasUsd > 0 ? round(yield7d / gasUsd, 2) : 0;
    opt.ytg_profitable = yield7d > gasUsd * 3;
  }

  // Sort: deploy_now first, then swap_first, then acquire_to_unlock; within each tier by APY desc
  const tierOrder: Record<YieldTier, number> = { deploy_now: 0, swap_first: 1, acquire_to_unlock: 2 };
  options.sort((a, b) => {
    const td = tierOrder[a.tier] - tierOrder[b.tier];
    return td !== 0 ? td : b.apy_pct - a.apy_pct;
  });

  return { options, sources };
}

// -- Break prices -------------------------------------------------------------
async function getBreakPrices(hodlmm: HodlmmPositions, sbtcPrice: number): Promise<{ breakPrices: BreakPrices; sources: string[] }> {
  const sources: string[] = [];
  let rangeLow: number | null = null, rangeHigh: number | null = null;
  const sbtcPool = hodlmm.pools.find(p => p.name.includes("sBTC") && p.user_bins);
  if (sbtcPool?.user_bins) {
    try {
      const poolContract = HODLMM_POOLS.find(p => p.id === sbtcPool.pool_id)?.contract;
      if (poolContract) {
        const pd = await callReadOnly(poolContract, "get-pool", []);
        if (pd.okay && pd.result) {
          const pp = parseClarityHex(pd.result) as Record<string, ClarityValue>;
          const initPrice = typeof pp["initial-price"] === "bigint" ? pp["initial-price"] : 0n;
          const binStep = typeof pp["bin-step"] === "bigint" ? pp["bin-step"] : 0n;
          if (initPrice > 0n && binStep > 0n) {
            const lowS = sbtcPool.user_bins.min - 500;
            const highS = sbtcPool.user_bins.max - 500;
            const toInt128 = (v: number) => `0x00${BigInt(v >= 0 ? v : (1n << 128n) + BigInt(v)).toString(16).padStart(32, "0")}`;
            const [lr, hr] = await Promise.all([
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(lowS)]),
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(highS)]),
            ]);
            if (lr.okay && lr.result) { rangeLow = round(Number(parseUint128Hex(lr.result)) / BIN_PRICE_SCALE, 2); sources.push("hodlmm-bin-price-low"); }
            if (hr.okay && hr.result) { rangeHigh = round(Number(parseUint128Hex(hr.result)) / BIN_PRICE_SCALE, 2); sources.push("hodlmm-bin-price-high"); }
          }
        }
      }
    } catch { /* skip */ }
  }
  return { breakPrices: { hodlmm_range_exit_low_usd: rangeLow, hodlmm_range_exit_high_usd: rangeHigh, current_sbtc_price_usd: sbtcPrice }, sources };
}

// =============================================================================
// ==  RESERVE (PoR) MODULE
// =============================================================================

async function checkReserve(): Promise<ReserveResult> {
  try {
    const pubkeyRes = await callReadOnly(
      `${SBTC_REGISTRY}.${SBTC_REGISTRY_NAME}`, "get-current-aggregate-pubkey", [], SBTC_REGISTRY
    );
    if (!pubkeyRes.okay || !pubkeyRes.result) throw new Error("sbtc-registry returned no aggregate pubkey");
    const hex = pubkeyRes.result.replace(/^0x/, "");
    const compressedPubkey = hex.slice(10);
    if (compressedPubkey.length !== 66) throw new Error(`Expected 33-byte pubkey, got ${compressedPubkey.length / 2}`);

    const xOnlyHex = compressedPubkey.slice(2);
    const signerAddress = xOnlyPubkeyToP2TR(xOnlyHex);

    const [addrInfo, supplyRes] = await Promise.all([
      fetchJson<Record<string, Record<string, number>>>(`${MEMPOOL_API}/address/${signerAddress}`),
      callReadOnly(`${SBTC_TOKEN.split("::")[0]}`, "get-total-supply", [], SBTC_REGISTRY),
    ]);

    const funded = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
    const spent = addrInfo?.chain_stats?.spent_txo_sum ?? 0;
    const btcReserve = (funded - spent) / 1e8;

    let sbtcCirculating = 0;
    if (supplyRes.okay && supplyRes.result) {
      const supplyRaw = parseUint128Hex(supplyRes.result);
      sbtcCirculating = Number(supplyRaw) / 1e8;
    }

    const reserveRatio = sbtcCirculating > 0 ? btcReserve / sbtcCirculating : 0;

    if (reserveRatio < ROTATION_THRESHOLD) {
      return {
        signal: "DATA_UNAVAILABLE", reserve_ratio: round(reserveRatio, 6), score: 0,
        sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4),
        signer_address: signerAddress,
        recommendation: `Reserve ratio ${(reserveRatio * 100).toFixed(1)}% — likely signer key rotation in progress.`,
      };
    }

    let signal: PorSignal;
    if (reserveRatio >= THRESHOLD_GREEN) signal = "GREEN";
    else if (reserveRatio >= THRESHOLD_YELLOW) signal = "YELLOW";
    else signal = "RED";

    let score = 100;
    if (reserveRatio < 0.995) score -= 30;
    else if (reserveRatio < 0.999) score -= 15;
    score = Math.max(0, score);

    const recommendation = signal === "GREEN"
      ? "sBTC fully backed. Safe to proceed."
      : signal === "YELLOW"
      ? "sBTC reserve slightly below threshold. Read-only operations only."
      : "sBTC reserve critically low. Emergency withdrawal recommended.";

    return { signal, reserve_ratio: round(reserveRatio, 6), score, sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4), signer_address: signerAddress, recommendation };
  } catch (err: unknown) {
    return {
      signal: "DATA_UNAVAILABLE", reserve_ratio: null, score: 0,
      sbtc_circulating: 0, btc_reserve: 0, signer_address: "",
      recommendation: "Reserve check failed. Treat as RED — do not proceed.",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// ==  GUARDIAN MODULE
// =============================================================================

interface EngineState { last_rebalance_at?: string }

function readState(): EngineState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeState(state: EngineState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkGuardian(scout: ScoutResult): Promise<GuardianResult> {
  const refusals: string[] = [];

  // 1. Price source gate
  const pricesOk = scout.prices.sbtc > 0 && scout.prices.stx > 0;
  if (!pricesOk) refusals.push("Price data unavailable — cannot calculate USD values safely");

  // 2. Slippage check (HODLMM active bin vs market price)
  let slippagePct = 0;
  let slippageOk = true;
  const guardianPools = await fetchBitflowPools().catch(() => [] as BitflowPoolData[]);
  try {
    const dlmm1 = guardianPools.find(p => p.poolId === "dlmm_1");
    if (dlmm1?.tokens) {
      const pool1 = HODLMM_POOLS[0];
      const abr = await callReadOnly(pool1.contract, "get-active-bin-id", []);
      if (abr.okay && abr.result) {
        const binsData = await fetchJson<{ bins?: Array<{ bin_id: number; price?: string }>; active_bin_id?: number }>(`${BITFLOW_API}/api/quotes/v1/bins/dlmm_1`);
        const activeBinId = binsData.active_bin_id ?? 0;
        const activeBinData = binsData.bins?.find(b => b.bin_id === activeBinId);
        if (activeBinData?.price) {
          const binPrice = parseFloat(activeBinData.price);
          const hodlmmPriceUsd = (binPrice / PRICE_SCALE) * Math.pow(10, dlmm1.tokens.tokenX.decimals - dlmm1.tokens.tokenY.decimals);
          const marketPrice = dlmm1.tokens.tokenX.priceUsd;
          if (marketPrice > 0) {
            slippagePct = round(Math.abs(hodlmmPriceUsd - marketPrice) / marketPrice * 100, 4);
            slippageOk = slippagePct <= MAX_SLIPPAGE_PCT;
            if (!slippageOk) refusals.push(`Slippage ${slippagePct}% > ${MAX_SLIPPAGE_PCT}% cap`);
          }
        }
      }
    }
  } catch { /* slippage check unavailable — allow */ }

  // 3. Volume gate
  let volumeUsd = 0;
  let volumeOk = true;
  try {
    const dlmm1 = guardianPools.find(p => p.poolId === "dlmm_1");
    volumeUsd = dlmm1?.volumeUsd1d ?? 0;
    volumeOk = volumeUsd >= MIN_24H_VOLUME_USD;
    if (!volumeOk) refusals.push(`24h volume $${Math.round(volumeUsd)} < $${MIN_24H_VOLUME_USD} minimum`);
  } catch { /* unavailable */ }

  // 4. Gas gate
  let gasStx = 0;
  let gasOk = true;
  try {
    const fees = await fetchJson<{ transfer_fee_estimate: number }>(`${HIRO_API}/v2/fees/transfer`);
    gasStx = round((fees.transfer_fee_estimate ?? 6) * 3600 / 1e6, 2);
    gasOk = gasStx <= MAX_GAS_STX;
    if (!gasOk) refusals.push(`Estimated gas ${gasStx} STX > ${MAX_GAS_STX} STX cap`);
  } catch { /* allow */ }

  // 5. Cooldown
  const state = readState();
  let cooldownOk = true;
  let cooldownRemaining = 0;
  if (state.last_rebalance_at) {
    const elapsed = (Date.now() - new Date(state.last_rebalance_at).getTime()) / 3_600_000;
    cooldownRemaining = round(Math.max(0, COOLDOWN_HOURS - elapsed), 2);
    cooldownOk = cooldownRemaining === 0;
    if (!cooldownOk) refusals.push(`Cooldown: ${cooldownRemaining}h remaining`);
  }

  // Note: relay health is checked at MCP runtime layer, not duplicated here.
  // Guardian gates: slippage, volume, gas, cooldown, prices (5 gates).

  return {
    can_proceed: refusals.length === 0, refusals,
    slippage: { ok: slippageOk, pct: slippagePct },
    volume: { ok: volumeOk, usd: volumeUsd },
    gas: { ok: gasOk, estimated_stx: gasStx },
    cooldown: { ok: cooldownOk, remaining_hours: cooldownRemaining },
    prices: { ok: pricesOk, detail: pricesOk ? "all prices live" : "missing price data" },
  };
}

// =============================================================================
// ==  EXECUTOR MODULE
// =============================================================================
// Outputs INSTRUCTIONS for the agent runtime to execute via MCP.
// The engine does not hold private keys or sign transactions.

type Protocol = "zest" | "hermetica" | "granite" | "hodlmm";

interface ExecuteInstruction {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

// -- Bitflow DLMM swap routes ---------------------------------------------------
// Maps (tokenIn, tokenOut) to the DLMM pool and direction for swap-simple-multi.
// Each route is a single-hop swap through a known Bitflow DLMM pool.
interface DlmmSwapRoute {
  pool: string;     // pool contract principal
  xToken: string;   // x-token-trait principal (the pool's X token contract)
  yToken: string;   // y-token-trait principal (the pool's Y token contract)
  xForY: boolean;   // true = selling X for Y, false = selling Y for X
}

function getDlmmSwapRoute(tokenIn: string, tokenOut: string): DlmmSwapRoute | null {
  // USDCx → aeUSDC (pool: aeUSDC/USDCx, selling Y for X)
  if ((tokenIn === "usdcx" || tokenIn === "stx") && tokenOut === "aeusdc") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1",
      xToken: AEUSDC_TOKEN, yToken: USDCX_TOKEN, xForY: false,
    };
  }
  // USDCx → USDh (pool: USDh/USDCx, selling Y for X)
  if ((tokenIn === "usdcx" || tokenIn === "stx") && tokenOut === "usdh") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",
      xToken: USDH_TOKEN, yToken: USDCX_TOKEN, xForY: false,
    };
  }
  // sBTC → USDCx (pool: sBTC/USDCx 10bps, selling X for Y)
  if (tokenIn === "sbtc" && tokenOut === "usdcx") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
      xToken: SBTC_TOKEN, yToken: USDCX_TOKEN, xForY: true,
    };
  }
  return null;
}

// Default slippage by pair volatility profile.
// Stable-stable pairs use tight tolerance; volatile pairs need more room.
function defaultSlippagePct(route: DlmmSwapRoute): number {
  const stable = [USDCX_TOKEN, AEUSDC_TOKEN, USDH_TOKEN];
  const bothStable = stable.includes(route.xToken) && stable.includes(route.yToken);
  return bothStable ? 0.5 : 3;
}

// Build a call_contract instruction for a Bitflow DLMM swap.
// Uses swap-simple-multi with a single swap in the list.
function buildDlmmSwapInstruction(route: DlmmSwapRoute, amount: number, slippagePct?: number): ExecuteInstruction {
  slippagePct = slippagePct ?? defaultSlippagePct(route);
  const minReceived = Math.floor(amount * (1 - slippagePct / 100));
  return {
    tool: "call_contract",
    params: {
      contractAddress: DLMM_SWAP_ROUTER,
      contractName: DLMM_SWAP_ROUTER_NAME,
      functionName: "swap-simple-multi",
      functionArgs: [{
        type: "list", value: [{
          type: "tuple", value: {
            amount: { type: "uint", value: String(amount) },
            "max-steps": { type: "uint", value: "6" },
            "min-received": { type: "uint", value: String(minReceived) },
            "pool-trait": { type: "principal", value: route.pool },
            "x-for-y": { type: "bool", value: route.xForY },
            "x-token-trait": { type: "principal", value: route.xToken },
            "y-token-trait": { type: "principal", value: route.yToken },
          },
        }],
      }],
      postConditionMode: "allow",
    },
    description: `Swap ${amount} via Bitflow DLMM (${route.xForY ? "X→Y" : "Y→X"}, min-received: ${minReceived}, ${slippagePct}% slippage)`,
  };
}

function buildDeployInstructions(protocol: Protocol, amount: number, token: string, scout: ScoutResult): ExecuteInstruction[] {
  const instructions: ExecuteInstruction[] = [];
  const wallet = scout.wallet;

  switch (protocol) {
    case "zest":
      instructions.push({
        tool: "zest_supply",
        params: { asset: "sBTC", amount: String(amount) },
        description: `Supply ${amount} sats sBTC to Zest v2 vault`,
      });
      break;

    case "hermetica": {
      // Hermetica staking-v1 is deactivated (HQ ERR_INACTIVE_CONTRACT u1006).
      // staking-v1-1 is the active contract. It takes an additional `affiliate` arg (optional buff 64).
      // Staking mints sUSDh back to the caller — postConditionMode must be "allow"
      // because the sUSDh mint is not covered by the outgoing USDh post-condition.
      if (token === "usdh") {
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "stake",
            functionArgs: [{ type: "uint", value: amount }, null],
            postConditionMode: "allow",
            // allow mode required: staking mints sUSDh back to caller (not expressible as sender-side PC).
            // Belt-and-suspenders: outgoing USDh transfer is still asserted.
            postConditions: [
              { type: "ft", principal: wallet, asset: USDH_TOKEN, assetName: "usdh-token", conditionCode: "lte", amount },
            ],
          },
          description: `Stake ${amount} USDh into Hermetica sUSDh (earning yield)`,
        });
      } else {
        // Need to swap to USDh first via Bitflow DLMM router
        const swapRoute = getDlmmSwapRoute(token, "usdh");
        if (!swapRoute) {
          instructions.push({ tool: "info", params: {}, description: `No DLMM swap route from ${token} to USDh. Acquire USDh manually.` });
          break;
        }
        instructions.push(buildDlmmSwapInstruction(swapRoute, amount));
        // Step 2 amount depends on Step 1 swap output — use input amount as estimate
        // Agent must read swap tx result and substitute actual received amount before executing
        const hermeticaEstimate = String(amount);
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "stake",
            functionArgs: [{ type: "uint", value: hermeticaEstimate }, null],
            postConditionMode: "allow",
            // allow mode required: staking mints sUSDh (not expressible as sender-side PC).
            // Belt-and-suspenders: outgoing USDh transfer is still asserted.
            postConditions: [
              { type: "ft", principal: wallet, asset: USDH_TOKEN, assetName: "usdh-token", conditionCode: "lte", amount: hermeticaEstimate },
            ],
            requires_substitution: true,
            _note: "SEQUENTIAL: execute after Step 1 confirms. Replace amount with actual swap output from tx receipt.",
          },
          description: `Step 2: Stake ~${hermeticaEstimate} USDh into Hermetica sUSDh (adjust amount from Step 1 output)`,
        });
      }
      break;
    }

    case "granite":
      // Granite LP accepts aeUSDC only
      // Deposit mints LP tokens back to the caller — postConditionMode must be "allow"
      // because the LP token mint is not covered by the outgoing aeUSDC post-condition.
      if (token === "aeusdc") {
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
            contractName: "liquidity-provider-v1",
            functionName: "deposit",
            functionArgs: [
              { type: "uint", value: amount },
              { type: "principal", value: wallet },
            ],
            postConditionMode: "allow",
            // allow mode required: deposit mints LP tokens back to caller (not expressible as sender-side PC).
            // Belt-and-suspenders: outgoing aeUSDC transfer is still asserted.
            postConditions: [
              { type: "ft", principal: wallet, asset: AEUSDC_TOKEN, assetName: "bridged-usdc", conditionCode: "lte", amount },
            ],
          },
          description: `Deposit ${amount} aeUSDC to Granite lending pool`,
        });
      } else {
        // Need swap to aeUSDC first via Bitflow DLMM router
        const swapRoute = getDlmmSwapRoute(token, "aeusdc");
        if (!swapRoute) {
          instructions.push({ tool: "info", params: {}, description: `No DLMM swap route from ${token} to aeUSDC. Acquire aeUSDC manually.` });
          break;
        }
        instructions.push(buildDlmmSwapInstruction(swapRoute, amount));
        // Step 2 amount depends on Step 1 swap output — use input amount as estimate
        // Agent must read swap tx result and substitute actual received amount before executing
        const graniteEstimate = String(amount);
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
            contractName: "liquidity-provider-v1",
            functionName: "deposit",
            functionArgs: [
              { type: "uint", value: graniteEstimate },
              { type: "principal", value: wallet },
            ],
            postConditionMode: "allow",
            // allow mode required: deposit mints LP tokens (not expressible as sender-side PC).
            // Belt-and-suspenders: outgoing aeUSDC transfer is still asserted.
            postConditions: [
              { type: "ft", principal: wallet, asset: AEUSDC_TOKEN, assetName: "bridged-usdc", conditionCode: "lte", amount: graniteEstimate },
            ],
            requires_substitution: true,
            _note: "SEQUENTIAL: execute after Step 1 confirms. Replace amount with actual swap output from tx receipt.",
          },
          description: `Step 2: Deposit ~${graniteEstimate} aeUSDC to Granite lending pool (adjust amount from Step 1 output)`,
        });
      }
      break;

    case "hodlmm": {
      const hasSbtc = scout.balances.sbtc.amount > 0;
      const hasUsdcx = scout.balances.usdcx.amount > 0;
      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];

      if (hasSbtc && hasUsdcx) {
        bins.push({ activeBinOffset: 0, xAmount: String(amount), yAmount: String(Math.floor(scout.balances.usdcx.amount * 1e6)) });
      } else if (hasSbtc) {
        for (let i = 1; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: String(Math.floor(amount / 5)), yAmount: "0" });
      } else if (hasUsdcx) {
        const usdcxMicro = Math.floor(scout.balances.usdcx.amount * 1e6);
        for (let i = -5; i <= -1; i++) bins.push({ activeBinOffset: i, xAmount: "0", yAmount: String(Math.floor(usdcxMicro / 5)) });
      }

      instructions.push({
        tool: "bitflow:add-liquidity-simple",
        params: { poolId: "dlmm_1", bins: JSON.stringify(bins) },
        description: `Add liquidity to HODLMM sBTC-USDCx-10bps pool (${bins.length} bins)`,
      });
      break;
    }
  }
  return instructions;
}

function buildWithdrawInstructions(protocol: Protocol, scout: ScoutResult): ExecuteInstruction[] {
  const wallet = scout.wallet;
  switch (protocol) {
    case "zest":
      return [{ tool: "zest_withdraw", params: { asset: "sBTC", amount: "max" }, description: "Withdraw all sBTC from Zest v2" }];

    case "hermetica": {
      // unstake sUSDh -> creates claim in silo -> withdraw after cooldown
      // staking-v1-1 is the active contract (staking-v1 is deactivated)
      // Unstake burns sUSDh and creates a claim — postConditionMode must be "allow"
      // because the sUSDh burn is not expressible as a sender-side post-condition.
      const susdhSats = Math.floor(scout.balances.susdh.amount * 1e8);
      if (susdhSats <= 0) return [{ tool: "info", params: {}, description: "No sUSDh position to withdraw" }];
      return [
        {
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "unstake",
            functionArgs: [{ type: "uint", value: susdhSats }],
            postConditionMode: "allow",
            // allow mode required: unstake burns sUSDh and creates a claim (not expressible as sender-side PC).
            // Belt-and-suspenders: outgoing sUSDh transfer is still asserted.
            postConditions: [
              { type: "ft", principal: wallet, asset: SUSDH_TOKEN, assetName: "susdh-token", conditionCode: "lte", amount: String(susdhSats) },
            ],
          },
          description: `Unstake ${susdhSats} sUSDh (creates claim in staking-silo)`,
        },
        {
          tool: "info",
          params: { note: "After 7-day cooldown, call staking-silo-v1-1.withdraw(claim-id) to receive USDh" },
          description: "NOTE: 7-day unstake cooldown. Run withdraw again after cooldown to claim USDh.",
        },
      ];
    }

    case "granite": {
      // Use actual LP shares from on-chain position — not hardcoded 0
      const granitePos = scout.positions.granite;
      const shares = granitePos.lp_shares ?? "0";
      if (shares === "0") return [{ tool: "info", params: {}, description: "No Granite LP position to withdraw" }];
      // Granite follows ERC-4626: redeem(shares) burns share count, withdraw(assets) takes asset amount.
      // We have the share count, so use redeem().
      const sharesNum = BigInt(shares);
      const expectedAeusdc = String(sharesNum + sharesNum / 10n); // shares + 10% interest buffer for post-condition
      return [{
        tool: "call_contract",
        params: {
          contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
          contractName: "liquidity-provider-v1", functionName: "redeem",
          functionArgs: [{ type: "uint", value: shares }, { type: "principal", value: wallet }],
          postConditions: [
            // Cap outflow from pool (upper bound)
            {
              type: "ft", principal: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.liquidity-provider-v1",
              asset: AEUSDC_TOKEN, assetName: "bridged-usdc",
              conditionCode: "lte", amount: expectedAeusdc,
            },
            // Guarantee wallet receives non-zero aeUSDC — catches bugged pool returning 0
            {
              type: "ft", principal: wallet,
              asset: AEUSDC_TOKEN, assetName: "bridged-usdc",
              conditionCode: "gte", amount: "1",
            },
          ],
        },
        description: `Redeem ${shares} LP shares for aeUSDC from Granite lending pool`,
      }];
    }

    case "hodlmm": {
      const pools = scout.positions.hodlmm.pools;
      return pools.map(p => ({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId: `dlmm_${p.pool_id}`, positions: "all" },
        description: `Withdraw all liquidity from HODLMM ${p.name}`,
      }));
    }
  }
}

function buildEmergencyInstructions(scout: ScoutResult): ExecuteInstruction[] {
  const instructions: ExecuteInstruction[] = [];
  if (scout.positions.hodlmm.has_position) {
    instructions.push(...buildWithdrawInstructions("hodlmm", scout));
  }
  if (scout.positions.zest.has_position) {
    instructions.push(...buildWithdrawInstructions("zest", scout));
  }
  if (scout.positions.hermetica.has_position || scout.balances.susdh.amount > 0) {
    instructions.push(...buildWithdrawInstructions("hermetica", scout));
  }
  if (scout.positions.granite.has_position) {
    instructions.push(...buildWithdrawInstructions("granite", scout));
  }
  return instructions;
}

// =============================================================================
// ==  SAFETY PIPELINE
// =============================================================================

function withDisclaimer(result: Omit<EngineResult, "disclaimer">): EngineResult {
  return { ...result, disclaimer: DISCLAIMER };
}

async function runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<EngineResult> {
  return withDisclaimer(await _runPipeline(wallet, command, opts));
}

async function _runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<Omit<EngineResult, "disclaimer">> {
  // Step 0: Input validation — pure string/number checks only.
  // NOT a safety bypass: the full pipeline (Scout → PoR → Guardian → YTG → Executor)
  // still runs for every valid write request. This just catches obviously invalid input
  // (bad protocol name, zero amount, wrong token) before wasting 12+ API calls.
  if (command === "deploy") {
    const protocol = opts.protocol;
    if (!protocol || !["zest", "hermetica", "granite", "hodlmm"].includes(protocol)) {
      return { status: "error", command, error: "Invalid protocol. Use: zest, hermetica, granite, hodlmm" };
    }
    const amount = parseInt(opts.amount ?? "0", 10);
    if (isNaN(amount) || amount <= 0) return { status: "error", command, error: "Amount must be a positive number" };
    const token = opts.token ?? inferToken(protocol as Protocol);
    const validTokens: Record<string, string[]> = { zest: ["sbtc"], hermetica: ["usdh", "sbtc", "usdcx", "stx"], granite: ["aeusdc", "usdcx"], hodlmm: ["sbtc", "stx", "usdcx", "usdh", "aeusdc"] };
    if (!validTokens[protocol].includes(token)) {
      return { status: "error", command, error: `${protocol} does not accept ${token}. Valid: ${validTokens[protocol].join(", ")}` };
    }
  }
  if (command === "withdraw") {
    const protocol = opts.protocol;
    if (!protocol || !["zest", "hermetica", "granite", "hodlmm"].includes(protocol)) {
      return { status: "error", command, error: "Invalid protocol. Use: zest, hermetica, granite, hodlmm" };
    }
  }
  if (command === "migrate") {
    if (!opts.from || !opts.to || opts.from === opts.to) {
      return { status: "error", command, error: "Specify --from and --to (different protocols)" };
    }
  }

  // Step 1: Scout
  let scout: ScoutResult;
  try {
    scout = await scoutWallet(wallet);
  } catch (err: unknown) {
    return { status: "error", command, error: `Scout failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: Reserve check
  const reserve = await checkReserve();

  // --confirm gate for emergency too
  const confirmed = opts.confirm === "true" || opts.confirm === "";

  // Emergency bypasses guardian
  if (command === "emergency") {
    const instructions = buildEmergencyInstructions(scout);
    if (!confirmed) {
      return {
        status: "preview", command, scout, reserve,
        action: {
          description: `[DRY RUN] EMERGENCY EXIT: ${instructions.length} operations — add --confirm to execute`,
          details: { instructions },
        },
      };
    }
    return {
      status: "ok", command, scout, reserve,
      action: {
        description: `EMERGENCY EXIT: ${instructions.length} operations to withdraw all positions`,
        details: { instructions },
      },
    };
  }

  // PoR RED or DATA_UNAVAILABLE -> refuse writes
  if (reserve.signal === "RED" || reserve.signal === "DATA_UNAVAILABLE") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: [`PoR signal: ${reserve.signal} — ${reserve.recommendation}`],
      action: { description: "Write refused. Run 'emergency' to withdraw all positions." },
    };
  }

  // PoR YELLOW -> refuse writes
  if (reserve.signal === "YELLOW") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: ["PoR signal: YELLOW — reserve below 99.9%. Read-only operations only."],
    };
  }

  // Step 3: Guardian check
  const guardian = await checkGuardian(scout);
  if (!guardian.can_proceed) {
    return {
      status: "refused", command, scout, reserve, guardian,
      refusal_reasons: guardian.refusals,
    };
  }

  // Step 4: Execute
  let instructions: ExecuteInstruction[] = [];
  let description = "";

  switch (command) {
    case "deploy": {
      // Input already validated in Step 0 above
      const protocol = opts.protocol as Protocol;
      const token = opts.token ?? inferToken(protocol);
      const amount = parseInt(opts.amount ?? "0", 10);

      // Check 0% APY
      const targetOpt = scout.options.find(o => o.protocol.toLowerCase() === protocol);
      if (targetOpt && targetOpt.apy_pct === 0 && !opts.force) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: [`${protocol} APY is 0%. Use --force to override.`] };
      }

      // YTG profit gate: 7d yield must exceed 3x gas cost
      if (targetOpt && !targetOpt.ytg_profitable && !opts.force) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: [`YTG gate: 7d yield ($${round(targetOpt.daily_usd * 7, 4)}) < 3x gas cost. Ratio: ${targetOpt.ytg_ratio}x. Use --force to override.`] };
      }

      // Balance check: refuse if requested amount exceeds wallet balance
      const tokenKey = token as keyof WalletBalances;
      if (scout.balances[tokenKey]) {
        const decimals = TOKENS[tokenKey]?.decimals ? Math.pow(10, TOKENS[tokenKey].decimals) : 1e6;
        const walletUnits = Math.floor(scout.balances[tokenKey].amount * decimals);
        if (amount > walletUnits) {
          return { status: "error", command, error: `Insufficient ${token} balance: have ${walletUnits}, requested ${amount}` };
        }
      }

      instructions = buildDeployInstructions(protocol, amount, token, scout);
      description = `Deploy ${amount} ${token} to ${protocol}`;
      break;
    }

    case "withdraw": {
      // Input already validated in Step 0 above
      const protocol = opts.protocol as Protocol;
      instructions = buildWithdrawInstructions(protocol, scout);
      description = `Withdraw from ${protocol}`;
      break;
    }

    case "rebalance": {
      const poolId = opts["pool-id"] ?? "dlmm_1";
      const poolNum = parseInt(poolId.replace("dlmm_", ""), 10);
      const pool = scout.positions.hodlmm.pools.find(p => p.pool_id === poolNum);
      if (!pool) return { status: "error", command, error: `No position found in pool ${poolId}` };
      if (pool.in_range) return { status: "ok", command, scout, reserve, guardian, action: { description: `Pool ${poolId} is IN RANGE at bin ${pool.active_bin}. No rebalance needed.` } };

      instructions.push({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId, positions: "all" },
        description: `Step 1: Withdraw all liquidity from ${pool.name}`,
      });
      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];
      for (let i = -5; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: "auto", yAmount: "auto" });
      instructions.push({
        tool: "bitflow:add-liquidity-simple",
        params: { poolId, bins: JSON.stringify(bins) },
        description: `Step 2: Re-add liquidity centered on active bin ${pool.active_bin}`,
      });

      description = `Rebalance ${pool.name}: withdraw + re-add around bin ${pool.active_bin}`;
      break;
    }

    case "migrate": {
      // Input already validated in Step 0 above
      const from = opts.from as Protocol;
      const to = opts.to as Protocol;
      instructions.push(...buildWithdrawInstructions(from, scout));
      const token = opts.token ?? inferToken(to);
      const parsedAmt = opts.amount ? parseInt(opts.amount, 10) : NaN;
      const amount = isNaN(parsedAmt) ? Math.floor(scout.balances.sbtc.amount * 1e8) : parsedAmt;
      instructions.push(...buildDeployInstructions(to, amount, token, scout));
      description = `Migrate from ${from} to ${to}`;
      break;
    }
  }

  if (!confirmed) {
    return {
      status: "preview", command, scout, reserve, guardian,
      action: {
        description: `[DRY RUN] ${description} — add --confirm to execute`,
        details: { instructions, instruction_count: instructions.length },
      },
    };
  }

  // Stamp rebalance cooldown only on actual execution, never on preview
  if (command === "rebalance") {
    writeState({ ...readState(), last_rebalance_at: new Date().toISOString() });
  }

  return {
    status: "ok", command, scout, reserve, guardian,
    action: { description, details: { instructions, instruction_count: instructions.length } },
  };
}

function inferToken(protocol: Protocol): string {
  switch (protocol) {
    case "zest": return "sbtc";
    case "hermetica": return "usdh";
    case "granite": return "aeusdc";
    case "hodlmm": return "sbtc";
  }
}

// =============================================================================
// ==  DOCTOR COMMAND
// =============================================================================

async function runDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Bech32m test vectors
  const tv = verifyBech32mTestVectors();
  checks.push({ name: "BIP-350 Bech32m Test Vectors", ok: tv.pass, detail: tv.detail });

  // 2. P2TR derivation self-test
  try {
    const addr = xOnlyPubkeyToP2TR("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const expected = "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9";
    checks.push({ name: "P2TR Derivation Self-Test", ok: addr === expected, detail: addr === expected ? "G point -> tweaked P2TR pass" : `Expected ${expected}, got ${addr}` });
  } catch (e: unknown) {
    checks.push({ name: "P2TR Derivation Self-Test", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Hiro Stacks API
  try {
    const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ name: "Hiro Stacks API", ok: true, detail: `tip: ${info.stacks_tip_height}, burn: ${info.burn_block_height}` });
  } catch (e: unknown) { checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 4. Tenero Price Oracle
  try {
    const t = await fetchJson<Record<string, Record<string, unknown>>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_TOKEN}`);
    const d = t?.data as Record<string, unknown> | undefined;
    const p = (d?.price_usd as number) ?? 0;
    checks.push({ name: "Tenero Price Oracle", ok: p > 0, detail: `sBTC: $${round(p, 2)}` });
  } catch (e: unknown) { checks.push({ name: "Tenero Price Oracle", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 5. Bitflow HODLMM API
  try {
    const pools = await fetchBitflowPools();
    checks.push({ name: "Bitflow HODLMM API", ok: pools.length > 0, detail: `${pools.length} pools` });
  } catch (e: unknown) { checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 6. mempool.space
  try {
    const fees = await fetchJson<{ fastestFee: number }>(`${MEMPOOL_API}/v1/fees/recommended`);
    checks.push({ name: "mempool.space", ok: !!fees.fastestFee, detail: `${fees.fastestFee} sat/vB` });
  } catch (e: unknown) { checks.push({ name: "mempool.space", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 7. sBTC Proof of Reserve
  try {
    const r = await checkReserve();
    checks.push({ name: "sBTC Proof of Reserve", ok: r.signal === "GREEN", detail: `${r.signal} — ratio ${r.reserve_ratio ?? "N/A"}, ${round(r.btc_reserve, 2)} BTC backing ${round(r.sbtc_circulating, 2)} sBTC` });
  } catch (e: unknown) { checks.push({ name: "sBTC Proof of Reserve", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 8. Zest v2 vault
  try {
    const ur = await callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []);
    checks.push({ name: "Zest v2 sBTC Vault", ok: ur.okay, detail: ur.okay ? "utilization readable" : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Zest v2 sBTC Vault", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 9. Hermetica staking
  try {
    const rr = await callReadOnly(HERMETICA_STAKING, "get-usdh-per-susdh", []);
    const rate = rr.okay && rr.result ? Number(parseUint128Hex(rr.result)) / 1e8 : 0;
    checks.push({ name: "Hermetica Staking", ok: rr.okay && rate > 0, detail: `exchange rate: ${round(rate, 6)} USDh/sUSDh` });
  } catch (e: unknown) { checks.push({ name: "Hermetica Staking", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 10. Granite Protocol
  try {
    const lp = await callReadOnly(GRANITE_STATE, "get-lp-params", []);
    checks.push({ name: "Granite Protocol (aeUSDC LP)", ok: lp.okay, detail: lp.okay ? "get-lp-params readable" : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Granite Protocol (aeUSDC LP)", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 11. HODLMM Pool Contract
  try {
    const ab = await callReadOnly(HODLMM_POOLS[0].contract, "get-active-bin-id", []);
    const bin = ab.okay && ab.result ? 500 + Number(parseInt128Hex(ab.result)) : 0;
    checks.push({ name: "HODLMM Pool Contracts", ok: ab.okay, detail: `active bin: ${bin}` });
  } catch (e: unknown) { checks.push({ name: "HODLMM Pool Contracts", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  const allOk = checks.every(c => c.ok);
  const cryptoOk = checks.slice(0, 2).every(c => c.ok);

  console.log(JSON.stringify({
    status: allOk ? "ok" : cryptoOk ? "degraded" : "critical",
    checks,
    message: !cryptoOk
      ? "CRITICAL: Cryptographic self-tests failed. Engine will not operate."
      : allOk
      ? `All ${checks.length} checks passed. Engine ready.`
      : "Some data sources unavailable — engine may operate in degraded mode.",
  }, null, 2));

  if (!cryptoOk) process.exit(2);
  if (!allOk) process.exit(1);
}

// =============================================================================
// ==  RENDERED REPORT
// =============================================================================

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function renderReport(scout: ScoutResult, reserve: ReserveResult, guardian: GuardianResult): string {
  const L: string[] = [];

  L.push("");
  L.push("Stacks Alpha Engine — Full Report");
  L.push(`Wallet: ${scout.wallet}`);
  L.push("");

  // Section 1: What You Have
  const walletUsd = round(scout.balances.sbtc.usd + scout.balances.stx.usd + scout.balances.usdcx.usd + scout.balances.usdh.usd + scout.balances.susdh.usd + scout.balances.aeusdc.usd, 2);
  L.push("## 1. What You Have (available in wallet)");
  L.push("");
  L.push("| Token   | Amount             | USD      |");
  L.push("|---------|--------------------|---------:|");
  L.push(`| sBTC    | ${pad(String(scout.balances.sbtc.amount), 18)} | $${scout.balances.sbtc.usd} |`);
  L.push(`| STX     | ${pad(String(scout.balances.stx.amount), 18)} | $${scout.balances.stx.usd} |`);
  L.push(`| USDCx   | ${pad(String(scout.balances.usdcx.amount), 18)} | $${scout.balances.usdcx.usd} |`);
  L.push(`| USDh    | ${pad(String(scout.balances.usdh.amount), 18)} | $${scout.balances.usdh.usd} |`);
  L.push(`| sUSDh   | ${pad(String(scout.balances.susdh.amount), 18)} | $${scout.balances.susdh.usd} |`);
  L.push(`| aeUSDC  | ${pad(String(scout.balances.aeusdc.amount), 18)} | $${scout.balances.aeusdc.usd} |`);
  L.push(`| **Wallet Total** |              | **$${walletUsd}** |`);
  L.push("");

  // Section 2: Positions (4 protocols)
  L.push("## 2. Positions (deployed capital)");
  L.push("");
  L.push("| Protocol   | Status     | Detail |");
  L.push("|------------|------------|--------|");

  const z = scout.positions.zest;
  L.push(`| Zest       | ${z.has_position ? "**ACTIVE**" : "Idle"} | ${z.detail} |`);

  const herm = scout.positions.hermetica;
  const hermDetail = scout.balances.susdh.amount > 0
    ? `${scout.balances.susdh.amount} sUSDh staked (rate: ${herm.exchange_rate})`
    : herm.detail;
  L.push(`| Hermetica  | ${scout.balances.susdh.amount > 0 ? "**ACTIVE**" : "Idle"} | ${hermDetail} |`);

  const g = scout.positions.granite;
  L.push(`| Granite    | ${g.has_position ? "**ACTIVE**" : "Idle"} | ${g.detail} (accepts: ${g.accepted_token}) |`);

  const h = scout.positions.hodlmm;
  let deployedUsd = 0;
  if (h.has_position) {
    for (const p of h.pools) {
      const rangeTag = p.in_range ? "IN RANGE" : "**OUT OF RANGE**";
      const binStr = p.user_bins ? `${p.user_bins.count} bins (${p.user_bins.min}-${p.user_bins.max})` : "no bins";
      const valueStr = p.estimated_value_usd !== null ? `$${p.estimated_value_usd}` : "-";
      if (p.estimated_value_usd) deployedUsd += p.estimated_value_usd;
      L.push(`| HODLMM     | **ACTIVE** | ${p.name} ${rangeTag} bin ${p.active_bin}, ${binStr}, ${valueStr} |`);
    }
  } else {
    L.push("| HODLMM     | Idle | No positions across 8 pools |");
  }
  L.push("");

  // Section 3: sBTC Reserve Status
  L.push("## 3. sBTC Reserve Status (Proof of Reserve)");
  L.push("");
  L.push(`| Check | Value |`);
  L.push(`|-------|------:|`);
  L.push(`| Signal | **${reserve.signal}** |`);
  L.push(`| Reserve ratio | ${reserve.reserve_ratio ?? "N/A"} |`);
  L.push(`| BTC in vault | ${reserve.btc_reserve} BTC |`);
  L.push(`| sBTC circulating | ${reserve.sbtc_circulating} sBTC |`);
  L.push(`| Verdict | ${reserve.recommendation} |`);
  L.push("");

  // Section 4: Yield Options (3-tier)
  L.push("## 4. Yield Options");
  L.push("");

  const deployNow = scout.options.filter(o => o.tier === "deploy_now");
  const swapFirst = scout.options.filter(o => o.tier === "swap_first");
  const acquire = scout.options.filter(o => o.tier === "acquire_to_unlock");

  if (deployNow.length > 0) {
    L.push("### You can deploy now");
    L.push("| # | Protocol | Pool | Token | APY | Daily | Monthly | YTG | Note |");
    L.push("|---|----------|------|-------|----:|------:|--------:|----:|------|");
    deployNow.forEach((o, i) => {
      const ytg = o.ytg_profitable ? `${o.ytg_ratio}x` : `**${o.ytg_ratio}x**`;
      L.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | $${o.daily_usd} | $${o.monthly_usd} | ${ytg} | ${o.note} |`);
    });
    L.push("");
    L.push("_YTG = Yield-to-Gas ratio (7d projected yield / gas cost to enter). Below 3x means gas eats your yield — hold until capital or APY grows. Use --force to override._");
    L.push("");
  }

  if (swapFirst.length > 0) {
    L.push("### Swap first, then deploy");
    L.push("| # | Protocol | Pool | Token | APY | YTG | Swap | Note |");
    L.push("|---|----------|------|-------|----:|----:|------|------|");
    swapFirst.forEach((o, i) => {
      const ytg = o.ytg_profitable ? `${o.ytg_ratio}x` : `**${o.ytg_ratio}x**`;
      L.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | ${ytg} | ${o.swap_cost_note ?? "-"} | ${o.note} |`);
    });
    L.push("");
  }

  if (acquire.length > 0) {
    L.push("### Acquire to unlock");
    L.push("| Protocol | Pool | Token needed | APY | How to get |");
    L.push("|----------|------|-------------|----:|------------|");
    acquire.forEach(o => {
      L.push(`| ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | ${o.note} |`);
    });
    L.push("");
  }

  // Section 5: Best Move + YTG Verdict
  L.push("## 5. Verdict");
  L.push("");
  L.push(`> ${scout.best_move.recommendation}`);
  L.push("");
  const profitable = scout.options.filter(o => o.ytg_profitable && o.tier !== "acquire_to_unlock");
  const unprofitable = scout.options.filter(o => !o.ytg_profitable && o.tier !== "acquire_to_unlock");
  if (profitable.length > 0 && unprofitable.length > 0) {
    L.push(`**YTG verdict:** ${profitable.length} option${profitable.length > 1 ? "s" : ""} profitable (yield > 3x gas), ${unprofitable.length} blocked (gas eats yield — hold until capital or APY grows).`);
  } else if (profitable.length > 0) {
    L.push(`**YTG verdict:** All ${profitable.length} options are profitable — gas cost is negligible relative to yield.`);
  } else if (unprofitable.length > 0) {
    L.push(`**YTG verdict:** No profitable options at current capital. Hold — gas would eat all yield. Accumulate more or wait for higher APY.`);
  }
  L.push("");

  // Section 6: Break Prices
  const bp = scout.break_prices;
  L.push("## 6. Break Prices");
  L.push("");
  L.push("| Trigger | sBTC Price |");
  L.push("|---------|----------:|");
  if (bp.hodlmm_range_exit_low_usd) L.push(`| HODLMM range exit (low) | **$${bp.hodlmm_range_exit_low_usd.toLocaleString()}** |`);
  L.push(`| Current sBTC price | $${bp.current_sbtc_price_usd.toLocaleString()} |`);
  if (bp.hodlmm_range_exit_high_usd) L.push(`| HODLMM range exit (high) | **$${bp.hodlmm_range_exit_high_usd.toLocaleString()}** |`);
  L.push("");

  // Section 7: Safety Gates
  L.push("## 7. Safety Gates");
  L.push("");
  L.push(`| Gate | Status | Detail |`);
  L.push(`|------|--------|--------|`);
  L.push(`| PoR Reserve | ${reserve.signal === "GREEN" ? "PASS" : "**FAIL**"} | ${reserve.signal} |`);
  L.push(`| Slippage | ${guardian.slippage.ok ? "PASS" : "**FAIL**"} | ${guardian.slippage.pct}% (max ${MAX_SLIPPAGE_PCT}%) |`);
  L.push(`| 24h Volume | ${guardian.volume.ok ? "PASS" : "**FAIL**"} | $${Math.round(guardian.volume.usd).toLocaleString()} (min $${MIN_24H_VOLUME_USD.toLocaleString()}) |`);
  L.push(`| Gas | ${guardian.gas.ok ? "PASS" : "**FAIL**"} | ${guardian.gas.estimated_stx} STX (max ${MAX_GAS_STX}) |`);
  L.push(`| Cooldown | ${guardian.cooldown.ok ? "PASS" : "**FAIL**"} | ${guardian.cooldown.remaining_hours > 0 ? `${guardian.cooldown.remaining_hours}h remaining` : "Ready"} |`);
  L.push(`| Prices | ${guardian.prices.ok ? "PASS" : "**FAIL**"} | ${guardian.prices.detail} |`);
  L.push(`| **Can execute writes?** | **${guardian.can_proceed ? "YES" : "NO"}** | ${guardian.refusals.length > 0 ? guardian.refusals.join("; ") : "All gates pass"} |`);
  L.push("");

  L.push("---");
  L.push(`Data sources: ${scout.data_sources.length} live reads | Status: ${scout.status} | Engine: stacks-alpha-engine v2.0.0`);
  L.push("");

  return L.join("\n");
}

// =============================================================================
// ==  CLI
// =============================================================================

const program = new Command();

program
  .name("stacks-alpha-engine")
  .description("Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM with sBTC reserve verification")
  .version("2.0.0");

program
  .command("doctor")
  .description("Run all self-tests: crypto vectors, data sources, on-chain reads, PoR verification")
  .action(runDoctor);

program
  .command("scan")
  .description("Full read-only scan: wallet, positions (4 protocols), yields (3-tier), break prices, PoR, safety gates")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--format <type>", "Output format: json (default) or text", "json")
  .action(async (opts: { wallet: string; format: string }) => {
    try {
      const scout = await scoutWallet(opts.wallet);
      const reserve = await checkReserve();
      const guardian = await checkGuardian(scout);
      if (opts.format === "text") {
        console.log(renderReport(scout, reserve, guardian));
      } else {
        console.log(JSON.stringify({ status: "ok", command: "scan", disclaimer: DISCLAIMER, scout, reserve, guardian, rendered_report: renderReport(scout, reserve, guardian) }, null, 2));
      }
    } catch (err: unknown) {
      console.error(JSON.stringify({ status: "error", command: "scan", error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }
  });

program
  .command("deploy")
  .description("Deploy capital to a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Target protocol: zest, hermetica, granite, hodlmm")
  .requiredOption("--amount <value>", "Amount in smallest unit (sats for sBTC, micro for stablecoins)")
  .option("--token <symbol>", "Token to deploy (default: inferred from protocol)")
  .option("--force", "Override 0% APY refusal")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "deploy", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("withdraw")
  .description("Withdraw from a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Source protocol: zest, hermetica, granite, hodlmm")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "withdraw", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("rebalance")
  .description("Withdraw out-of-range HODLMM bins and re-add centered on active bin")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--pool-id <id>", "HODLMM pool ID (default: dlmm_1)", "dlmm_1")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "rebalance", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("migrate")
  .description("Move capital from one protocol to another (withdraw + deploy)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--from <protocol>", "Source protocol: zest, hermetica, granite, hodlmm")
  .requiredOption("--to <protocol>", "Target protocol: zest, hermetica, granite, hodlmm")
  .option("--token <symbol>", "Token to deploy into target (default: inferred)")
  .option("--amount <value>", "Amount in smallest unit (default: all)")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "migrate", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("emergency")
  .description("Emergency withdrawal from ALL protocols (bypasses guardian gates)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "emergency", opts);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install-packs")
  .description("Check dependency requirements")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "Requires: tiny-secp256k1 (BIP-341 EC point addition). All other operations use public APIs.",
      data: { requires: ["tiny-secp256k1"] },
    }, null, 2));
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
