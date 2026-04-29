#!/usr/bin/env bun

import { Command } from "commander";
import {
  AnchorMode,
  PostConditionMode,
  Pc,
  broadcastTransaction,
  bufferCV,
  contractPrincipalCV,
  cvToJSON,
  fetchCallReadOnlyFunction,
  listCV,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
  uintCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";

interface SharedOptions {
  wallet: string;
  collateralAsset?: string;
  borrowAsset?: string;
  amount?: string;
  minGasReserveUstx?: string;
  waitSeconds?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
  feeUstx?: string;
}

interface AssetConfig {
  symbol: string;
  aliases: string[];
  underlying: string;
  assetName: string;
  vault?: string;
  decimals: number;
  canCollateral: boolean;
  canBorrow: boolean;
  pythFeed?: string;
}

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

const NETWORK = "mainnet";
const HIRO_API = "https://api.hiro.so";
const PYTH_HERMES_API = "https://hermes.pyth.network";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "BORROW";
const DEFAULT_FEE_USTX = 70_000n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 200_000n;
const DEFAULT_WAIT_SECONDS = 240;
const PYTH_MAX_FEE_USTX = 10n;
const INDEX_PRECISION = 1_000_000_000_000n;

const MARKET = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const MARKET_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault";
const ASSETS = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets";
const EGROUP = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-egroup";
const STX_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx";

const ASSET_CONFIGS: AssetConfig[] = [
  {
    symbol: "STX",
    aliases: ["stx", "wstx"],
    underlying: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    assetName: "wstx",
    vault: STX_VAULT,
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  },
  {
    symbol: "sBTC",
    aliases: ["sbtc", "btc"],
    underlying: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    assetName: "sbtc-token",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    decimals: 8,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  {
    symbol: "stSTX",
    aliases: ["ststx"],
    underlying: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    assetName: "ststx",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-ststx",
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  },
  {
    symbol: "USDC",
    aliases: ["usdc", "usdcx"],
    underlying: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    assetName: "usdcx-token",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc",
    decimals: 6,
    canCollateral: true,
    canBorrow: true,
    pythFeed: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  {
    symbol: "USDH",
    aliases: ["usdh"],
    underlying: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    assetName: "usdh",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdh",
    decimals: 8,
    canCollateral: true,
    canBorrow: true,
  },
  {
    symbol: "stSTXBTC",
    aliases: ["ststxbtc"],
    underlying: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    assetName: "ststxbtc",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-ststxbtc",
    decimals: 6,
    canCollateral: true,
    canBorrow: false,
    pythFeed: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  },
];

class BlockedError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
    public data: JsonMap = {}
  ) {
    super(message);
  }
}

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stringify(val)])) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function output(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  console.log(JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2));
}

function success(action: string, data: JsonMap): void {
  output("success", action, data, null);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  output("blocked", action, data, { code, message, next });
}

function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor and inspect the failing check before retrying." });
  process.exitCode = 1;
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract id: ${contractId}`);
  return { address, name };
}

function parsePositiveBigInt(value: string | undefined, label: string): bigint {
  if (!value) throw new Error(`${label} is required`);
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer in base units`);
  const parsed = BigInt(value);
  if (parsed <= 0n) throw new Error(`${label} must be greater than 0`);
  return parsed;
}

function parseNonNegativeBigInt(value: string | undefined, fallback: bigint, label: string): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function resolveAsset(input: string | undefined, label: string): AssetConfig {
  if (!input) throw new BlockedError(`MISSING_${label.toUpperCase()}_ASSET`, `--${label}-asset is required.`, `Re-run with --${label}-asset <symbol>.`);
  const wanted = input.toLowerCase();
  const asset = ASSET_CONFIGS.find((candidate) =>
    candidate.symbol.toLowerCase() === wanted ||
    candidate.aliases.some((alias) => alias.toLowerCase() === wanted) ||
    candidate.underlying.toLowerCase() === wanted ||
    candidate.vault?.toLowerCase() === wanted
  );
  if (!asset) throw new Error(`Unsupported Zest ${label} asset: ${input}`);
  return asset;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<T>;
}

async function getContract(contractId: string): Promise<{ canonical?: boolean; tx_id?: string }> {
  return fetchJson(`${HIRO_API}/extended/v1/contract/${contractId}`);
}

async function getContractInterface(contractId: string): Promise<{ functions?: Array<{ name: string; access: string; args?: unknown[] }> }> {
  const { address, name } = parseContractId(contractId);
  return fetchJson(`${HIRO_API}/v2/contracts/interface/${address}/${name}?proof=0`);
}

async function callReadOnly(contractId: string, functionName: string, args: Parameters<typeof fetchCallReadOnlyFunction>[0]["functionArgs"], sender: string) {
  const { address, name } = parseContractId(contractId);
  return fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName,
    functionArgs: args,
    senderAddress: sender,
  });
}

function cvJson(value: unknown): JsonMap {
  return stringify(cvToJSON(value)) as JsonMap;
}

function uintValue(value: unknown): bigint {
  if (value && typeof value === "object" && "value" in value) return BigInt(String((value as { value: unknown }).value ?? "0"));
  return BigInt(String(value ?? "0"));
}

function fieldValue(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) return (value as { value: unknown }).value;
  return value;
}

function boolField(value: JsonMap | null, field: string): boolean {
  return Boolean(fieldValue(value?.[field]));
}

function okValue(value: JsonMap): unknown {
  if (value.success === false) return null;
  const wrapped = value.value;
  if (wrapped && typeof wrapped === "object" && "value" in wrapped) {
    return (wrapped as { value: unknown }).value;
  }
  return wrapped;
}

function parseListEntries(value: unknown): JsonMap[] {
  if (!value || typeof value !== "object" || !("value" in value)) return [];
  const first = (value as { value: unknown }).value;
  const list = first && typeof first === "object" && "value" in first
    ? (first as { value: unknown }).value
    : first;
  return Array.isArray(list) ? list.map((entry) => (entry && typeof entry === "object" && "value" in entry ? (entry as { value: JsonMap }).value : entry as JsonMap)) : [];
}

function oracleSummary(status: JsonMap): JsonMap {
  const value = okValue(status) as JsonMap | null;
  const oracle = fieldValue(value?.oracle) as JsonMap | null;
  const callcode = fieldValue(oracle?.callcode) as JsonMap | null;
  return {
    type: fieldValue(oracle?.type) as Json,
    ident: fieldValue(oracle?.ident) as Json,
    callcode: callcode ? fieldValue(callcode) as Json : null,
    maxStaleness: fieldValue(oracle?.["max-staleness"]) as Json,
  };
}

function registrySummary(status: JsonMap): JsonMap {
  const value = okValue(status) as JsonMap | null;
  return {
    collateralEnabled: boolField(value, "collateral"),
    borrowEnabled: boolField(value, "debt"),
    oracle: oracleSummary(status),
  };
}

function okUint(value: JsonMap | undefined): bigint | null {
  if (!value) return null;
  const inner = okValue(value);
  return inner === null || inner === undefined ? null : uintValue(inner);
}

function scaledToDebt(scaledDebt: bigint, index: bigint | null): bigint | null {
  return index === null ? null : (scaledDebt * index) / INDEX_PRECISION;
}

async function getAssetStatus(asset: AssetConfig, wallet: string, useVault: boolean): Promise<JsonMap> {
  const target = useVault ? asset.vault : asset.underlying;
  if (!target) throw new Error(`${asset.symbol} has no vault asset`);
  return cvJson(await callReadOnly(ASSETS, "get-asset-status", [principalCV(target)], wallet));
}

async function getPosition(wallet: string): Promise<JsonMap> {
  const bitmap = cvJson(await callReadOnly(ASSETS, "get-bitmap", [], wallet));
  return cvJson(await callReadOnly(MARKET_VAULT, "get-position", [principalCV(wallet), uintCV(BigInt(String(bitmap.value)))], wallet));
}

async function getStxAvailable(wallet: string): Promise<bigint> {
  const response = await fetchJson<{ balance: string; locked: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(response.balance) - BigInt(response.locked);
}

async function getPendingDepth(wallet: string): Promise<number> {
  const response = await fetchJson<{ total?: number; results?: unknown[] }>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}&limit=20`);
  return Number(response.total ?? response.results?.length ?? 0);
}

async function getBorrowVaultStats(asset: AssetConfig, wallet: string): Promise<JsonMap> {
  if (!asset.vault) return {};
  const calls = await Promise.all([
    callReadOnly(asset.vault, "get-pause-states", [], wallet).then(cvJson),
    callReadOnly(asset.vault, "get-cap-debt", [], wallet).then(cvJson).catch(() => ({})),
    callReadOnly(asset.vault, "get-debt", [], wallet).then(cvJson).catch(() => ({})),
    callReadOnly(asset.vault, "get-index", [], wallet).then(cvJson).catch(() => ({})),
    callReadOnly(asset.vault, "get-next-index", [], wallet).then(cvJson).catch(() => ({})),
    callReadOnly(asset.vault, "get-available-assets", [], wallet).then(cvJson).catch(() => ({})),
  ]);
  return {
    pauseStates: calls[0],
    capDebt: calls[1],
    debt: calls[2],
    index: calls[3],
    nextIndex: calls[4],
    availableAssets: calls[5],
  };
}

function assetIdFromStatus(status: JsonMap): bigint {
  const value = okValue(status) as JsonMap | null;
  const idField = value && typeof value === "object" ? (value.id as JsonMap | undefined) : undefined;
  return uintValue(idField);
}

function findPositionAmount(position: JsonMap, kind: "collateral" | "debt", assetId: bigint): bigint {
  const value = okValue(position) as JsonMap | null;
  if (!value) return 0n;
  const entries = parseListEntries(value[kind]);
  for (const entry of entries) {
    const aid = uintValue(entry.aid);
    if (aid === assetId) return uintValue(kind === "collateral" ? entry.amount : entry.scaled);
  }
  return 0n;
}

async function fetchPythPriceFeedBytes(assets: AssetConfig[]): Promise<{ bytes: Buffer; feeds: string[] }> {
  const feeds = [...new Set(assets.map((asset) => asset.pythFeed).filter(Boolean) as string[])];
  if (feeds.length === 0) return { bytes: Buffer.alloc(0), feeds };
  const params = new URLSearchParams();
  params.set("encoding", "hex");
  for (const feed of feeds) params.append("ids[]", feed);
  const payload = await fetchJson<{ binary?: { encoding?: string; data?: string[] } }>(`${PYTH_HERMES_API}/v2/updates/price/latest?${params.toString()}`);
  const hex = payload.binary?.data?.[0];
  if (!hex || payload.binary?.encoding !== "hex") throw new Error("Pyth Hermes did not return hex update bytes");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0 || bytes.length > 8192) throw new Error(`Pyth update length ${bytes.length} is outside the V2 market limit`);
  return { bytes, feeds };
}

function buildPriceFeeds(bytes: Buffer) {
  return bytes.length > 0 ? someCV(listCV([bufferCV(bytes)])) : noneCV();
}

async function collectContext(opts: SharedOptions, requireAmount: boolean, requireAssets: boolean) {
  if (!opts.wallet) throw new Error("--wallet is required");
  const collateralAsset = requireAssets ? resolveAsset(opts.collateralAsset, "collateral") : resolveAsset(opts.collateralAsset ?? "sBTC", "collateral");
  const borrowAsset = requireAssets ? resolveAsset(opts.borrowAsset, "borrow") : resolveAsset(opts.borrowAsset ?? "STX", "borrow");
  if (!collateralAsset.canCollateral || !collateralAsset.vault) throw new BlockedError("UNSUPPORTED_COLLATERAL_ASSET", `${collateralAsset.symbol} is not configured as V2 collateral.`, "Choose a Zest V2 collateral asset.");
  if (!borrowAsset.canBorrow) throw new BlockedError("UNSUPPORTED_BORROW_ASSET", `${borrowAsset.symbol} is not configured as borrowable.`, "Choose a Zest V2 borrow asset.");

  const amount = requireAmount ? parsePositiveBigInt(opts.amount, "--amount") : (opts.amount ? parsePositiveBigInt(opts.amount, "--amount") : 0n);
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const wallet = opts.wallet;

  const [market, marketVault, assets, egroup, marketInterface, position, collateralStatus, borrowStatus, stxAvailable, pendingDepth, borrowVaultStats] = await Promise.all([
    getContract(MARKET),
    getContract(MARKET_VAULT),
    getContract(ASSETS),
    getContract(EGROUP),
    getContractInterface(MARKET),
    getPosition(wallet),
    getAssetStatus(collateralAsset, wallet, true),
    getAssetStatus(borrowAsset, wallet, false),
    getStxAvailable(wallet),
    getPendingDepth(wallet),
    getBorrowVaultStats(borrowAsset, wallet),
  ]);

  if (!market.canonical || !marketVault.canonical || !assets.canonical || !egroup.canonical) {
    throw new BlockedError("V2_CONTRACT_NOT_CANONICAL", "One or more Zest V2 contracts is not canonical on Hiro.", "Re-verify the V2 deployment before broadcasting.", { market, marketVault, assets, egroup });
  }
  const borrowFn = marketInterface.functions?.find((fn) => fn.name === "borrow" && fn.access === "public");
  if (!borrowFn) throw new BlockedError("BORROW_ABI_MISSING", "Zest V2 market borrow ABI is missing.", "Do not broadcast until v0-4-market.borrow is verified.");
  if (stxAvailable < minGasReserve) throw new BlockedError("INSUFFICIENT_GAS", `Need at least ${minGasReserve} uSTX available, found ${stxAvailable}.`, "Fund the wallet or lower the gas reserve only if safe.", { stxAvailable, minGasReserve });

  const collateralAssetId = assetIdFromStatus(collateralStatus);
  const borrowAssetId = assetIdFromStatus(borrowStatus);
  const collateralRegistry = registrySummary(collateralStatus);
  const borrowRegistry = registrySummary(borrowStatus);
  if (!collateralRegistry.collateralEnabled) throw new BlockedError("COLLATERAL_NOT_ENABLED", `${collateralAsset.symbol} is not enabled as Zest V2 collateral in the live registry.`, "Choose an enabled collateral asset or re-verify the registry.", { collateralAsset: collateralAsset.symbol, collateralRegistry });
  if (!borrowRegistry.borrowEnabled) throw new BlockedError("BORROW_NOT_ENABLED", `${borrowAsset.symbol} is not enabled as a Zest V2 borrow asset in the live registry.`, "Choose an enabled borrow asset or re-verify the registry.", { borrowAsset: borrowAsset.symbol, borrowRegistry });
  const collateralAmount = findPositionAmount(position, "collateral", collateralAssetId);
  const scaledDebt = findPositionAmount(position, "debt", borrowAssetId);
  const debtIndex = okUint(borrowVaultStats.index as JsonMap | undefined);
  const nextDebtIndex = okUint(borrowVaultStats.nextIndex as JsonMap | undefined);
  const currentDebtEstimate = scaledToDebt(scaledDebt, debtIndex);
  const nextDebtEstimate = scaledToDebt(scaledDebt, nextDebtIndex);
  const positionTracked = position.success !== false;

  if (requireAmount) {
    if (!positionTracked) throw new BlockedError("NO_V2_POSITION", "Wallet has no tracked Zest V2 Market-Vault position.", "Create collateral first, then rerun plan/run.", { position });
    if (collateralAmount <= 0n) throw new BlockedError("NO_SELECTED_COLLATERAL", `Wallet has no ${collateralAsset.symbol} V2 collateral.`, "Supply or add selected collateral before borrowing.", { collateralAsset: collateralAsset.symbol, collateralAssetId });
  }

  return {
    wallet,
    collateralAsset,
    borrowAsset,
    amount,
    stxAvailable,
    pendingDepth,
    positionTracked,
    collateralAssetId,
    borrowAssetId,
    collateralAmount,
    scaledDebt,
    contracts: {
      market: MARKET,
      marketVault: MARKET_VAULT,
      assets: ASSETS,
      egroup: EGROUP,
      staleLegacyHelperBlocked: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-5",
      legacyHelperNotTarget: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7",
    },
    assets: {
      collateral: { symbol: collateralAsset.symbol, vault: collateralAsset.vault, assetId: collateralAssetId, amount: collateralAmount, decimals: collateralAsset.decimals, registry: collateralRegistry },
      borrow: {
        symbol: borrowAsset.symbol,
        token: borrowAsset.underlying,
        assetName: borrowAsset.assetName,
        assetId: borrowAssetId,
        scaledDebt,
        currentDebtEstimate,
        nextDebtEstimate,
        debtIndex,
        nextDebtIndex,
        scaledDebtNote: "scaledDebt is principal in index-scaled units. It is not the repayment amount; multiply by the debt index / 1e12 for an estimated current debt amount.",
        decimals: borrowAsset.decimals,
        registry: borrowRegistry,
      },
    },
    safety: {
      network: NETWORK,
      postConditionMode: "deny",
      pendingDepth,
      stxAvailableUstx: stxAvailable,
      receiverArgument: "(some --wallet)",
      priceFeeds: "Pyth Hermes update bytes when selected assets use Pyth feeds",
      note: "This primitive borrows only. It requires existing V2 collateral and does not supply collateral.",
    },
    raw: { position, collateralStatus, borrowStatus, borrowVaultStats },
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function aibtcPath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

async function decryptSessionAccount(walletId: string): Promise<{ address: string; privateKey: string } | null> {
  const session = await readJsonFile<SessionFile>(aibtcPath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) return null;
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) return null;
  const sessionKey = await fs.readFile(aibtcPath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];
  const config = await readJsonFile<{ activeWalletId?: string }>(aibtcPath("config.json"));
  const walletId = process.env.AIBTC_WALLET_ID || config?.activeWalletId;
  if (walletId) {
    try {
      const account = await decryptSessionAccount(walletId);
      if (account?.privateKey) {
        if (account.address !== expectedWallet) throw new Error(`session resolves to ${account.address}, expected ${expectedWallet}`);
        return { privateKey: account.privateKey, address: account.address, source: "AIBTC_SESSION_FILE" };
      }
      attempts.push("AIBTC_SESSION_FILE: no active unexpired session");
    } catch (error) {
      attempts.push(`AIBTC_SESSION_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    attempts.push("AIBTC_SESSION_FILE: no active wallet id");
  }
  const privateKey = process.env.STACKS_PRIVATE_KEY?.trim();
  if (privateKey) {
    const address = getAddressFromPrivateKey(privateKey, "mainnet");
    if (address !== expectedWallet) throw new Error(`STACKS_PRIVATE_KEY resolves to ${address}, expected ${expectedWallet}`);
    return { privateKey, address, source: "STACKS_PRIVATE_KEY" };
  }
  attempts.push("STACKS_PRIVATE_KEY: not set");
  throw new Error(`Could not resolve signer. ${attempts.join("; ")}`);
}

function buildPostConditions(context: Awaited<ReturnType<typeof collectContext>>) {
  if (context.borrowAsset.symbol === "STX") {
    return [
      Pc.principal(STX_VAULT).willSendLte(context.amount).ustx(),
      Pc.principal(context.wallet).willSendLte(PYTH_MAX_FEE_USTX).ustx(),
    ];
  }
  return [
    Pc.principal(context.borrowAsset.vault as `${string}.${string}`).willSendLte(context.amount).ft(context.borrowAsset.underlying as `${string}.${string}`, context.borrowAsset.assetName),
    Pc.principal(context.wallet).willSendLte(PYTH_MAX_FEE_USTX).ustx(),
  ];
}

async function buildAndBroadcast(context: Awaited<ReturnType<typeof collectContext>>, privateKey: string, fee: bigint) {
  const market = parseContractId(MARKET);
  const borrowToken = parseContractId(context.borrowAsset.underlying);
  const { bytes, feeds } = await fetchPythPriceFeedBytes([context.collateralAsset, context.borrowAsset]);
  const postConditions = buildPostConditions(context);
  const transaction = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: "borrow",
    functionArgs: [
      contractPrincipalCV(borrowToken.address, borrowToken.name),
      uintCV(context.amount),
      someCV(principalCV(context.wallet)),
      buildPriceFeeds(bytes),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions,
    fee,
  });
  const result = await broadcastTransaction({ transaction, network: STACKS_MAINNET });
  if ("error" in result && result.error) throw new Error(`Broadcast failed: ${result.error}${"reason" in result ? ` - ${result.reason}` : ""}`);
  return {
    txid: result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`,
    postConditionCount: postConditions.length,
    priceFeedBytesLength: bytes.length,
    priceFeeds: feeds,
  };
}

async function waitForTx(txid: string, waitSeconds: number): Promise<JsonMap | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  let last: JsonMap | null = null;
  while (Date.now() <= deadline) {
    try {
      const tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
      last = tx;
      const status = String(tx.tx_status ?? "");
      if (status === "success" || status === "failed" || status.startsWith("abort")) return tx;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("HTTP 404 ")) throw error;
      last = { tx_status: "not_indexed", tx_id: txid };
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return last;
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  const context = await collectContext({ ...opts, collateralAsset: opts.collateralAsset ?? "sBTC", borrowAsset: opts.borrowAsset ?? "STX" }, false, false);
  if (context.pendingDepth > 0) {
    blocked("doctor", "PENDING_STX_TX", `Wallet has ${context.pendingDepth} pending transaction(s).`, "Wait for pending transactions to confirm before planning or borrowing.", {
      result: "blocked-by-pending-tx",
      pendingDepth: context.pendingDepth,
      contracts: context.contracts,
      assets: context.assets,
      safety: context.safety,
    });
    return;
  }
  success("doctor", {
    result: context.pendingDepth === 0 ? "ready" : "blocked-by-pending-tx",
    contracts: context.contracts,
    assets: context.assets,
    safety: context.safety,
  });
}

async function runStatus(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, false, true);
  success("status", {
    wallet: context.wallet,
    contracts: context.contracts,
    assets: context.assets,
    positionTracked: context.positionTracked,
    safety: context.safety,
  });
}

async function runPlan(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, true, true);
  if (context.pendingDepth > 0) throw new BlockedError("PENDING_STX_TX", `Wallet has ${context.pendingDepth} pending transaction(s).`, "Wait for pending transactions to confirm before borrowing.", { pendingDepth: context.pendingDepth });
  success("plan", {
    wallet: context.wallet,
    contracts: context.contracts,
    assets: context.assets,
    amount: context.amount,
    safety: context.safety,
    postconditions: context.borrowAsset.symbol === "STX"
      ? [`${STX_VAULT} sends <= ${context.amount} uSTX`, `${context.wallet} sends <= ${PYTH_MAX_FEE_USTX} uSTX for Pyth update fee`]
      : [`${context.borrowAsset.vault} sends <= ${context.amount} ${context.borrowAsset.underlying}`, `${context.wallet} sends <= ${PYTH_MAX_FEE_USTX} uSTX for Pyth update fee`],
    proofObligations: [
      "tx_status: success",
      "sender matches --wallet",
      "contract/function is v0-4-market.borrow",
      "post_condition_mode is deny",
      "post-borrow Market-Vault position shows increased debt",
    ],
  });
}

async function runConfirmed(opts: RunOptions): Promise<void> {
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked("run", "CONFIRMATION_REQUIRED", "This write skill requires explicit confirmation.", "Re-run with --confirm=BORROW.", { requiredConfirm: CONFIRM_TOKEN });
    return;
  }
  const context = await collectContext(opts, true, true);
  if (context.pendingDepth > 0) throw new BlockedError("PENDING_STX_TX", `Wallet has ${context.pendingDepth} pending transaction(s).`, "Wait for pending transactions to confirm before borrowing.", { pendingDepth: context.pendingDepth });
  const signer = await resolveSigner(context.wallet);
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const waitSeconds = parseNonNegativeInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
  const broadcast = await buildAndBroadcast(context, signer.privateKey, fee);
  const tx = waitSeconds > 0 ? await waitForTx(broadcast.txid, waitSeconds) : null;
  const txStatus = String(tx?.tx_status ?? (waitSeconds > 0 ? "not_indexed" : "broadcast"));
  const postPosition = await getPosition(context.wallet).catch((error) => ({ error: error instanceof Error ? error.message : String(error) } as JsonMap));
  const txProof = {
    txid: broadcast.txid,
    explorer: `${EXPLORER}/${broadcast.txid}?chain=mainnet`,
    status: txStatus,
    sender: tx?.sender_address ?? signer.address,
    contract: tx?.contract_call && typeof tx.contract_call === "object" ? (tx.contract_call as JsonMap).contract_id : MARKET,
    function: tx?.contract_call && typeof tx.contract_call === "object" ? (tx.contract_call as JsonMap).function_name : "borrow",
    result: tx?.tx_result,
    postConditionMode: tx?.post_condition_mode ?? "deny",
    postConditionCount: broadcast.postConditionCount,
    priceFeedBytesLength: broadcast.priceFeedBytesLength,
    priceFeeds: broadcast.priceFeeds,
  };
  if (txStatus !== "success" && txStatus !== "broadcast") {
    blocked("run", "TX_NOT_SUCCESSFUL", `Borrow transaction broadcast but did not succeed: ${txStatus}.`, "Inspect the tx result before retrying.", { tx: txProof, postPosition });
    return;
  }
  success("run", {
    wallet: context.wallet,
    signer: { source: signer.source, address: signer.address },
    amount: context.amount,
    contracts: context.contracts,
    assets: context.assets,
    tx: txProof,
    postPosition,
  });
}

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption("--wallet <stacksAddress>", "wallet that owns collateral and signs the borrow")
    .option("--collateral-asset <symbol>", "existing V2 collateral asset to inspect")
    .option("--borrow-asset <symbol>", "asset to borrow; STX maps to Zest wSTX")
    .option("--amount <baseUnits>", "borrow amount in selected asset base units")
    .option("--min-gas-reserve-ustx <uSTX>", "minimum available STX reserve before writes", DEFAULT_MIN_GAS_RESERVE_USTX.toString());
}

const program = new Command();

program
  .name("zest-borrow-asset-primitive")
  .description("Borrow a supported asset from Zest V2 against existing collateral on Stacks mainnet.");

addSharedOptions(program.command("doctor").description("Check Zest V2 borrow readiness"))
  .action((opts: SharedOptions) => runDoctor(opts).catch((error) => fail("doctor", error)));

addSharedOptions(program.command("status").description("Read current Zest V2 collateral/debt state"))
  .action((opts: SharedOptions) => runStatus(opts).catch((error) => fail("status", error)));

addSharedOptions(program.command("plan").description("Preview a Zest V2 borrow without broadcasting"))
  .action((opts: SharedOptions) => runPlan(opts).catch((error) => fail("plan", error)));

addSharedOptions(program.command("run").description("Broadcast a confirmed Zest V2 borrow transaction"))
  .option("--confirm <token>", "required confirmation token")
  .option("--fee-ustx <uSTX>", "transaction fee in micro-STX", DEFAULT_FEE_USTX.toString())
  .option("--wait-seconds <seconds>", "seconds to poll Hiro for tx status", String(DEFAULT_WAIT_SECONDS))
  .action((opts: RunOptions) => runConfirmed(opts).catch((error) => fail("run", error)));

program.parse();
