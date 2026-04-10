#!/usr/bin/env bun

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { cvToJSON, hexToCV } from "@stacks/transactions";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";
import { getExplorerTxUrl } from "@aibtc/mcp-server/dist/config/networks.js";
import { getZestProtocolService } from "@aibtc/mcp-server/dist/services/defi.service.js";
import { getHiroApi } from "@aibtc/mcp-server/dist/services/hiro-api.js";

const NETWORK = "mainnet";
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_APP_API = "https://bff.bitflowapis.finance/api/app/v1/pools";
const BITFLOW_QUOTES_API = "https://bff.bitflowapis.finance/api/quotes/v1/pools";
const BITFLOW_BINS_API = "https://bff.bitflowapis.finance/api/quotes/v1/bins";
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
const DEFAULT_ROUTE_EDGE_BPS = 25;
const DEFAULT_COOLDOWN_HOURS = 4;
const CONFIRM_TOKEN = "MAXIMIZE";
const STATE_FILE = join(homedir(), ".sbtc-yield-maximizer-state.json");

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

interface ZestSignal {
  rawInterestRate: bigint;
  utilization: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  inferredApyBps: number;
  inferredApyPct: number;
}

interface HodlmmCandidate {
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
}

interface RouteDecision {
  route: RouteName;
  deploySats: bigint;
  rationale: string[];
  zest: ZestSignal;
  topHodlmm: HodlmmCandidate | null;
  executable: boolean;
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

interface RunOptions {
  walletId?: string;
  maxDeploySats: bigint;
  reserveSats: bigint;
  minGasReserveUstx: bigint;
  minHodlmmVolumeUsd: number;
  minHodlmmTvlUsd: number;
  maxPriceDivergencePct: number;
  routeEdgeBps: number;
  cooldownHours: number;
  confirm?: string;
}

interface Context {
  wallet: WalletMetadata;
  stxUstx: bigint;
  sbtcSats: bigint;
  cooldown: CooldownResult;
  decision: RouteDecision;
  blockers: string[];
  zestPosition: Record<string, unknown> | null;
}

const REQUIRED_PACKS = [
  "@aibtc/mcp-server",
  "@stacks/transactions",
  "commander",
] as const;

function serializeZestSignal(signal: ZestSignal): Record<string, unknown> {
  return {
    rawInterestRate: signal.rawInterestRate.toString(),
    utilization: signal.utilization.toString(),
    totalAssets: signal.totalAssets.toString(),
    totalSupply: signal.totalSupply.toString(),
    inferredApyBps: signal.inferredApyBps,
    inferredApyPct: signal.inferredApyPct,
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
        "User-Agent": "bff-skills/sbtc-yield-maximizer",
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

async function readState(): Promise<MaximizerState> {
  try {
    const file = Bun.file(STATE_FILE);
    if (!(await file.exists())) return {};
    return JSON.parse(await file.text()) as MaximizerState;
  } catch {
    return {};
  }
}

async function writeState(state: MaximizerState): Promise<void> {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

async function checkCooldown(cooldownHours: number): Promise<CooldownResult> {
  const state = await readState();
  if (!state.lastDecisionAt) return { ok: true, remainingHours: 0, lastDecisionAt: null };
  const elapsed = (Date.now() - new Date(state.lastDecisionAt).getTime()) / 3_600_000;
  const remaining = Math.max(0, cooldownHours - elapsed);
  return {
    ok: remaining === 0,
    remainingHours: Number(remaining.toFixed(2)),
    lastDecisionAt: state.lastDecisionAt,
  };
}

async function getZestSignal(senderAddress: string): Promise<ZestSignal> {
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
  // Verified against the live v0-vault-sbtc source:
  // the contract defines `BPS u10000` and applies interest math in basis points,
  // so `get-interest-rate` already returns a bps-style integer.
  const inferredApyBps = Number(rawInterestRate);
  return {
    rawInterestRate,
    utilization,
    totalAssets,
    totalSupply,
    inferredApyBps,
    inferredApyPct: inferredApyBps / 100,
  };
}

async function getZestPosition(address: string): Promise<Record<string, unknown> | null> {
  const service = getZestProtocolService(NETWORK);
  return (await service.getUserPosition("sBTC", address)) as unknown as Record<string, unknown> | null;
}

async function fetchHodlmmCandidates(options: RunOptions): Promise<HodlmmCandidate[]> {
  const [quotePoolsData, appPoolsData] = await Promise.all([
    fetchJson<{ pools?: QuotePool[] }>(BITFLOW_QUOTES_API),
    fetchJson<AppPoolsResponse>(BITFLOW_APP_API),
  ]);
  const quotePools = (quotePoolsData.pools || []).filter(
    (pool) => pool.token_x === SBTC_CONTRACT || pool.token_y === SBTC_CONTRACT
  );
  const appMap = new Map((appPoolsData.data || []).map((pool) => [pool.poolId, pool]));

  const candidates = await Promise.all(
    quotePools.map(async (pool): Promise<HodlmmCandidate | null> => {
      const appPool = appMap.get(pool.pool_id);
      if (!appPool) return null;
      const bins = (await fetchJson<BinsResponse>(`${BITFLOW_BINS_API}/${pool.pool_id}`)).bins || [];
      const activeBin = bins.find((bin) => bin.bin_id === pool.active_bin);
      const tokenXIsSbtc = appPool.tokens.tokenX.contract === SBTC_CONTRACT;
      const sbtcPriceUsd = tokenXIsSbtc ? appPool.tokens.tokenX.priceUsd : appPool.tokens.tokenY.priceUsd;
      const pairedPriceUsd = tokenXIsSbtc ? appPool.tokens.tokenY.priceUsd : appPool.tokens.tokenX.priceUsd;
      let divergencePct = 0;
      if (activeBin && sbtcPriceUsd > 0) {
        const normalized = (Number(activeBin.price) / PRICE_SCALE) *
          Math.pow(10, appPool.tokens.tokenX.decimals - appPool.tokens.tokenY.decimals);
        const activeSbtcPriceUsd = tokenXIsSbtc
          ? normalized * pairedPriceUsd
          : normalized > 0
          ? appPool.tokens.tokenX.priceUsd / normalized
          : 0;
        if (activeSbtcPriceUsd > 0) {
          divergencePct = Math.abs(activeSbtcPriceUsd - sbtcPriceUsd) / sbtcPriceUsd * 100;
        }
      }
      const feeRunRatePct = appPool.tvlUsd > 0 ? (appPool.feesUsd1d / appPool.tvlUsd) * 365 * 100 : 0;
      const effectiveYieldPct = Math.max(appPool.apr24h, feeRunRatePct);
      const reasons: string[] = [];
      if (appPool.volumeUsd1d < options.minHodlmmVolumeUsd) reasons.push(`24h volume ${appPool.volumeUsd1d.toFixed(2)} < ${options.minHodlmmVolumeUsd}`);
      if (appPool.tvlUsd < options.minHodlmmTvlUsd) reasons.push(`TVL ${appPool.tvlUsd.toFixed(2)} < ${options.minHodlmmTvlUsd}`);
      if (divergencePct > options.maxPriceDivergencePct) reasons.push(`price divergence ${divergencePct.toFixed(2)}% > ${options.maxPriceDivergencePct}%`);
      return {
        poolId: pool.pool_id,
        pair: tokenXIsSbtc ? `sBTC-${appPool.tokens.tokenY.symbol}` : `${appPool.tokens.tokenX.symbol}-sBTC`,
        apr24h: appPool.apr24h,
        feeRunRatePct: Number(feeRunRatePct.toFixed(4)),
        effectiveYieldPct: Number(effectiveYieldPct.toFixed(4)),
        effectiveYieldBps: Math.round(effectiveYieldPct * 100),
        volumeUsd1d: appPool.volumeUsd1d,
        tvlUsd: appPool.tvlUsd,
        divergencePct: Number(divergencePct.toFixed(4)),
        safe: reasons.length === 0,
        reasons,
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
  zest: ZestSignal,
  hodlmmCandidates: HodlmmCandidate[],
  options: RunOptions,
  cooldown: CooldownResult
): RouteDecision {
  const idleSats = sbtcSats > options.reserveSats ? sbtcSats - options.reserveSats : 0n;
  const deploySats = idleSats > options.maxDeploySats ? options.maxDeploySats : idleSats;
  const topHodlmm = hodlmmCandidates.find((candidate) => candidate.safe) || null;
  const rationale: string[] = [];

  if (!cooldown.ok) {
    rationale.push(`Cooldown active for another ${cooldown.remainingHours} hours`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false };
  }
  if (stxUstx < options.minGasReserveUstx) {
    rationale.push(`STX reserve ${stxUstx.toString()} uSTX is below required ${options.minGasReserveUstx.toString()} uSTX`);
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false };
  }
  if (deploySats <= 0n) {
    rationale.push("No idle sBTC remains above reserve");
    return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false };
  }

  const zestBps = zest.inferredApyBps;
  const hodlmmBps = topHodlmm?.effectiveYieldBps || 0;
  if (topHodlmm && hodlmmBps > zestBps + options.routeEdgeBps) {
    rationale.push(`HODLMM leads Zest by ${hodlmmBps - zestBps} bps`);
    rationale.push(`Top HODLMM pool ${topHodlmm.poolId} passed stale-price and liquidity gates`);
    return { route: "deploy-to-hodlmm", deploySats, rationale, zest, topHodlmm, executable: false };
  }

  if (zestBps > 0) {
    rationale.push(`Zest inferred yield ${zest.inferredApyPct.toFixed(2)}% is the best safe executable route`);
    if (topHodlmm && !topHodlmm.safe) {
      rationale.push(`Top HODLMM pool failed safety gates: ${topHodlmm.reasons.join("; ")}`);
    }
    return { route: "lend-to-zest", deploySats, rationale, zest, topHodlmm, executable: true };
  }

  rationale.push("No positive executable yield route is currently available");
  return { route: "hold", deploySats, rationale, zest, topHodlmm, executable: false };
}

async function collectContext(options: RunOptions): Promise<Context> {
  const wallet = await resolveWallet(options.walletId);
  const [stxUstx, sbtcSats, cooldown, zest, hodlmmCandidates, zestPosition] = await Promise.all([
    getStxBalance(wallet.address),
    getSbtcBalance(wallet.address),
    checkCooldown(options.cooldownHours),
    getZestSignal(wallet.address),
    fetchHodlmmCandidates(options),
    getZestPosition(wallet.address),
  ]);

  const decision = decideRoute(sbtcSats, stxUstx, zest, hodlmmCandidates, options, cooldown);
  const blockers: string[] = [];
  if (wallet.network !== NETWORK) blockers.push(`Wallet network ${wallet.network || "unknown"} is not ${NETWORK}`);
  if (decision.route === "hold") blockers.push(...decision.rationale);
  if (decision.route === "deploy-to-hodlmm") blockers.push("Direct HODLMM deposit is not enabled in this skill version");

  return {
    wallet,
    stxUstx,
    sbtcSats,
    cooldown,
    decision,
    blockers,
    zestPosition,
  };
}

async function runDoctor(options: RunOptions): Promise<void> {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const context = await collectContext(options);
    checks.wallet = { ok: true, detail: `${context.wallet.address} (${context.wallet.btcAddress || "no btc"})` };
    checks.balances = { ok: true, detail: `stx=${context.stxUstx.toString()} uSTX, sbtc=${context.sbtcSats.toString()} sats` };
    checks.zest = { ok: context.decision.zest.inferredApyBps > 0, detail: `interest-rate=${context.decision.zest.rawInterestRate.toString()} inferredApy=${context.decision.zest.inferredApyPct.toFixed(2)}%` };
    checks.hodlmm = { ok: true, detail: context.decision.topHodlmm ? `${context.decision.topHodlmm.poolId} safe=${context.decision.topHodlmm.safe} yield=${context.decision.topHodlmm.effectiveYieldPct.toFixed(2)}%` : "No sBTC HODLMM pool found" };
    checks.cooldown = { ok: context.cooldown.ok, detail: context.cooldown.ok ? "No active route cooldown" : `Cooldown active for ${context.cooldown.remainingHours} more hours` };
    checks.password_env = { ok: Boolean(process.env.AIBTC_WALLET_PASSWORD), detail: process.env.AIBTC_WALLET_PASSWORD ? "AIBTC_WALLET_PASSWORD is set" : "AIBTC_WALLET_PASSWORD not set (required only for run)" };
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
      note: "This skill expects these packages to be available in the execution environment.",
    },
    error: null,
  });
}

async function runStatus(options: RunOptions): Promise<void> {
  const context = await collectContext(options);
  const actionMap: Record<RouteName, string> = {
    hold: "Hold idle sBTC until a safer executable route is available.",
    "lend-to-zest": `Route ${context.decision.deploySats.toString()} sats to Zest because it is the highest safe executable yield path.`,
    "deploy-to-hodlmm": "HODLMM is currently the highest-yield route, but this standalone version does not execute direct HODLMM deposits.",
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
      routeDecision: {
        route: context.decision.route,
        executable: context.decision.executable,
        deploySats: context.decision.deploySats.toString(),
        rationale: context.decision.rationale,
      },
      zest: serializeZestSignal(context.decision.zest),
      zestPosition: context.zestPosition,
      topHodlmm: context.decision.topHodlmm,
      blockers: context.blockers,
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
  if (context.decision.route !== "lend-to-zest" || !context.decision.executable) {
    printResult({
      status: "blocked",
      action: "Yield maximizer did not select an executable Zest route.",
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

  const walletManager = getWalletManager();
  const zest = getZestProtocolService(NETWORK);

  try {
    const account = await walletManager.unlock(context.wallet.id, password);
    const result = await zest.supply(account, "sBTC", context.decision.deploySats);
    await writeState({
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
        stateFile: STATE_FILE,
      },
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printResult({
      status: "error",
      action: "Check the error, verify the wallet password and balances, then retry if safe.",
      data: {
        wallet: { id: context.wallet.id, address: context.wallet.address },
        attemptedDeploySats: context.decision.deploySats.toString(),
      },
      error: {
        code: "MAXIMIZER_FAILED",
        message,
        next: "Verify password, balances, and route conditions before retrying",
      },
    });
  } finally {
    await walletManager.lock().catch(() => undefined);
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
    routeEdgeBps: parseNumberOption(rawOptions.routeEdgeBps || rawOptions["route-edge-bps"], DEFAULT_ROUTE_EDGE_BPS, "route-edge-bps"),
    cooldownHours: parseNumberOption(rawOptions.cooldownHours || rawOptions["cooldown-hours"], DEFAULT_COOLDOWN_HOURS, "cooldown-hours"),
    confirm: rawOptions.confirm,
  };

  if (
    parsed.maxDeploySats < 0n ||
    parsed.reserveSats < 0n ||
    parsed.minGasReserveUstx < 0n ||
    parsed.minHodlmmVolumeUsd < 0 ||
    parsed.minHodlmmTvlUsd < 0 ||
    parsed.maxPriceDivergencePct < 0 ||
    parsed.routeEdgeBps < 0 ||
    parsed.cooldownHours < 0
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
    .option("--route-edge-bps <bps>", "Minimum HODLMM edge over Zest required for HODLMM to win", String(DEFAULT_ROUTE_EDGE_BPS))
    .option("--cooldown-hours <hours>", "Cooldown window between write executions", String(DEFAULT_COOLDOWN_HOURS))
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
