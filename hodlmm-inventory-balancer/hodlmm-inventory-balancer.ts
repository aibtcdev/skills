#!/usr/bin/env bun
/**
 * hodlmm-inventory-balancer — Restore a target HODLMM LP token-exposure ratio.
 *
 * Detects INVENTORY drift (token-ratio imbalance from one-sided swap flow), not
 * price drift. Executes a corrective Bitflow swap and a redeploy via
 * hodlmm-move-liquidity, gated by the shared 4h per-pool cooldown.
 *
 * Commands:
 *   install-packs — install @stacks/* deps
 *   doctor        — pre-flight: wallet, Bitflow APIs, cooldown state, state marker
 *   status        — read-only ratio + deviation per eligible pool
 *   recommend     — dry-run cycle plan (swap + redeploy plan)
 *   run           — execute cycle (requires --confirm=BALANCE)
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

// DLMM swap router — user-facing swap entrypoint with built-in min-out protection.
// Verified via contract read on 2026-04-17: swap-(x|y)-for-(y|x)-simple-multi takes
// (pool-trait, x-token-trait, y-token-trait, amount uint, min-out uint) and internally
// asserts received >= min-out (ERR_MINIMUM_RECEIVED) — contract-level slippage.
const DLMM_SWAP_ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const DLMM_SWAP_ROUTER_NAME = "dlmm-swap-router-v-1-1";

// DLMM liquidity router — used by the opt-in `--allow-rebalance-withdraw` mode to
// withdraw a slice of the overweight bin and redeposit swapped proceeds on the
// underweight side. Same mainnet deployer as the swap router; contract functions
// used: `withdraw-relative-liquidity-same-multi`, `add-relative-liquidity-same-multi`.
const DLMM_LIQUIDITY_ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const DLMM_LIQUIDITY_ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// Contract principals for tokens we support. STX wrapper implements SIP-010 but
// transfers move native STX under the hood → STX post-conditions, not FT.
const STX_WRAPPER_CONTRACT = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
// Asset names verified against on-chain `define-fungible-token` directives (2026-04-17).
// Override at runtime with TOKEN_ASSETS_OVERRIDE env var (JSON map {"contract": "asset-name"}).
const TOKEN_ASSET_NAMES: Record<string, string> = {
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token": "sbtc-token",
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx": "usdcx-token",
  "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc": "aeUSDC",
  "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1": "usdh",
};

const FETCH_TIMEOUT = 30_000;
// Bitflow DLMM bin layout: bin 500 is the canonical 1:1 center; activeBinOffset
// = bin_id - CENTER_BIN_ID. All relative-offset math elsewhere assumes this.
const CENTER_BIN_ID = 500;
// Fixed-point denominator for bin prices from the Bitflow quotes API.
// raw_y_for_swap = raw_x_in * price / PRICE_SCALE.
const PRICE_SCALE = 1e8;

// Reads state owned by hodlmm-move-liquidity (authoritative source for redeploy cooldown)
const MOVE_LIQUIDITY_STATE_FILE = path.join(os.homedir(), ".hodlmm-move-liquidity-state.json");
const MOVE_LIQUIDITY_COOLDOWN_MS = 4 * 60 * 60 * 1000;

// Our own state file — tracks incomplete cycles and meta-cooldown
const INVENTORY_STATE_FILE = path.join(os.homedir(), ".hodlmm-inventory-balancer-state.json");
const INVENTORY_META_COOLDOWN_MS = 60 * 60 * 1000; // 1h

const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

const DEFAULT_MIN_DRIFT_PCT = 5;
const DEFAULT_MAX_CORRECTION_SATS = 500_000;
const DEFAULT_MAX_QUOTE_STALENESS_SECONDS = 45;
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%
const STX_GAS_FLOOR_USTX = 500_000n; // 0.5 STX reserved for gas
const MIN_SWAP_SATS = 1000n; // refuse tiny swaps

// --allow-rebalance-withdraw: opt-in 3-leg mode (withdraw-slice → swap → redeposit)
// that lets the skill hit target ± --min-drift-pct on positions v1's swap+recenter
// path alone cannot balance. Guardrails: REBALANCE_MAX_SLICE_BPS caps how much of
// the overweight bin's shares a single cycle may withdraw (deterministic upper
// bound on capital motion). REBALANCE_ADD_OFFSET_BINS is the number of bins on
// either side of active the redeposit walks (narrow by default — tight bin cluster
// around active = swap proceeds land as concentrated liquidity close to mid-price).
const REBALANCE_MAX_SLICE_BPS = 8000;       // at most 80% of a single bin's shares
const REBALANCE_ADD_OFFSET_BINS = 1;        // deposit at active ±1 (3 bins total)
const REBALANCE_ADD_TOLERANCE_BINS = 2;     // active-bin drift tolerance on deposit

// Pool volume floor — refuse corrective swaps on pools whose bin-level reserves
// (across bins we'd touch) are too thin to absorb the swap without moving the
// price by more than the slippage budget. #493 safety contract: "Pool volume
// too thin to support corrective swap without moving the pool price."
// Conservative: require the active bin's reserve of the OUTPUT token to be at
// least THIN_POOL_MIN_RATIO × the expected output.
const THIN_POOL_MIN_RATIO = 3n; // active-bin reserve must be ≥ 3× expected output

// Post-broadcast verification sleep — lets the first Nakamoto block settle so
// ratio_after reflects the post-swap state. #493 step 6 requires re-reading
// and emitting before/after ratios.
const VERIFY_SLEEP_MS = 10_000;

// v1 scope: Bitflow-tradeable HODLMM pools. Eligibility is derived dynamically
// from /api/app/v1 per-pool state — no hardcoded allowlist. Predicates below.
//
// HODLMM_POOL_DEPLOYER is the single mainnet address that deploys DLMM pool
// contracts; JingSwap and other AMMs use different deployers, so contract-prefix
// match is the JingSwap-exclusion predicate Diego asked for (not an allowlist).
const HODLMM_POOL_DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";

function isEligibleHodlmmPool(p: PoolMeta): boolean {
  return p.pool_status === true && p.pool_contract.startsWith(`${HODLMM_POOL_DEPLOYER}.`);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  pool_status: boolean;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface RatioSummary {
  pool_id: string;
  pair: string;
  active_bin: number;
  user_bins: number[];
  total_x_raw: string;
  total_y_raw: string;
  total_x_in_y: string; // Y-units — X valued at its bin price
  total_value_in_y: string;
  current_x_ratio: number; // 0..1 (fraction of value in X)
  current_y_ratio: number;
  target_x_ratio: number;
  target_y_ratio: number;
  deviation_abs: number; // |current_x - target_x|, 0..1
  quote_staleness_seconds: number;
  quote_fetched_at: string;
}

interface SwapPlan {
  direction: "X->Y" | "Y->X";
  token_in: string; // contract principal
  token_in_symbol: string;
  token_in_decimals: number;
  token_out: string;
  token_out_symbol: string;
  token_out_decimals: number;
  amount_in_raw: string;
  expected_amount_out_raw: string;
  minimum_amount_out_raw: string;
  slippage_bps: number;
  quote_source: string;
  quote_fetched_at: string;
}

interface InventoryState {
  // Per-pool state
  [poolId: string]: {
    last_cycle_at?: string;
    last_cycle_status?:
      | "success"
      | "swap_done_redeploy_pending"
      | "withdraw_done_swap_pending"
      | "withdraw_done_swap_done_redeposit_pending"
      | "aborted";
    last_swap_tx?: string;
    last_redeploy_tx?: string;
    last_withdraw_tx?: string;
    last_redeposit_tx?: string;
    last_cycle_mode?: "default" | "rebalance_withdraw";
    swap_pending_details?: {
      swap_tx: string;
      swap_direction: "X->Y" | "Y->X";
      swap_amount_in_raw: string;
      swap_minimum_out_raw: string;
      target_ratio_x: number;
      captured_at: string;
    };
    // Captured at leg-1 success in the 3-leg flow so legs 2+3 can rebuild
    // the contract calls on resume without re-planning. Re-planning mid-cycle
    // would need to derive amounts from on-chain tx events of the prior leg —
    // brittle and indexer-lag-prone — so we snapshot the original plan instead.
    rebalance_pending_details?: {
      swap: SwapPlan;
      redeposit: RedepositPlan;
      target_ratio_x: number;
      captured_at: string;
    };
  };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(status: "success" | "error" | "blocked", action: string, data: unknown, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function err(action: string, message: string, data: unknown = null): never {
  out("error", action, data, message);
  process.exit(1);
}

function log(...args: unknown[]): void {
  process.stderr.write(`[inventory-balancer] ${args.join(" ")}\n`);
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as string);
  if (!fs.existsSync(WALLETS_FILE)) {
    throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
  }
  const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  const activeWallet = (walletsJson.wallets ?? [])[0];
  if (!activeWallet?.id) throw new Error("No active wallet configured.");
  const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
  if (!fs.existsSync(keystorePath)) throw new Error(`Keystore not found at ${keystorePath}`);
  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
  const enc = keystore.encrypted;
  if (!enc?.ciphertext) {
    const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
    if (!legacyEnc) throw new Error("Keystore format unrecognized.");
    const { decryptMnemonic } = await import("@stacks/encryption" as string);
    const mnemonic = await decryptMnemonic(legacyEnc, password);
    const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
    const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
    return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
  }
  const { scryptSync, createDecipheriv } = await import("crypto");
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
    N: enc.scryptParams?.N ?? 16384,
    r: enc.scryptParams?.r ?? 8,
    p: enc.scryptParams?.p ?? 1,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
}

// ─── Bitflow API reads ────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  // Bitflow App v1 response: camelCase with nested tokens.{tokenX,tokenY}.
  // No active_bin at this endpoint; we fetch it per-pool from the quotes bins endpoint.
  const raw = await fetchJson<{ data?: unknown[]; [k: string]: unknown }>(`${BITFLOW_APP}/pools?amm_type=dlmm`);
  const list = (raw.data ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  return list.map((p) => {
    const tokens = (p.tokens ?? {}) as Record<string, Record<string, unknown>>;
    const tx = tokens.tokenX ?? {};
    const ty = tokens.tokenY ?? {};
    return {
      pool_id: String(p.poolId ?? ""),
      pool_contract: String(p.poolContract ?? ""),
      pool_status: p.poolStatus === true,
      token_x: String(tx.contract ?? ""),
      token_y: String(ty.contract ?? ""),
      token_x_symbol: String(tx.symbol ?? "?"),
      token_y_symbol: String(ty.symbol ?? "?"),
      token_x_decimals: Number(tx.decimals ?? 8),
      token_y_decimals: Number(ty.decimals ?? 6),
      active_bin: 0, // populated from /bins/<poolId>.active_bin_id
      bin_step: Number(p.binStep ?? 0),
    };
  });
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[]; fetched_at: string }> {
  const fetched_at = new Date().toISOString();
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins, fetched_at };
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  // Best-effort across field-name variants — the App API returns user bins with
  // either snake_case or camelCase keys depending on endpoint version.
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  ).catch(() => ({ bins: [] as unknown[] }));
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => BigInt(String(b.user_liquidity ?? b.userLiquidity ?? b.liquidity ?? "0")) > 0n)
    .map((b) => ({
      bin_id: Number(b.bin_id ?? b.binId),
      liquidity: String(b.user_liquidity ?? b.userLiquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
      reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchStxBalanceUstx(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, string>>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(data?.balance ?? "0");
}

async function fetchTokenBalanceRaw(wallet: string, asset: TokenAsset): Promise<bigint> {
  if (asset.kind === "stx") return fetchStxBalanceUstx(wallet);
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/balances`
  );
  const fts = (data.fungible_tokens ?? {}) as Record<string, { balance?: string }>;
  const key = `${asset.contract}::${asset.assetName}`;
  return BigInt(fts[key]?.balance ?? "0");
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/nonces`);
  const nextNonce = data.possible_next_nonce;
  if (nextNonce !== undefined && nextNonce !== null) return BigInt(Number(nextNonce));
  const lastExec = data.last_executed_tx_nonce;
  if (lastExec !== undefined && lastExec !== null) return BigInt(Number(lastExec) + 1);
  return 0n;
}

// Stacks fee estimation. Queries Hiro `/v2/fees/transfer` for the current
// uSTX-per-byte rate, multiplies by a conservative byte budget for the swap tx
// (~500 bytes for swap-simple-multi with a sender-pin post-condition), and
// floors at FEE_SWAP_FLOOR_USTX so we never pay below the upstream mempool
// acceptance threshold. Same mempool-derived-with-floor pattern as the
// upstream aibtcdev/skills#338 fix to hodlmm-move-liquidity.
const FEE_SWAP_FLOOR_USTX = 250_000n;
const FEE_SWAP_BYTES_BUDGET = 500n;

async function estimateSwapFeeUstx(): Promise<bigint> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(`${HIRO_API}/v2/fees/transfer`, { signal: controller.signal });
      if (!res.ok) return FEE_SWAP_FLOOR_USTX;
      const ratePerByte = BigInt(Math.max(0, Math.ceil(Number(await res.json()))));
      const estimated = ratePerByte * FEE_SWAP_BYTES_BUDGET;
      return estimated > FEE_SWAP_FLOOR_USTX ? estimated : FEE_SWAP_FLOOR_USTX;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return FEE_SWAP_FLOOR_USTX;
  }
}

async function fetchPendingMempoolTxCount(wallet: string): Promise<number> {
  try {
    const data = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/address/${wallet}/mempool`
    );
    const results = data.results as unknown[] | undefined;
    return Array.isArray(results) ? results.length : 0;
  } catch {
    return 0;
  }
}

// ─── Move-liquidity cooldown ──────────────────────────────────────────────────

function readMoveLiquidityCooldownMs(poolId: string): number {
  if (!fs.existsSync(MOVE_LIQUIDITY_STATE_FILE)) return 0;
  try {
    const state = JSON.parse(fs.readFileSync(MOVE_LIQUIDITY_STATE_FILE, "utf-8")) as Record<
      string,
      { last_move_at?: string }
    >;
    const entry = state[poolId];
    if (!entry?.last_move_at) return 0;
    const elapsed = Date.now() - new Date(entry.last_move_at).getTime();
    return Math.max(0, MOVE_LIQUIDITY_COOLDOWN_MS - elapsed);
  } catch {
    return 0;
  }
}

// ─── Our state file ───────────────────────────────────────────────────────────

function loadInventoryState(): InventoryState {
  try {
    return JSON.parse(fs.readFileSync(INVENTORY_STATE_FILE, "utf-8")) as InventoryState;
  } catch {
    return {};
  }
}

function saveInventoryState(state: InventoryState): void {
  fs.writeFileSync(INVENTORY_STATE_FILE, JSON.stringify(state, null, 2));
}

function inventoryMetaCooldownMs(state: InventoryState, poolId: string): number {
  const entry = state[poolId];
  if (!entry?.last_cycle_at) return 0;
  const elapsed = Date.now() - new Date(entry.last_cycle_at).getTime();
  return Math.max(0, INVENTORY_META_COOLDOWN_MS - elapsed);
}

// ─── Ratio computer ───────────────────────────────────────────────────────────
//
// Arc's invariant: bins STRICTLY below active hold only Y; bins STRICTLY above
// hold only X; active bin holds both. Ratios MUST be price-weighted — raw sums
// misrepresent exposure because X and Y are in different units and different
// bins contribute at different prices.
//
// We express everything in Y-units (no USD conversion needed):
//   bin_value_in_y = reserve_y + reserve_x * bin_price / PRICE_SCALE
//   total_value_in_y = Σ bin_value_in_y
//   total_x_in_y = Σ (reserve_x * bin_price / PRICE_SCALE)
//   current_x_ratio = total_x_in_y / total_value_in_y

function computeRatio(
  pool: PoolMeta,
  userBins: UserBin[],
  poolBins: BinData[],
  activeBin: number,
  targetXRatio: number,
  quoteFetchedAt: string
): RatioSummary {
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));

  let totalXRaw = 0n;
  let totalYRaw = 0n;
  // Bitflow bin `price` is an integer string already scaled so that:
  //   raw_y_per_raw_x = price / PRICE_SCALE
  // No separate token-decimal math — the scale bakes the x/y decimal delta in.
  //   x_value_in_raw_y = reserve_x * price / PRICE_SCALE
  let totalXValueY = 0n; // raw-Y units (rounded-down integer)
  let totalYValueY = 0n; // raw-Y units

  for (const ub of userBins) {
    let rx = BigInt(ub.reserve_x || "0");
    let ry = BigInt(ub.reserve_y || "0");
    const pb = poolBinMap.get(ub.bin_id);
    const priceStr = (ub.price && ub.price !== "0") ? ub.price : pb?.price ?? "0";
    if ((rx === 0n && ry === 0n) && pb) {
      const poolDlp = BigInt(pb.liquidity || "0");
      const userDlp = BigInt(ub.liquidity || "0");
      if (poolDlp > 0n && userDlp > 0n) {
        rx = (userDlp * BigInt(pb.reserve_x)) / poolDlp;
        ry = (userDlp * BigInt(pb.reserve_y)) / poolDlp;
      }
    }
    totalXRaw += rx;
    totalYRaw += ry;

    const priceRaw = BigInt(priceStr || "0");
    const xValueY = priceRaw === 0n ? 0n : (rx * priceRaw) / BigInt(PRICE_SCALE);
    totalXValueY += xValueY;
    totalYValueY += ry;
  }

  const totalValueY = totalXValueY + totalYValueY;
  const currentXRatio =
    totalValueY === 0n ? 0 : Number((totalXValueY * 1_000_000n) / totalValueY) / 1_000_000;
  const currentYRatio = 1 - currentXRatio;
  const deviationAbs = Math.abs(currentXRatio - targetXRatio);

  const quoteStalenessSeconds = Math.max(0, Math.floor((Date.now() - new Date(quoteFetchedAt).getTime()) / 1000));

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    user_bins: userBins.map((b) => b.bin_id).sort((a, b) => a - b),
    total_x_raw: totalXRaw.toString(),
    total_y_raw: totalYRaw.toString(),
    total_x_in_y: totalXValueY.toString(),
    total_value_in_y: totalValueY.toString(),
    current_x_ratio: Number(currentXRatio.toFixed(4)),
    current_y_ratio: Number(currentYRatio.toFixed(4)),
    target_x_ratio: Number(targetXRatio.toFixed(4)),
    target_y_ratio: Number((1 - targetXRatio).toFixed(4)),
    deviation_abs: Number(deviationAbs.toFixed(4)),
    quote_staleness_seconds: quoteStalenessSeconds,
    quote_fetched_at: quoteFetchedAt,
  };
}

// ─── Corrective-swap planner ──────────────────────────────────────────────────
//
// Given current vs target X-ratio, pick the direction and size to bring the
// value back within target ± min-drift-pct. Cap at max-correction-sats.
// Minimum-out is computed from expected output using slippage budget.
//
// Approximation: for a single corrective swap, ignore pool-price slippage on
// the correction itself (conservative: we only correct PART of the gap each
// cycle, not all of it — meta-cooldown prevents re-firing too quickly).

interface PlannerInputs {
  ratio: RatioSummary;
  pool: PoolMeta;
  activeBinPriceScaled: bigint;
  minDriftPct: number;
  maxCorrectionSats: bigint;
  slippageBps: number;
  // 1 minus the wallet's available side. If we're over-weight X, we sell X for Y, so the swap burns X.
}

function planCorrectiveSwap(inputs: PlannerInputs): SwapPlan | null {
  const { ratio, pool, activeBinPriceScaled, maxCorrectionSats, slippageBps, minDriftPct } = inputs;
  if (ratio.deviation_abs * 100 < minDriftPct) return null;

  const totalValueY = BigInt(ratio.total_value_in_y);
  if (totalValueY === 0n || activeBinPriceScaled === 0n) return null;

  const overWeightX = ratio.current_x_ratio > ratio.target_x_ratio;
  // Halfway conservative correction — smooths flow-driven oscillation and matches
  // Arc's "conservative sizing" guidance.
  const gapAbs = Math.abs(ratio.current_x_ratio - ratio.target_x_ratio);
  const gapMicro = BigInt(Math.floor(gapAbs * 1_000_000));
  const correctionValueY = (totalValueY * gapMicro) / 2_000_000n; // in raw Y units

  // Bitflow bin price semantic: raw_y = raw_x * price / PRICE_SCALE.
  // → raw_x = raw_y * PRICE_SCALE / price.

  let amountInRaw: bigint;
  let expectedOutRaw: bigint;
  let direction: "X->Y" | "Y->X";
  let tokenIn: string;
  let tokenOut: string;
  let tokenInSymbol: string;
  let tokenOutSymbol: string;
  let tokenInDecimals: number;
  let tokenOutDecimals: number;

  if (overWeightX) {
    direction = "X->Y";
    tokenIn = pool.token_x;
    tokenOut = pool.token_y;
    tokenInSymbol = pool.token_x_symbol;
    tokenOutSymbol = pool.token_y_symbol;
    tokenInDecimals = pool.token_x_decimals;
    tokenOutDecimals = pool.token_y_decimals;
    amountInRaw = (correctionValueY * BigInt(PRICE_SCALE)) / activeBinPriceScaled;
    expectedOutRaw = correctionValueY;
  } else {
    direction = "Y->X";
    tokenIn = pool.token_y;
    tokenOut = pool.token_x;
    tokenInSymbol = pool.token_y_symbol;
    tokenOutSymbol = pool.token_x_symbol;
    tokenInDecimals = pool.token_y_decimals;
    tokenOutDecimals = pool.token_x_decimals;
    amountInRaw = correctionValueY;
    expectedOutRaw = (correctionValueY * BigInt(PRICE_SCALE)) / activeBinPriceScaled;
  }

  // Cap at max-correction-sats for the sell token (interpreted as sat-denominated for 8-dec tokens;
  // for 6-dec tokens the raw-unit cap is still the conservative practical limit).
  if (amountInRaw > maxCorrectionSats) {
    const scale = Number(amountInRaw) / Number(maxCorrectionSats);
    amountInRaw = maxCorrectionSats;
    expectedOutRaw = BigInt(Math.floor(Number(expectedOutRaw) / scale));
  }

  if (amountInRaw < MIN_SWAP_SATS) return null;

  const minimumOutRaw = (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    direction,
    token_in: tokenIn,
    token_in_symbol: tokenInSymbol,
    token_in_decimals: tokenInDecimals,
    token_out: tokenOut,
    token_out_symbol: tokenOutSymbol,
    token_out_decimals: tokenOutDecimals,
    amount_in_raw: amountInRaw.toString(),
    expected_amount_out_raw: expectedOutRaw.toString(),
    minimum_amount_out_raw: minimumOutRaw.toString(),
    slippage_bps: slippageBps,
    quote_source: `${BITFLOW_QUOTES}/bins/${ratio.pool_id}#active_bin_price`,
    quote_fetched_at: ratio.quote_fetched_at,
  };
}

// ─── Bitflow swap execution (HODLMM pool direct-call) ─────────────────────────
//
// v1 corrective swap goes through the HODLMM pool contract directly — single
// hop through the same pool we're balancing. Post-conditions: Deny with an FT
// receive condition on `minimum_amount_out_raw`.

// Unified token-kind resolver — single source of truth for "is this native STX
// (via the wrapper passthrough) or a real SIP-010?" Post-conditions, balance
// gates, and any future token-handling branch should go through this helper so
// the two codepaths cannot drift out of sync (per @arc0btc's observation on
// bff-skills #494).
type TokenAsset =
  | { kind: "stx" }
  | { kind: "ft"; contract: `${string}.${string}`; assetName: string };

function resolveTokenAsset(contract: string): TokenAsset {
  if (contract === STX_WRAPPER_CONTRACT) return { kind: "stx" };
  const override = process.env.TOKEN_ASSETS_OVERRIDE;
  let assetName: string | undefined;
  if (override) {
    try {
      const map = JSON.parse(override) as Record<string, string>;
      if (map[contract]) assetName = map[contract];
    } catch { /* ignore */ }
  }
  if (!assetName) assetName = TOKEN_ASSET_NAMES[contract];
  if (!assetName) {
    // Fall back to the contract name — safe for contracts that use
    // `(define-fungible-token <contract-name>)`, unsafe otherwise. Flagged loudly.
    assetName = contract.split(".")[1] ?? contract;
    log(`WARN: no verified asset-name for ${contract}, falling back to contract-name '${assetName}'`);
  }
  return { kind: "ft", contract: contract as `${string}.${string}`, assetName };
}

async function executeCorrectiveSwap(
  privateKey: string,
  senderAddress: string,
  pool: PoolMeta,
  plan: SwapPlan,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    uintCV,
    boolCV,
    listCV,
    tupleCV,
    contractPrincipalCV,
    PostConditionMode,
    AnchorMode,
    Pc,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const amountIn = BigInt(plan.amount_in_raw);
  const minOut = BigInt(plan.minimum_amount_out_raw);

  const inAsset = resolveTokenAsset(plan.token_in);
  const outAsset = resolveTokenAsset(plan.token_out);

  // Post-conditions: dual pins under existing Allow mode, closing @diegomey's item 2
  // from the #494 review per @macbotmini-eng's audit. Mirrors the author's mainnet
  // refs 0x134df5e1… and 0x5195822e… (and the broader 0x958719b5… / 0x9f3731fc…
  // baseline for swap-simple-multi):
  //   - PC[0] caller's max input — Pc.principal(sender).willSendLte(amountIn)
  //   - PC[1] pool's min output — Pc.principal(pool).willSendGte(minOut)
  // The output PC is anchored on the POOL principal (the pool sends the output
  // token to the caller), not the caller — Stacks post-conditions evaluate against
  // the principal that is sending the asset, so a "user receives ≥ X" invariant
  // is expressed as "pool sends ≥ X". @stacks/transactions Pc builder exposes
  // willSendGte; there is no willReceiveGte primitive (the receive-side framing
  // doesn't exist at the protocol level).
  // Allow mode (vs Deny + enumerate-each-fee) remains because protocol/provider
  // fees accrue inside dlmm-core's `unclaimed-protocol-fees` map and bin balances
  // — they do NOT emit FT transfer events on the swap tx (verified on-chain), so
  // the receive-side pool pin is orthogonal to the fee-flow surface.
  const senderPin = Pc.principal(senderAddress).willSendLte(amountIn);
  const poolPin = Pc.principal(pool.pool_contract).willSendGte(minOut);
  const pcs: unknown[] = [
    inAsset.kind === "stx" ? senderPin.ustx() : senderPin.ft(inAsset.contract, inAsset.assetName),
    outAsset.kind === "stx" ? poolPin.ustx() : poolPin.ft(outAsset.contract, outAsset.assetName),
  ];

  // Canonical entrypoint: swap-simple-multi takes a list of swap tuples.
  // Single-hop in our case → list of 1. max-steps=319 (contract MAX_STEPS).
  const swapTuple = tupleCV({
    "pool-trait": contractPrincipalCV(poolAddr, poolName),
    "x-token-trait": contractPrincipalCV(xAddr, xName),
    "y-token-trait": contractPrincipalCV(yAddr, yName),
    amount: uintCV(amountIn),
    "min-received": uintCV(minOut),
    "x-for-y": boolCV(plan.direction === "X->Y"),
    // max-steps bounds how many bins the router walks. Tiny corrective swaps
    // finish in 1–2 bins; 10 gives headroom without overallocating the fold.
    "max-steps": uintCV(10),
  });

  const fee = await estimateSwapFeeUstx();
  const tx = await makeContractCall({
    contractAddress: DLMM_SWAP_ROUTER_ADDR,
    contractName: DLMM_SWAP_ROUTER_NAME,
    functionName: "swap-simple-multi",
    functionArgs: [listCV([swapTuple])],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,
    postConditions: pcs as never[],
    anchorMode: AnchorMode.Any,
    nonce,
    fee,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Swap broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

// ─── 3-leg rebalance: withdraw-slice → swap → redeposit ──────────────────────
//
// Opt-in via `--allow-rebalance-withdraw`. Completes the skill's "balancer"
// claim on positions where v1's swap + bin-to-bin redeploy cannot close the
// gap (e.g. sprawled all-Y bins below active). Emitted instead of the default
// swap+redeploy when the flag is set and the position has meaningful deviation.
//
// Plan shape:
//   1. withdraw-slice: pick the largest overweight bin, compute share fraction
//      that frees ΔV worth of overweight token (ΔV = |current - target| × total_value)
//   2. swap: route 100% of that freed balance through the existing corrective
//      swap path (wallet-side, same post-condition pattern)
//   3. redeposit: add-relative-liquidity-same-multi at active ± REBALANCE_ADD_OFFSET_BINS,
//      depositing the swap output on the underweight side. The add-liquidity is
//      the redeploy — the move-liquidity CLI is NOT invoked in this path.

interface WithdrawSliceEntry {
  bin_id: number;
  active_bin_id_offset: number;
  shares_to_withdraw_raw: string;
  share_fraction_bps: number;
  expected_x_raw: string;
  expected_y_raw: string;
  min_x_raw: string;
  min_y_raw: string;
}

interface WithdrawSlicePlan {
  entries: WithdrawSliceEntry[];          // may span multiple bins (list cap 300)
  total_expected_x_raw: string;
  total_expected_y_raw: string;
  total_min_x_raw: string;
  total_min_y_raw: string;
}

interface RedepositPlan {
  bins: Array<{ active_bin_id_offset: number; x_amount_raw: string; y_amount_raw: string }>;
  total_x_raw: string;
  total_y_raw: string;
  active_bin_expected: number;
  active_bin_tolerance: number;
}

interface RebalanceWithdrawPlan {
  withdraw: WithdrawSlicePlan;
  swap: SwapPlan;
  redeposit: RedepositPlan;
  target_x_ratio: number;
  current_x_ratio: number;
  projected_x_ratio_after: number;
}

function planRebalanceWithdraw(
  ratio: RatioSummary,
  userBins: UserBin[],
  pool: PoolMeta,
  poolBins: BinData[],
  activeBin: number,
  activePriceScaled: bigint,
  slippageBps: number,
  maxSliceBps: number
): { status: "ok"; plan: RebalanceWithdrawPlan } | { status: "refused"; reason: string; detail?: Record<string, unknown> } {
  const totalValueY = BigInt(ratio.total_value_in_y);
  if (totalValueY === 0n || activePriceScaled === 0n) {
    return { status: "refused", reason: "insufficient_position_value" };
  }

  // Shift in Y-value to reach target_x_ratio. Overweight side donates; underweight receives.
  const currentXY = BigInt(ratio.total_x_in_y);                    // X value in Y units
  const targetXY = (totalValueY * BigInt(Math.floor(ratio.target_x_ratio * 1_000_000))) / 1_000_000n;
  const overWeightX = currentXY > targetXY;
  const shiftValueY = overWeightX ? currentXY - targetXY : targetXY - currentXY;
  if (shiftValueY <= 0n) {
    return { status: "refused", reason: "already_within_target" };
  }

  // Pick the bin holding the most overweight token (by raw amount of that side).
  // Per-user-bin reserves may be reported as 0 by the App API — in that case derive
  // effective reserves from user shares × pool_bin_reserves / pool_bin_liquidity
  // (same derivation computeRatio uses). Without this, a sprawled position that only
  // reports aggregate reserves would falsely refuse with "no_overweight_bin_found".
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));
  const candidates = userBins
    .map((b) => {
      let rx = BigInt(b.reserve_x || "0");
      let ry = BigInt(b.reserve_y || "0");
      if (rx === 0n && ry === 0n) {
        const pb = poolBinMap.get(b.bin_id);
        const userDlp = BigInt(b.liquidity || "0");
        const poolDlp = pb ? BigInt(pb.liquidity || "0") : 0n;
        if (pb && userDlp > 0n && poolDlp > 0n) {
          rx = (userDlp * BigInt(pb.reserve_x)) / poolDlp;
          ry = (userDlp * BigInt(pb.reserve_y)) / poolDlp;
        }
      }
      return { bin: b, rx, ry, amt: overWeightX ? rx : ry };
    })
    .filter((c) => c.amt > 0n)
    .sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));

  if (candidates.length === 0) {
    return { status: "refused", reason: "no_overweight_bin_found", detail: { overweight_side: overWeightX ? "X" : "Y" } };
  }

  // Target withdraw amount in Y-value terms. Convert to raw overweight token.
  const activePrice = activePriceScaled; // raw_y per raw_x, scaled
  const withdrawAmtRaw = overWeightX
    ? (shiftValueY * BigInt(PRICE_SCALE)) / activePrice  // raw X needed
    : shiftValueY;                                         // raw Y (Y value == Y amount)

  // Greedy fill across bins (largest-first) to accumulate the needed withdraw
  // amount while respecting the per-bin slice cap. Each bin contributes at most
  // `maxSliceBps` of its user shares; we walk down the sorted list until
  // `accumulated >= withdrawAmtRaw` or we run out of bins.
  // Router list cap is 300 per `withdraw-relative-liquidity-same-multi`.
  const WITHDRAW_LIST_CAP = 300;
  const entries: WithdrawSliceEntry[] = [];
  let accumulated = 0n;
  let totalExpectedX = 0n;
  let totalExpectedY = 0n;

  for (const c of candidates) {
    if (accumulated >= withdrawAmtRaw || entries.length >= WITHDRAW_LIST_CAP) break;
    const binReserveRaw = c.amt;
    if (binReserveRaw === 0n) continue;
    const needed = withdrawAmtRaw - accumulated;
    const rawBinBps = Number((needed * 10_000n) / binReserveRaw);
    const binSliceBps = Math.min(maxSliceBps, Math.max(1, rawBinBps));
    const userShares = BigInt(c.bin.liquidity || "0");
    if (userShares === 0n) continue;
    const sharesRaw = (userShares * BigInt(binSliceBps)) / 10_000n;
    if (sharesRaw === 0n) continue;
    const eX = (c.rx * BigInt(binSliceBps)) / 10_000n;
    const eY = (c.ry * BigInt(binSliceBps)) / 10_000n;
    const mX = (eX * BigInt(10_000 - slippageBps)) / 10_000n;
    const mY = (eY * BigInt(10_000 - slippageBps)) / 10_000n;
    entries.push({
      bin_id: c.bin.bin_id,
      active_bin_id_offset: c.bin.bin_id - activeBin,
      shares_to_withdraw_raw: sharesRaw.toString(),
      share_fraction_bps: binSliceBps,
      expected_x_raw: eX.toString(),
      expected_y_raw: eY.toString(),
      min_x_raw: mX.toString(),
      min_y_raw: mY.toString(),
    });
    accumulated += overWeightX ? eX : eY;
    totalExpectedX += eX;
    totalExpectedY += eY;
  }

  if (entries.length === 0) {
    return { status: "refused", reason: "no_viable_slice_entries" };
  }

  const totalMinX = (totalExpectedX * BigInt(10_000 - slippageBps)) / 10_000n;
  const totalMinY = (totalExpectedY * BigInt(10_000 - slippageBps)) / 10_000n;
  const withdraw: WithdrawSlicePlan = {
    entries,
    total_expected_x_raw: totalExpectedX.toString(),
    total_expected_y_raw: totalExpectedY.toString(),
    total_min_x_raw: totalMinX.toString(),
    total_min_y_raw: totalMinY.toString(),
  };
  const expectedXRaw = totalExpectedX;
  const expectedYRaw = totalExpectedY;

  // Swap plan — input is the GUARANTEED-DELIVERED floor of the overweight side
  // (totalMinX/Y, not totalExpectedX/Y). The withdraw contract honors per-bin
  // and aggregate min floors but may deliver anywhere between min and expected
  // — sizing the swap to expected risks an insufficient-input-balance abort on
  // leg-2 if withdraw lands at the floor (worst case 0.5% short at default
  // slippageBps=50). Tradeoff: up to slippageBps of overweight token may sit
  // in the wallet post-cycle and absorb into the next cycle's accumulator.
  const swapInRaw = overWeightX ? totalMinX : totalMinY;
  if (swapInRaw < MIN_SWAP_SATS) {
    return { status: "refused", reason: "planned_swap_below_minimum", detail: { planned_raw: swapInRaw.toString() } };
  }
  const expectedSwapOutRaw = overWeightX
    ? (swapInRaw * activePrice) / BigInt(PRICE_SCALE)   // X→Y
    : (swapInRaw * BigInt(PRICE_SCALE)) / activePrice;  // Y→X
  const minSwapOutRaw = (expectedSwapOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  const swap: SwapPlan = {
    direction: overWeightX ? "X->Y" : "Y->X",
    token_in: overWeightX ? pool.token_x : pool.token_y,
    token_in_symbol: overWeightX ? pool.token_x_symbol : pool.token_y_symbol,
    token_in_decimals: overWeightX ? pool.token_x_decimals : pool.token_y_decimals,
    token_out: overWeightX ? pool.token_y : pool.token_x,
    token_out_symbol: overWeightX ? pool.token_y_symbol : pool.token_x_symbol,
    token_out_decimals: overWeightX ? pool.token_y_decimals : pool.token_x_decimals,
    amount_in_raw: swapInRaw.toString(),
    expected_amount_out_raw: expectedSwapOutRaw.toString(),
    minimum_amount_out_raw: minSwapOutRaw.toString(),
    slippage_bps: slippageBps,
    quote_source: `active_bin_price@bin=${activeBin} (rebalance-withdraw leg)`,
    quote_fetched_at: ratio.quote_fetched_at,
  };

  // Redeposit — underweight token goes to the side of active that HODLMM assigns
  // it (bins above active hold X only, bins below hold Y only; active itself is
  // the mixed frontier). We deposit at active ± REBALANCE_ADD_OFFSET_BINS with
  // the underweight amount split evenly across the appropriate side.
  const underweightRaw = expectedSwapOutRaw; // raw tokens we'll have post-swap
  const offsets: number[] = [];
  if (overWeightX) {
    // Underweight is Y — bins BELOW active (-1..-N)
    for (let i = 1; i <= REBALANCE_ADD_OFFSET_BINS; i++) offsets.push(-i);
  } else {
    // Underweight is X — bins ABOVE active (+1..+N)
    for (let i = 1; i <= REBALANCE_ADD_OFFSET_BINS; i++) offsets.push(i);
  }
  if (offsets.length === 0) {
    return { status: "refused", reason: "no_redeposit_bins_available" };
  }

  const perBinRaw = underweightRaw / BigInt(offsets.length);
  const remainder = underweightRaw - perBinRaw * BigInt(offsets.length);
  const redepositBins = offsets.map((o, idx) => ({
    active_bin_id_offset: o,
    x_amount_raw: overWeightX ? "0" : (perBinRaw + (idx === 0 ? remainder : 0n)).toString(),
    y_amount_raw: overWeightX ? (perBinRaw + (idx === 0 ? remainder : 0n)).toString() : "0",
  }));

  const redeposit: RedepositPlan = {
    bins: redepositBins,
    total_x_raw: overWeightX ? "0" : underweightRaw.toString(),
    total_y_raw: overWeightX ? underweightRaw.toString() : "0",
    // Carried for plan-output visibility only (operator can inspect via
    // `recommend` mode). Contract call passes `noneCV()` for active-bin-tolerance
    // — see executeAddLiquidityRedeposit for rationale.
    active_bin_expected: activeBin,
    active_bin_tolerance: REBALANCE_ADD_TOLERANCE_BINS,
  };

  // Projected post-state: LP loses the withdrawn slice on the overweight side
  // and gains `underweightRaw` (valued via activePrice) on the underweight side.
  const newXY = currentXY
    - (overWeightX ? (expectedXRaw * activePrice) / BigInt(PRICE_SCALE) : 0n)
    + (overWeightX ? 0n : (underweightRaw * activePrice) / BigInt(PRICE_SCALE));
  const newValueY = totalValueY
    - (overWeightX ? (expectedXRaw * activePrice) / BigInt(PRICE_SCALE) : expectedYRaw)
    + (overWeightX ? expectedSwapOutRaw : (underweightRaw * activePrice) / BigInt(PRICE_SCALE));
  const projectedX = newValueY === 0n ? 0 : Number((newXY * 1_000_000n) / newValueY) / 1_000_000;

  return {
    status: "ok",
    plan: {
      withdraw,
      swap,
      redeposit,
      target_x_ratio: ratio.target_x_ratio,
      current_x_ratio: ratio.current_x_ratio,
      projected_x_ratio_after: Number(projectedX.toFixed(4)),
    },
  };
}

async function executeWithdrawSlice(
  privateKey: string,
  senderAddress: string,
  pool: PoolMeta,
  slice: WithdrawSlicePlan,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    uintCV,
    intCV,
    listCV,
    tupleCV,
    contractPrincipalCV,
    PostConditionMode,
    AnchorMode,
    Pc,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const positionTuples = slice.entries.map((e) => tupleCV({
    "active-bin-id-offset": intCV(e.active_bin_id_offset),
    amount: uintCV(BigInt(e.shares_to_withdraw_raw)),
    "min-x-amount": uintCV(BigInt(e.min_x_raw)),
    "min-y-amount": uintCV(BigInt(e.min_y_raw)),
    "pool-trait": contractPrincipalCV(poolAddr, poolName),
  }));

  // 3-pin envelope on withdraw — defense-in-depth alongside the contract-level
  // per-bin / aggregate min floors and the per-bin shares-burned arg.
  //   PC1: sender willSendLte(total_shares).ft(pool, 'pool-token') — DLP burn cap
  //   PC2: pool   willSendGte(total_min_x).ft(token_x, ...)        — X receive floor
  //   PC3: pool   willSendGte(total_min_y).ft(token_y, ...)        — Y receive floor
  // PC1 asset name `pool-token` verified live on tx 0x89315a8b… burn event
  // (asset_id: <pool_contract>::pool-token). Every DLMM pool deploys from the
  // same template (deployer SM1FKX...) so `pool-token` is uniform across pools.
  // Sided per-token on PC2/PC3: skip the asset whose total_min is 0 (over-weight
  // side fully drained, no withdrawal of that side). resolveTokenAsset() unifies
  // STX vs FT branching with the swap-leg PCs.
  const xAsset = resolveTokenAsset(pool.token_x);
  const yAsset = resolveTokenAsset(pool.token_y);
  const minX = BigInt(slice.total_min_x_raw);
  const minY = BigInt(slice.total_min_y_raw);
  const totalShares = slice.entries.reduce((s, e) => s + BigInt(e.shares_to_withdraw_raw), 0n);
  const poolPin = Pc.principal(pool.pool_contract);
  const senderPin = Pc.principal(senderAddress);
  const pcs: unknown[] = [];
  if (totalShares > 0n) {
    pcs.push(senderPin.willSendLte(totalShares).ft(pool.pool_contract as `${string}.${string}`, "pool-token"));
  }
  if (minX > 0n) {
    pcs.push(xAsset.kind === "stx"
      ? poolPin.willSendGte(minX).ustx()
      : poolPin.willSendGte(minX).ft(xAsset.contract, xAsset.assetName));
  }
  if (minY > 0n) {
    pcs.push(yAsset.kind === "stx"
      ? poolPin.willSendGte(minY).ustx()
      : poolPin.willSendGte(minY).ft(yAsset.contract, yAsset.assetName));
  }

  const fee = await estimateSwapFeeUstx();
  const tx = await makeContractCall({
    contractAddress: DLMM_LIQUIDITY_ROUTER_ADDR,
    contractName: DLMM_LIQUIDITY_ROUTER_NAME,
    functionName: "withdraw-relative-liquidity-same-multi",
    functionArgs: [
      listCV(positionTuples),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      uintCV(minX),
      uintCV(minY),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    // Allow mode (vs Deny + per-fee enumeration) preserved because per-bin
    // `bin-liquidity-fee` accruals are routed inside dlmm-core and don't always
    // emit FT transfer events. The wallet-level receive pins above + per-bin
    // min-x/y on the position tuple + aggregate min-x/y-amount-total in the
    // function args together form the safety envelope.
    postConditionMode: PostConditionMode.Allow,
    postConditions: pcs as never[],
    anchorMode: AnchorMode.Any,
    nonce,
    fee,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Withdraw-slice broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

async function executeAddLiquidityRedeposit(
  privateKey: string,
  senderAddress: string,
  pool: PoolMeta,
  plan: RedepositPlan,
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall,
    broadcastTransaction,
    uintCV,
    intCV,
    listCV,
    tupleCV,
    contractPrincipalCV,
    noneCV,
    PostConditionMode,
    AnchorMode,
    Pc,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const positions = plan.bins.map((b) => tupleCV({
    "active-bin-id-offset": intCV(b.active_bin_id_offset),
    // 5% cap on per-side liquidity fees — same ceiling hodlmm-move-liquidity uses.
    "max-x-liquidity-fee": uintCV((BigInt(b.x_amount_raw) * 5n) / 100n),
    "max-y-liquidity-fee": uintCV((BigInt(b.y_amount_raw) * 5n) / 100n),
    // min-dlp = 1 — redeposit mints fresh DLP shares at the current price; any
    // positive share count indicates the deposit routed correctly. Cross-bin
    // min-dlp semantics are the same ones upstream aibtcdev/skills#338 flagged.
    "min-dlp": uintCV(1n),
    "x-amount": uintCV(BigInt(b.x_amount_raw)),
    "y-amount": uintCV(BigInt(b.y_amount_raw)),
  }));

  // active-bin-tolerance: pass noneCV() instead of someCV({expected-bin-id,
  // max-deviation}). Mid-cycle the active bin can drift between our Leg 2 swap
  // (which moves the pool) and Leg 3 redeposit (which reads it), so a hard
  // tolerance check spuriously aborts with `(err u5008)` ERR_ACTIVE_BIN_TOLERANCE
  // even when the redeposit math is correct. Widening max-deviation does not
  // help — on high-volume pools the bin can move arbitrarily far in 30-60s.
  //
  // Proven on-chain in Leg 3 tx
  // 0x135f490ca3f7b2862c3bd2eb33124bcd99e9ce2d93331865ad1dfd2065d6f53c
  // (mainnet block 7641905, dlmm_1, 0%X→100%X→49.95%X / 50.05%Y rebalance
  // cycle — see paired txs 0x89315a8b… (Leg 1 withdraw) and 0x5195822e…
  // (Leg 2 swap)).
  //
  // Fund safety on the redeposit is preserved by the wallet-side bounds already
  // enforced on each `positions` entry: max-x-liquidity-fee + max-y-liquidity-fee
  // (per-bin 5% caps), min-dlp (>=1 share required for the deposit to settle),
  // and per-bin x-amount / y-amount limits.
  //
  // The plan's active_bin_expected / active_bin_tolerance fields stay in the
  // snapshot schema as informational metadata but are no longer load-bearing.

  // Wallet-level send-side pin — defense-in-depth alongside the contract's
  // per-bin x-amount/y-amount + max-liquidity-fee gates. We pin sender
  // willSendLte (total + 5% fee headroom — matches the per-tuple
  // max-(x|y)-liquidity-fee ceiling). Sided per-token: skip the asset whose
  // total is 0 (one-sided redeposit, only X above active or Y below).
  // resolveTokenAsset() unifies STX vs FT branching with the swap-leg PCs.
  const xAsset = resolveTokenAsset(pool.token_x);
  const yAsset = resolveTokenAsset(pool.token_y);
  const totalX = BigInt(plan.total_x_raw);
  const totalY = BigInt(plan.total_y_raw);
  const senderPin = Pc.principal(senderAddress);
  const pcs: unknown[] = [];
  if (totalX > 0n) {
    const capX = (totalX * 105n) / 100n; // 5% headroom for liquidity-fee accrual
    pcs.push(xAsset.kind === "stx"
      ? senderPin.willSendLte(capX).ustx()
      : senderPin.willSendLte(capX).ft(xAsset.contract, xAsset.assetName));
  }
  if (totalY > 0n) {
    const capY = (totalY * 105n) / 100n;
    pcs.push(yAsset.kind === "stx"
      ? senderPin.willSendLte(capY).ustx()
      : senderPin.willSendLte(capY).ft(yAsset.contract, yAsset.assetName));
  }

  const fee = await estimateSwapFeeUstx();
  const tx = await makeContractCall({
    contractAddress: DLMM_LIQUIDITY_ROUTER_ADDR,
    contractName: DLMM_LIQUIDITY_ROUTER_NAME,
    functionName: "add-relative-liquidity-same-multi",
    functionArgs: [
      listCV(positions),
      contractPrincipalCV(poolAddr, poolName),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      noneCV(),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    // Allow mode (vs Deny + per-fee enumeration) preserved because per-bin
    // fee transfers vary with pool config and don't always emit FT events
    // (see PR #494 comment to @TheBigMacBTC). Sender send-cap pins above
    // bound the wallet-side capital motion.
    postConditionMode: PostConditionMode.Allow,
    postConditions: pcs as never[],
    anchorMode: AnchorMode.Any,
    nonce,
    fee,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Redeposit broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

// 600s default timeout. Mainnet propagation + indexing on Hiro can easily run
// past the naïve 2× block-time estimate (Nakamoto is ~5s but microblock/epoch
// boundaries and mempool congestion routinely push tx visibility to 60–180s).
// The 3-leg flow broadcasts 3 sequential txs, each waiting on this helper;
// being generous here trades wall-clock for a lower false-failure rate when the
// state marker is between legs. Prefix `0x` on Hiro tx lookups — some codepaths
// return the tx without, some require it, and querying with the prefix works
// consistently. The .replace strips any leading 0x defensively so an SDK
// upgrade that changes broadcastTransaction's return shape can't double-prefix
// the URL into a silent lookup_failed (per arc0btc's PR #2 carryover).
async function waitForTxConfirmation(txId: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = 6_000;
  const url = `${HIRO_API}/extended/v1/tx/0x${txId.replace(/^0x/, "")}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetchJson<Record<string, unknown>>(url);
      const status = res.tx_status as string | undefined;
      if (status === "success") return;
      if (status && status !== "pending") {
        throw new Error(`Tx ${txId} landed with status ${status}: ${JSON.stringify((res as Record<string, unknown>).tx_result ?? {})}`);
      }
    } catch (e) {
      if ((e as Error).message.startsWith("Tx ")) throw e;
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new Error(`Tx ${txId} did not confirm within ${timeoutMs / 1000}s`);
}

// Light-touch tx-status probe used on the resume path in the 3-leg flow.
// Unlike waitForTxConfirmation, this returns immediately rather than polling —
// the operator has already waited (they re-ran the skill); we just need to
// know whether the prior leg's tx ultimately landed `success` before we let
// the resume proceed. Returns `{ status: "unknown_lookup_failed", ok: false }`
// on lookup error so callers can surface a clear hint instead of throwing.
async function probeTxStatus(txId: string): Promise<{ status: string; ok: boolean }> {
  try {
    // Strip leading 0x defensively: SDK currently returns txid without prefix
    // (verified empirically via existing live txs 0x89315a8b…, 0xf4f49328…),
    // but normalizing here means an SDK upgrade can't silently route prior-
    // leg lookups to lookup_failed via double-prefix. See PR #2 carryover.
    const res = await fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/tx/0x${txId.replace(/^0x/, "")}`);
    const status = String(res.tx_status ?? "unknown");
    return { status, ok: status === "success" };
  } catch (e) {
    return { status: `lookup_failed: ${(e as Error).message}`, ok: false };
  }
}

// ─── Redeploy via hodlmm-move-liquidity CLI ───────────────────────────────────

function invokeMoveLiquidityRedeploy(poolId: string, stxAddress: string, password: string | undefined): string {
  const cli =
    process.env.HODLMM_MOVE_LIQUIDITY_CLI ??
    path.resolve(__dirname, "..", "hodlmm-move-liquidity", "hodlmm-move-liquidity.ts");
  if (!fs.existsSync(cli)) {
    throw new Error(`hodlmm-move-liquidity CLI not found at ${cli}. Install the skill or set HODLMM_MOVE_LIQUIDITY_CLI.`);
  }
  // `hodlmm-move-liquidity`'s `run` requires `--wallet <address>` + `--pool` + boolean `--confirm`
  // (no value). `--force` overrides the IN_RANGE no-op gate — required here because the
  // inventory balancer corrects exposure ratio regardless of price-drift status.
  const args = ["run", cli, "run", "--wallet", stxAddress, "--pool", poolId, "--confirm", "--force"];
  // Password is passed via env, never argv. An argv entry would surface in /proc/<pid>/cmdline
  // and `ps auxww` for the child's lifetime; env vars are not visible to peers without ptrace.
  const childEnv = password ? { ...process.env, WALLET_PASSWORD: password } : process.env;

  // 600s timeout matches waitForTxConfirmation's default. The child invocation
  // polls Hiro for tx confirmation internally; congested-chain indexing routinely
  // lags 60–180s. A 120s parent timeout would kill the child mid-poll, leaving
  // last_cycle_status === "swap_done_redeploy_pending" with the redeploy tx in
  // flight — the next resume call would then re-broadcast invokeMoveLiquidityRedeploy
  // and risk a double-broadcast if the original landed.
  const result = spawnSync("bun", args, { encoding: "utf-8", timeout: 600_000, env: childEnv });
  if (result.error) throw new Error(`move-liquidity invoke failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`move-liquidity exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  // Parse the last JSON line from stdout
  const lines = result.stdout.trim().split("\n").filter((l) => l.trim().startsWith("{"));
  if (lines.length === 0) throw new Error("move-liquidity returned no JSON output");
  const parsed = JSON.parse(lines[lines.length - 1]);
  if (parsed.status !== "success") {
    throw new Error(`move-liquidity reported ${parsed.status}: ${parsed.error ?? JSON.stringify(parsed)}`);
  }
  const tx = parsed?.data?.tx_id ?? parsed?.data?.txid ?? parsed?.data?.transaction?.txid;
  if (!tx) throw new Error("move-liquidity succeeded but returned no tx_id");
  return String(tx);
}

// ─── Pool/position utilities ──────────────────────────────────────────────────

async function gatherPool(poolId: string, wallet: string) {
  const pools = await fetchPools();
  const pool = pools.find((p) => p.pool_id === poolId);
  if (!pool) throw new Error(`Pool ${poolId} not found in Bitflow DLMM registry.`);
  if (!isEligibleHodlmmPool(pool)) {
    throw new Error(`Pool ${poolId} not eligible (inactive or non-HODLMM deployer — v1 excludes JingSwap and retired pools).`);
  }
  const [poolBins, userBins] = await Promise.all([fetchPoolBins(poolId), fetchUserPositions(poolId, wallet)]);
  return { pool, poolBins, userBins };
}

function activeBinPriceScaled(poolBins: BinData[], activeBin: number): bigint {
  // Bitflow bin prices are integer strings already scaled so that
  // raw_y = raw_x * price / PRICE_SCALE. Return as-is.
  const bin = poolBins.find((b) => b.bin_id === activeBin);
  if (!bin) return 0n;
  return BigInt(bin.price || "0");
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-inventory-balancer")
  .description("Restore target HODLMM LP token-exposure ratio via corrective swap + redeploy")
  .version("1.0.0");

program
  .command("install-packs")
  .description("Install @stacks SDK dependencies")
  .action(async () => {
    const packs = ["@stacks/transactions", "@stacks/network", "@stacks/wallet-sdk", "@stacks/encryption", "commander"];
    const result = spawnSync("bun", ["add", ...packs], { stdio: "inherit" });
    if (result.status !== 0) {
      return err("install-packs", `bun add exited ${result.status}`);
    }
    out("success", "install-packs", { installed: packs });
  });

program
  .command("doctor")
  .description("Pre-flight checks")
  .option("--pool <id>", "Optional: narrow to a single pool")
  .action(async (opts) => {
    try {
      const password = process.env.WALLET_PASSWORD ?? "";
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
      let wallet = "";
      try {
        const { stxAddress } = await getWalletKeys(password);
        wallet = stxAddress;
        checks.push({ name: "wallet", ok: true, detail: wallet });
      } catch (e) {
        checks.push({ name: "wallet", ok: false, detail: (e as Error).message });
      }

      // Cached pool list — reused below for the per-pool cooldown iteration so we
      // hit /api/app/v1/pools at most once per doctor run. Failure of the first
      // call leaves cachedPools null; the cooldown branch then degrades to an
      // empty pool list rather than re-calling and re-failing.
      let cachedPools: PoolMeta[] | null = null;
      try {
        cachedPools = await fetchPools();
        const eligible = cachedPools.filter(isEligibleHodlmmPool);
        checks.push({ name: "bitflow_app_api", ok: eligible.length > 0, detail: `${eligible.length} eligible pools` });
      } catch (e) {
        checks.push({ name: "bitflow_app_api", ok: false, detail: (e as Error).message });
      }

      if (wallet) {
        try {
          const bal = await fetchStxBalanceUstx(wallet);
          const ok = bal >= STX_GAS_FLOOR_USTX;
          checks.push({
            name: "stx_gas_reserve",
            ok,
            detail: `${Number(bal) / 1e6} STX (floor ${Number(STX_GAS_FLOOR_USTX) / 1e6})`,
          });

          const pending = await fetchPendingMempoolTxCount(wallet);
          checks.push({
            name: "mempool_depth",
            ok: pending === 0,
            detail: pending === 0 ? "clear" : `${pending} pending txs — would serialize via nonce-manager`,
          });
        } catch (e) {
          checks.push({ name: "chain_reads", ok: false, detail: (e as Error).message });
        }
      }

      // Surface cooldown state per pool (or the targeted one). When no --pool is
      // specified, iterate the live eligibility set; missing pool list on API
      // error degrades to empty map rather than silently checking a stale allowlist.
      const targetPool = opts.pool as string | undefined;
      const cooldowns: Record<string, string> = {};
      let poolsToCheck: string[];
      if (targetPool) {
        poolsToCheck = [targetPool];
      } else if (cachedPools) {
        poolsToCheck = cachedPools.filter(isEligibleHodlmmPool).map((p) => p.pool_id);
      } else {
        // First fetchPools() call failed above; degrade to empty rather than
        // re-fetch (which would hit the same upstream error and double the noise).
        poolsToCheck = [];
      }
      for (const pid of poolsToCheck) {
        const ms = readMoveLiquidityCooldownMs(pid);
        cooldowns[pid] = ms === 0 ? "clear" : `${Math.ceil(ms / 60_000)} min remaining`;
      }
      checks.push({
        name: "move_liquidity_cooldown",
        ok: true,
        detail: JSON.stringify(cooldowns),
      });

      // Surface unresolved state markers — flag both the v1 pending state and
      // the two intermediate states introduced by the 3-leg rebalance-withdraw path.
      const state = loadInventoryState();
      const unresolvedStatuses = new Set([
        "swap_done_redeploy_pending",
        "withdraw_done_swap_pending",
        "withdraw_done_swap_done_redeposit_pending",
      ]);
      const unresolved = Object.entries(state)
        .filter(([, v]) => v.last_cycle_status && unresolvedStatuses.has(v.last_cycle_status))
        .map(([k, v]) => `${k}:${v.last_cycle_status}`);
      checks.push({
        name: "state_marker",
        ok: unresolved.length === 0,
        detail: unresolved.length === 0 ? "no unresolved cycles" : `unresolved: ${unresolved.join(", ")}`,
      });

      const allOk = checks.every((c) => c.ok);
      out(allOk ? "success" : "error", "doctor", { checks }, allOk ? null : "One or more checks failed");
      if (!allOk) process.exit(1);
    } catch (e) {
      err("doctor", (e as Error).message);
    }
  });

program
  .command("status")
  .description("Read-only ratio + deviation per eligible pool")
  .option("--pool <id>", "Narrow to a single pool")
  .option("--target-ratio <r>", "X:Y percent (e.g. 50:50)", "50:50")
  .option("--min-drift-pct <n>", "Drift threshold (%)", String(DEFAULT_MIN_DRIFT_PCT))
  .action(async (opts) => {
    try {
      const password = process.env.WALLET_PASSWORD ?? "";
      const { stxAddress } = await getWalletKeys(password);
      const targetXRatio = parseTargetRatio(opts.targetRatio);
      const minDriftPct = Number(opts.minDriftPct);
      const pools = await fetchPools();
      const eligible = pools.filter(isEligibleHodlmmPool);
      const targetPools = opts.pool ? eligible.filter((p) => p.pool_id === opts.pool) : eligible;

      const reports = [];
      for (const pool of targetPools) {
        const userBins = await fetchUserPositions(pool.pool_id, stxAddress);
        if (userBins.length === 0) continue;
        const { bins, active_bin_id, fetched_at } = await fetchPoolBins(pool.pool_id);
        const ratio = computeRatio(pool, userBins, bins, active_bin_id, targetXRatio, fetched_at);
        const cooldownMs = readMoveLiquidityCooldownMs(pool.pool_id);
        const state = loadInventoryState()[pool.pool_id];
        reports.push({
          ...ratio,
          breach: ratio.deviation_abs * 100 >= minDriftPct,
          move_liquidity_cooldown_minutes: Math.ceil(cooldownMs / 60_000),
          last_cycle: state ?? null,
        });
      }
      out("success", "status", { pools: reports, min_drift_pct: minDriftPct });
    } catch (e) {
      err("status", (e as Error).message);
    }
  });

program
  .command("recommend")
  .description("Dry-run cycle plan")
  .option("--pool <id>", "Pool to plan against (required)")
  .option("--target-ratio <r>", "X:Y percent", "50:50")
  .option("--min-drift-pct <n>", String(DEFAULT_MIN_DRIFT_PCT))
  .option("--max-correction-sats <n>", String(DEFAULT_MAX_CORRECTION_SATS))
  .option("--max-quote-staleness-seconds <n>", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
  .option("--slippage-bps <n>", String(slippageDefault()))
  .option("--skip-redeploy", "Plan swap only; do not include redeploy")
  .option("--allow-rebalance-withdraw", "Plan the withdraw-slice → swap → redeposit 3-leg flow")
  .option("--max-slice-bps <n>", `Cap on per-bin share slice (default ${REBALANCE_MAX_SLICE_BPS})`)
  .action(async (opts) => {
    try {
      await recommendOrRun(opts, false);
    } catch (e) {
      err("recommend", (e as Error).message);
    }
  });

program
  .command("reset-marker")
  .description("Clear stale state marker for a pool (escape hatch for stuck cycles)")
  .requiredOption("--pool <id>", "Pool whose state entry to clear")
  .option("--confirm", "Required — irreversible; deletes the in-flight cycle snapshot")
  .action((opts) => {
    try {
      if (!opts.confirm) {
        return err("reset-marker", "--confirm required (this is irreversible)");
      }
      const state = loadInventoryState();
      const cleared = state[opts.pool];
      if (!cleared) {
        return out("success", "reset-marker", { pool_id: opts.pool, note: "no state marker present" });
      }
      delete state[opts.pool];
      saveInventoryState(state);
      out("success", "reset-marker", {
        pool_id: opts.pool,
        cleared,
        note: "Re-run `run --pool <id> --allow-rebalance-withdraw --confirm BALANCE` to plan a fresh cycle from current ratio.",
      });
    } catch (e) {
      err("reset-marker", (e as Error).message);
    }
  });

program
  .command("run")
  .description("Execute the corrective cycle (requires --confirm=BALANCE)")
  .option("--pool <id>", "Pool to correct (required)")
  .option("--target-ratio <r>", "X:Y percent", "50:50")
  .option("--min-drift-pct <n>", String(DEFAULT_MIN_DRIFT_PCT))
  .option("--max-correction-sats <n>", String(DEFAULT_MAX_CORRECTION_SATS))
  .option("--max-quote-staleness-seconds <n>", String(DEFAULT_MAX_QUOTE_STALENESS_SECONDS))
  .option("--slippage-bps <n>", String(slippageDefault()))
  .option("--skip-redeploy", "Execute swap only; write swap_done_redeploy_pending marker")
  .option("--force-direction <dir>", "Override planner direction: X->Y or Y->X (operator escape hatch)")
  .option("--force-amount-in-raw <n>", "Override planner amount_in (raw sats)")
  .option("--allow-rebalance-withdraw", "Opt-in: withdraw-slice → swap → redeposit mode for positions v1 swap+recenter cannot close. 3 sequential mainnet txs.")
  .option("--max-slice-bps <n>", `Cap on per-bin share slice in rebalance-withdraw mode (default ${REBALANCE_MAX_SLICE_BPS})`)
  .option("--confirm <token>", "Must equal BALANCE to execute")
  .action(async (opts) => {
    try {
      const execute = opts.confirm === "BALANCE";
      await recommendOrRun(opts, execute);
    } catch (e) {
      err("run", (e as Error).message);
    }
  });

// ─── Shared recommend/run body ────────────────────────────────────────────────

async function recommendOrRun(opts: Record<string, string | boolean | undefined>, execute: boolean): Promise<void> {
  const action = execute ? "run" : "recommend";
  const poolId = opts.pool as string | undefined;
  if (!poolId) return err(action, "--pool is required");
  // Password is read from WALLET_PASSWORD env var only. A --password CLI flag
  // would leak via /proc/<pid>/cmdline and `ps auxww` — same exposure class
  // @diegomey flagged on the child-process invocation of hodlmm-move-liquidity
  // (PR #494 review item 5). Env vars are visible only to the same user or root
  // via /proc/<pid>/environ, a much smaller exposure surface.
  const password = process.env.WALLET_PASSWORD ?? "";
  const targetXRatio = parseTargetRatio(String(opts.targetRatio ?? "50:50"));
  const minDriftPct = Number(opts.minDriftPct ?? DEFAULT_MIN_DRIFT_PCT);
  const maxCorrectionSats = BigInt(String(opts.maxCorrectionSats ?? DEFAULT_MAX_CORRECTION_SATS));
  const maxStaleSec = Number(opts.maxQuoteStalenessSeconds ?? DEFAULT_MAX_QUOTE_STALENESS_SECONDS);
  const slippageBps = Number(opts.slippageBps ?? slippageDefault());
  const skipRedeploy = Boolean(opts.skipRedeploy);

  const { stxAddress, stxPrivateKey } = await getWalletKeys(password);

  // Load state BEFORE cooldown check — the move-liquidity cooldown only applies
  // to flows that invoke the hodlmm-move-liquidity CLI (default mode + leg-3
  // of the v1-style fallback). The 3-leg rebalance-withdraw resume path uses
  // add-relative-liquidity-same-multi directly with no CLI invocation, so the
  // cooldown is irrelevant on resumes from a 3-leg intermediate state.
  const state = loadInventoryState();
  const poolState = state[poolId];
  const isThreeLegResume =
    poolState?.last_cycle_status === "withdraw_done_swap_pending" ||
    poolState?.last_cycle_status === "withdraw_done_swap_done_redeposit_pending";

  // Cooldown gate
  const cooldownMs = readMoveLiquidityCooldownMs(poolId);
  if (cooldownMs > 0 && !skipRedeploy && !isThreeLegResume) {
    return out("blocked", action, {
      pool_id: poolId,
      reason: "move_liquidity_cooldown_active",
      cooldown_minutes_remaining: Math.ceil(cooldownMs / 60_000),
      hint: "Pass --skip-redeploy to run the swap-only correction, or wait for the cooldown to clear.",
    });
  }

  // Rebalance-withdraw intermediate states: pick up where the prior cycle
  // stopped. The plan snapshot at leg-1-success (rebalance_pending_details)
  // tells us exactly which legs to broadcast. We verify the prior tx(s) hit
  // `success` on-chain before resuming so we never broadcast leg N+1 against
  // an aborted leg N — that would silently corrupt state. If the snapshot is
  // missing (state file from before this fix shipped, or manually edited),
  // fall back to surfacing `--reset-marker` as the escape hatch — the operator
  // re-runs from scratch and the planner re-plans against the current ratio.
  if (poolState?.last_cycle_status === "withdraw_done_swap_pending") {
    if (!poolState.rebalance_pending_details || !poolState.last_withdraw_tx) {
      return out("blocked", action, {
        pool_id: poolId,
        reason: "withdraw_done_swap_pending_legacy_marker",
        last_withdraw_tx: poolState.last_withdraw_tx ?? null,
        explorer: poolState.last_withdraw_tx ? `${EXPLORER}/0x${poolState.last_withdraw_tx}?chain=mainnet` : null,
        hint: "State marker present but no rebalance_pending_details snapshot — cannot rebuild swap/redeposit plans. Run `reset-marker --pool <id> --confirm` to clear, then re-run `run --pool <id> --allow-rebalance-withdraw --confirm BALANCE` to plan a fresh cycle from current ratio.",
      });
    }
    if (!execute) {
      return out("success", action, {
        pool_id: poolId,
        resume: "swap+redeposit",
        last_withdraw_tx: poolState.last_withdraw_tx,
        pending: poolState.rebalance_pending_details,
      });
    }
    // Verify withdraw landed `success` on-chain before resuming. Three buckets:
    //   1. pending — tx still propagating; safe to wait + re-run
    //   2. lookup_failed — Hiro down / rate-limited / operator offline; we
    //      DO NOT KNOW the tx state, so default to safe-wait. Pointing the
    //      operator at reset-marker on uncertainty would orphan an in-flight
    //      tx if it lands later.
    //   3. terminal-non-success — confirmed aborted (abort_by_response /
    //      abort_by_post_condition / dropped_*). Reset-marker is safe here.
    const verifyW = await probeTxStatus(poolState.last_withdraw_tx);
    if (!verifyW.ok) {
      const isPending = verifyW.status === "pending";
      const isLookupFailed = verifyW.status.startsWith("lookup_failed");
      const safeWait = isPending || isLookupFailed;
      return out("blocked", action, {
        pool_id: poolId,
        reason: isPending
          ? "prior_withdraw_tx_still_pending"
          : isLookupFailed
            ? "prior_withdraw_tx_status_lookup_failed"
            : "prior_withdraw_tx_aborted",
        last_withdraw_tx: poolState.last_withdraw_tx,
        chain_status: verifyW.status,
        explorer: `${EXPLORER}/0x${poolState.last_withdraw_tx}?chain=mainnet`,
        hint: safeWait
          ? "Cannot positively confirm withdraw landed `success` (tx still propagating, or Hiro lookup failed). Wait until the explorer shows tx_status=success, then re-run. Do NOT run `reset-marker` — that would orphan an in-flight tx if it lands later."
          : "Withdraw aborted on-chain (positively-confirmed non-success status). Inspect on the explorer to confirm the abort reason; then run `reset-marker --pool <id> --confirm` to clear and start a new cycle.",
      });
    }
    // Gas-reserve guard for the 2 follow-on broadcasts (swap + redeposit).
    // Wallet may have drained between leg 1 and resume from other tx activity.
    // Without this, leg 2 fires then leg 3 runs out of gas → SECOND stuck cycle.
    const stxBalResume = await fetchStxBalanceUstx(stxAddress);
    if (stxBalResume < STX_GAS_FLOOR_USTX * 2n) {
      return out("blocked", action, {
        pool_id: poolId,
        reason: "insufficient_stx_gas_for_resume",
        stx_balance_ustx: stxBalResume.toString(),
        required_ustx: (STX_GAS_FLOOR_USTX * 2n).toString(),
        legs_remaining: 2,
        hint: "Resume from withdraw-done needs gas reserve for swap + redeposit (2 txs). Top up STX and re-run.",
      });
    }
    const { pool: poolGathered, poolBins: freshPoolBins } = await gatherPool(poolId, stxAddress);
    const pending = poolState.rebalance_pending_details;
    // Stale-price guard. Leg-2 reuses the swap plan snapshotted at leg-1 success;
    // its `minimum_amount_out_raw` was sized at the price observed when the cycle
    // started. If the active bin moved against us between legs (long-wait resume,
    // market shock), the broadcast aborts via ERR_MINIMUM_RECEIVED at the contract
    // because the actual output at current price falls below the snapshot's floor —
    // leaving the marker stuck on `withdraw_done_swap_pending`. Refuse with a
    // clean blocked status pointing at `reset-marker`; do NOT silently resize the
    // floor (that would break the slippage contract the operator signed up for).
    const freshActivePrice = activeBinPriceScaled(freshPoolBins.bins, freshPoolBins.active_bin_id);
    if (freshActivePrice === 0n) {
      log(`active bin ${freshPoolBins.active_bin_id} missing from poolBins on resume for ${poolId}`);
      return out("blocked", action, {
        pool_id: poolId,
        reason: "active_bin_price_unavailable_on_resume",
        active_bin_id: freshPoolBins.active_bin_id,
        hint: "Could not read active bin price from the quotes endpoint. Retry shortly; if persistent, run `reset-marker --pool <id> --confirm` and re-plan.",
      });
    }
    const snapshotSwapInRaw = BigInt(pending.swap.amount_in_raw);
    const snapshotMinOutRaw = BigInt(pending.swap.minimum_amount_out_raw);
    // Direction-aware: bin price represents raw_y per raw_x, scaled by PRICE_SCALE.
    //   X→Y: raw_y_out = raw_x_in * price / PRICE_SCALE
    //   Y→X: raw_x_out = raw_y_in * PRICE_SCALE / price
    // Mirrors the planner derivation at planRebalanceWithdraw so this guard's
    // expected-output formula stays in lockstep with how the snapshot was sized.
    const freshExpectedOutRaw = pending.swap.direction === "X->Y"
      ? (snapshotSwapInRaw * freshActivePrice) / BigInt(PRICE_SCALE)
      : (snapshotSwapInRaw * BigInt(PRICE_SCALE)) / freshActivePrice;
    if (freshExpectedOutRaw < snapshotMinOutRaw) {
      return out("blocked", action, {
        pool_id: poolId,
        reason: "price_moved_beyond_slippage_replan_required",
        direction: pending.swap.direction,
        snapshot_amount_in_raw: pending.swap.amount_in_raw,
        snapshot_minimum_out_raw: snapshotMinOutRaw.toString(),
        snapshot_expected_out_raw: pending.swap.expected_amount_out_raw,
        fresh_expected_out_raw: freshExpectedOutRaw.toString(),
        active_bin_id: freshPoolBins.active_bin_id,
        slippage_bps: pending.swap.slippage_bps,
        last_withdraw_tx: poolState.last_withdraw_tx,
        explorer: `${EXPLORER}/0x${poolState.last_withdraw_tx}?chain=mainnet`,
        hint: "Active bin price has moved against the snapshot beyond slippage_bps since leg 1 landed. Resume swap would abort via ERR_MINIMUM_RECEIVED. Run `reset-marker --pool <id> --confirm` to clear the marker and re-plan against the current ratio.",
      });
    }
    // Leg 2: swap (reuses snapshotted plan)
    const n2 = await fetchNonce(stxAddress);
    const swapTx2 = await executeCorrectiveSwap(stxPrivateKey, stxAddress, poolGathered, pending.swap, n2);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_status: "withdraw_done_swap_done_redeposit_pending",
      last_swap_tx: swapTx2,
    };
    saveInventoryState(state);
    await waitForTxConfirmation(swapTx2);
    // Leg 3: redeposit (reuses snapshotted plan)
    const n3 = await fetchNonce(stxAddress);
    const redepositTx = await executeAddLiquidityRedeposit(stxPrivateKey, stxAddress, poolGathered, pending.redeposit, n3);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "success",
      last_redeposit_tx: redepositTx,
      rebalance_pending_details: undefined,
    };
    saveInventoryState(state);
    const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, pending.target_ratio_x);
    return out("success", action, {
      pool_id: poolId,
      pair: poolGathered.token_x_symbol + "/" + poolGathered.token_y_symbol,
      mode: "rebalance_withdraw",
      resumed_from: "withdraw_done_swap_pending",
      ratio_after: ratioAfter,
      withdraw: { tx_id: poolState.last_withdraw_tx, explorer: `${EXPLORER}/0x${poolState.last_withdraw_tx}?chain=mainnet` },
      swap: { ...pending.swap, tx_id: swapTx2, explorer: `${EXPLORER}/0x${swapTx2}?chain=mainnet` },
      redeposit: { ...pending.redeposit, tx_id: redepositTx, explorer: `${EXPLORER}/0x${redepositTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
    });
  }
  if (poolState?.last_cycle_status === "withdraw_done_swap_done_redeposit_pending") {
    if (!poolState.rebalance_pending_details || !poolState.last_swap_tx) {
      return out("blocked", action, {
        pool_id: poolId,
        reason: "withdraw_done_swap_done_redeposit_pending_legacy_marker",
        last_withdraw_tx: poolState.last_withdraw_tx ?? null,
        last_swap_tx: poolState.last_swap_tx ?? null,
        hint: "State marker present but no rebalance_pending_details snapshot — cannot rebuild redeposit plan. Run `reset-marker --pool <id> --confirm` to clear, then re-run.",
      });
    }
    if (!execute) {
      return out("success", action, {
        pool_id: poolId,
        resume: "redeposit-only",
        last_withdraw_tx: poolState.last_withdraw_tx,
        last_swap_tx: poolState.last_swap_tx,
        pending: poolState.rebalance_pending_details,
      });
    }
    const verifyS = await probeTxStatus(poolState.last_swap_tx);
    if (!verifyS.ok) {
      const isPending = verifyS.status === "pending";
      const isLookupFailed = verifyS.status.startsWith("lookup_failed");
      const safeWait = isPending || isLookupFailed;
      return out("blocked", action, {
        pool_id: poolId,
        reason: isPending
          ? "prior_swap_tx_still_pending"
          : isLookupFailed
            ? "prior_swap_tx_status_lookup_failed"
            : "prior_swap_tx_aborted",
        last_swap_tx: poolState.last_swap_tx,
        chain_status: verifyS.status,
        explorer: `${EXPLORER}/0x${poolState.last_swap_tx}?chain=mainnet`,
        hint: safeWait
          ? "Cannot positively confirm swap landed `success` (tx still propagating, or Hiro lookup failed). Wait until the explorer shows tx_status=success, then re-run. Do NOT run `reset-marker` — that would orphan an in-flight tx if it lands later."
          : "Swap aborted on-chain (positively-confirmed non-success status). Inspect on the explorer; then run `reset-marker --pool <id> --confirm` to clear.",
      });
    }
    // Gas-reserve guard for the 1 follow-on broadcast (redeposit).
    const stxBalResume = await fetchStxBalanceUstx(stxAddress);
    if (stxBalResume < STX_GAS_FLOOR_USTX) {
      return out("blocked", action, {
        pool_id: poolId,
        reason: "insufficient_stx_gas_for_resume",
        stx_balance_ustx: stxBalResume.toString(),
        required_ustx: STX_GAS_FLOOR_USTX.toString(),
        legs_remaining: 1,
        hint: "Resume from swap-done needs gas reserve for redeposit (1 tx). Top up STX and re-run.",
      });
    }
    const { pool: poolGathered } = await gatherPool(poolId, stxAddress);
    const pending = poolState.rebalance_pending_details;
    const n3 = await fetchNonce(stxAddress);
    const redepositTx = await executeAddLiquidityRedeposit(stxPrivateKey, stxAddress, poolGathered, pending.redeposit, n3);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "success",
      last_redeposit_tx: redepositTx,
      rebalance_pending_details: undefined,
    };
    saveInventoryState(state);
    const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, pending.target_ratio_x);
    return out("success", action, {
      pool_id: poolId,
      pair: poolGathered.token_x_symbol + "/" + poolGathered.token_y_symbol,
      mode: "rebalance_withdraw",
      resumed_from: "withdraw_done_swap_done_redeposit_pending",
      ratio_after: ratioAfter,
      withdraw: poolState.last_withdraw_tx ? { tx_id: poolState.last_withdraw_tx, explorer: `${EXPLORER}/0x${poolState.last_withdraw_tx}?chain=mainnet` } : null,
      swap: { ...pending.swap, tx_id: poolState.last_swap_tx, explorer: `${EXPLORER}/0x${poolState.last_swap_tx}?chain=mainnet` },
      redeposit: { ...pending.redeposit, tx_id: redepositTx, explorer: `${EXPLORER}/0x${redepositTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
    });
  }

  const pending = poolState?.last_cycle_status === "swap_done_redeploy_pending" ? poolState.swap_pending_details : undefined;
  if (pending && skipRedeploy) {
    return out("blocked", action, {
      reason: "swap_done_redeploy_pending — call without --skip-redeploy to finish the cycle",
      pending,
    });
  }

  if (pending && !skipRedeploy) {
    // Resume directly at redeploy (skip swap)
    if (!execute) {
      return out("success", action, { resume: "redeploy-only", pending });
    }
    const { stxAddress: resumeStx } = await getWalletKeys(password);
    const redeployTx = invokeMoveLiquidityRedeploy(poolId, resumeStx, password || undefined);
    state[poolId] = {
      ...poolState,
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "success",
      last_redeploy_tx: redeployTx,
      swap_pending_details: undefined,
    };
    saveInventoryState(state);
    return out("success", action, {
      pool_id: poolId,
      resumed: true,
      redeploy: { tx_id: redeployTx, explorer: `${EXPLORER}/0x${redeployTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
    });
  }

  // Meta-cooldown gate (prevents rapid re-correction within the same flow event)
  const metaCdMs = inventoryMetaCooldownMs(state, poolId);
  if (metaCdMs > 0) {
    return out("blocked", action, {
      reason: "inventory_balancer_meta_cooldown_active",
      cooldown_minutes_remaining: Math.ceil(metaCdMs / 60_000),
    });
  }

  // Gather + assess
  const { pool, poolBins, userBins } = await gatherPool(poolId, stxAddress);
  if (userBins.length === 0) {
    return out("success", action, { pool_id: poolId, reason: "no_user_position" });
  }
  const ratio = computeRatio(pool, userBins, poolBins.bins, poolBins.active_bin_id, targetXRatio, poolBins.fetched_at);

  if (ratio.quote_staleness_seconds > maxStaleSec) {
    return out("blocked", action, {
      reason: "bitflow_quote_stale",
      quote_age_seconds: ratio.quote_staleness_seconds,
      max_allowed: maxStaleSec,
    });
  }

  if (ratio.deviation_abs * 100 < minDriftPct) {
    return out("success", action, { pool_id: poolId, reason: "within_threshold", ratio });
  }

  // Wallet gas reserve
  const stxBal = await fetchStxBalanceUstx(stxAddress);
  if (stxBal < STX_GAS_FLOOR_USTX) {
    return out("blocked", action, {
      reason: "insufficient_stx_gas_reserve",
      stx_balance_ustx: stxBal.toString(),
      required_ustx: STX_GAS_FLOOR_USTX.toString(),
    });
  }

  // Mempool depth guard
  const pendingCount = await fetchPendingMempoolTxCount(stxAddress);
  if (pendingCount > 0) {
    return out("blocked", action, {
      reason: "sender_has_pending_mempool_tx",
      pending_count: pendingCount,
      hint: "Wait for the prior tx to confirm, then retry — avoids TooMuchChaining on nonce-serial writes.",
    });
  }

  const activePriceScaled = activeBinPriceScaled(poolBins.bins, poolBins.active_bin_id);
  if (activePriceScaled === 0n) {
    return out("blocked", action, { reason: "active_bin_price_unavailable" });
  }

  // ── OPT-IN 3-LEG PATH: withdraw-slice → swap → redeposit ────────────────────
  // Enabled by --allow-rebalance-withdraw. Addresses the v1 limitation where a
  // sprawled position cannot reach target ± --min-drift-pct via the default
  // swap+recenter flow (no primitive redeposits wallet-side swap output into LP).
  // Planned here, executed further below after the standard gates.
  const allowRebalanceWithdraw = Boolean(opts["allowRebalanceWithdraw"]);
  const sliceBpsCap = Math.min(
    REBALANCE_MAX_SLICE_BPS,
    Math.max(1, Number(opts["maxSliceBps"] ?? REBALANCE_MAX_SLICE_BPS))
  );

  if (allowRebalanceWithdraw) {
    const planResult = planRebalanceWithdraw(
      ratio, userBins, pool, poolBins.bins, poolBins.active_bin_id,
      activePriceScaled, slippageBps, sliceBpsCap
    );
    if (planResult.status === "refused") {
      return out("blocked", action, {
        reason: `rebalance_withdraw_${planResult.reason}`,
        detail: planResult.detail,
      });
    }
    const rwPlan = planResult.plan;

    if (!execute) {
      return out("success", action, {
        pool_id: poolId,
        mode: "rebalance_withdraw",
        ratio_before: ratio,
        plan: rwPlan,
        note: "Dry-run. Pass --confirm=BALANCE to execute the 3-leg flow (withdraw-slice → swap → redeposit).",
      });
    }

    // Guard rails before broadcasting a 3-tx sequence on mainnet
    if (stxBal < STX_GAS_FLOOR_USTX * 3n) {
      return out("blocked", action, {
        reason: "insufficient_stx_gas_for_3leg",
        stx_balance_ustx: stxBal.toString(),
        required_ustx: (STX_GAS_FLOOR_USTX * 3n).toString(),
        hint: "3-leg rebalance needs gas reserve for withdraw + swap + redeposit.",
      });
    }

    // Leg 1: withdraw-slice. We snapshot the swap + redeposit plans into
    // rebalance_pending_details at the same moment we mark the marker — the
    // resume path (above) reads this snapshot to rebuild the contract calls
    // without re-planning. Snapshot at marker-write-time means the snapshot
    // is durable across crash-between-broadcasts as well.
    const n1 = await fetchNonce(stxAddress);
    const withdrawTx = await executeWithdrawSlice(stxPrivateKey, stxAddress, pool, rwPlan.withdraw, n1);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "withdraw_done_swap_pending",
      last_withdraw_tx: withdrawTx,
      last_cycle_mode: "rebalance_withdraw",
      rebalance_pending_details: {
        swap: rwPlan.swap,
        redeposit: rwPlan.redeposit,
        target_ratio_x: targetXRatio,
        captured_at: new Date().toISOString(),
      },
    };
    saveInventoryState(state);
    await waitForTxConfirmation(withdrawTx);

    // Leg 2: swap the withdrawn overweight proceeds
    const n2 = await fetchNonce(stxAddress);
    const swapTx2 = await executeCorrectiveSwap(stxPrivateKey, stxAddress, pool, rwPlan.swap, n2);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_status: "withdraw_done_swap_done_redeposit_pending",
      last_swap_tx: swapTx2,
    };
    saveInventoryState(state);
    await waitForTxConfirmation(swapTx2);

    // Leg 3: redeposit swapped underweight proceeds as fresh liquidity near active
    const n3 = await fetchNonce(stxAddress);
    const redepositTx = await executeAddLiquidityRedeposit(stxPrivateKey, stxAddress, pool, rwPlan.redeposit, n3);
    state[poolId] = {
      ...(state[poolId] ?? {}),
      last_cycle_at: new Date().toISOString(),
      last_cycle_status: "success",
      last_redeposit_tx: redepositTx,
      rebalance_pending_details: undefined,
    };
    saveInventoryState(state);

    const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, targetXRatio);
    return out("success", action, {
      pool_id: poolId,
      pair: ratio.pair,
      mode: "rebalance_withdraw",
      ratio_before: ratio,
      ratio_after: ratioAfter,
      withdraw: { ...rwPlan.withdraw, tx_id: withdrawTx, explorer: `${EXPLORER}/0x${withdrawTx}?chain=mainnet` },
      swap: { ...rwPlan.swap, tx_id: swapTx2, explorer: `${EXPLORER}/0x${swapTx2}?chain=mainnet` },
      redeposit: { ...rwPlan.redeposit, tx_id: redepositTx, explorer: `${EXPLORER}/0x${redepositTx}?chain=mainnet` },
      projected_x_ratio_after: rwPlan.projected_x_ratio_after,
      state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
    });
  }

  // Operator overrides — deliberate escape hatch for testing or for corrections
  // the planner refuses (e.g. wallet holds under-weight side, over-weight side
  // is fully in the LP). Both flags must be supplied together.
  const forceDir = opts["forceDirection"] as string | undefined;
  const forceAmt = opts["forceAmountInRaw"] as string | undefined;
  if ((forceDir || forceAmt) && !(forceDir && forceAmt)) {
    return err(action, "--force-direction and --force-amount-in-raw must be used together");
  }
  if (forceDir && forceDir !== "X->Y" && forceDir !== "Y->X") {
    return err(action, "--force-direction must be 'X->Y' or 'Y->X'");
  }

  let plan: SwapPlan | null;
  if (forceDir && forceAmt) {
    const overrideIn = BigInt(forceAmt);
    const xForY = forceDir === "X->Y";
    const expectedOutRaw = xForY
      ? (overrideIn * activePriceScaled) / BigInt(PRICE_SCALE)
      : (overrideIn * BigInt(PRICE_SCALE)) / activePriceScaled;
    plan = {
      direction: forceDir as "X->Y" | "Y->X",
      token_in: xForY ? pool.token_x : pool.token_y,
      token_in_symbol: xForY ? pool.token_x_symbol : pool.token_y_symbol,
      token_in_decimals: xForY ? pool.token_x_decimals : pool.token_y_decimals,
      token_out: xForY ? pool.token_y : pool.token_x,
      token_out_symbol: xForY ? pool.token_y_symbol : pool.token_x_symbol,
      token_out_decimals: xForY ? pool.token_y_decimals : pool.token_x_decimals,
      amount_in_raw: overrideIn.toString(),
      expected_amount_out_raw: expectedOutRaw.toString(),
      minimum_amount_out_raw: ((expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
      slippage_bps: slippageBps,
      quote_source: `${BITFLOW_QUOTES}/bins/${poolId}#active_bin_price (operator override)`,
      quote_fetched_at: poolBins.fetched_at,
    };
  } else {
    plan = planCorrectiveSwap({
      ratio,
      pool,
      activeBinPriceScaled: activePriceScaled,
      minDriftPct,
      maxCorrectionSats,
      slippageBps,
    });
    if (!plan) {
      return out("success", action, { pool_id: poolId, reason: "no_correction_planned_below_min_swap", ratio });
    }
  }

  if (!execute) {
    return out("success", action, {
      pool_id: poolId,
      ratio_before: ratio,
      swap: plan,
      redeploy: skipRedeploy ? null : { skill: "hodlmm-move-liquidity", invocation: `run --pool ${poolId} --confirm` },
      note: "Dry-run. Pass --confirm=BALANCE to execute.",
    });
  }

  // Pre-broadcast thin-pool guard — #493 safety contract.
  // If the active bin's reserve of the OUTPUT token is less than
  // THIN_POOL_MIN_RATIO × the expected output, a single-hop swap would
  // need to walk many bins and risk moving the pool price by more than the
  // slippage budget. Refuse rather than broadcast.
  const outputActiveReserveRaw = plan.direction === "X->Y"
    ? BigInt(
      poolBins.bins.find((b) => b.bin_id === poolBins.active_bin_id)?.reserve_y ?? "0"
    )
    : BigInt(
      poolBins.bins.find((b) => b.bin_id === poolBins.active_bin_id)?.reserve_x ?? "0"
    );
  const expectedOutForThreshold = BigInt(plan.expected_amount_out_raw);
  if (outputActiveReserveRaw < expectedOutForThreshold * THIN_POOL_MIN_RATIO) {
    return out("blocked", action, {
      reason: "pool_volume_too_thin",
      direction: plan.direction,
      active_bin_output_reserve_raw: outputActiveReserveRaw.toString(),
      expected_output_raw: expectedOutForThreshold.toString(),
      min_ratio: THIN_POOL_MIN_RATIO.toString(),
      hint: "Active bin's output-token reserve is less than the conservative headroom (3× expected). Thin pools can move price beyond the slippage budget. Shrink --max-correction-sats or try a different pool.",
    });
  }

  // Pre-broadcast input-token balance gate — per @arc0btc's review on PR #494.
  // The swap transfers `amount_in_raw` of token_in FROM the sender's wallet
  // via the SIP-010 transfer call inside the router. If the wallet doesn't
  // hold it (common when the over-weight side is fully locked in LP bins),
  // the tx would abort on-chain AND the state marker would still be written,
  // leaving the next run trying to redeploy against a swap that never settled.
  // Routes through `resolveTokenAsset` so STX vs FT detection stays in sync
  // with the post-condition path.
  const inAssetResolved = resolveTokenAsset(plan.token_in);
  const requiredIn = BigInt(plan.amount_in_raw);
  const availableIn = await fetchTokenBalanceRaw(stxAddress, inAssetResolved);
  if (availableIn < requiredIn) {
    return out("blocked", action, {
      reason: "insufficient_input_token_balance",
      token_in: plan.token_in,
      token_in_symbol: plan.token_in_symbol,
      required_raw: requiredIn.toString(),
      available_raw: availableIn.toString(),
      hint: "The over-weight token likely sits inside LP bins. Withdraw a slice first or top up the wallet externally. v1 does not auto-withdraw.",
    });
  }

  // Execute: swap → state marker → redeploy (if not skipped)
  const nonce = await fetchNonce(stxAddress);
  const swapTx = await executeCorrectiveSwap(stxPrivateKey, stxAddress, pool, plan, nonce);

  state[poolId] = {
    ...(state[poolId] ?? {}),
    last_cycle_at: new Date().toISOString(),
    last_cycle_status: "swap_done_redeploy_pending",
    last_swap_tx: swapTx,
    swap_pending_details: {
      swap_tx: swapTx,
      swap_direction: plan.direction,
      swap_amount_in_raw: plan.amount_in_raw,
      swap_minimum_out_raw: plan.minimum_amount_out_raw,
      target_ratio_x: targetXRatio,
      captured_at: new Date().toISOString(),
    },
  };
  saveInventoryState(state);

  if (skipRedeploy) {
    const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, targetXRatio);
    return out("success", action, {
      pool_id: poolId,
      ratio_before: ratio,
      ratio_after: ratioAfter,
      swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
      redeploy: null,
      state_marker: { path: INVENTORY_STATE_FILE, status: "swap_done_redeploy_pending" },
    });
  }

  let redeployTx: string;
  try {
    redeployTx = invokeMoveLiquidityRedeploy(poolId, stxAddress, password || undefined);
  } catch (e) {
    return out("error", action, {
      pool_id: poolId,
      swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
      state_marker: { path: INVENTORY_STATE_FILE, status: "swap_done_redeploy_pending" },
    }, `Redeploy failed after swap — marker kept for resumption: ${(e as Error).message}`);
  }

  state[poolId] = {
    ...(state[poolId] ?? {}),
    last_cycle_at: new Date().toISOString(),
    last_cycle_status: "success",
    last_swap_tx: swapTx,
    last_redeploy_tx: redeployTx,
    swap_pending_details: undefined,
  };
  saveInventoryState(state);

  // #493 step 6 "Verify": re-read position post-broadcast and emit ratio_after.
  const ratioAfter = await readRatioAfterDelay(poolId, stxAddress, targetXRatio);

  return out("success", action, {
    pool_id: poolId,
    pair: ratio.pair,
    ratio_before: ratio,
    ratio_after: ratioAfter,
    swap: { ...plan, tx_id: swapTx, explorer: `${EXPLORER}/0x${swapTx}?chain=mainnet` },
    redeploy: { tx_id: redeployTx, explorer: `${EXPLORER}/0x${redeployTx}?chain=mainnet` },
    state_marker: { path: INVENTORY_STATE_FILE, status: "success" },
  });
}

/**
 * Re-read the position ratio after a short delay so the first Nakamoto block
 * has a chance to include our tx. If the tx hasn't confirmed yet, the returned
 * ratio may still reflect pre-swap state — the `quote_fetched_at` field on the
 * returned RatioSummary lets the caller reason about freshness.
 */
async function readRatioAfterDelay(poolId: string, wallet: string, targetXRatio: number): Promise<RatioSummary | { note: string }> {
  try {
    await new Promise((r) => setTimeout(r, VERIFY_SLEEP_MS));
    const { pool, poolBins, userBins } = await gatherPool(poolId, wallet);
    if (userBins.length === 0) return { note: "no_user_position_after" };
    return computeRatio(pool, userBins, poolBins.bins, poolBins.active_bin_id, targetXRatio, poolBins.fetched_at);
  } catch (e) {
    return { note: `ratio_after_read_failed: ${(e as Error).message}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTargetRatio(s: string): number {
  const parts = s.split(":").map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((p) => Number.isNaN(p) || p < 0)) {
    throw new Error(`Invalid --target-ratio '${s}'. Expected X:Y like '50:50'.`);
  }
  const sum = parts[0] + parts[1];
  if (sum === 0) throw new Error("target-ratio sides cannot both be 0.");
  return parts[0] / sum;
}

function slippageDefault(): number {
  const fromEnv = process.env.INVENTORY_BALANCER_SLIPPAGE_BPS;
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed < 5000 ? parsed : DEFAULT_SLIPPAGE_BPS;
}

// ─── Go ───────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  program.parseAsync(process.argv).catch((e) => {
    err("main", (e as Error).message);
  });
}
