#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  AnchorMode,
  Pc,
  PostConditionMode,
  broadcastTransaction,
  contractPrincipalCV,
  getAddressFromPrivateKey,
  intCV,
  listCV,
  makeContractCall,
  principalCV,
  someCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const NETWORK = "mainnet";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_API = "https://bff.bitflowapis.finance";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "DEPOSIT";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_ACTIVE_BIN_MAX_DEVIATION = 0;
const DEFAULT_MIN_GAS_RESERVE_USTX = 100_000n;
const DEFAULT_FEE_USTX = 50_000n;
const DEFAULT_WAIT_SECONDS = 120;
const HODLMM_LIQUIDITY_ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1";
const DEPOSIT_FUNCTION = "add-relative-liquidity-same-multi";
const DLP_ASSET_NAME = "pool-token";
const DLP_TOKEN_ID_ASSET_NAME = "pool-token-id";
const PRICE_SCALE_BPS = 100_000_000n;
const FEE_SCALE_BPS = 10_000n;
const MINIMUM_BIN_SHARES = 10_000n;
const MINIMUM_BURNT_SHARES = 1_000n;
const HODLMM_CENTER_BIN_ID = 500;

type JsonMap = Record<string, unknown>;

interface Output {
  status: "success" | "blocked" | "error";
  action: string;
  data: JsonMap;
  error: { code: string; message: string; next: string } | null;
}

class BlockedError extends Error {
  code: string;
  next: string;
  data: JsonMap;

  constructor(code: string, message: string, next: string, data: JsonMap = {}) {
    super(message);
    this.name = "BlockedError";
    this.code = code;
    this.next = next;
    this.data = data;
  }
}

interface AppPoolToken {
  contract: string;
  symbol?: string;
  decimals?: number;
  assetName?: string | null;
}

interface AppPool {
  poolId?: string;
  pool_id?: string;
  poolContract?: string;
  pool_contract?: string;
  pool_token?: string;
  core_address?: string;
  poolStatus?: boolean;
  pool_status?: boolean;
  tokens?: {
    tokenX?: AppPoolToken;
    tokenY?: AppPoolToken;
  };
  token_x?: string;
  token_y?: string;
  binStep?: string | number;
  bin_step?: string | number;
  apr?: number;
  tvlUsd?: number;
  tvl_usd?: number;
  xProtocolFee?: string | number;
  xProviderFee?: string | number;
  xVariableFee?: string | number;
  yProtocolFee?: string | number;
  yProviderFee?: string | number;
  yVariableFee?: string | number;
  x_protocol_fee?: string | number;
  x_provider_fee?: string | number;
  x_variable_fee?: string | number;
  y_protocol_fee?: string | number;
  y_provider_fee?: string | number;
  y_variable_fee?: string | number;
  [key: string]: unknown;
}

interface PoolFees {
  xProtocolFee: bigint;
  xProviderFee: bigint;
  xVariableFee: bigint;
  yProtocolFee: bigint;
  yProviderFee: bigint;
  yVariableFee: bigint;
}

interface NormalizedPool {
  poolId: string;
  poolContract: string;
  tokenX: AppPoolToken;
  tokenY: AppPoolToken;
  pair: string;
  status: boolean;
  binStep?: string | number;
  apr?: number;
  tvlUsd?: number;
  fees: PoolFees;
}

interface BinRecord {
  pool_id?: string;
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface BinsResponse {
  success?: boolean;
  pool_id?: string;
  active_bin_id: number;
  total_bins?: number;
  bins: BinRecord[];
}

interface UserBinRecord {
  bin_id: number;
  price?: string | number;
  userLiquidity?: string | number;
  user_liquidity?: string | number;
  liquidity?: string | number;
  [key: string]: unknown;
}

interface UserBinsResponse {
  bins: UserBinRecord[];
  [key: string]: unknown;
}

interface HiroBalancesResponse {
  stx: { balance: string; locked?: string; estimated_balance?: string };
  fungible_tokens?: Record<string, { balance: string }>;
  non_fungible_tokens?: Record<string, { count: string }>;
}

interface HiroMempoolResponse {
  total?: number;
  results?: Array<{ tx_id: string; tx_status?: string; tx_type?: string; nonce?: number }>;
}

interface ContractInfo {
  contract_id?: string;
  canonical?: boolean;
  tx_id?: string;
  block_height?: number;
  error?: string;
}

interface ContractInterface {
  fungible_tokens?: Array<{ name: string }>;
  non_fungible_tokens?: Array<{ name: string; type?: unknown }>;
  functions?: Array<{ name: string; access?: string; args?: unknown[]; outputs?: unknown }>;
}

interface TokenAsset {
  kind: "stx" | "ft" | "unknown";
  contract: string;
  symbol: string;
  assetName?: string;
  balance: bigint;
}

interface DepositPlanInput {
  binId?: number;
  offset?: number;
  xAmount?: string | number;
  yAmount?: string | number;
}

interface DepositCandidate {
  index: number;
  binId: number;
  activeBinOffset: number;
  xAmount: bigint;
  yAmount: bigint;
  reserveX: bigint;
  reserveY: bigint;
  binLiquidity: bigint;
  price: bigint;
  minDlp: bigint;
  expectedDlp: bigint;
  maxXLiquidityFee: bigint;
  maxYLiquidityFee: bigint;
  hasExistingPosition: boolean;
}

interface DepositTotals {
  xAmount: bigint;
  yAmount: bigint;
  minDlp: bigint;
  expectedDlp: bigint;
  maxXLiquidityFee: bigint;
  maxYLiquidityFee: bigint;
}

interface Context {
  wallet: string;
  pool: NormalizedPool;
  bins: BinsResponse;
  userBins: Array<{ binId: number; userLiquidity: bigint; price?: string | number }>;
  selectedBins: DepositCandidate[];
  skippedBins: Array<{ binId: number; reason: string }>;
  selection: {
    mode: string;
    slippageBps: number;
    activeBinMaxDeviation: number;
    distribution: string;
    availableModes: string[];
  };
  totals: DepositTotals;
  balances: HiroBalancesResponse;
  stxAvailable: bigint;
  pendingDepth: number;
  pendingTransactions: HiroMempoolResponse["results"];
  routerContract: ContractInfo;
  poolContract: ContractInfo;
  routerInterface: ContractInterface;
  poolInterface: ContractInterface;
  xAsset: TokenAsset;
  yAsset: TokenAsset;
}

interface SharedOptions {
  poolId?: string;
  wallet?: string;
  binId?: string;
  binIds?: string;
  offsets?: string;
  range?: string;
  planJson?: string;
  amountX?: string;
  amountY?: string;
  distribution?: string;
  slippageBps?: string;
  activeBinMaxDeviation?: string;
  minGasReserveUstx?: string;
  feeUstx?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
  waitSeconds?: string;
}

interface EncryptedData {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  scryptParams: {
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
}

interface WalletMetadata {
  id: string;
  name?: string;
  address: string;
  network: string;
}

interface WalletIndex {
  wallets: WalletMetadata[];
}

interface AppConfig {
  activeWalletId?: string | null;
}

interface KeystoreFile {
  encrypted: EncryptedData;
}

interface SessionFile {
  version: number;
  walletId: string;
  encrypted: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  expiresAt: string | null;
}

interface SerializedAccount {
  address: string;
  privateKey: string;
  network: string;
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, raw) => (typeof raw === "bigint" ? raw.toString() : raw),
    2
  );
}

function print(value: unknown): void {
  console.log(stringify(value));
}

function printOutput(output: Output): void {
  print(output);
}

function printFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  print({ error: message });
  process.exitCode = 1;
}

function printActionError(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    return;
  }
  printFatal(error);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  printOutput({
    status: "blocked",
    action,
    data,
    error: { code, message, next },
  });
}

function success(action: string, data: JsonMap): void {
  printOutput({
    status: "success",
    action,
    data,
    error: null,
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
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

function asBigInt(value: string | number | bigint | null | undefined, label: string): bigint {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} is missing`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} is not a valid integer: ${value}`);
  }
}

function parseNonNegativeBigInt(value: string | undefined, label: string): bigint {
  if (value === undefined || value === "") return 0n;
  const parsed = asBigInt(value, label);
  if (parsed < 0n) throw new Error(`${label} must be greater than or equal to zero`);
  return parsed;
}

function parseBps(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${label} must be an integer from 0 to 10000`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeTxId(txid: string): string {
  return txid.startsWith("0x") ? txid : `0x${txid}`;
}

function stxDepositAmount(context: Pick<Context, "xAsset" | "yAsset" | "totals">): bigint {
  return (context.xAsset.kind === "stx" ? context.totals.xAmount : 0n)
    + (context.yAsset.kind === "stx" ? context.totals.yAmount : 0n);
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract identifier: ${contractId}`);
  return { address, name };
}

function feeValue(raw: AppPool, camel: keyof AppPool, snake: keyof AppPool): bigint {
  return asBigInt((raw[camel] ?? raw[snake] ?? 0) as string | number | bigint, String(camel));
}

function normalizePool(raw: AppPool): NormalizedPool {
  const poolId = raw.poolId ?? raw.pool_id;
  const poolContract = raw.poolContract ?? raw.pool_contract ?? raw.pool_token ?? raw.core_address;
  const tokenX = raw.tokens?.tokenX ?? (raw.token_x ? { contract: raw.token_x, symbol: "token-x" } : undefined);
  const tokenY = raw.tokens?.tokenY ?? (raw.token_y ? { contract: raw.token_y, symbol: "token-y" } : undefined);

  if (!poolId) throw new Error("Pool response missing poolId");
  if (!poolContract) throw new Error("Pool response missing pool contract");
  if (!tokenX?.contract || !tokenY?.contract) throw new Error("Pool response missing token contracts");

  return {
    poolId,
    poolContract,
    tokenX,
    tokenY,
    pair: `${tokenX.symbol ?? "token-x"}-${tokenY.symbol ?? "token-y"}`,
    status: raw.poolStatus ?? raw.pool_status ?? true,
    binStep: raw.binStep ?? raw.bin_step,
    apr: typeof raw.apr === "number" ? raw.apr : undefined,
    tvlUsd: typeof raw.tvlUsd === "number" ? raw.tvlUsd : typeof raw.tvl_usd === "number" ? raw.tvl_usd : undefined,
    fees: {
      xProtocolFee: feeValue(raw, "xProtocolFee", "x_protocol_fee"),
      xProviderFee: feeValue(raw, "xProviderFee", "x_provider_fee"),
      xVariableFee: feeValue(raw, "xVariableFee", "x_variable_fee"),
      yProtocolFee: feeValue(raw, "yProtocolFee", "y_protocol_fee"),
      yProviderFee: feeValue(raw, "yProviderFee", "y_provider_fee"),
      yVariableFee: feeValue(raw, "yVariableFee", "y_variable_fee"),
    },
  };
}

async function getPool(poolId: string): Promise<NormalizedPool> {
  const raw = await fetchJson<AppPool>(`${BITFLOW_API}/api/app/v1/pools/${poolId}`);
  return normalizePool(raw);
}

async function getBins(poolId: string): Promise<BinsResponse> {
  const bins = await fetchJson<BinsResponse>(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`);
  if (!Array.isArray(bins.bins)) throw new Error(`Bins response for ${poolId} is missing bins[]`);
  if (bins.active_bin_id === null || bins.active_bin_id === undefined) {
    throw new Error(`Bins response for ${poolId} is missing active_bin_id`);
  }
  return bins;
}

async function getUserBins(wallet: string, poolId: string): Promise<Array<{ binId: number; userLiquidity: bigint; price?: string | number }>> {
  const response = await fetchJson<UserBinsResponse>(
    `${BITFLOW_API}/api/app/v1/users/${wallet}/positions/${poolId}/bins?fresh=true`
  );
  const bins = Array.isArray(response.bins) ? response.bins : [];
  return bins
    .map((bin) => ({
      binId: Number(bin.bin_id),
      userLiquidity: asBigInt(bin.userLiquidity ?? bin.user_liquidity ?? bin.liquidity ?? 0, `user bin ${bin.bin_id} liquidity`),
      price: bin.price,
    }))
    .filter((bin) => Number.isFinite(bin.binId) && bin.userLiquidity > 0n)
    .sort((a, b) => a.binId - b.binId);
}

async function getBalances(wallet: string): Promise<HiroBalancesResponse> {
  return fetchJson<HiroBalancesResponse>(`${HIRO_API}/extended/v1/address/${wallet}/balances`);
}

async function getPendingTransactions(wallet: string): Promise<HiroMempoolResponse> {
  return fetchJson<HiroMempoolResponse>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}&limit=20`);
}

async function getContract(contractId: string): Promise<ContractInfo> {
  return fetchJson<ContractInfo>(`${HIRO_API}/extended/v1/contract/${contractId}`);
}

async function getContractInterface(contractId: string): Promise<ContractInterface> {
  const { address, name } = parseContractId(contractId);
  return fetchJson<ContractInterface>(`${HIRO_API}/v2/contracts/interface/${address}/${name}?proof=0`);
}

function tokenBalance(asset: Omit<TokenAsset, "balance">, balances: HiroBalancesResponse): bigint {
  if (asset.kind === "stx") {
    const balance = asBigInt(balances.stx.balance, "stx balance");
    const locked = asBigInt(balances.stx.locked ?? 0, "locked stx balance");
    return balance > locked ? balance - locked : 0n;
  }
  if (asset.kind === "ft" && asset.assetName) {
    const exactKey = `${asset.contract}::${asset.assetName}`;
    const exact = balances.fungible_tokens?.[exactKey]?.balance;
    if (exact !== undefined) return asBigInt(exact, `${asset.symbol} balance`);

    const fallback = Object.entries(balances.fungible_tokens ?? {})
      .find(([key]) => key.startsWith(`${asset.contract}::`))?.[1]?.balance;
    if (fallback !== undefined) return asBigInt(fallback, `${asset.symbol} balance`);
  }
  return 0n;
}

function normalizeAsset(token: AppPoolToken, contractInterface: ContractInterface, balances: HiroBalancesResponse): TokenAsset {
  const symbol = token.symbol ?? token.contract.split(".").at(-1) ?? "token";
  const ftName = token.assetName ?? contractInterface.fungible_tokens?.[0]?.name;
  const base = ftName
    ? { kind: "ft" as const, contract: token.contract, symbol, assetName: ftName }
    : symbol.toUpperCase() === "STX"
      ? { kind: "stx" as const, contract: token.contract, symbol }
      : { kind: "unknown" as const, contract: token.contract, symbol };
  return { ...base, balance: tokenBalance(base, balances) };
}

function getPoolBinMap(bins: BinsResponse): Map<number, BinRecord> {
  return new Map(bins.bins.map((bin) => [Number(bin.bin_id), bin]));
}

function getUserBinMap(userBins: Context["userBins"]): Map<number, bigint> {
  return new Map(userBins.map((bin) => [bin.binId, bin.userLiquidity]));
}

function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("Cannot take sqrt of negative bigint");
  if (value < 2n) return value;
  let x0 = value / 2n;
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (amount <= 0n) return 0n;
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function feeCeil(amount: bigint, slippageBps: number): bigint {
  if (amount <= 0n) return 0n;
  return (amount * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

function calculateDlpForBin(
  bin: { isActiveBin: boolean; price: bigint; reserveX: bigint; reserveY: bigint; binLiquidity: bigint; xAmount: bigint; yAmount: bigint },
  fees: PoolFees,
  slippageBps: number
): { expectedDlp: bigint; minDlp: bigint; maxXLiquidityFee: bigint; maxYLiquidityFee: bigint } {
  const addLiquidityValue = bin.price * bin.xAmount + bin.yAmount * PRICE_SCALE_BPS;
  const binLiquidityValue = bin.price * bin.reserveX + bin.reserveY * PRICE_SCALE_BPS;
  const roughDlp = bin.binLiquidity === 0n || binLiquidityValue === 0n
    ? bigintSqrt(addLiquidityValue)
    : (addLiquidityValue * bin.binLiquidity) / binLiquidityValue;

  let xFee = 0n;
  let yFee = 0n;

  if (bin.isActiveBin && roughDlp > 0n) {
    const denominator = bin.binLiquidity + roughDlp;
    const xWithdrawable = denominator > 0n ? (roughDlp * (bin.reserveX + bin.xAmount)) / denominator : 0n;
    const yWithdrawable = denominator > 0n ? (roughDlp * (bin.reserveY + bin.yAmount)) / denominator : 0n;
    const xFeeBps = fees.xProtocolFee + fees.xProviderFee + fees.xVariableFee;
    const yFeeBps = fees.yProtocolFee + fees.yProviderFee + fees.yVariableFee;

    if (yWithdrawable > bin.yAmount && bin.xAmount > xWithdrawable) {
      xFee = ((bin.xAmount - xWithdrawable) * xFeeBps + FEE_SCALE_BPS - 1n) / FEE_SCALE_BPS;
      if (xFee > bin.xAmount) xFee = bin.xAmount;
    }
    if (xWithdrawable > bin.xAmount && bin.yAmount > yWithdrawable) {
      yFee = ((bin.yAmount - yWithdrawable) * yFeeBps + FEE_SCALE_BPS - 1n) / FEE_SCALE_BPS;
      if (yFee > bin.yAmount) yFee = bin.yAmount;
    }
  }

  const xPostFees = bin.xAmount - xFee;
  const yPostFees = bin.yAmount - yFee;
  const reserveXPostFees = bin.reserveX + xFee;
  const reserveYPostFees = bin.reserveY + yFee;
  const addValuePostFees = bin.price * xPostFees + yPostFees * PRICE_SCALE_BPS;
  const binValuePostFees = bin.price * reserveXPostFees + reserveYPostFees * PRICE_SCALE_BPS;

  let expectedDlp: bigint;
  if (bin.binLiquidity === 0n) {
    const intended = bigintSqrt(addValuePostFees);
    expectedDlp = intended >= MINIMUM_BIN_SHARES ? intended - MINIMUM_BURNT_SHARES : 0n;
  } else if (binValuePostFees === 0n) {
    expectedDlp = bigintSqrt(addValuePostFees);
  } else {
    expectedDlp = (addValuePostFees * bin.binLiquidity) / binValuePostFees;
  }

  return {
    expectedDlp,
    minDlp: applySlippage(expectedDlp, slippageBps),
    maxXLiquidityFee: feeCeil(xFee, slippageBps),
    maxYLiquidityFee: feeCeil(yFee, slippageBps),
  };
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function parseCsvIntegers(value: string | undefined, label: string): number[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((part) => parseInteger(part.trim(), label)))];
}

function parseRange(value: string | undefined): number[] {
  if (!value) return [];
  const [startRaw, endRaw] = value.split(":");
  const start = parseInteger(startRaw, "--range start");
  const end = parseInteger(endRaw, "--range end");
  if (end < start) throw new Error("--range end must be greater than or equal to start");
  if (end - start > 40) throw new Error("--range supports at most 41 bins per call");
  return Array.from({ length: end - start + 1 }, (_value, index) => start + index);
}

function parsePlanJson(value: string | undefined): DepositPlanInput[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("--plan-json must be a JSON array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`--plan-json entry ${index} must be an object`);
    const raw = entry as Record<string, unknown>;
    return {
      binId: raw.binId === undefined ? undefined : Number(raw.binId),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
      xAmount: raw.xAmount as string | number | undefined,
      yAmount: raw.yAmount as string | number | undefined,
    };
  });
}

function splitAmount(amount: bigint, slots: number): bigint[] {
  if (slots <= 0) return [];
  const base = amount / BigInt(slots);
  let remainder = amount % BigInt(slots);
  return Array.from({ length: slots }, () => {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    return base + extra;
  });
}

function selectedOffsets(opts: SharedOptions, activeBinId: number): { mode: string; offsets: number[]; explicit: DepositPlanInput[] } {
  const plan = parsePlanJson(opts.planJson);
  const binId = opts.binId ? parseInteger(opts.binId, "--bin-id") : null;
  const binIds = parseCsvIntegers(opts.binIds, "--bin-ids");
  const offsets = parseCsvIntegers(opts.offsets, "--offsets");
  const range = parseRange(opts.range);
  const selectorCount = [plan.length > 0, binId !== null, binIds.length > 0, offsets.length > 0, range.length > 0].filter(Boolean).length;
  if (selectorCount > 1) {
    throw new Error("Use only one selector: --plan-json, --bin-id, --bin-ids, --offsets, or --range");
  }
  if (plan.length > 0) return { mode: "plan-json", offsets: [], explicit: plan };
  if (binId !== null) return { mode: "bin-id", offsets: [binId - activeBinId], explicit: [] };
  if (binIds.length > 0) return { mode: "bin-ids", offsets: binIds.map((id) => id - activeBinId), explicit: [] };
  if (offsets.length > 0) return { mode: "offsets", offsets, explicit: [] };
  if (range.length > 0) return { mode: "range", offsets: range, explicit: [] };
  return { mode: "default-active-bin", offsets: [0], explicit: [] };
}

function hasDepositPlan(opts: SharedOptions): boolean {
  return Boolean(opts.planJson || opts.amountX || opts.amountY);
}

function planFromOptions(opts: SharedOptions, bins: BinsResponse): Array<{ offset: number; binId: number; xAmount: bigint; yAmount: bigint }> {
  const activeBinId = bins.active_bin_id;
  const { mode, offsets, explicit } = selectedOffsets(opts, activeBinId);
  const amountX = parseNonNegativeBigInt(opts.amountX, "--amount-x");
  const amountY = parseNonNegativeBigInt(opts.amountY, "--amount-y");

  if (explicit.length) {
    return explicit.map((entry, index) => {
      const hasBin = entry.binId !== undefined;
      const hasOffset = entry.offset !== undefined;
      if (hasBin === hasOffset) throw new Error(`--plan-json entry ${index} must include exactly one of binId or offset`);
      const offset = hasOffset ? Number(entry.offset) : Number(entry.binId) - activeBinId;
      const binId = activeBinId + offset;
      return {
        offset,
        binId,
        xAmount: asBigInt(entry.xAmount ?? 0, `plan entry ${index} xAmount`),
        yAmount: asBigInt(entry.yAmount ?? 0, `plan entry ${index} yAmount`),
      };
    });
  }

  if (amountX <= 0n && amountY <= 0n) {
    throw new Error("Provide --amount-x, --amount-y, or --plan-json with at least one nonzero amount");
  }

  const uniqueOffsets = [...new Set(offsets)].sort((a, b) => a - b);
  const xSlots = uniqueOffsets.filter((offset) => offset >= 0);
  const ySlots = uniqueOffsets.filter((offset) => offset <= 0);
  if (amountX > 0n && !xSlots.length) throw new Error("Token X can only be deposited at or above the active bin");
  if (amountY > 0n && !ySlots.length) throw new Error("Token Y can only be deposited at or below the active bin");

  const xSplits = splitAmount(amountX, xSlots.length);
  const ySplits = splitAmount(amountY, ySlots.length);
  const xByOffset = new Map(xSlots.map((offset, index) => [offset, xSplits[index] ?? 0n]));
  const yByOffset = new Map(ySlots.map((offset, index) => [offset, ySplits[index] ?? 0n]));

  return uniqueOffsets.map((offset) => ({
    offset,
    binId: activeBinId + offset,
    xAmount: xByOffset.get(offset) ?? 0n,
    yAmount: yByOffset.get(offset) ?? 0n,
  })).filter((entry) => entry.xAmount > 0n || entry.yAmount > 0n);
}

function buildDepositCandidate(
  index: number,
  requested: { offset: number; binId: number; xAmount: bigint; yAmount: bigint },
  poolBin: BinRecord,
  activeBinId: number,
  userLiquidity: bigint,
  fees: PoolFees,
  slippageBps: number
): DepositCandidate {
  if (requested.binId < 0 || requested.binId > 1000) {
    throw new Error(`bin ${requested.binId} is outside unsigned HODLMM bin range`);
  }
  if (requested.binId < activeBinId && requested.xAmount > 0n) {
    throw new Error(`bin ${requested.binId} is below active bin ${activeBinId}; only token Y may be deposited`);
  }
  if (requested.binId > activeBinId && requested.yAmount > 0n) {
    throw new Error(`bin ${requested.binId} is above active bin ${activeBinId}; only token X may be deposited`);
  }
  if (requested.xAmount <= 0n && requested.yAmount <= 0n) {
    throw new Error(`bin ${requested.binId} has zero deposit amount`);
  }

  const reserveX = asBigInt(poolBin.reserve_x, `bin ${requested.binId} reserve_x`);
  const reserveY = asBigInt(poolBin.reserve_y, `bin ${requested.binId} reserve_y`);
  const binLiquidity = asBigInt(poolBin.liquidity, `bin ${requested.binId} liquidity`);
  const price = asBigInt(poolBin.price, `bin ${requested.binId} price`);
  const dlp = calculateDlpForBin(
    {
      isActiveBin: requested.binId === activeBinId,
      price,
      reserveX,
      reserveY,
      binLiquidity,
      xAmount: requested.xAmount,
      yAmount: requested.yAmount,
    },
    fees,
    slippageBps
  );
  if (dlp.minDlp <= 0n) {
    throw new Error(`bin ${requested.binId} produces zero min-dlp`);
  }

  return {
    index,
    binId: requested.binId,
    activeBinOffset: requested.offset,
    xAmount: requested.xAmount,
    yAmount: requested.yAmount,
    reserveX,
    reserveY,
    binLiquidity,
    price,
    minDlp: dlp.minDlp,
    expectedDlp: dlp.expectedDlp,
    maxXLiquidityFee: dlp.maxXLiquidityFee,
    maxYLiquidityFee: dlp.maxYLiquidityFee,
    hasExistingPosition: userLiquidity > 0n,
  };
}

function sumCandidates(candidates: DepositCandidate[]): DepositTotals {
  return candidates.reduce<DepositTotals>(
    (totals, candidate) => ({
      xAmount: totals.xAmount + candidate.xAmount,
      yAmount: totals.yAmount + candidate.yAmount,
      minDlp: totals.minDlp + candidate.minDlp,
      expectedDlp: totals.expectedDlp + candidate.expectedDlp,
      maxXLiquidityFee: totals.maxXLiquidityFee + candidate.maxXLiquidityFee,
      maxYLiquidityFee: totals.maxYLiquidityFee + candidate.maxYLiquidityFee,
    }),
    { xAmount: 0n, yAmount: 0n, minDlp: 0n, expectedDlp: 0n, maxXLiquidityFee: 0n, maxYLiquidityFee: 0n }
  );
}

function selectCandidates(
  pool: NormalizedPool,
  bins: BinsResponse,
  userBins: Context["userBins"],
  opts: SharedOptions
): Pick<Context, "selectedBins" | "skippedBins" | "selection" | "totals"> {
  const slippageBps = parseBps(opts.slippageBps, DEFAULT_SLIPPAGE_BPS, "--slippage-bps");
  const activeBinMaxDeviation = parseNonNegativeInteger(opts.activeBinMaxDeviation, DEFAULT_ACTIVE_BIN_MAX_DEVIATION, "--active-bin-max-deviation");
  const distribution = opts.distribution ?? "equal";
  if (!["equal", "explicit"].includes(distribution)) {
    throw new Error("--distribution must be equal or explicit");
  }

  const poolBins = getPoolBinMap(bins);
  const userBinMap = getUserBinMap(userBins);
  const planned = planFromOptions(opts, bins);
  const selector = selectedOffsets(opts, bins.active_bin_id);
  const skippedBins: Array<{ binId: number; reason: string }> = [];
  const selectedBins = planned.flatMap((entry, index) => {
    const poolBin = poolBins.get(entry.binId);
    if (!poolBin) {
      skippedBins.push({ binId: entry.binId, reason: "missing pool bin data" });
      return [];
    }
    try {
      return [buildDepositCandidate(
        index,
        entry,
        poolBin,
        bins.active_bin_id,
        userBinMap.get(entry.binId) ?? 0n,
        pool.fees,
        slippageBps
      )];
    } catch (error) {
      skippedBins.push({ binId: entry.binId, reason: error instanceof Error ? error.message : String(error) });
      return [];
    }
  });

  if (!selectedBins.length) {
    throw new Error(`No usable deposit candidate found. ${skippedBins.map((bin) => `bin ${bin.binId}: ${bin.reason}`).join("; ")}`);
  }

  return {
    selectedBins,
    skippedBins,
    selection: {
      mode: selector.mode,
      slippageBps,
      activeBinMaxDeviation,
      distribution,
      availableModes: ["default active bin", "--bin-id <id>", "--bin-ids <ids>", "--offsets <offsets>", "--range <start:end>", "--plan-json <json>"],
    },
    totals: sumCandidates(selectedBins),
  };
}

function buildPostConditions(context: Context) {
  const postConditions = [];

  if (context.totals.xAmount > 0n) {
    if (context.xAsset.kind === "stx") {
      postConditions.push(Pc.principal(context.wallet).willSendLte(context.totals.xAmount).ustx());
    } else if (context.xAsset.kind === "ft" && context.xAsset.assetName) {
      postConditions.push(Pc.principal(context.wallet).willSendLte(context.totals.xAmount).ft(context.xAsset.contract, context.xAsset.assetName));
    } else {
      throw new Error(`Cannot build postcondition for token X ${context.xAsset.symbol}`);
    }
  }

  if (context.totals.yAmount > 0n) {
    if (context.yAsset.kind === "stx") {
      postConditions.push(Pc.principal(context.wallet).willSendLte(context.totals.yAmount).ustx());
    } else if (context.yAsset.kind === "ft" && context.yAsset.assetName) {
      postConditions.push(Pc.principal(context.wallet).willSendLte(context.totals.yAmount).ft(context.yAsset.contract, context.yAsset.assetName));
    } else {
      throw new Error(`Cannot build postcondition for token Y ${context.yAsset.symbol}`);
    }
  }

  for (const bin of context.selectedBins) {
    if (bin.hasExistingPosition) {
      postConditions.push(Pc.principal(context.wallet)
        .willSendAsset()
        .nft(
          context.pool.poolContract,
          DLP_TOKEN_ID_ASSET_NAME,
          tupleCV({
            "token-id": uintCV(bin.binId),
            owner: principalCV(context.wallet),
          })
        ));
    }
  }

  return postConditions;
}

function routerExpectedBinId(activeBinId: number): number {
  return activeBinId - HODLMM_CENTER_BIN_ID;
}

async function collectContext(opts: SharedOptions, requirePlan = true): Promise<Context> {
  if (!opts.poolId) throw new Error("--pool-id is required");
  if (!opts.wallet) throw new Error("--wallet is required");
  const poolId = opts.poolId;
  const wallet = opts.wallet;
  const minGasReserve = asBigInt(opts.minGasReserveUstx ?? DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");

  const [pool, bins, userBins, balances, pending, routerContract] = await Promise.all([
    getPool(poolId),
    getBins(poolId),
    getUserBins(wallet, poolId),
    getBalances(wallet),
    getPendingTransactions(wallet),
    getContract(HODLMM_LIQUIDITY_ROUTER),
  ]);

  const [poolContract, routerInterface, poolInterface, xInterface, yInterface] = await Promise.all([
    getContract(pool.poolContract),
    getContractInterface(HODLMM_LIQUIDITY_ROUTER),
    getContractInterface(pool.poolContract),
    getContractInterface(pool.tokenX.contract),
    getContractInterface(pool.tokenY.contract),
  ]);

  if (!pool.status) {
    throw new BlockedError(
      "UNSUPPORTED_POOL_INTERFACE",
      `Pool ${poolId} is not active`,
      "Choose an active Bitflow HODLMM pool and rerun doctor/status before any write.",
      { poolId, poolContract: pool.poolContract }
    );
  }
  if (!routerContract.canonical) {
    throw new BlockedError(
      "UNSUPPORTED_ROUTER_INTERFACE",
      `Router contract is not canonical: ${HODLMM_LIQUIDITY_ROUTER}`,
      "Re-verify the HODLMM liquidity router before attempting a write.",
      { router: HODLMM_LIQUIDITY_ROUTER, canonical: routerContract.canonical ?? null }
    );
  }
  if (!poolContract.canonical) {
    throw new BlockedError(
      "UNSUPPORTED_POOL_INTERFACE",
      `Pool contract is not canonical: ${pool.poolContract}`,
      "Choose a canonical Bitflow HODLMM pool and rerun doctor/status before any write.",
      { poolId, poolContract: pool.poolContract, canonical: poolContract.canonical ?? null }
    );
  }
  if (!routerInterface.functions?.some((fn) => fn.name === DEPOSIT_FUNCTION && fn.access === "public")) {
    throw new BlockedError(
      "UNSUPPORTED_ROUTER_INTERFACE",
      `Router contract does not expose public ${DEPOSIT_FUNCTION}`,
      "Re-verify the HODLMM liquidity router function shape before attempting a write.",
      { router: HODLMM_LIQUIDITY_ROUTER, function: DEPOSIT_FUNCTION }
    );
  }
  if (!poolInterface.fungible_tokens?.some((token) => token.name === DLP_ASSET_NAME)) {
    throw new BlockedError(
      "UNSUPPORTED_POOL_INTERFACE",
      `Pool contract does not expose fungible token ${DLP_ASSET_NAME}`,
      "Do not broadcast. Add explicit support only after validating this pool interface.",
      { poolId, poolContract: pool.poolContract, missing: DLP_ASSET_NAME }
    );
  }
  if (!poolInterface.non_fungible_tokens?.some((token) => token.name === DLP_TOKEN_ID_ASSET_NAME)) {
    throw new BlockedError(
      "UNSUPPORTED_POOL_INTERFACE",
      `Pool contract does not expose non-fungible token ${DLP_TOKEN_ID_ASSET_NAME}`,
      "Do not broadcast. Add explicit support only after validating this pool interface.",
      { poolId, poolContract: pool.poolContract, missing: DLP_TOKEN_ID_ASSET_NAME }
    );
  }

  const xAsset = normalizeAsset(pool.tokenX, xInterface, balances);
  const yAsset = normalizeAsset(pool.tokenY, yInterface, balances);
  const selection = requirePlan || hasDepositPlan(opts)
    ? selectCandidates(pool, bins, userBins, opts)
    : {
        selectedBins: [],
        skippedBins: [],
        selection: {
          mode: "doctor-no-plan",
          slippageBps: parseBps(opts.slippageBps, DEFAULT_SLIPPAGE_BPS, "--slippage-bps"),
          activeBinMaxDeviation: parseNonNegativeInteger(opts.activeBinMaxDeviation, DEFAULT_ACTIVE_BIN_MAX_DEVIATION, "--active-bin-max-deviation"),
          distribution: opts.distribution ?? "equal",
          availableModes: ["default active bin", "--bin-id <id>", "--bin-ids <ids>", "--offsets <offsets>", "--range <start:end>", "--plan-json <json>"],
        },
        totals: { xAmount: 0n, yAmount: 0n, minDlp: 0n, expectedDlp: 0n, maxXLiquidityFee: 0n, maxYLiquidityFee: 0n },
      };
  const stxBalance = tokenBalance({ kind: "stx", contract: "STX", symbol: "STX" }, balances);
  const pendingDepth = Number(pending.total ?? pending.results?.length ?? 0);
  const fee = asBigInt(opts.feeUstx ?? DEFAULT_FEE_USTX, "--fee-ustx");
  const stxDeposit = stxDepositAmount({ xAsset, yAsset, totals: selection.totals });
  const stxRequired = stxDeposit + fee + minGasReserve;

  if (stxBalance < stxRequired) {
    throw new BlockedError(
      "INSUFFICIENT_STX_BALANCE",
      `Insufficient STX balance for deposit, fee, and reserve. Need ${stxDeposit} uSTX deposit + ${fee} uSTX fee + ${minGasReserve} uSTX reserve = ${stxRequired} uSTX, have ${stxBalance} uSTX.`,
      "Reduce the STX-side deposit amount, lower --fee-ustx or --min-gas-reserve-ustx, or fund the wallet with more STX.",
      { stxDeposit, feeUstx: fee, minGasReserveUstx: minGasReserve, requiredUstx: stxRequired, availableUstx: stxBalance }
    );
  }
  if (selection.totals.xAmount > xAsset.balance) {
    throw new BlockedError(
      "INSUFFICIENT_TOKEN_X_BALANCE",
      `Insufficient ${xAsset.symbol} balance. Need ${selection.totals.xAmount}, have ${xAsset.balance}.`,
      "Reduce --amount-x or fund the wallet with more token X.",
      { symbol: xAsset.symbol, required: selection.totals.xAmount, available: xAsset.balance }
    );
  }
  if (selection.totals.yAmount > yAsset.balance) {
    throw new BlockedError(
      "INSUFFICIENT_TOKEN_Y_BALANCE",
      `Insufficient ${yAsset.symbol} balance. Need ${selection.totals.yAmount}, have ${yAsset.balance}.`,
      "Reduce --amount-y or fund the wallet with more token Y.",
      { symbol: yAsset.symbol, required: selection.totals.yAmount, available: yAsset.balance }
    );
  }

  return {
    wallet,
    pool,
    bins,
    userBins,
    ...selection,
    balances,
    stxAvailable: stxBalance,
    pendingDepth,
    pendingTransactions: pending.results ?? [],
    routerContract,
    poolContract,
    routerInterface,
    poolInterface,
    xAsset,
    yAsset,
  };
}

function contextData(context: Context): JsonMap {
  return {
    network: NETWORK,
    wallet: context.wallet,
    pool: {
      id: context.pool.poolId,
      pair: context.pool.pair,
      contract: context.pool.poolContract,
      binStep: context.pool.binStep,
      apr: context.pool.apr,
      tvlUsd: context.pool.tvlUsd,
    },
    router: {
      contract: HODLMM_LIQUIDITY_ROUTER,
      function: DEPOSIT_FUNCTION,
      canonical: context.routerContract.canonical,
      publishTx: context.routerContract.tx_id,
    },
    poolInterface: {
      fungibleToken: DLP_ASSET_NAME,
      nonFungibleToken: DLP_TOKEN_ID_ASSET_NAME,
    },
    activeBin: context.bins.active_bin_id,
    selection: context.selection,
    selectedBins: context.selectedBins.map(binData),
    skippedBins: context.skippedBins,
    totals: context.totals,
    tokens: {
      x: context.xAsset,
      y: context.yAsset,
    },
    safety: {
      stxAvailableUstx: context.stxAvailable,
      pendingDepth: context.pendingDepth,
      postConditionMode: "deny",
      activeBinTolerance: {
        observedActiveBinId: context.bins.active_bin_id,
        routerExpectedBinId: routerExpectedBinId(context.bins.active_bin_id),
        maxDeviation: context.selection.activeBinMaxDeviation,
      },
      postconditions: [
        context.totals.xAmount > 0n ? `wallet sends <= ${context.totals.xAmount} ${context.xAsset.symbol}` : null,
        context.totals.yAmount > 0n ? `wallet sends <= ${context.totals.yAmount} ${context.yAsset.symbol}` : null,
        ...context.selectedBins
          .filter((bin) => bin.hasExistingPosition)
          .map((bin) => `wallet sends existing ${context.pool.poolContract}::${DLP_TOKEN_ID_ASSET_NAME} token-id ${bin.binId}`),
      ].filter(Boolean),
      dlpNote: "Minimum DLP and max liquidity fee bounds are enforced by router arguments.",
      sftNote: "Existing-bin pool-token-id sends are postconditioned. First-time bin mint behavior is protected by min-dlp and deny-mode spend limits.",
    },
  };
}

function binData(bin: DepositCandidate) {
  return {
    index: bin.index,
    binId: bin.binId,
    activeBinOffset: bin.activeBinOffset,
    xAmount: bin.xAmount,
    yAmount: bin.yAmount,
    reserveX: bin.reserveX,
    reserveY: bin.reserveY,
    binLiquidity: bin.binLiquidity,
    price: bin.price,
    expectedDlp: bin.expectedDlp,
    minDlp: bin.minDlp,
    maxXLiquidityFee: bin.maxXLiquidityFee,
    maxYLiquidityFee: bin.maxYLiquidityFee,
    hasExistingPosition: bin.hasExistingPosition,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function aibtcStoragePath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

function deriveAesKey(password: string, salt: Buffer, params: EncryptedData["scryptParams"]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keyLen, { N: params.N, r: params.r, p: params.p }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function decryptKeystoreMnemonic(encrypted: EncryptedData, password: string): Promise<string> {
  const key = await deriveAesKey(password, Buffer.from(encrypted.salt, "base64"), encrypted.scryptParams);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("invalid wallet password or corrupted keystore");
  }
}

async function decryptSessionAccount(walletId: string): Promise<SerializedAccount | null> {
  const session = await readJsonFile<SessionFile>(aibtcStoragePath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) return null;
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) return null;

  const sessionKey = await fs.readFile(aibtcStoragePath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) return null;

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8")) as SerializedAccount;
  } catch {
    return null;
  }
}

async function resolveManagedWalletId(): Promise<string> {
  if (process.env.AIBTC_WALLET_ID?.trim()) return process.env.AIBTC_WALLET_ID.trim();
  const config = await readJsonFile<AppConfig>(aibtcStoragePath("config.json"));
  if (config?.activeWalletId) return config.activeWalletId;
  throw new Error("No active AIBTC wallet is configured. Set AIBTC_WALLET_ID or select/unlock a wallet before running this write.");
}

async function resolveManagedWalletSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const walletId = await resolveManagedWalletId();
  const index = await readJsonFile<WalletIndex>(aibtcStoragePath("wallets.json"));
  const metadata = index?.wallets?.find((wallet) => wallet.id === walletId);
  if (!metadata) throw new Error(`managed wallet id ${walletId} not found in ~/.aibtc/wallets.json`);
  if (metadata.network !== "mainnet") throw new Error(`managed wallet ${walletId} is ${metadata.network}, expected mainnet`);
  if (metadata.address !== expectedWallet) {
    throw new Error(`managed wallet ${walletId} resolves to ${metadata.address}, expected ${expectedWallet}`);
  }

  const sessionAccount = await decryptSessionAccount(walletId);
  if (sessionAccount?.privateKey) {
    if (sessionAccount.address !== expectedWallet) {
      throw new Error(`managed wallet session resolves to ${sessionAccount.address}, expected ${expectedWallet}`);
    }
    return { privateKey: sessionAccount.privateKey, address: sessionAccount.address, source: "AIBTC_SESSION_FILE" };
  }

  const password = process.env.AIBTC_WALLET_PASSWORD?.trim();
  if (!password) {
    throw new Error(`AIBTC_WALLET_PASSWORD is not set for managed wallet ${walletId}`);
  }

  const keystore = await readJsonFile<KeystoreFile>(aibtcStoragePath("wallets", walletId, "keystore.json"));
  if (!keystore) throw new Error(`keystore not found for managed wallet ${walletId}`);

  const mnemonic = await decryptKeystoreMnemonic(keystore.encrypted, password);
  const { generateWallet } = await import("@stacks/wallet-sdk");
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0];
  const address = getAddressFromPrivateKey(account.stxPrivateKey, "mainnet");
  if (address !== expectedWallet) {
    throw new Error(`managed wallet keystore resolves to ${address}, expected ${expectedWallet}`);
  }
  return { privateKey: account.stxPrivateKey, address, source: "AIBTC_WALLET_PASSWORD" };
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];

  try {
    return await resolveManagedWalletSigner(expectedWallet);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    attempts.push(`managed AIBTC wallet: ${detail}`);
  }

  const clientMnemonic = process.env.CLIENT_MNEMONIC?.trim();
  if (clientMnemonic) {
    try {
      const { generateWallet } = await import("@stacks/wallet-sdk");
      const wallet = await generateWallet({ secretKey: clientMnemonic, password: "" });
      const account = wallet.accounts[0];
      const address = getAddressFromPrivateKey(account.stxPrivateKey, "mainnet");
      if (address !== expectedWallet) {
        throw new Error(`resolves to ${address}, expected ${expectedWallet}`);
      }
      return { privateKey: account.stxPrivateKey, address, source: "CLIENT_MNEMONIC" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      attempts.push(`CLIENT_MNEMONIC: ${detail}`);
    }
  } else {
    attempts.push("CLIENT_MNEMONIC: not set");
  }

  const privateKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (privateKey) {
    try {
      const address = getAddressFromPrivateKey(privateKey, "mainnet");
      if (address !== expectedWallet) {
        throw new Error(`resolves to ${address}, expected ${expectedWallet}`);
      }
      return { privateKey, address, source: "STACKS_PRIVATE_KEY" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      attempts.push(`STACKS_PRIVATE_KEY: ${detail}`);
    }
  } else {
    attempts.push("STACKS_PRIVATE_KEY: not set");
  }

  throw new Error(
    `Could not resolve local signer. Set AIBTC_WALLET_ID plus AIBTC_WALLET_PASSWORD, unlock the active wallet with wallet/wallet.ts unlock, or set CLIENT_MNEMONIC/STACKS_PRIVATE_KEY. Attempts: ${attempts.join("; ")}`
  );
}

async function buildAndBroadcast(context: Context, privateKey: string, fee: bigint) {
  const { address: routerAddress, name: routerName } = parseContractId(HODLMM_LIQUIDITY_ROUTER);
  const { address: poolAddress, name: poolName } = parseContractId(context.pool.poolContract);
  const { address: xAddress, name: xName } = parseContractId(context.pool.tokenX.contract);
  const { address: yAddress, name: yName } = parseContractId(context.pool.tokenY.contract);

  const positions = context.selectedBins.map((bin) => tupleCV({
    "active-bin-id-offset": intCV(bin.activeBinOffset),
    "x-amount": uintCV(bin.xAmount),
    "y-amount": uintCV(bin.yAmount),
    "min-dlp": uintCV(bin.minDlp),
    "max-x-liquidity-fee": uintCV(bin.maxXLiquidityFee),
    "max-y-liquidity-fee": uintCV(bin.maxYLiquidityFee),
  }));

  const activeBinTolerance = someCV(tupleCV({
    "expected-bin-id": intCV(routerExpectedBinId(context.bins.active_bin_id)),
    "max-deviation": uintCV(context.selection.activeBinMaxDeviation),
  }));

  const postConditions = buildPostConditions(context);
  const transaction = await makeContractCall({
    contractAddress: routerAddress,
    contractName: routerName,
    functionName: DEPOSIT_FUNCTION,
    functionArgs: [
      listCV(positions),
      contractPrincipalCV(poolAddress, poolName),
      contractPrincipalCV(xAddress, xName),
      contractPrincipalCV(yAddress, yName),
      activeBinTolerance,
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee,
  });

  const result = await broadcastTransaction({ transaction, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Broadcast failed: ${result.error}${"reason" in result ? ` - ${result.reason}` : ""}`);
  }

  return {
    txid: normalizeTxId(result.txid),
    postConditionCount: postConditions.length,
  };
}

async function waitForTx(txid: string, waitSeconds: number) {
  const deadline = Date.now() + waitSeconds * 1000;
  let last: JsonMap | null = null;

  while (Date.now() <= deadline) {
    let tx: JsonMap;
    try {
      tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("HTTP 404 ")) {
        last = { tx_status: "not_indexed", tx_id: txid };
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      throw error;
    }
    last = tx;
    const status = String(tx.tx_status ?? "");
    if (status === "success") return tx;
    if (status.startsWith("abort") || status === "failed") return tx;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }

  return last;
}

function txProofData(context: Context, signer: { source: string; address: string }, broadcast: { txid: string; postConditionCount: number }, tx: JsonMap | null, txStatus: string): JsonMap {
  return {
    ...contextData(context),
    signer: {
      source: signer.source,
      address: signer.address,
    },
    tx: {
      txid: broadcast.txid,
      explorer: `${EXPLORER}/${broadcast.txid}?chain=mainnet`,
      status: txStatus,
      sender: tx?.sender_address ?? signer.address,
      contract: tx?.contract_call && typeof tx.contract_call === "object"
        ? (tx.contract_call as JsonMap).contract_id
        : HODLMM_LIQUIDITY_ROUTER,
      function: tx?.contract_call && typeof tx.contract_call === "object"
        ? (tx.contract_call as JsonMap).function_name
        : DEPOSIT_FUNCTION,
      postConditionMode: tx?.post_condition_mode ?? "deny",
      postConditionCount: broadcast.postConditionCount,
    },
  };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, false);
  success("doctor", {
    result: "ready",
    details: {
      pool: context.pool.poolId,
      poolContract: context.pool.poolContract,
      router: HODLMM_LIQUIDITY_ROUTER,
      function: DEPOSIT_FUNCTION,
      activeBin: context.bins.active_bin_id,
      tokenX: { ...context.xAsset, sufficientForPlan: context.xAsset.balance >= context.totals.xAmount },
      tokenY: { ...context.yAsset, sufficientForPlan: context.yAsset.balance >= context.totals.yAmount },
      poolToken: DLP_ASSET_NAME,
      poolTokenId: DLP_TOKEN_ID_ASSET_NAME,
      selectedBins: context.selectedBins.length,
      stxAvailableUstx: context.stxAvailable,
      pendingDepth: context.pendingDepth,
      writeBlockedByPendingTx: context.pendingDepth > 0,
    },
  });
}

async function runStatus(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts);
  success("status", contextData(context));
}

async function runConfirmed(opts: RunOptions): Promise<void> {
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked(
      "run",
      "CONFIRMATION_REQUIRED",
      "This write skill requires explicit confirmation.",
      "Re-run with --confirm=DEPOSIT.",
      { requiredConfirm: CONFIRM_TOKEN }
    );
    return;
  }

  const context = await collectContext(opts);
  if (context.pendingDepth > 0) {
    throw new BlockedError(
      "PENDING_STX_TX",
      `Wallet has ${context.pendingDepth} pending STX transaction(s).`,
      "Wait for pending transactions to confirm or clear before running this write.",
      { pending: context.pendingTransactions }
    );
  }
  if (context.totals.xAmount <= 0n && context.totals.yAmount <= 0n) {
    throw new BlockedError(
      "ZERO_DEPOSIT",
      "Selected plan has no nonzero token amount.",
      "Provide --amount-x, --amount-y, or --plan-json with nonzero amounts."
    );
  }
  if (context.totals.minDlp <= 0n) {
    throw new BlockedError(
      "ZERO_MIN_DLP",
      "Selected plan has zero aggregate min-dlp.",
      "Increase the deposit amount or choose bins with usable liquidity."
    );
  }

  const signer = await resolveSigner(context.wallet);
  const fee = asBigInt(opts.feeUstx ?? DEFAULT_FEE_USTX, "--fee-ustx");
  const waitSeconds = parseNonNegativeInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
  const broadcast = await buildAndBroadcast(context, signer.privateKey, fee);
  const tx = waitSeconds > 0 ? await waitForTx(broadcast.txid, waitSeconds) : null;
  const txStatus = String(tx?.tx_status ?? (waitSeconds > 0 ? "not_indexed" : "broadcast"));
  success("run", txProofData(context, signer, broadcast, tx, txStatus));
}

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption("--wallet <stacksAddress>", "wallet that owns tokens and signs the write")
    .requiredOption("--pool-id <poolId>", "HODLMM pool id")
    .option("--bin-id <id>", "absolute HODLMM bin id")
    .option("--bin-ids <ids>", "comma-separated absolute HODLMM bin ids")
    .option("--offsets <offsets>", "comma-separated active-bin-relative offsets, e.g. -1,0,1")
    .option("--range <start:end>", "active-bin-relative offset range, e.g. -2:2")
    .option("--plan-json <json>", "explicit JSON plan with binId or offset plus xAmount/yAmount")
    .option("--amount-x <amount>", "token X amount in base units")
    .option("--amount-y <amount>", "token Y amount in base units")
    .option("--distribution <mode>", "distribution mode: equal or explicit", "equal")
    .option("--slippage-bps <bps>", "slippage tolerance in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--active-bin-max-deviation <bins>", "max active-bin drift tolerated before revert", String(DEFAULT_ACTIVE_BIN_MAX_DEVIATION))
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX balance to preserve after deposit and fee", DEFAULT_MIN_GAS_RESERVE_USTX.toString());
}

const program = new Command();

program
  .name("bitflow-hodlmm-deposit")
  .description("Deposit selected assets into Bitflow HODLMM bins on Stacks mainnet.");

addSharedOptions(program.command("doctor").description("Check environment and selected HODLMM pool readiness"))
  .action(async (opts: SharedOptions) => {
    try {
      await runDoctor(opts);
    } catch (error) {
      printActionError("doctor", error);
    }
  });

addSharedOptions(program.command("status").description("Preview HODLMM deposit plan without broadcasting"))
  .action(async (opts: SharedOptions) => {
    try {
      await runStatus(opts);
    } catch (error) {
      printActionError("status", error);
    }
  });

addSharedOptions(program.command("run").description("Broadcast a confirmed HODLMM deposit transaction"))
  .option("--confirm <token>", "required confirmation token")
  .option("--fee-ustx <uSTX>", "transaction fee in uSTX", DEFAULT_FEE_USTX.toString())
  .option("--wait-seconds <seconds>", "seconds to wait for Hiro tx status", String(DEFAULT_WAIT_SECONDS))
  .action(async (opts: RunOptions) => {
    try {
      await runConfirmed(opts);
    } catch (error) {
      printActionError("run", error);
    }
  });

program.parse();
