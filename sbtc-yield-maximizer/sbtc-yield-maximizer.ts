#!/usr/bin/env bun

import { Command } from "commander";
import { homedir, tmpdir } from "os";
import { extname, isAbsolute, join, resolve as resolvePath } from "path";
import { closeSync, openSync, statSync, unlinkSync } from "fs";
import { cvToJSON, hexToCV } from "@stacks/transactions";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getZestProtocolService } from "../src/lib/services/defi.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";

const NETWORK = "mainnet";
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1/pools";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1/pools";
const BITFLOW_BINS_API = "https://bff.bitflowapis.finance/api/quotes/v1/bins";
const BITFLOW_APP_USER_POSITIONS_API = "https://bff.bitflowapis.finance/api/app/v1/users";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const ZEST_SBTC_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";
const FETCH_TIMEOUT_MS = 30_000;
const PRICE_SCALE = 1e8;
const DEFAULT_MAX_DEPLOY_SATS = 10_000n;
const DEFAULT_RESERVE_SATS = 100n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 100_000n;
const DEFAULT_MIN_HODLMM_VOLUME_USD = 250;
const DEFAULT_MIN_HODLMM_TVL_USD = 1_000;
const DEFAULT_MAX_PRICE_DIVERGENCE_PCT = 1;
const DEFAULT_MIN_APY_DIFF_BPS = 50;
const DEFAULT_MAX_DATA_AGE_SECONDS = 30;
const DEFAULT_META_COOLDOWN_HOURS = 1;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 0;
const DEFAULT_HODLMM_SPREAD = 5;
const MAX_HODLMM_FALLBACK_POOLS = 3;
const CONFIRM_TOKEN = "MAXIMIZE";
const STATE_DIR = join(homedir(), ".aibtc");
const HODLMM_EXTERNAL_COOLDOWN_HOURS = 4;
const EXECUTION_LOCK_MAX_AGE_MS = 15 * 60_000;
const HODLMM_MOVE_STATE_CANDIDATES = [
  join(STATE_DIR, "hodlmm-move-liquidity-state.json"),
  join(homedir(), ".hodlmm-move-liquidity-state.json"),
];

type SkillStatus = "success" | "error" | "blocked";
type RouteName = "hold" | "lend-to-zest" | "deploy-to-hodlmm";

interface SkillOutput {
  status: SkillStatus;
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface WalletMetadata {
  id: string;
  name?: string;
  address: string;
  btcAddress?: string;
  taprootAddress?: string;
  network?: string;
}

interface HiroStxResponse {
  balance: string;
  locked: string;
}

interface HiroBalancesResponse {
  fungible_tokens?: Record<string, { balance: string }>;
}

interface QuotePool {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
}

interface BinRecord {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface AppPoolToken {
  contract: string;
  symbol?: string;
  decimals: number;
  priceUsd: number;
}

interface AppPool {
  poolId: string;
  tvlUsd: number;
  volumeUsd1d: number;
  feesUsd1d: number;
  feesUsd7d: number;
  apr24h: number;
  tokens: {
    tokenX: AppPoolToken;
    tokenY: AppPoolToken;
  };
}

interface AppPoolsResponse {
  data?: AppPool[];
}

interface BinsResponse {
  bins?: BinRecord[];
}

interface UserPositionBin {
  bin_id: number;
  userLiquidity?: string | number;
  user_liquidity?: string;
  liquidity?: string;
}

interface UserPositionBinsResponse {
  bins?: UserPositionBin[];
}

interface FreshRead {
  fetchedAt: string;
  ageSeconds: number;
}

interface ZestSignal extends FreshRead {
  rawInterestRate: bigint;
  utilization: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  inferredApyBps: number;
  inferredApyPct: number;
}

interface HodlmmMoveHealth {
  hasPosition: boolean;
  inRange: boolean;
  drift: number;
  userBins: number[];
}

interface HodlmmCandidate extends FreshRead {
  poolId: string;
  pair: string;
  apr24h: number;
  feeRunRatePct: number;
  effectiveYieldPct: number;
  effectiveYieldBps: number;
  volumeUsd1d: number;
  tvlUsd: number;
  divergencePct: number;
  safe: boolean;
  reasons: string[];
  moveHealth: HodlmmMoveHealth;
}

interface RouteDecision {
  route: RouteName;
  deploySats: bigint;
  rationale: string[];
  zest: ZestSignal;
  topHodlmm: HodlmmCandidate | null;
  executable: boolean;
  winnerApyBps: number;
  apyDiffBps: number;
}

interface MaximizerState {
  lastDecisionAt?: string;
  lastRoute?: RouteName;
  lastTxid?: string;
}

interface CooldownResult {
  ok: boolean;
  remainingHours: number;
  lastDecisionAt: string | null;
}

interface ExternalCooldownState {
  [poolId: string]: { last_move_at: string };
}

interface MempoolResponse {
  total?: number;
  results?: unknown[];
}

interface RunOptions {
  walletId?: string;
  maxDeploySats: bigint;
  reserveSats: bigint;
  minGasReserveUstx: bigint;
  minHodlmmVolumeUsd: number;
  minHodlmmTvlUsd: number;
  maxPriceDivergencePct: number;
  minApyDiffBps: number;
  maxDataAgeSeconds: number;
  cooldownHours: number;
  mempoolDepthLimit: number;
  hodlmmSpread: number;
  confirm?: string;
}

interface Context {
  wallet: WalletMetadata;
  stxUstx: bigint;
  sbtcSats: bigint;
  cooldown: CooldownResult;
  mempoolDepth: number;
  decision: RouteDecision;
  blockers: string[];
  zestPosition: Record<string, unknown> | null;
  hodlmmCandidates: HodlmmCandidate[];
  stateFile: string;
  hodlmmStateFile: string | null;
}

interface ExternalCommandResult {
  status?: string;
  action?: string;
  error?: string | null;
  data?: Record<string, unknown>;
}

interface HodlmmScanPosition {
  pool_id?: string;
  poolId?: string;
  in_range?: boolean;
  inRange?: boolean;
}

const REQUIRED_PACKS = [
  "@aibtc/mcp-server",
  "@stacks/transactions",
  "commander",
] as const;

function getStateFile(walletId: string): string {
  return join(STATE_DIR, `sbtc-yield-maximizer-${walletId}.json`);
}

function getLockFile(walletId: string): string {
  return join(STATE_DIR, `sbtc-yield-maximizer-${walletId}.lock`);
}

function serializeZestSignal(signal: ZestSignal): Record<string, unknown> {
  return {
    rawInterestRate: signal.rawInterestRate.toString(),
    utilization: signal.utilization.toString(),
    totalAssets: signal.totalAssets.toString(),
    totalSupply: signal.totalSupply.toString(),
    inferredApyBps: signal.inferredApyBps,
    inferredApyPct: signal.inferredApyPct,
    fetchedAt: signal.fetchedAt,
    ageSeconds: signal.ageSeconds,
  };
}

function printFlatError(message: string): never {
  console.log(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

function printResult(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function toBigInt(value: string | number | bigint | undefined | null): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function parseBigIntOption(value: string | undefined, fallback: bigint, flag: string): bigint {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) printFlatError(`${flag} must not be empty`);
  try {
    return BigInt(trimmed);
  } catch {
    printFlatError(`${flag} must be an integer value`);
  }
}

function parseNumberOption(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) printFlatError(`${flag} must not be empty`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) printFlatError(`${flag} must be a numeric value`);
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "aibtc-skills/sbtc-yield-maximizer",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveWallet(walletId?: string): Promise<WalletMetadata> {
  const manager = getWalletManager();
  const wallets = (await manager.listWallets()) as WalletMetadata[];
  if (!wallets.length) throw new Error("No AIBTC wallets found");

  if (walletId) {
    const selected = wallets.find((wallet) => wallet.id === walletId);
    if (!selected) throw new Error(`Wallet ${walletId} not found`);
    if (selected.network !== NETWORK) throw new Error(`Wallet ${walletId} is not on ${NETWORK}`);
    return selected;
  }

  const activeWalletId = await manager.getActiveWalletId();
  if (!activeWalletId) throw new Error("No active AIBTC wallet set");
  const active = wallets.find((wallet) => wallet.id === activeWalletId);
  if (!active) throw new Error("Active AIBTC wallet could not be resolved");
  if (active.network !== NETWORK) throw new Error(`Active wallet is not on ${NETWORK}`);
  return active;
}

async function getStxBalance(address: string): Promise<bigint> {
  const data = await fetchJson<HiroStxResponse>(`${HIRO_API}/extended/v1/address/${address}/stx`);
  const balance = toBigInt(data.balance);
  const locked = toBigInt(data.locked);
  return balance > locked ? balance - locked : 0n;
}

async function getSbtcBalance(address: string): Promise<bigint> {
  const data = await fetchJson<HiroBalancesResponse>(`${HIRO_API}/extended/v1/address/${address}/balances`);
  const key = Object.keys(data.fungible_tokens || {}).find((entry) => entry.startsWith(SBTC_CONTRACT));
  return toBigInt(key ? data.fungible_tokens?.[key]?.balance : "0");
}

async function readState(walletId: string): Promise<MaximizerState> {
  try {
    const file = Bun.file(getStateFile(walletId));
    if (!(await file.exists())) return {};
    return JSON.parse(await file.text()) as MaximizerState;
  } catch {
    return {};
  }
}

async function writeState(walletId: string, state: MaximizerState): Promise<void> {
  await Bun.write(getStateFile(walletId), JSON.stringify(state, null, 2));
}

async function checkCooldown(walletId: string, cooldownHours: number): Promise<CooldownResult> {
  const state = await readState(walletId);
  if (!state.lastDecisionAt) return { ok: true, remainingHours: 0, lastDecisionAt: null };
  const elapsed = (Date.now() - new Date(state.lastDecisionAt).getTime()) / 3_600_000;
  const remaining = Math.max(0, cooldownHours - elapsed);
  return {
    ok: remaining === 0,
    remainingHours: Number(remaining.toFixed(2)),
    lastDecisionAt: state.lastDecisionAt,
  };
}

async function getMempoolDepth(address: string): Promise<number> {
  const data = await fetchJson<MempoolResponse>(`${HIRO_API}/extended/v1/address/${address}/mempool?limit=1`);
  return Number(data.total || data.results?.length || 0);
}

async function getZestSignal(senderAddress: string): Promise<ZestSignal> {
  const fetchedAt = new Date().toISOString();
  const hiro = getHiroApi(NETWORK);
  const readUint = async (fn: string): Promise<bigint> => {
    const result = await hiro.callReadOnlyFunction(ZEST_SBTC_VAULT, fn, [], senderAddress);
    if (!result.okay || !result.result) return 0n;
    const decoded = cvToJSON(hexToCV(result.result));
    const value = decoded?.value?.value ?? decoded?.value;
    return toBigInt(value);
  };
  const [rawInterestRate, utilization, totalAssets, totalSupply] = await Promise.all([
    readUint("get-interest-rate"),
    readUint("get-utilization"),
    readUint("get-total-assets"),
    readUint("get-total-supply"),
  ]);
  // Verified against the live v0-vault-sbtc source, which defines BPS u10000.
  const inferredApyBps = Number(rawInterestRate);
  return {
    rawInterestRate,
    utilization,
    totalAssets,
    totalSupply,
    inferredApyBps,
    inferredApyPct: inferredApyBps / 100,
    fetchedAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - new Date(fetchedAt).getTime()) / 1000)),
  };
}

async function getZestPosition(address: string): Promise<Record<string, unknown> | null> {
  const service = getZestProtocolService(NETWORK);
  return (await service.getUserPosition("sBTC", address)) as unknown as Record<string, unknown> | null;
}

async function fetchUserPositionBins(address: string, poolId: string): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${BITFLOW_APP_USER_POSITIONS_API}/${address}/positions/${poolId}/bins`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "aibtc-skills/sbtc-yield-maximizer",
      },
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${BITFLOW_APP_USER_POSITIONS_API}/${address}/positions/${poolId}/bins`);
    const data = (await response.json()) as UserPositionBinsResponse;
    return (data.bins || [])
      .filter((bin) => toBigInt(bin.userLiquidity ?? bin.user_liquidity ?? bin.liquidity ?? "0") > 0n)
      .map((bin) => Number(bin.bin_id))
      .sort((a, b) => a - b);
  } finally {
    clearTimeout(timer);
  }
}

function assessMoveHealth(activeBin: number, userBins: number[]): HodlmmMoveHealth {
  if (userBins.length === 0) {
    return {
      hasPosition: false,
      inRange: false,
      drift: 0,
      userBins: [],
    };
  }
  const inRange = activeBin >= userBins[0] && activeBin <= userBins[userBins.length - 1];
  const center = Math.round((userBins[0] + userBins[userBins.length - 1]) / 2);
  return {
    hasPosition: true,
    inRange,
    drift: Math.abs(activeBin - center),
    userBins,
  };
}

async function fetchHodlmmCandidates(options: RunOptions, walletAddress: string): Promise<HodlmmCandidate[]> {
  const [quotePoolsData, appPoolsData] = await Promise.all([
    fetchJson<{ pools?: QuotePool[] }>(BITFLOW_QUOTES_API),
    fetchJson<AppPoolsResponse>(BITFLOW_APP_API),
  ]);
  const quotePools = (quotePoolsData.pools || [])
    .filter((pool) => pool.token_x === SBTC_CONTRACT || pool.token_y === SBTC_CONTRACT);
  const appPools = (appPoolsData.data || []).filter(
    (pool) => pool.tokens.tokenX.contract === SBTC_CONTRACT || pool.tokens.tokenY.contract === SBTC_CONTRACT
  );
  const appMap = new Map(appPools.map((pool) => [pool.poolId, pool]));
  const matchedPools = quotePools
    .map((pool) => ({ quote: pool, app: appMap.get(pool.pool_id) || null }))
    .filter((entry): entry is { quote: QuotePool; app: AppPool } => Boolean(entry.app));
  const candidatePools = matchedPools.filter(
    ({ app }) => app.volumeUsd1d >= options.minHodlmmVolumeUsd && app.tvlUsd >= options.minHodlmmTvlUsd
  );
  // If no pool clears the configured liquidity floors, still surface a bounded
  // fallback set for status visibility. These fallback candidates may remain
  // unsafe and must still pass the downstream `safe` gate before execution.
  const poolsToEvaluate = candidatePools.length > 0
    ? candidatePools
    : matchedPools
        .sort((a, b) => (b.app.tvlUsd + b.app.volumeUsd1d) - (a.app.tvlUsd + a.app.volumeUsd1d))
        .slice(0, MAX_HODLMM_FALLBACK_POOLS);

  const candidates = await Promise.all(
    poolsToEvaluate.map(async ({ quote, app }): Promise<HodlmmCandidate | null> => {
      const fetchedAt = new Date().toISOString();
      const [binsData, userBins] = await Promise.all([
        fetchJson<BinsResponse>(`${BITFLOW_BINS_API}/${quote.pool_id}`),
        fetchUserPositionBins(walletAddress, quote.pool_id),
      ]);
      const bins = binsData.bins || [];
      const activeBin = bins.find((bin) => bin.bin_id === quote.active_bin);
      const tokenXIsSbtc = app.tokens.tokenX.contract === SBTC_CONTRACT;
      const sbtcPriceUsd = tokenXIsSbtc ? app.tokens.tokenX.priceUsd : app.tokens.tokenY.priceUsd;
      const pairedPriceUsd = tokenXIsSbtc ? app.tokens.tokenY.priceUsd : app.tokens.tokenX.priceUsd;
      let divergencePct = 0;
      if (activeBin && sbtcPriceUsd > 0) {
        const normalized = (Number(activeBin.price) / PRICE_SCALE) *
          Math.pow(10, app.tokens.tokenX.decimals - app.tokens.tokenY.decimals);
        const activeSbtcPriceUsd = tokenXIsSbtc
          ? normalized * pairedPriceUsd
          : normalized > 0
          ? app.tokens.tokenX.priceUsd / normalized
          : 0;
        if (activeSbtcPriceUsd > 0) {
          divergencePct = (Math.abs(activeSbtcPriceUsd - sbtcPriceUsd) / sbtcPriceUsd) * 100;
        }
      }

      const feeRunRatePct = app.tvlUsd > 0 ? (app.feesUsd1d / app.tvlUsd) * 365 * 100 : 0;
      const effectiveYieldPct = Math.max(app.apr24h, feeRunRatePct);
      const reasons: string[] = [];
      if (app.volumeUsd1d < options.minHodlmmVolumeUsd) reasons.push(`24h volume ${app.volumeUsd1d.toFixed(2)} < ${options.minHodlmmVolumeUsd}`);
      if (app.tvlUsd < options.minHodlmmTvlUsd) reasons.push(`TVL ${app.tvlUsd.toFixed(2)} < ${options.minHodlmmTvlUsd}`);
      if (divergencePct > options.maxPriceDivergencePct) reasons.push(`price divergence ${divergencePct.toFixed(2)}% > ${options.maxPriceDivergencePct}%`);

      const moveHealth = assessMoveHealth(quote.active_bin, userBins);
      if (!moveHealth.hasPosition) reasons.push("no active LP position is available for move-liquidity");

      return {
        poolId: quote.pool_id,
        pair: tokenXIsSbtc ? `sBTC-${app.tokens.tokenY.symbol}` : `${app.tokens.tokenX.symbol}-sBTC`,
        apr24h: app.apr24h,
        feeRunRatePct: Number(feeRunRatePct.toFixed(4)),
        effectiveYieldPct: Number(effectiveYieldPct.toFixed(4)),
        effectiveYieldBps: Math.round(effectiveYieldPct * 100),
        volumeUsd1d: app.volumeUsd1d,
        tvlUsd: app.tvlUsd,
        divergencePct: Number(divergencePct.toFixed(4)),
        safe: reasons.length === 0,
        reasons,
        moveHealth,
        fetchedAt,
        ageSeconds: Math.max(0, Math.round((Date.now() - new Date(fetchedAt).getTime()) / 1000)),
      };
    })
  );

  return candidates
    .filter((candidate): candidate is HodlmmCandidate => Boolean(candidate))
    .sort((a, b) => b.effectiveYieldBps - a.effectiveYieldBps);
}

function decideRoute(
  sbtcSats: bigint,
  stxUstx: bigint,
  mempoolDepth: number,
  zest: ZestSignal,
  hodlmmCandidates: HodlmmCandidate[],
  options: RunOptions,
  cooldown: CooldownResult
): RouteDecision {
  const idleSats = sbtcSats > options.reserveSats ? sbtcSats - options.reserveSats : 0n;
  const deploySats = idleSats > options.maxDeploySats ? options.maxDeploySats : idleSats;
  const topHodlmm = hodlmmCandidates[0] || null;
  const rationale: string[] = [];

  if (!cooldown.ok) {
    rationale.push(`Router cooldown active for another ${cooldown.remainingHours} hours`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }
  if (mempoolDepth > options.mempoolDepthLimit) {
    rationale.push(`Pending mempool depth ${mempoolDepth} exceeds allowed limit ${options.mempoolDepthLimit}`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }
  if (stxUstx < options.minGasReserveUstx) {
    rationale.push(`STX reserve ${stxUstx.toString()} uSTX is below required ${options.minGasReserveUstx.toString()} uSTX`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }
  if (deploySats <= 0n) {
    rationale.push("No idle sBTC remains above reserve");
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }
  // ageSeconds is most useful once these reads are cached or reused across
  // cycles; today it mainly captures fetch duration and leaves the stale-data
  // gate ready for future cached reads.
  if (zest.ageSeconds > options.maxDataAgeSeconds) {
    rationale.push(`Zest rate age ${zest.ageSeconds}s exceeds max data age ${options.maxDataAgeSeconds}s`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }
  if (topHodlmm && topHodlmm.ageSeconds > options.maxDataAgeSeconds) {
    rationale.push(`HODLMM data age ${topHodlmm.ageSeconds}s exceeds max data age ${options.maxDataAgeSeconds}s`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
  }

  const zestBps = zest.inferredApyBps;
  const hodlmmBps = topHodlmm?.effectiveYieldBps || 0;
  const apyDiffBps = Math.abs(hodlmmBps - zestBps);

  if (topHodlmm && hodlmmBps > zestBps) {
    if (!topHodlmm.safe) {
      rationale.push(`Top HODLMM pool failed safety gates: ${topHodlmm.reasons.join("; ")}`);
      return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: hodlmmBps, apyDiffBps };
    }
    if (apyDiffBps < options.minApyDiffBps) {
      rationale.push(`HODLMM only leads Zest by ${apyDiffBps} bps, below the ${options.minApyDiffBps} bps minimum edge`);
      return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: hodlmmBps, apyDiffBps };
    }
    if (topHodlmm.moveHealth.inRange) {
      rationale.push(`HODLMM pool ${topHodlmm.poolId} leads by ${apyDiffBps} bps and the current position is already in range`);
      return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: hodlmmBps, apyDiffBps };
    }
    rationale.push(`HODLMM leads Zest by ${apyDiffBps} bps`);
    rationale.push(`Pool ${topHodlmm.poolId} has an out-of-range LP position with drift ${topHodlmm.moveHealth.drift}`);
    return { route: "deploy-to-hodlmm", deploySats, rationale, zest, topHodlmm, executable: true, winnerApyBps: hodlmmBps, apyDiffBps };
  }

  if (zestBps > 0) {
    if (topHodlmm && zestBps - hodlmmBps < options.minApyDiffBps) {
      rationale.push(`Zest only leads HODLMM by ${zestBps - hodlmmBps} bps, below the ${options.minApyDiffBps} bps minimum edge`);
      return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: zestBps, apyDiffBps: zestBps - hodlmmBps };
    }
    rationale.push(`Zest inferred yield ${zest.inferredApyPct.toFixed(2)}% is the best safe executable route`);
    if (topHodlmm && !topHodlmm.safe) rationale.push(`Top HODLMM pool failed safety gates: ${topHodlmm.reasons.join("; ")}`);
    return { route: "lend-to-zest", deploySats, rationale, zest, topHodlmm, executable: true, winnerApyBps: zestBps, apyDiffBps: Math.max(0, zestBps - hodlmmBps) };
  }

  rationale.push("No positive executable yield route is currently available");
  return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false, winnerApyBps: 0, apyDiffBps: 0 };
}

async function readExternalCooldown(poolId: string): Promise<{ active: boolean; remainingHours: number; stateFile: string | null }> {
  for (const stateFile of HODLMM_MOVE_STATE_CANDIDATES) {
    try {
      const file = Bun.file(stateFile);
      if (!(await file.exists())) continue;
      const state = JSON.parse(await file.text()) as ExternalCooldownState;
      const entry = state[poolId];
      if (!entry) return { active: false, remainingHours: 0, stateFile };
      const elapsedHours = (Date.now() - new Date(entry.last_move_at).getTime()) / 3_600_000;
      const remainingHours = Math.max(0, HODLMM_EXTERNAL_COOLDOWN_HOURS - elapsedHours);
      return { active: remainingHours > 0, remainingHours: Number(remainingHours.toFixed(2)), stateFile };
    } catch {
      continue;
    }
  }
  return { active: false, remainingHours: 0, stateFile: null };
}

function acquireExecutionLock(walletId: string): () => void {
  const lockFile = getLockFile(walletId);
  const existing = statSync(lockFile, { throwIfNoEntry: false });
  if (existing && Date.now() - existing.mtimeMs > EXECUTION_LOCK_MAX_AGE_MS) {
    try {
      unlinkSync(lockFile);
    } catch {}
  }
  const fd = openSync(lockFile, "wx");
  return () => {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(lockFile);
    } catch {}
  };
}

function resolveHodlmmCommand(): string[] {
  const env = process.env.HODLMM_MOVE_LIQUIDITY_CMD?.trim();
  if (env) return env.split(/\s+/);
  const direct = Bun.which("hodlmm-move-liquidity");
  if (direct) return [direct];
  throw new Error("HODLMM_MOVE_LIQUIDITY_CMD is not set and hodlmm-move-liquidity is not installed in PATH");
}

function resolveHodlmmScriptTarget(command: string[]): string | null {
  let candidate: string | null = null;
  if (command[0] === "bun" && command[1] === "run" && command[2]) {
    candidate = command[2];
  } else if (command.length === 1) {
    candidate = command[0];
  }
  if (!candidate) return null;
  const resolved = isAbsolute(candidate) ? candidate : resolvePath(process.cwd(), candidate);
  const extension = extname(resolved).toLowerCase();
  return [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extension) ? resolved : null;
}

function getHodlmmSecureExecutionError(): string {
  return "Secure HODLMM execution requires HODLMM_MOVE_LIQUIDITY_CMD to resolve to a Bun-runnable script path";
}

async function runExternalJsonCommand(command: string[], args: string[], extraEnv: Record<string, string> = {}): Promise<ExternalCommandResult> {
  const proc = Bun.spawn({
    cmd: [...command, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `External command failed with exit code ${exitCode}`);
  }
  let parsed: ExternalCommandResult;
  try {
    parsed = JSON.parse(stdout.trim()) as ExternalCommandResult;
  } catch {
    throw new Error(`Could not parse external JSON output: ${stdout.trim() || stderr.trim()}`);
  }
  if (parsed.status === "error") {
    throw new Error(parsed.error || "External command reported an error");
  }
  return parsed;
}

async function runHodlmmJsonCommand(
  command: string[],
  args: string[],
  extraEnv: Record<string, string> = {},
  requirePasswordBridge = false
): Promise<ExternalCommandResult> {
  const scriptTarget = resolveHodlmmScriptTarget(command);
  if (!scriptTarget) {
    if (requirePasswordBridge) {
      throw new Error(getHodlmmSecureExecutionError());
    }
    return runExternalJsonCommand(command, args, extraEnv);
  }

  const wrapperPath = join(
    tmpdir(),
    `sbtc-yield-maximizer-hodlmm-wrapper-${process.pid}-${Date.now()}.mjs`
  );
  const wrapperSource = [
    `process.argv = ["bun", ${JSON.stringify(scriptTarget)}, ...JSON.parse(process.env.HODLMM_WRAPPER_ARGS || "[]"), ...(process.env.AIBTC_WALLET_PASSWORD ? ["--password", process.env.AIBTC_WALLET_PASSWORD] : [])];`,
    `await import(${JSON.stringify(scriptTarget)});`,
  ].join("\n");

  await Bun.write(wrapperPath, wrapperSource);
  try {
    return await runExternalJsonCommand(["bun", wrapperPath], [], {
      ...extraEnv,
      HODLMM_WRAPPER_ARGS: JSON.stringify(args),
    });
  } finally {
    try {
      unlinkSync(wrapperPath);
    } catch {}
  }
}

async function preflightHodlmmMove(context: Context, options: RunOptions, extraEnv: Record<string, string> = {}): Promise<ExternalCommandResult> {
  const top = context.decision.topHodlmm;
  if (!top) throw new Error("No HODLMM pool selected for preflight");
  const command = resolveHodlmmCommand();
  const result = await runHodlmmJsonCommand(command, [
    "scan",
    "--wallet",
    context.wallet.address,
  ], extraEnv);
  const positions = ((result.data as Record<string, unknown> | undefined)?.positions || []) as HodlmmScanPosition[];
  const selected = positions.find((position) => (position.pool_id || position.poolId) === top.poolId);
  if (!selected) {
    throw new Error(`HODLMM preflight did not find a position for pool ${top.poolId}`);
  }
  const inRange = selected.in_range ?? selected.inRange ?? false;
  if (inRange) {
    throw new Error(`HODLMM preflight found pool ${top.poolId} already in range`);
  }
  return result;
}

async function executeHodlmmMove(context: Context, options: RunOptions, password: string): Promise<{ txid: string; explorerUrl: string; command: string[]; preflight: ExternalCommandResult }> {
  const top = context.decision.topHodlmm;
  if (!top) throw new Error("No HODLMM pool selected for execution");
  const externalCooldown = await readExternalCooldown(top.poolId);
  if (externalCooldown.active) {
    throw new Error(`hodlmm-move-liquidity cooldown is active for another ${externalCooldown.remainingHours} hours`);
  }

  const walletManager = getWalletManager();
  const account = await walletManager.unlock(context.wallet.id, password);
  const privateKey = String(
    (account as Record<string, unknown>).stxPrivateKey ||
    (account as Record<string, unknown>).privateKey ||
    ""
  );
  if (!privateKey) {
    await walletManager.lock().catch(() => undefined);
    throw new Error("Selected wallet did not expose stxPrivateKey for delegated HODLMM execution");
  }

  const command = resolveHodlmmCommand();
  const extraEnv = {
    STACKS_PRIVATE_KEY: privateKey,
    STACKS_ADDRESS: context.wallet.address,
  };

  try {
    const preflight = await preflightHodlmmMove(context, options, extraEnv);
    const result = await runHodlmmJsonCommand(command, [
      "run",
      "--wallet",
      context.wallet.address,
      "--pool",
      top.poolId,
      "--spread",
      String(options.hodlmmSpread),
      "--confirm",
    ], extraEnv, true);

    const transaction = ((result.data as Record<string, unknown> | undefined)?.transaction || null) as Record<string, unknown> | null;
    const txid = String(transaction?.txid || "");
    const explorerUrl = String(transaction?.explorer || "");
    if (!txid) throw new Error("HODLMM execution succeeded but returned no txid");
    return { txid, explorerUrl, command, preflight };
  } finally {
    await walletManager.lock().catch(() => undefined);
  }
}

async function collectContext(options: RunOptions): Promise<Context> {
  const wallet = await resolveWallet(options.walletId);
  const stateFile = getStateFile(wallet.id);
  const hodlmmStateFile = (
    await Promise.all(
      HODLMM_MOVE_STATE_CANDIDATES.map(async (file) => ((await Bun.file(file).exists()) ? file : null))
    )
  ).find((file): file is string => Boolean(file)) || null;
  const [stxUstx, sbtcSats, cooldown, mempoolDepth, zest, hodlmmCandidates, zestPosition] = await Promise.all([
    getStxBalance(wallet.address),
    getSbtcBalance(wallet.address),
    checkCooldown(wallet.id, options.cooldownHours),
    getMempoolDepth(wallet.address),
    getZestSignal(wallet.address),
    fetchHodlmmCandidates(options, wallet.address),
    getZestPosition(wallet.address),
  ]);

  const decision = decideRoute(sbtcSats, stxUstx, mempoolDepth, zest, hodlmmCandidates, options, cooldown);
  const blockers: string[] = [];
  if (wallet.network !== NETWORK) blockers.push(`Wallet network ${wallet.network || "unknown"} is not ${NETWORK}`);
  if (decision.route === "hold") blockers.push(...decision.rationale);
  if (decision.route === "deploy-to-hodlmm" && !decision.executable) blockers.push(...decision.rationale);

  return {
    wallet,
    stxUstx,
    sbtcSats,
    cooldown,
    mempoolDepth,
    decision,
    blockers,
    zestPosition,
    hodlmmCandidates,
    stateFile,
    hodlmmStateFile,
  };
}

async function runDoctor(options: RunOptions): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const context = await collectContext(options);
    checks.wallet = { ok: true, detail: `${context.wallet.address} (${context.wallet.btcAddress || "no btc"})` };
    checks.balances = { ok: true, detail: `stx=${context.stxUstx.toString()} uSTX, sbtc=${context.sbtcSats.toString()} sats` };
    checks.zest = {
      ok: context.decision.zest.inferredApyBps > 0 && context.decision.zest.ageSeconds <= options.maxDataAgeSeconds,
      detail: `interest-rate=${context.decision.zest.rawInterestRate.toString()} inferredApy=${context.decision.zest.inferredApyPct.toFixed(2)}% age=${context.decision.zest.ageSeconds}s`,
    };
    checks.hodlmm = {
      ok: Boolean(context.decision.topHodlmm && context.decision.topHodlmm.ageSeconds <= options.maxDataAgeSeconds),
      detail: context.decision.topHodlmm
        ? `${context.decision.topHodlmm.poolId} safe=${context.decision.topHodlmm.safe} yield=${context.decision.topHodlmm.effectiveYieldPct.toFixed(2)}% age=${context.decision.topHodlmm.ageSeconds}s`
        : context.hodlmmCandidates[0]
        ? `${context.hodlmmCandidates[0].poolId} unavailable: ${context.hodlmmCandidates[0].reasons.join("; ")}`
        : "No sBTC HODLMM pool found",
    };
    checks.cooldown = { ok: context.cooldown.ok, detail: context.cooldown.ok ? "No active router cooldown" : `Cooldown active for ${context.cooldown.remainingHours} more hours` };
    checks.mempool = { ok: context.mempoolDepth <= options.mempoolDepthLimit, detail: `depth=${context.mempoolDepth} limit=${options.mempoolDepthLimit}` };
    try {
      const command = resolveHodlmmCommand();
      const scriptTarget = resolveHodlmmScriptTarget(command);
      checks.hodlmm_executor = scriptTarget
        ? { ok: true, detail: command.join(" ") }
        : { ok: false, detail: getHodlmmSecureExecutionError() };
    } catch (error) {
      checks.hodlmm_executor = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    checks.password_env = {
      ok: true,
      detail: process.env.AIBTC_WALLET_PASSWORD
        ? "AIBTC_WALLET_PASSWORD is set"
        : "AIBTC_WALLET_PASSWORD not set (required only for run)",
    };
    checks.state_file = { ok: true, detail: context.stateFile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.context = { ok: false, detail: message };
  }

  const allOk = Object.values(checks).every((check) => check.ok);
  const blockers = Object.entries(checks).filter(([, c]) => !c.ok).map(([name, c]) => `${name}: ${c.detail}`);
  printResult(allOk ? {
    status: "success",
    action: "Environment ready. Run status to inspect the route decision or run with --confirm=MAXIMIZE to execute.",
    data: { checks },
    error: null,
  } : {
    status: "blocked",
    action: "Resolve the reported blockers before executing the yield maximizer.",
    data: { checks, blockers },
    error: { code: "DOCTOR_FAILED", message: blockers.join("; "), next: "Resolve the failed checks and re-run doctor" },
  });
}

async function runInstallPacks(): Promise<void> {
  printResult({
    status: "success",
    action: "Required runtime packages listed for sbtc-yield-maximizer.",
    data: {
      packages: REQUIRED_PACKS,
      note: "This skill expects these packages plus installed dependent skills declared in metadata.requires.",
    },
    error: null,
  });
}

async function runStatus(options: RunOptions): Promise<void> {
  const context = await collectContext(options);
  const actionMap: Record<RouteName, string> = {
    hold: "Hold idle sBTC until a safer executable route is available.",
    "lend-to-zest": `Route ${context.decision.deploySats.toString()} sats to Zest because it is the highest safe executable yield path.`,
    "deploy-to-hodlmm": `Rebalance HODLMM liquidity in ${context.decision.topHodlmm?.poolId || "the winning pool"} because it is the highest safe executable route.`,
  };

  printResult({
    status: "success",
    action: actionMap[context.decision.route],
    data: {
      wallet: context.wallet,
      balances: {
        stxUstx: context.stxUstx.toString(),
        sbtcSats: context.sbtcSats.toString(),
      },
      cooldown: context.cooldown,
      mempoolDepth: context.mempoolDepth,
      routeDecision: {
        route: context.decision.route,
        executable: context.decision.executable,
        deploySats: context.decision.deploySats.toString(),
        rationale: context.decision.rationale,
        winnerApyBps: context.decision.winnerApyBps,
        apyDiffBps: context.decision.apyDiffBps,
      },
      zest: serializeZestSignal(context.decision.zest),
      zestPosition: context.zestPosition,
      topHodlmm: context.decision.topHodlmm,
      hodlmmCandidates: context.hodlmmCandidates,
      blockers: context.blockers,
      stateFile: context.stateFile,
      hodlmmStateFile: context.hodlmmStateFile,
    },
    error: null,
  });
}

async function runMaximize(options: RunOptions): Promise<void> {
  if (options.confirm !== CONFIRM_TOKEN) {
    printResult({
      status: "blocked",
      action: `Re-run with --confirm=${CONFIRM_TOKEN} after explicit operator approval.`,
      data: {},
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "This write skill requires explicit confirmation before broadcast",
        next: `Re-run with --confirm=${CONFIRM_TOKEN}`,
      },
    });
    return;
  }

  const password = process.env.AIBTC_WALLET_PASSWORD;
  if (!password) {
    printResult({
      status: "blocked",
      action: "Set AIBTC_WALLET_PASSWORD in the environment before executing the maximizer.",
      data: {},
      error: {
        code: "PASSWORD_REQUIRED",
        message: "AIBTC_WALLET_PASSWORD is required to unlock the wallet for writes",
        next: "Export AIBTC_WALLET_PASSWORD and retry",
      },
    });
    return;
  }

  const context = await collectContext(options);
  if (!context.decision.executable || context.decision.route === "hold") {
    printResult({
      status: "blocked",
      action: "Yield maximizer did not select an executable route.",
      data: {
        route: context.decision.route,
        rationale: context.decision.rationale,
      },
      error: {
        code: "PREFLIGHT_BLOCKED",
        message: context.blockers.join("; ") || "No executable route passed the configured safety gates",
        next: "Re-run later or adjust thresholds with explicit operator approval",
      },
    });
    return;
  }

  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = acquireExecutionLock(context.wallet.id);

    if (context.decision.route === "deploy-to-hodlmm") {
      const execution = await executeHodlmmMove(context, options, password);
      await writeState(context.wallet.id, {
        lastDecisionAt: new Date().toISOString(),
        lastRoute: context.decision.route,
        lastTxid: execution.txid,
      });
      printResult({
        status: "success",
        action: "Moved HODLMM liquidity because it was the highest safe executable yield route",
        data: {
          operation: "maximize-yield",
          wallet: {
            id: context.wallet.id,
            address: context.wallet.address,
            name: context.wallet.name || "aibtc-wallet",
          },
          route: context.decision.route,
          deploySats: context.decision.deploySats.toString(),
          rationale: context.decision.rationale,
          zest: serializeZestSignal(context.decision.zest),
          topHodlmm: context.decision.topHodlmm,
          txid: execution.txid,
          explorerUrl: execution.explorerUrl || getExplorerTxUrl(execution.txid, NETWORK),
          stateFile: context.stateFile,
          hodlmmCommand: execution.command.join(" "),
          hodlmmPreflight: execution.preflight,
        },
        error: null,
      });
      return;
    }

    const walletManager = getWalletManager();
    const zest = getZestProtocolService(NETWORK);
    try {
      const account = await walletManager.unlock(context.wallet.id, password);
      const result = await zest.supply(account, "sBTC", context.decision.deploySats);
      await writeState(context.wallet.id, {
        lastDecisionAt: new Date().toISOString(),
        lastRoute: context.decision.route,
        lastTxid: result.txid,
      });
      printResult({
        status: "success",
        action: "Supplied sBTC to Zest because it was the highest safe executable yield route",
        data: {
          operation: "maximize-yield",
          wallet: {
            id: context.wallet.id,
            address: context.wallet.address,
            name: context.wallet.name || "aibtc-wallet",
          },
          route: context.decision.route,
          deploySats: context.decision.deploySats.toString(),
          rationale: context.decision.rationale,
          zest: serializeZestSignal(context.decision.zest),
          topHodlmm: context.decision.topHodlmm,
          txid: result.txid,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
          stateFile: context.stateFile,
        },
        error: null,
      });
    } finally {
      await walletManager.lock().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult({
      status: "error",
      action: "Check the error, verify the wallet password and balances, then retry if safe.",
      data: {
        wallet: { id: context.wallet.id, address: context.wallet.address },
        attemptedDeploySats: context.decision.deploySats.toString(),
        route: context.decision.route,
      },
      error: {
        code: "MAXIMIZER_FAILED",
        message,
        next: "Verify password, balances, route conditions, and dependent skill availability before retrying",
      },
    });
  } finally {
    releaseLock?.();
  }
}

function parseOptions(rawOptions: Record<string, string | undefined>): RunOptions {
  const parsed: RunOptions = {
    walletId: rawOptions.walletId || rawOptions["wallet-id"],
    maxDeploySats: parseBigIntOption(rawOptions.maxDeploySats || rawOptions["max-deploy-sats"], DEFAULT_MAX_DEPLOY_SATS, "max-deploy-sats"),
    reserveSats: parseBigIntOption(rawOptions.reserveSats || rawOptions["reserve-sats"], DEFAULT_RESERVE_SATS, "reserve-sats"),
    minGasReserveUstx: parseBigIntOption(rawOptions.minGasReserveUstx || rawOptions["min-gas-reserve-ustx"], DEFAULT_MIN_GAS_RESERVE_USTX, "min-gas-reserve-ustx"),
    minHodlmmVolumeUsd: parseNumberOption(rawOptions.minHodlmmVolumeUsd || rawOptions["min-hodlmm-volume-usd"], DEFAULT_MIN_HODLMM_VOLUME_USD, "min-hodlmm-volume-usd"),
    minHodlmmTvlUsd: parseNumberOption(rawOptions.minHodlmmTvlUsd || rawOptions["min-hodlmm-tvl-usd"], DEFAULT_MIN_HODLMM_TVL_USD, "min-hodlmm-tvl-usd"),
    maxPriceDivergencePct: parseNumberOption(rawOptions.maxPriceDivergencePct || rawOptions["max-price-divergence-pct"], DEFAULT_MAX_PRICE_DIVERGENCE_PCT, "max-price-divergence-pct"),
    minApyDiffBps: parseNumberOption(rawOptions.minApyDiffBps || rawOptions["min-apy-diff-bps"], DEFAULT_MIN_APY_DIFF_BPS, "min-apy-diff-bps"),
    maxDataAgeSeconds: parseNumberOption(rawOptions.maxDataAgeSeconds || rawOptions["max-data-age-seconds"], DEFAULT_MAX_DATA_AGE_SECONDS, "max-data-age-seconds"),
    cooldownHours: parseNumberOption(rawOptions.cooldownHours || rawOptions["cooldown-hours"], DEFAULT_META_COOLDOWN_HOURS, "cooldown-hours"),
    mempoolDepthLimit: parseNumberOption(rawOptions.mempoolDepthLimit || rawOptions["mempool-depth-limit"], DEFAULT_MEMPOOL_DEPTH_LIMIT, "mempool-depth-limit"),
    hodlmmSpread: parseNumberOption(rawOptions.hodlmmSpread || rawOptions["hodlmm-spread"], DEFAULT_HODLMM_SPREAD, "hodlmm-spread"),
    confirm: rawOptions.confirm,
  };

  if (
    parsed.maxDeploySats < 0n ||
    parsed.reserveSats < 0n ||
    parsed.minGasReserveUstx < 0n ||
    parsed.minHodlmmVolumeUsd < 0 ||
    parsed.minHodlmmTvlUsd < 0 ||
    parsed.maxPriceDivergencePct < 0 ||
    parsed.minApyDiffBps < 0 ||
    parsed.maxDataAgeSeconds < 0 ||
    parsed.cooldownHours < 0 ||
    parsed.mempoolDepthLimit < 0 ||
    parsed.hodlmmSpread < 0
  ) {
    printFlatError("All numeric options must be non-negative");
  }

  return parsed;
}

const program = new Command();

program
  .name("sbtc-yield-maximizer")
  .description("Write skill for routing idle sBTC to the highest safe current yield path")
  .showHelpAfterError();

for (const command of ["doctor", "install-packs", "status", "run"]) {
  program
    .command(command)
    .option("--wallet-id <id>", "Specific AIBTC wallet id to use")
    .option("--max-deploy-sats <sats>", "Maximum sBTC amount to deploy", DEFAULT_MAX_DEPLOY_SATS.toString())
    .option("--reserve-sats <sats>", "Minimum sBTC to retain after deployment", DEFAULT_RESERVE_SATS.toString())
    .option("--min-gas-reserve-ustx <ustx>", "Minimum STX reserve to keep after execution", DEFAULT_MIN_GAS_RESERVE_USTX.toString())
    .option("--min-hodlmm-volume-usd <usd>", "Minimum HODLMM 24h volume required for a pool to win", String(DEFAULT_MIN_HODLMM_VOLUME_USD))
    .option("--min-hodlmm-tvl-usd <usd>", "Minimum HODLMM TVL required for a pool to win", String(DEFAULT_MIN_HODLMM_TVL_USD))
    .option("--max-price-divergence-pct <pct>", "Maximum HODLMM price divergence allowed before a pool is disqualified", String(DEFAULT_MAX_PRICE_DIVERGENCE_PCT))
    .option("--min-apy-diff-bps <bps>", "Minimum APY edge required before rotating between Zest and HODLMM", String(DEFAULT_MIN_APY_DIFF_BPS))
    .option("--max-data-age-seconds <seconds>", "Maximum freshness age allowed for APY reads", String(DEFAULT_MAX_DATA_AGE_SECONDS))
    .option("--cooldown-hours <hours>", "Router-level cooldown window between write executions", String(DEFAULT_META_COOLDOWN_HOURS))
    .option("--mempool-depth-limit <count>", "Maximum allowed pending tx count before execution is blocked", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--hodlmm-spread <bins>", "Bin spread passed through to hodlmm-move-liquidity", String(DEFAULT_HODLMM_SPREAD))
    .option("--confirm <token>", "Required only for run: set to MAXIMIZE to allow broadcast")
    .action(async (rawOptions) => {
      if (command === "install-packs") return runInstallPacks();
      const options = parseOptions(rawOptions as Record<string, string | undefined>);
      if (command === "doctor") return runDoctor(options);
      if (command === "status") return runStatus(options);
      return runMaximize(options);
    });
}

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  printFlatError(message);
});
