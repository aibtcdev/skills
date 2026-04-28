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
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const NETWORK = "mainnet";
const HIRO_API = "https://api.hiro.so";
const BITFLOW_API = "https://bff.bitflowapis.finance";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "EXIT";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_WITHDRAW_BPS = 10_000;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MIN_GAS_RESERVE_USTX = 100_000n;
const DEFAULT_FEE_USTX = 50_000n;
const DEFAULT_WAIT_SECONDS = 120;
const HODLMM_LIQUIDITY_ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1";
const WITHDRAW_FUNCTION = "withdraw-relative-liquidity-same-multi";
const DLP_ASSET_NAME = "pool-token";
const DLP_TOKEN_ID_ASSET_NAME = "pool-token-id";

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
  [key: string]: unknown;
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

interface HiroStxResponse {
  balance: string;
  locked: string;
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
}

interface PositionCandidate {
  index: number;
  binId: number;
  activeBinOffset: number;
  userLiquidity: bigint;
  binLiquidity: bigint;
  amount: bigint;
  reserveX: bigint;
  reserveY: bigint;
  estimatedX: bigint;
  estimatedY: bigint;
  minX: bigint;
  minY: bigint;
  price: string;
}

interface SelectionTotals {
  withdrawAmount: bigint;
  estimatedX: bigint;
  estimatedY: bigint;
  minX: bigint;
  minY: bigint;
}

interface Context {
  wallet: string;
  pool: NormalizedPool;
  bins: BinsResponse;
  userBins: Array<{ binId: number; userLiquidity: bigint; price?: string | number }>;
  withdrawableBins: PositionCandidate[];
  selectedBins: PositionCandidate[];
  skippedBins: Array<{ binId: number; reason: string }>;
  selection: {
    mode: "default-all-bins" | "all-bins" | "bin-id" | "bin-ids";
    availableModes: string[];
    withdrawBps: number;
    slippageBps: number;
  };
  totals: SelectionTotals;
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
  allBins?: boolean;
  amount?: string;
  withdrawBps?: string;
  slippageBps?: string;
  minGasReserveUstx?: string;
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

function parsePositiveBigInt(value: string | undefined, label: string): bigint | null {
  if (!value) return null;
  const parsed = asBigInt(value, label);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function parseBps(value: string | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error(`${label} must be an integer from 1 to 10000`);
  }
  return parsed;
}

function normalizeTxId(txid: string): string {
  return txid.startsWith("0x") ? txid : `0x${txid}`;
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract identifier: ${contractId}`);
  return { address, name };
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
      userLiquidity: asBigInt(bin.userLiquidity ?? bin.user_liquidity ?? bin.liquidity, `user bin ${bin.bin_id} liquidity`),
      price: bin.price,
    }))
    .filter((bin) => Number.isFinite(bin.binId) && bin.userLiquidity > 0n)
    .sort((a, b) => a.binId - b.binId);
}

async function getStxAvailable(wallet: string): Promise<bigint> {
  const response = await fetchJson<HiroStxResponse>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  const balance = asBigInt(response.balance, "stx balance");
  const locked = asBigInt(response.locked, "locked stx balance");
  return balance > locked ? balance - locked : 0n;
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

function normalizeAsset(token: AppPoolToken, contractInterface: ContractInterface): TokenAsset {
  const symbol = token.symbol ?? token.contract.split(".").at(-1) ?? "token";
  const ftName = contractInterface.fungible_tokens?.[0]?.name;
  if (ftName) {
    return {
      kind: "ft",
      contract: token.contract,
      symbol,
      assetName: token.assetName ?? ftName,
    };
  }
  if (symbol.toUpperCase() === "STX") {
    return {
      kind: "stx",
      contract: token.contract,
      symbol,
    };
  }
  return {
    kind: "unknown",
    contract: token.contract,
    symbol,
  };
}

function getPoolBinMap(bins: BinsResponse): Map<number, BinRecord> {
  return new Map(bins.bins.map((bin) => [Number(bin.bin_id), bin]));
}

function estimateTokenAmount(reserve: bigint, amount: bigint, binLiquidity: bigint): bigint {
  if (reserve <= 0n || amount <= 0n || binLiquidity <= 0n) return 0n;
  return (reserve * amount) / binLiquidity;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (amount <= 0n) return 0n;
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

function parseBinId(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must contain non-negative integer bin ids`);
  }
  return parsed;
}

function parseBinIds(value: string | undefined): number[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((part) => parseBinId(part.trim(), "--bin-ids")))];
}

function candidateForBin(
  index: number,
  userBin: Context["userBins"][number],
  poolBin: BinRecord,
  activeBinId: number,
  amount: bigint,
  slippageBps: number
): PositionCandidate {
  if (amount > userBin.userLiquidity) {
    throw new Error(`requested amount ${amount} exceeds user liquidity ${userBin.userLiquidity}`);
  }

  const reserveX = asBigInt(poolBin.reserve_x, `bin ${userBin.binId} reserve_x`);
  const reserveY = asBigInt(poolBin.reserve_y, `bin ${userBin.binId} reserve_y`);
  const binLiquidity = asBigInt(poolBin.liquidity, `bin ${userBin.binId} liquidity`);
  if (binLiquidity <= 0n) {
    throw new Error("pool bin liquidity is zero");
  }

  const estimatedX = estimateTokenAmount(reserveX, amount, binLiquidity);
  const estimatedY = estimateTokenAmount(reserveY, amount, binLiquidity);
  const minX = applySlippage(estimatedX, slippageBps);
  const minY = applySlippage(estimatedY, slippageBps);
  if (minX <= 0n && minY <= 0n) {
    throw new Error("selected amount produces zero minimum output");
  }

  return {
    index,
    binId: userBin.binId,
    activeBinOffset: userBin.binId - activeBinId,
    userLiquidity: userBin.userLiquidity,
    binLiquidity,
    amount,
    reserveX,
    reserveY,
    estimatedX,
    estimatedY,
    minX,
    minY,
    price: String(poolBin.price),
  };
}

function sumCandidates(candidates: PositionCandidate[]): SelectionTotals {
  return candidates.reduce<SelectionTotals>(
    (totals, candidate) => ({
      withdrawAmount: totals.withdrawAmount + candidate.amount,
      estimatedX: totals.estimatedX + candidate.estimatedX,
      estimatedY: totals.estimatedY + candidate.estimatedY,
      minX: totals.minX + candidate.minX,
      minY: totals.minY + candidate.minY,
    }),
    { withdrawAmount: 0n, estimatedX: 0n, estimatedY: 0n, minX: 0n, minY: 0n }
  );
}

function selectCandidates(
  userBins: Context["userBins"],
  poolBins: Map<number, BinRecord>,
  activeBinId: number,
  opts: SharedOptions
): Pick<Context, "withdrawableBins" | "selectedBins" | "skippedBins" | "selection" | "totals"> {
  const selectedBinId = opts.binId ? parseBinId(opts.binId, "--bin-id") : null;
  const selectedBinIds = parseBinIds(opts.binIds);
  const selectorCount = [selectedBinId !== null, selectedBinIds.length > 0, Boolean(opts.allBins)].filter(Boolean).length;
  if (selectorCount > 1) {
    throw new Error("Use only one selection option: --bin-id, --bin-ids, or --all-bins");
  }

  const explicitAmount = parsePositiveBigInt(opts.amount, "--amount");
  const withdrawBps = parseBps(opts.withdrawBps, DEFAULT_WITHDRAW_BPS, "--withdraw-bps");
  const slippageBps = parseBps(opts.slippageBps, DEFAULT_SLIPPAGE_BPS, "--slippage-bps");
  const sortedUserBins = [...userBins].sort((a, b) => a.binId - b.binId);
  if (!sortedUserBins.length) throw new Error("No HODLMM user bins found");

  const makeAmount = (userLiquidity: bigint) => explicitAmount ?? (() => {
    const computed = (userLiquidity * BigInt(withdrawBps)) / 10_000n;
    return computed > 0n ? computed : 1n;
  })();

  const build = (binsToBuild: typeof sortedUserBins) => {
    const skipped: Array<{ binId: number; reason: string }> = [];
    const candidates = binsToBuild.flatMap((userBin) => {
      const poolBin = poolBins.get(userBin.binId);
      if (!poolBin) {
        skipped.push({ binId: userBin.binId, reason: "missing pool bin data" });
        return [];
      }
      try {
        return [candidateForBin(
          sortedUserBins.findIndex((candidate) => candidate.binId === userBin.binId),
          userBin,
          poolBin,
          activeBinId,
          makeAmount(userBin.userLiquidity),
          slippageBps
        )];
      } catch (error) {
        skipped.push({ binId: userBin.binId, reason: error instanceof Error ? error.message : String(error) });
        return [];
      }
    });
    return { candidates, skipped };
  };

  const allBuilt = build(sortedUserBins);
  const withdrawableBins = allBuilt.candidates;
  const selectionMode = selectedBinId !== null
    ? "bin-id"
    : selectedBinIds.length > 0
      ? "bin-ids"
      : opts.allBins
        ? "all-bins"
        : "default-all-bins";

  const selectedUserBins = selectedBinId !== null
    ? sortedUserBins.filter((bin) => bin.binId === selectedBinId)
    : selectedBinIds.length > 0
      ? selectedBinIds.map((id) => sortedUserBins.find((bin) => bin.binId === id)).filter((bin): bin is typeof sortedUserBins[number] => Boolean(bin))
      : sortedUserBins;

  if (selectedBinId !== null && !selectedUserBins.length) {
    throw new Error(`Wallet has no liquidity in bin ${selectedBinId}`);
  }
  const missingSelectedBins = selectedBinIds.filter((id) => !sortedUserBins.some((bin) => bin.binId === id));
  if (missingSelectedBins.length) {
    throw new Error(`Wallet has no liquidity in selected bin(s): ${missingSelectedBins.join(",")}`);
  }
  if (explicitAmount !== null && selectedUserBins.length !== 1) {
    throw new Error("--amount is only supported with exactly one selected bin; use --withdraw-bps for multi-bin withdrawals");
  }

  const selectedBuilt = selectedUserBins.length === sortedUserBins.length
    ? allBuilt
    : build(selectedUserBins);
  const selectedBins = selectedBuilt.candidates;
  if (!selectedBins.length) {
    throw new Error(`No usable withdrawal candidate found. ${selectedBuilt.skipped.map((bin) => `bin ${bin.binId}: ${bin.reason}`).join("; ")}`);
  }

  return {
    withdrawableBins,
    selectedBins,
    skippedBins: selectedBuilt.skipped,
    selection: {
      mode: selectionMode,
      availableModes: ["default all eligible bins", "--all-bins", "--bin-id <id>", "--bin-ids <ids>"],
      withdrawBps,
      slippageBps,
    },
    totals: sumCandidates(selectedBins),
  };
}

function buildPostConditions(context: Context) {
  const postConditions = [
    Pc.principal(context.wallet)
      .willSendLte(context.totals.withdrawAmount)
      .ft(context.pool.poolContract, DLP_ASSET_NAME),
    ...context.selectedBins.map((bin) => Pc.principal(context.wallet)
      .willSendAsset()
      .nft(
        context.pool.poolContract,
        DLP_TOKEN_ID_ASSET_NAME,
        tupleCV({
          "token-id": uintCV(bin.binId),
          owner: principalCV(context.wallet),
        })
      )),
  ];

  if (context.xAsset.kind === "stx") {
    postConditions.push(
      Pc.principal(context.pool.poolContract)
        .willSendGte(context.totals.minX)
        .ustx()
    );
  } else if (context.xAsset.kind === "ft" && context.xAsset.assetName) {
    postConditions.push(
      Pc.principal(context.pool.poolContract)
        .willSendGte(context.totals.minX)
        .ft(context.xAsset.contract, context.xAsset.assetName)
    );
  } else {
    throw new Error(`Cannot build postcondition for token X ${context.xAsset.symbol}`);
  }

  if (context.yAsset.kind === "stx") {
    postConditions.push(
      Pc.principal(context.pool.poolContract)
        .willSendGte(context.totals.minY)
        .ustx()
    );
  } else if (context.yAsset.kind === "ft" && context.yAsset.assetName) {
    postConditions.push(
      Pc.principal(context.pool.poolContract)
        .willSendGte(context.totals.minY)
        .ft(context.yAsset.contract, context.yAsset.assetName)
    );
  } else {
    throw new Error(`Cannot build postcondition for token Y ${context.yAsset.symbol}`);
  }

  return postConditions;
}

async function collectContext(opts: SharedOptions): Promise<Context> {
  if (!opts.poolId) throw new Error("--pool-id is required");
  if (!opts.wallet) throw new Error("--wallet is required");
  const poolId = opts.poolId;
  const wallet = opts.wallet;
  const minGasReserve = asBigInt(opts.minGasReserveUstx ?? DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");

  const [pool, bins, userBins, stxAvailable, pending, routerContract] = await Promise.all([
    getPool(poolId),
    getBins(poolId),
    getUserBins(wallet, poolId),
    getStxAvailable(wallet),
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
  if (!routerInterface.functions?.some((fn) => fn.name === WITHDRAW_FUNCTION && fn.access === "public")) {
    throw new BlockedError(
      "UNSUPPORTED_ROUTER_INTERFACE",
      `Router contract does not expose public ${WITHDRAW_FUNCTION}`,
      "Re-verify the HODLMM liquidity router function shape before attempting a write.",
      { router: HODLMM_LIQUIDITY_ROUTER, function: WITHDRAW_FUNCTION }
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

  const selection = selectCandidates(userBins, getPoolBinMap(bins), bins.active_bin_id, opts);
  const pendingDepth = Number(pending.total ?? pending.results?.length ?? 0);
  const xAsset = normalizeAsset(pool.tokenX, xInterface);
  const yAsset = normalizeAsset(pool.tokenY, yInterface);

  if (stxAvailable < minGasReserve) {
    throw new Error(`Insufficient STX gas reserve. Need at least ${minGasReserve} uSTX, have ${stxAvailable} uSTX`);
  }

  return {
    wallet,
    pool,
    bins,
    userBins,
    ...selection,
    stxAvailable,
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
      function: WITHDRAW_FUNCTION,
      canonical: context.routerContract.canonical,
      publishTx: context.routerContract.tx_id,
    },
    poolInterface: {
      fungibleToken: DLP_ASSET_NAME,
      nonFungibleToken: DLP_TOKEN_ID_ASSET_NAME,
    },
    activeBin: context.bins.active_bin_id,
    selection: context.selection,
    userBins: context.userBins.map((bin) => ({
      binId: bin.binId,
      userLiquidity: bin.userLiquidity,
      price: bin.price,
    })),
    withdrawableBins: context.withdrawableBins.map(binData),
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
      postconditions: [
        `wallet sends <= ${context.totals.withdrawAmount} ${context.pool.poolContract}::${DLP_ASSET_NAME}`,
        ...context.selectedBins.map((bin) => `wallet sends ${context.pool.poolContract}::${DLP_TOKEN_ID_ASSET_NAME} token-id ${bin.binId}`),
        `${context.pool.poolContract} sends >= ${context.totals.minX} ${context.xAsset.symbol}`,
        `${context.pool.poolContract} sends >= ${context.totals.minY} ${context.yAsset.symbol}`,
      ],
      sftNote: "Deny-mode postconditions cover aggregate pool-token spend and one selected pool-token-id event per bin.",
    },
  };
}

function binData(bin: PositionCandidate) {
  return {
    index: bin.index,
    binId: bin.binId,
    activeBinOffset: bin.activeBinOffset,
    userLiquidity: bin.userLiquidity,
    withdrawAmount: bin.amount,
    reserveX: bin.reserveX,
    reserveY: bin.reserveY,
    estimatedX: bin.estimatedX,
    estimatedY: bin.estimatedY,
    minX: bin.minX,
    minY: bin.minY,
    price: bin.price,
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

  const withdrawPositions = context.selectedBins.map((bin) => tupleCV({
    "active-bin-id-offset": intCV(bin.activeBinOffset),
    amount: uintCV(bin.amount),
    "min-x-amount": uintCV(bin.minX),
    "min-y-amount": uintCV(bin.minY),
    "pool-trait": contractPrincipalCV(poolAddress, poolName),
  }));

  const postConditions = buildPostConditions(context);

  const transaction = await makeContractCall({
    contractAddress: routerAddress,
    contractName: routerName,
    functionName: WITHDRAW_FUNCTION,
    functionArgs: [
      listCV(withdrawPositions),
      contractPrincipalCV(xAddress, xName),
      contractPrincipalCV(yAddress, yName),
      uintCV(context.totals.minX),
      uintCV(context.totals.minY),
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
        : WITHDRAW_FUNCTION,
      postConditionCount: broadcast.postConditionCount,
    },
  };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    const context = await collectContext(opts);
    const signerSource = process.env.CLIENT_MNEMONIC
      ? "CLIENT_MNEMONIC"
      : process.env.STACKS_PRIVATE_KEY
        ? "STACKS_PRIVATE_KEY"
        : process.env.AIBTC_WALLET_PASSWORD
          ? "AIBTC_WALLET_PASSWORD"
          : null;
    const data = contextData(context);
    data.signer = {
      availableForRun: Boolean(signerSource),
      source: signerSource,
      note: signerSource ? "Signer env is present for confirmed run" : "Signer env not set; doctor/status are still read-only",
    };

    if (context.pendingDepth > 0) {
      blocked(
        "doctor",
        "PENDING_TX",
        `Wallet has ${context.pendingDepth} pending STX transaction(s)`,
        "Wait for pending transactions to settle before running a write.",
        data
      );
      return;
    }

    success("doctor", data);
  } catch (error) {
    printActionError("doctor", error);
  }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const context = await collectContext(opts);
    success("status", contextData(context));
  } catch (error) {
    printActionError("status", error);
  }
}

async function runExit(opts: SharedOptions & { confirm?: string; feeUstx?: string; waitSeconds?: string }): Promise<void> {
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked(
      "run",
      "CONFIRMATION_REQUIRED",
      "This write skill will withdraw HODLMM liquidity and requires explicit confirmation.",
      `Re-run with --confirm=${CONFIRM_TOKEN}.`
    );
    return;
  }

  try {
    const context = await collectContext(opts);
    if (context.pendingDepth > 0) {
      blocked(
        "run",
        "PENDING_TX",
        `Wallet has ${context.pendingDepth} pending STX transaction(s)`,
        "Wait for pending transactions to settle before broadcasting.",
        contextData(context)
      );
      return;
    }

    const signer = await resolveSigner(context.wallet);
    const fee = asBigInt(opts.feeUstx ?? DEFAULT_FEE_USTX, "--fee-ustx");
    const waitSeconds = Number(opts.waitSeconds ?? DEFAULT_WAIT_SECONDS);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 1200) {
      throw new Error("--wait-seconds must be an integer from 0 to 1200");
    }

    const broadcast = await buildAndBroadcast(context, signer.privateKey, fee);
    const tx = waitSeconds > 0 ? await waitForTx(broadcast.txid, waitSeconds) : null;
    const txStatus = tx ? String(tx.tx_status ?? "unknown") : "not-waited";

    const proofData = txProofData(context, signer, broadcast, tx, txStatus);
    if (waitSeconds > 0 && txStatus !== "success") {
      blocked(
        "run",
        "TX_NOT_CONFIRMED_SUCCESS",
        `Broadcast succeeded but Hiro status is ${txStatus}.`,
        "Inspect the tx before treating this as proof. A valid write-skill proof requires tx_status: success.",
        proofData
      );
      return;
    }

    success("run", proofData);
  } catch (error) {
    printActionError("run", error);
  }
}

const program = new Command();

program
  .name("bitflow-hodlmm-withdraw")
  .description("Withdraw Bitflow HODLMM liquidity across selected bins on Stacks mainnet.");

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption("--pool-id <poolId>", "HODLMM pool id")
    .requiredOption("--wallet <address>", "Stacks wallet address")
    .option("--bin-id <id>", "Specific HODLMM bin id to withdraw from")
    .option("--bin-ids <ids>", "Comma-separated HODLMM bin ids to withdraw from")
    .option("--all-bins", "Withdraw from every eligible user bin; this is also the default")
    .option("--amount <shares>", "Exact DLP pool-token share amount to withdraw; only valid with one selected bin")
    .option("--withdraw-bps <bps>", "Percent of selected bin liquidity to withdraw, in bps", String(DEFAULT_WITHDRAW_BPS))
    .option("--slippage-bps <bps>", "Minimum-output slippage tolerance in bps", String(DEFAULT_SLIPPAGE_BPS))
    .option("--min-gas-reserve-ustx <uSTX>", "Minimum available STX balance required before writes", String(DEFAULT_MIN_GAS_RESERVE_USTX));
}

addSharedOptions(
  program
    .command("doctor")
    .description("Check mainnet readiness, contracts, APIs, wallet position, gas, and pending tx depth")
).action((opts) => runDoctor(opts));

addSharedOptions(
  program
    .command("status")
    .description("Preview HODLMM withdrawal options and selected bins without broadcasting")
).action((opts) => runStatus(opts));

addSharedOptions(
  program
    .command("run")
    .description("Broadcast a confirmed HODLMM withdrawal transaction")
    .option("--confirm <token>", "Required confirmation token")
    .option("--fee-ustx <uSTX>", "Transaction fee in micro-STX", String(DEFAULT_FEE_USTX))
    .option("--wait-seconds <seconds>", "Seconds to poll Hiro for tx inclusion", String(DEFAULT_WAIT_SECONDS))
).action((opts) => runExit(opts));

program.parse();
