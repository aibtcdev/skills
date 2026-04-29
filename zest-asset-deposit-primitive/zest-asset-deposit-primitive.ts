#!/usr/bin/env bun

import { Command } from "commander";
import {
  AnchorMode,
  PostConditionMode,
  Pc,
  broadcastTransaction,
  contractPrincipalCV,
  cvToJSON,
  fetchCallReadOnlyFunction,
  makeContractCall,
  noneCV,
  principalCV,
  uintCV,
  type ClarityValue,
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
type CvJson = { success?: boolean; value?: unknown; type?: string };

interface SharedOptions {
  wallet: string;
  depositAsset?: string;
  amount?: string;
  minShares?: string;
  minGasReserveUstx?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
  feeUstx?: string;
  waitSeconds?: string;
}

interface AssetConfig {
  symbol: string;
  aliases: string[];
  underlying: string;
  underlyingAssetName: string;
  vault: string;
  vaultAssetName: string;
  underlyingId: bigint;
  vaultId: bigint;
  decimals: number;
  canDeposit: boolean;
}

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

const HIRO_API = "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "DEPOSIT";
const DEFAULT_FEE_USTX = 70_000n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 200_000n;
const DEFAULT_WAIT_SECONDS = 240;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const MAX_MASK = 18_446_744_073_709_551_615n;

const MARKET = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const MARKET_VAULT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault";
const ASSETS = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets";
const EGROUP = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-egroup";

const ASSET_CONFIGS: AssetConfig[] = [
  {
    symbol: "STX",
    aliases: ["stx", "wstx"],
    underlying: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    underlyingAssetName: "wstx",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx",
    vaultAssetName: "zft",
    underlyingId: 0n,
    vaultId: 1n,
    decimals: 6,
    canDeposit: true,
  },
  {
    symbol: "sBTC",
    aliases: ["sbtc", "btc"],
    underlying: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    underlyingAssetName: "sbtc-token",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    vaultAssetName: "zft",
    underlyingId: 2n,
    vaultId: 3n,
    decimals: 8,
    canDeposit: true,
  },
  {
    symbol: "USDC",
    aliases: ["usdc", "usdcx"],
    underlying: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    underlyingAssetName: "usdcx",
    vault: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc",
    vaultAssetName: "zft",
    underlyingId: 6n,
    vaultId: 7n,
    decimals: 6,
    canDeposit: true,
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
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor/status and inspect the failing check before retrying." });
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

function resolveAsset(input: string | undefined): AssetConfig {
  if (!input) throw new BlockedError("MISSING_DEPOSIT_ASSET", "--deposit-asset is required.", "Re-run with --deposit-asset <symbol>.");
  const wanted = input.toLowerCase();
  const asset = ASSET_CONFIGS.find((candidate) =>
    candidate.symbol.toLowerCase() === wanted ||
    candidate.aliases.includes(wanted) ||
    candidate.underlying.toLowerCase() === wanted ||
    candidate.vault.toLowerCase() === wanted
  );
  if (!asset) throw new Error(`Unsupported Zest deposit asset: ${input}`);
  if (!asset.canDeposit) throw new Error(`${asset.symbol} is not enabled for this deposit primitive`);
  return asset;
}

function readTimeoutMs(): number {
  const raw = process.env.ZEST_READ_TIMEOUT_MS;
  if (!raw) return DEFAULT_READ_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("ZEST_READ_TIMEOUT_MS must be a positive integer");
  return parsed;
}

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs = readTimeoutMs()): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`READ_TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readTimeoutMs());
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`READ_TIMEOUT: ${url} exceeded ${readTimeoutMs()}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchContractInterface(contractId: string) {
  const { address, name } = parseContractId(contractId);
  return fetchJson<{ functions?: Array<{ name: string; access: string }> }>(
    `${HIRO_API}/v2/contracts/interface/${address}/${name}?proof=0`
  );
}

async function callReadOnly(contractId: string, functionName: string, functionArgs: ClarityValue[], sender: string): Promise<CvJson> {
  const { address, name } = parseContractId(contractId);
  const cv = await withTimeout(
    `${contractId}.${functionName}`,
    fetchCallReadOnlyFunction({
      contractAddress: address,
      contractName: name,
      functionName,
      functionArgs,
      senderAddress: sender,
      network: STACKS_MAINNET,
    })
  );
  return cvToJSON(cv);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`Expected object, got ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
}

function cvUint(value: unknown): bigint {
  const record = asRecord(value);
  if (record.success === false) throw new Error(`Read-only call failed: ${JSON.stringify(value)}`);
  const nested = record.value && typeof record.value === "object" ? (record.value as Record<string, unknown>).value : undefined;
  const raw = nested ?? record.value;
  if (typeof raw === "string") return BigInt(raw);
  if (typeof raw === "number") return BigInt(raw);
  throw new Error(`Expected uint CV JSON, got ${JSON.stringify(value)}`);
}

function cvOkUint(value: CvJson): bigint {
  if (!value.success) throw new Error(`Read-only response failed: ${JSON.stringify(value)}`);
  return cvUint(value.value);
}

async function getPendingDepth(wallet: string): Promise<number> {
  const payload = await fetchJson<{ results?: Array<{ tx_id: string }> }>(
    `${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}`
  );
  return payload.results?.length ?? 0;
}

async function getStxBalance(wallet: string): Promise<bigint> {
  const payload = await fetchJson<{ balance: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(payload.balance);
}

async function getFtBalance(wallet: string, asset: AssetConfig): Promise<bigint> {
  if (asset.symbol === "STX") return getStxBalance(wallet);
  return cvOkUint(await callReadOnly(asset.underlying, "get-balance", [principalCV(wallet)], wallet));
}

async function getPosition(wallet: string): Promise<{ exists: boolean; raw?: unknown; mask: bigint; debtCount: number; collateralCount: number }> {
  const result = await callReadOnly(MARKET_VAULT, "get-position", [principalCV(wallet), uintCV(MAX_MASK)], wallet);
  if (!result.success) return { exists: false, mask: 0n, debtCount: 0, collateralCount: 0, raw: result };
  const responseValue = asRecord(result.value);
  const value = asRecord(responseValue.value);
  const mask = BigInt(String(asRecord(value.mask).value));
  const debtValue = asRecord(value.debt).value;
  const collateralValue = asRecord(value.collateral).value;
  const debtCount = Array.isArray(debtValue) ? debtValue.length : 0;
  const collateralCount = Array.isArray(collateralValue) ? collateralValue.length : 0;
  return { exists: true, raw: result, mask, debtCount, collateralCount };
}

async function validateEgroup(wallet: string, asset: AssetConfig, position: Awaited<ReturnType<typeof getPosition>>): Promise<JsonMap> {
  const futureMask = position.exists ? position.mask | (1n << asset.vaultId) : (1n << asset.vaultId);
  try {
    const result = await callReadOnly(EGROUP, "resolve", [uintCV(futureMask)], wallet);
    if (!result?.success) throw new Error(JSON.stringify(result));
    return { supported: true, currentMask: position.mask, futureMask };
  } catch (error) {
    throw new BlockedError(
      "UNSUPPORTED_EGROUP",
      "The selected deposit would create a collateral mask that Zest V2 does not support.",
      "Use an asset already supported by the account egroup or use a clean wallet/account state.",
      {
        asset: asset.symbol,
        vaultAssetId: asset.vaultId,
        currentMask: position.mask,
        futureMask,
        reason: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

async function checkContracts(asset: AssetConfig): Promise<JsonMap> {
  const [marketInterface, assetInterface, vaultInterface] = await Promise.all([
    fetchContractInterface(MARKET),
    fetchContractInterface(ASSETS),
    fetchContractInterface(asset.vault),
  ]);
  const hasDeposit = marketInterface.functions?.some((fn) => fn.name === "supply-collateral-add" && fn.access === "public");
  const hasFind = assetInterface.functions?.some((fn) => fn.name === "find");
  const hasShares = vaultInterface.functions?.some((fn) => fn.name === "convert-to-shares");
  if (!hasDeposit) throw new BlockedError("MARKET_ABI_MISSING", "Zest V2 market does not expose supply-collateral-add.", "Do not broadcast until the live market ABI is verified.");
  if (!hasFind) throw new BlockedError("ASSETS_ABI_MISSING", "Zest V2 assets contract does not expose find.", "Do not broadcast until the live assets ABI is verified.");
  if (!hasShares) throw new BlockedError("VAULT_ABI_MISSING", "Selected Zest vault does not expose convert-to-shares.", "Choose a supported Zest deposit asset.");
  return { market: MARKET, assets: ASSETS, vault: asset.vault, function: "supply-collateral-add" };
}

async function collectContext(opts: SharedOptions, requireAmount: boolean) {
  if (process.env.NETWORK && process.env.NETWORK !== "mainnet") {
    throw new BlockedError("MAINNET_ONLY", "Zest asset deposit is only available on mainnet.", "Set NETWORK=mainnet.");
  }
  if (!opts.wallet) throw new Error("--wallet is required");
  const asset = resolveAsset(opts.depositAsset);
  const amount = requireAmount ? parsePositiveBigInt(opts.amount, "--amount") : opts.amount ? parsePositiveBigInt(opts.amount, "--amount") : 0n;
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const contracts = await checkContracts(asset);
  const [balance, stxBalance, pendingDepth, position] = await Promise.all([
    getFtBalance(opts.wallet, asset),
    getStxBalance(opts.wallet),
    getPendingDepth(opts.wallet),
    getPosition(opts.wallet),
  ]);
  const expectedShares = amount > 0n
    ? cvOkUint(await callReadOnly(asset.vault, "convert-to-shares", [uintCV(amount)], opts.wallet))
    : 0n;
  if (amount > 0n && expectedShares <= 0n) {
    throw new BlockedError(
      "ZERO_SHARES",
      "Nonzero deposit converts to zero vault shares.",
      "Increase --amount before attempting a confirmed deposit.",
      { amount, expectedShares }
    );
  }
  const minShares = opts.minShares ? parsePositiveBigInt(opts.minShares, "--min-shares") : expectedShares;
  if (amount > 0n && minShares > expectedShares) {
    throw new BlockedError(
      "MIN_SHARES_TOO_HIGH",
      "Requested --min-shares is above the current share preview.",
      "Lower --min-shares or rerun status for a fresh preview.",
      { minShares, expectedShares }
    );
  }
  const egroup = await validateEgroup(opts.wallet, asset, position);
  const feeUstx = DEFAULT_FEE_USTX;
  const stxRequired = asset.symbol === "STX" ? amount + feeUstx + minGasReserve : feeUstx + minGasReserve;
  const balanceOk = balance >= amount;
  const gasOk = stxBalance >= stxRequired;
  return {
    wallet: opts.wallet,
    asset,
    amount,
    minShares,
    expectedShares,
    balance,
    stxBalance,
    minGasReserve,
    feeUstx,
    pendingDepth,
    position,
    egroup,
    contracts,
    balanceOk,
    gasOk,
    stxRequired,
  };
}

function contextData(context: Awaited<ReturnType<typeof collectContext>>): JsonMap {
  return {
    network: "mainnet",
    wallet: context.wallet,
    market: MARKET,
    function: "supply-collateral-add",
    asset: {
      symbol: context.asset.symbol,
      underlying: context.asset.underlying,
      vault: context.asset.vault,
      underlyingId: context.asset.underlyingId,
      vaultId: context.asset.vaultId,
      decimals: context.asset.decimals,
    },
    amount: context.amount,
    expectedShares: context.expectedShares,
    minShares: context.minShares,
    balances: {
      asset: context.balance,
      stx: context.stxBalance,
      assetSufficient: context.balanceOk,
      stxSufficientForFeeAndReserve: context.gasOk,
      stxRequired: context.stxRequired,
    },
    account: {
      positionExists: context.position.exists,
      currentMask: context.position.mask,
      futureMask: context.egroup.futureMask,
      debtCount: context.position.debtCount,
      collateralCount: context.position.collateralCount,
    },
    safety: {
      pendingDepth: context.pendingDepth,
      postConditionMode: "deny",
      postconditions: buildPostConditionSummary(context),
    },
  };
}

function buildPostConditionSummary(context: Awaited<ReturnType<typeof collectContext>>): string[] {
  if (context.amount <= 0n) return [];
  if (context.asset.symbol === "STX") {
    return [
      `wallet sends <= ${context.amount} STX`,
      `market sends <= ${context.amount} STX`,
      `wallet sends <= ${context.amount} ${context.asset.vault}::${context.asset.vaultAssetName}`,
    ];
  }
  return [
    `wallet sends <= ${context.amount} ${context.asset.underlying}::${context.asset.underlyingAssetName}`,
    `market sends <= ${context.amount} ${context.asset.underlying}::${context.asset.underlyingAssetName}`,
    `wallet sends <= ${context.amount} ${context.asset.vault}::${context.asset.vaultAssetName}`,
  ];
}

function buildPostConditions(context: Awaited<ReturnType<typeof collectContext>>) {
  if (context.asset.symbol === "STX") {
    return [
      Pc.principal(context.wallet).willSendLte(context.amount).ustx(),
      Pc.principal(MARKET).willSendLte(context.amount).ustx(),
      Pc.principal(context.wallet).willSendLte(context.amount).ft(context.asset.vault as `${string}.${string}`, context.asset.vaultAssetName),
    ];
  }
  return [
    Pc.principal(context.wallet).willSendLte(context.amount).ft(context.asset.underlying as `${string}.${string}`, context.asset.underlyingAssetName),
    Pc.principal(MARKET).willSendLte(context.amount).ft(context.asset.underlying as `${string}.${string}`, context.asset.underlyingAssetName),
    Pc.principal(context.wallet).willSendLte(context.amount).ft(context.asset.vault as `${string}.${string}`, context.asset.vaultAssetName),
  ];
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

async function waitForTx(txid: string, waitSeconds: number): Promise<JsonMap | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  let last: JsonMap | null = null;
  while (Date.now() <= deadline) {
    try {
      const tx = await fetchJson<JsonMap>(`${HIRO_API}/extended/v1/tx/${txid}`);
      last = tx;
      const status = String(tx.tx_status ?? "");
      if (status === "success" || status.startsWith("abort") || status === "failed") return tx;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("HTTP 404 ")) throw error;
      last = { tx_status: "not_indexed", tx_id: txid };
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return last;
}

async function buildAndBroadcast(context: Awaited<ReturnType<typeof collectContext>>, privateKey: string, fee: bigint) {
  const market = parseContractId(MARKET);
  const token = parseContractId(context.asset.underlying);
  const postConditions = buildPostConditions(context);
  const transaction = await makeContractCall({
    contractAddress: market.address,
    contractName: market.name,
    functionName: "supply-collateral-add",
    functionArgs: [
      contractPrincipalCV(token.address, token.name),
      uintCV(context.amount),
      uintCV(context.minShares),
      noneCV(),
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
  };
}

function txProofData(
  context: Awaited<ReturnType<typeof collectContext>>,
  signer: { address: string; source: string },
  broadcast: { txid: string; postConditionCount: number },
  tx: JsonMap | null,
  txStatus: string
): JsonMap {
  return {
    ...contextData(context),
    signer,
    tx: {
      txid: broadcast.txid,
      explorer: `${EXPLORER}/${broadcast.txid}?chain=mainnet`,
      status: txStatus,
      sender: tx?.sender_address ?? signer.address,
      contract: tx?.contract_call && typeof tx.contract_call === "object"
        ? (tx.contract_call as JsonMap).contract_id
        : MARKET,
      function: tx?.contract_call && typeof tx.contract_call === "object"
        ? (tx.contract_call as JsonMap).function_name
        : "supply-collateral-add",
      result: tx?.tx_result ?? null,
      postConditionMode: tx?.post_condition_mode ?? "deny",
      postConditionCount: tx?.post_conditions && Array.isArray(tx.post_conditions)
        ? tx.post_conditions.length
        : broadcast.postConditionCount,
    },
  };
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, false);
  success("doctor", {
    result: "ready",
    details: contextData(context),
  });
}

async function runStatus(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, true);
  success("status", contextData(context));
}

async function runPlan(opts: SharedOptions): Promise<void> {
  const context = await collectContext(opts, true);
  if (!context.balanceOk) {
    throw new BlockedError("INSUFFICIENT_ASSET_BALANCE", "Wallet balance is too low for the requested deposit.", "Reduce --amount or fund the wallet.", { balance: context.balance, amount: context.amount });
  }
  if (!context.gasOk) {
    throw new BlockedError("INSUFFICIENT_STX_BALANCE", "STX balance is too low for fee and reserve.", "Fund the wallet with more STX or lower --min-gas-reserve-ustx.", { balance: context.stxBalance, required: context.stxRequired });
  }
  success("plan", {
    ...contextData(context),
    transaction: {
      contract: MARKET,
      function: "supply-collateral-add",
      arguments: [
        { name: "ft", value: context.asset.underlying },
        { name: "amount", value: context.amount },
        { name: "min-shares", value: context.minShares },
        { name: "price-feeds", value: "none" },
      ],
      postConditionMode: "deny",
      postConditionCount: buildPostConditions(context).length,
    },
    proofObligations: [
      "Hiro tx_status must be success",
      "sender must match --wallet",
      "contract/function must be v0-4-market.supply-collateral-add",
      "post_condition_mode must be deny",
      "post-deposit position should reflect the collateral top-up",
    ],
  });
}

async function runConfirmed(opts: RunOptions): Promise<void> {
  if (opts.confirm !== CONFIRM_TOKEN) {
    blocked("run", "CONFIRMATION_REQUIRED", "This write skill requires explicit confirmation.", "Re-run with --confirm=DEPOSIT.", { requiredConfirm: CONFIRM_TOKEN });
    return;
  }
  const context = await collectContext(opts, true);
  if (context.pendingDepth > 0) {
    throw new BlockedError("PENDING_TX_DEPTH", "Wallet has pending Stacks transactions.", "Wait for pending transactions to confirm or clear before running this write.", { pendingDepth: context.pendingDepth });
  }
  if (!context.balanceOk) {
    throw new BlockedError("INSUFFICIENT_ASSET_BALANCE", "Wallet balance is too low for the requested deposit.", "Reduce --amount or fund the wallet.", { balance: context.balance, amount: context.amount });
  }
  if (!context.gasOk) {
    throw new BlockedError("INSUFFICIENT_STX_BALANCE", "STX balance is too low for fee and reserve.", "Fund the wallet with more STX or lower --min-gas-reserve-ustx.", { balance: context.stxBalance, required: context.stxRequired });
  }
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const waitSeconds = parseNonNegativeInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
  const signer = await resolveSigner(context.wallet);
  const broadcast = await buildAndBroadcast(context, signer.privateKey, fee);
  const tx = waitSeconds > 0 ? await waitForTx(broadcast.txid, waitSeconds) : null;
  const txStatus = String(tx?.tx_status ?? (waitSeconds > 0 ? "not_indexed" : "broadcast"));
  success("run", txProofData(context, { source: signer.source, address: signer.address }, broadcast, tx, txStatus));
}

function addSharedOptions(command: Command): Command {
  return command
    .requiredOption("--wallet <stacks-address>", "wallet address")
    .option("--deposit-asset <symbol>", "asset to deposit, e.g. sBTC, STX, USDC")
    .option("--amount <base-units>", "deposit amount in base units")
    .option("--min-shares <base-units>", "minimum vault shares to receive")
    .option("--min-gas-reserve-ustx <ustx>", "minimum STX reserve after fee");
}

const program = new Command();
program.name("zest-asset-deposit-primitive").description("Deposits selected assets into Zest V2 collateral");

addSharedOptions(program.command("doctor").description("Check environment and selected asset readiness"))
  .action(async (opts: SharedOptions) => {
    try {
      await runDoctor(opts);
    } catch (error) {
      fail("doctor", error);
    }
  });

addSharedOptions(program.command("status").description("Preview Zest deposit without broadcasting"))
  .action(async (opts: SharedOptions) => {
    try {
      await runStatus(opts);
    } catch (error) {
      fail("status", error);
    }
  });

addSharedOptions(program.command("plan").description("Prepare the Zest deposit transaction plan without broadcasting"))
  .action(async (opts: SharedOptions) => {
    try {
      await runPlan(opts);
    } catch (error) {
      fail("plan", error);
    }
  });

addSharedOptions(program.command("run").description("Broadcast a confirmed Zest deposit transaction"))
  .option("--confirm <token>", "required confirmation token")
  .option("--fee-ustx <ustx>", "transaction fee in uSTX", DEFAULT_FEE_USTX.toString())
  .option("--wait-seconds <seconds>", "seconds to wait for Hiro tx status", String(DEFAULT_WAIT_SECONDS))
  .action(async (opts: RunOptions) => {
    try {
      await runConfirmed(opts);
    } catch (error) {
      fail("run", error);
    }
  });

program.parse(process.argv);
