#!/usr/bin/env bun

import { Command } from "commander";
import {
  AnchorMode,
  type ClarityValue,
  type PostCondition,
  PostConditionMode,
  broadcastTransaction,
  cvToJSON,
  fetchCallReadOnlyFunction,
  getAddressFromPrivateKey,
  makeContractCall,
  principalCV,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";

interface TokenInfo {
  tokenId: string;
  symbol: string;
  name: string;
  tokenContract: string | null;
  tokenName: string | null;
  tokenDecimals: number;
  status?: string;
  type?: string;
}

interface SharedOptions {
  wallet?: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
  slippageBps?: string;
  feeUstx?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
  search?: string;
  limit?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

interface BitflowRouteQuote {
  bestRoute: {
    route: unknown;
    quote?: number | null;
    tokenPath?: string[];
    dexPath?: string[];
    tokenXDecimals?: number;
    tokenYDecimals?: number;
    priceImpact?: unknown;
  } | null;
}

interface BitflowSwapParams {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
}

interface BitflowSdkLike {
  getAvailableTokens(): Promise<unknown[]>;
  getQuoteForRoute(tokenIn: string, tokenOut: string, amountIn: number): Promise<BitflowRouteQuote>;
  prepareSwap?: (
    swapExecutionData: { route: unknown; amount: number; tokenXDecimals: number; tokenYDecimals: number },
    senderAddress: string,
    slippageTolerance?: number
  ) => Promise<BitflowSwapParams>;
  getSwapParams?: (
    swapExecutionData: { route: unknown; amount: number; tokenXDecimals: number; tokenYDecimals: number },
    senderAddress: string,
    slippageTolerance?: number
  ) => Promise<BitflowSwapParams>;
}

interface Context {
  wallet: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountHuman: number;
  amountAtomic: bigint;
  slippageDecimal: number;
  fee: bigint;
  minGasReserve: bigint;
  pendingDepth: number;
  mempoolDepthLimit: number;
  inputBalance: bigint;
  outputBalance: bigint;
  stxAvailable: bigint;
  quote: BitflowRouteQuote | null;
  swapParams: BitflowSwapParams | null;
}

interface SessionFile {
  version: number;
  expiresAt?: string;
  encrypted: { ciphertext: string; iv: string; authTag: string };
}

const NETWORK = process.env.NETWORK || "mainnet";
const HIRO_API = process.env.STACKS_API_HOST || "https://api.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";
const CONFIRM_TOKEN = "SWAP";
const DEFAULT_WAIT_SECONDS = 240;
const DEFAULT_SDK_TIMEOUT_MS = 25_000;
const DEFAULT_FEE_USTX = 70_000n;
const DEFAULT_MIN_GAS_RESERVE_USTX = 500_000n;
const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MEMPOOL_DEPTH_LIMIT = 3;

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
  process.stdout.write(`${JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2)}\n`);
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
    process.exit(0);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor/status and inspect the failing check before retrying." });
  process.exitCode = 1;
  if (message.startsWith("SDK_TIMEOUT:")) {
    process.exit(1);
  }
}

function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) throw new Error(`Invalid contract id: ${contractId}`);
  return { address, name };
}

function parsePositiveHuman(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} is required`);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${label} must be a positive decimal`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be greater than 0`);
  return parsed;
}

function decimalToAtomic(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal amount: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places`);
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function parseInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function parseNonNegativeBigInt(value: string | undefined, fallback: bigint, label: string): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(value);
}

function parseBps(value: string | undefined): number {
  const parsed = parseInteger(value, DEFAULT_SLIPPAGE_BPS, "--slippage-bps");
  if (parsed < 0 || parsed > 10_000) throw new Error("--slippage-bps must be between 0 and 10000");
  return parsed;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return response.json() as Promise<T>;
}

async function createBitflowSdk(): Promise<BitflowSdkLike> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk") as any;
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    API_HOST: process.env.API_HOST || "https://api.bitflowapis.finance",
    STACKS_API_HOST: process.env.STACKS_API_HOST || "https://api.hiro.so",
    READONLY_CALL_API_HOST: process.env.READONLY_CALL_API_HOST || "https://api.hiro.so",
    KEEPER_API_HOST: process.env.KEEPER_API_HOST || "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL || "https://api.bitflowapis.finance",
  });
}

const originalConsole = {
  warn: console.warn,
  error: console.error,
  log: console.log,
};
let quietSdkDepth = 0;

async function quietSdk<T>(fn: () => Promise<T>): Promise<T> {
  if (quietSdkDepth === 0) {
    console.warn = () => {};
    console.error = () => {};
    console.log = () => {};
  }
  quietSdkDepth += 1;
  try {
    return await fn();
  } finally {
    quietSdkDepth = Math.max(quietSdkDepth - 1, 0);
    if (quietSdkDepth === 0) {
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.log = originalConsole.log;
    }
  }
}

async function sdkCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const timeoutMs = parseInteger(process.env.BITFLOW_SDK_TIMEOUT_MS, DEFAULT_SDK_TIMEOUT_MS, "BITFLOW_SDK_TIMEOUT_MS");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      quietSdk(fn),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`SDK_TIMEOUT: ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeToken(raw: any): TokenInfo {
  const tokenContract = raw.tokenContract && raw.tokenContract !== "null" ? String(raw.tokenContract) : null;
  const tokenName = raw.tokenName && raw.tokenName !== "null" ? String(raw.tokenName) : null;
  return {
    tokenId: String(raw.tokenId ?? raw["token-id"]),
    symbol: String(raw.symbol ?? raw.tokenId ?? raw["token-id"]),
    name: String(raw.name ?? raw.symbol ?? raw.tokenId ?? raw["token-id"]),
    tokenContract,
    tokenName,
    tokenDecimals: Number(raw.tokenDecimals ?? 6),
    status: raw.status ? String(raw.status) : undefined,
    type: raw.type ? String(raw.type) : undefined,
  };
}

async function getTokens(sdk: BitflowSdkLike): Promise<TokenInfo[]> {
  const tokens = await sdkCall("getAvailableTokens", () => sdk.getAvailableTokens());
  return tokens.map(normalizeToken);
}

function matchesToken(token: TokenInfo, selector: string): boolean {
  const needle = selector.toLowerCase();
  return (
    token.tokenId.toLowerCase() === needle ||
    token.symbol.toLowerCase() === needle ||
    token.name.toLowerCase() === needle ||
    token.tokenContract?.toLowerCase() === needle ||
    token.tokenId.toLowerCase().includes(needle) ||
    token.symbol.toLowerCase().includes(needle)
  );
}

async function resolveToken(sdk: BitflowSdkLike, selector: string | undefined, label: string): Promise<TokenInfo> {
  return resolveTokenFromList(await getTokens(sdk), selector, label);
}

function resolveTokenFromList(tokens: TokenInfo[], selector: string | undefined, label: string): TokenInfo {
  if (!selector) throw new Error(`${label} is required`);
  const matches = tokens.filter((token) => matchesToken(token, selector));
  if (matches.length === 0) {
    throw new BlockedError("TOKEN_NOT_FOUND", `Could not resolve ${label}: ${selector}`, "Run tokens --search <symbol> and use a live Bitflow token ID.", { selector });
  }
  const needle = selector.toLowerCase();
  const exactMatches = matches.filter(
    (token) =>
      token.tokenId.toLowerCase() === needle ||
      token.symbol.toLowerCase() === needle ||
      token.tokenContract?.toLowerCase() === needle
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1 || matches.length > 1) {
    throw new BlockedError(
      "AMBIGUOUS_TOKEN",
      `Ambiguous ${label}: ${selector}`,
      "Run tokens --search <selector> and rerun with a specific token ID or contract ID.",
      { selector, candidates: matches.map(tokenSummary) }
    );
  }
  return matches[0];
}

function tokenSummary(token: TokenInfo): JsonMap {
  return {
    tokenId: token.tokenId,
    symbol: token.symbol,
    name: token.name,
    tokenContract: token.tokenContract,
    tokenName: token.tokenName,
    tokenDecimals: token.tokenDecimals,
    status: token.status ?? null,
    type: token.type ?? null,
  };
}

function isStx(token: TokenInfo): boolean {
  return token.tokenId === "token-stx" || token.symbol.toLowerCase() === "stx";
}

async function getStxAvailable(wallet: string): Promise<bigint> {
  const response = await fetchJson<{ balance: string; locked: string }>(`${HIRO_API}/extended/v1/address/${wallet}/stx`);
  return BigInt(response.balance) - BigInt(response.locked);
}

async function getPendingDepth(wallet: string): Promise<number> {
  const response = await fetchJson<{ total?: number; results?: unknown[] }>(`${HIRO_API}/extended/v1/tx/mempool?sender_address=${wallet}&limit=20`);
  return response.total ?? response.results?.length ?? 0;
}

async function getFtBalance(wallet: string, token: TokenInfo): Promise<bigint> {
  if (isStx(token)) return getStxAvailable(wallet);
  if (!token.tokenContract) throw new Error(`Token ${token.tokenId} has no token contract`);
  const { address, name } = parseContractId(token.tokenContract);
  const cv = await fetchCallReadOnlyFunction({
    network: STACKS_MAINNET,
    contractAddress: address,
    contractName: name,
    functionName: "get-balance",
    functionArgs: [principalCV(wallet)],
    senderAddress: wallet,
  });
  const json: any = cvToJSON(cv);
  if (!json?.success) throw new Error(`get-balance failed for ${token.tokenContract}: ${JSON.stringify(json)}`);
  return BigInt(String(json.value?.value ?? json.value));
}

function routeSummary(quote: BitflowRouteQuote | null): JsonMap {
  const best = quote?.bestRoute ?? null;
  const route = (best?.route ?? null) as any;
  return {
    quote: best?.quote ?? quote?.quote ?? null,
    tokenPath: best?.tokenPath ?? route?.token_path ?? null,
    dexPath: best?.dexPath ?? route?.dex_path ?? null,
    quoteContract: route?.quoteData?.contract ?? null,
    quoteFunction: route?.quoteData?.function ?? null,
    swapContract: route?.swapData?.contract ?? null,
    swapFunction: route?.swapData?.function ?? null,
    tokenXDecimals: best?.tokenXDecimals ?? null,
    tokenYDecimals: best?.tokenYDecimals ?? null,
    priceImpact: best?.priceImpact ?? null,
    rawRouteKeys: best ? Object.keys(best).sort() : [],
  };
}

function assertSwapParams(raw: unknown): BitflowSwapParams {
  const params = raw as Partial<BitflowSwapParams> | null;
  if (
    !params ||
    typeof params.contractAddress !== "string" ||
    typeof params.contractName !== "string" ||
    typeof params.functionName !== "string" ||
    !Array.isArray(params.functionArgs) ||
    !Array.isArray(params.postConditions)
  ) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return complete executable swap parameters.", "Inspect quote output and retry later.");
  }
  return params as BitflowSwapParams;
}

async function prepareSwap(sdk: BitflowSdkLike, context: Omit<Context, "swapParams">): Promise<BitflowSwapParams> {
  if (!context.quote?.bestRoute?.route) {
    throw new BlockedError("NO_ROUTE", "Bitflow aggregator did not return an executable route.", "Try a different token pair or amount.");
  }
  const swapExecutionData = {
    route: context.quote.bestRoute.route,
    amount: context.amountHuman,
    tokenXDecimals: context.tokenIn.tokenDecimals,
    tokenYDecimals: context.tokenOut.tokenDecimals,
  };
  if (typeof sdk.prepareSwap === "function") {
    return assertSwapParams(await sdkCall("prepareSwap", () => sdk.prepareSwap!(swapExecutionData, context.wallet, context.slippageDecimal)));
  }
  if (typeof sdk.getSwapParams === "function") {
    return assertSwapParams(await sdkCall("getSwapParams", () => sdk.getSwapParams!(swapExecutionData, context.wallet, context.slippageDecimal)));
  }
  throw new BlockedError("PREPARE_SWAP_UNAVAILABLE", "Bitflow SDK does not expose prepareSwap or getSwapParams.", "Use an SDK version with executable swap preparation support.");
}

function postconditionSummary(postConditions: unknown[]): Json[] {
  return postConditions.map((pc: any, index) => {
    try {
      return {
        index,
        conditionCode: pc.conditionCode ?? pc.condition_code ?? null,
        principal: String(pc.principal ?? pc.principalString ?? pc.conditionPrincipal ?? "unknown"),
        asset: String(pc.assetInfo ?? pc.asset ?? pc.assetName ?? "stx-or-unknown"),
        amount: String(pc.amount ?? "unknown"),
      };
    } catch {
      return { index, rawType: typeof pc };
    }
  });
}

async function buildContext(opts: SharedOptions, requireAmount: boolean): Promise<Context> {
  if (NETWORK !== "mainnet") {
    throw new BlockedError("MAINNET_ONLY", "bitflow-swap-aggregator is mainnet-only.", "Set NETWORK=mainnet.");
  }
  if (!opts.wallet) throw new Error("--wallet is required");
  const sdk = await createBitflowSdk();
  const tokens = await getTokens(sdk);
  const tokenIn = resolveTokenFromList(tokens, opts.tokenIn, "--token-in");
  const tokenOut = resolveTokenFromList(tokens, opts.tokenOut, "--token-out");
  const amountHuman = opts.amountIn ? parsePositiveHuman(opts.amountIn, "--amount-in") : 0;
  const amountAtomic = opts.amountIn ? decimalToAtomic(opts.amountIn, tokenIn.tokenDecimals) : 0n;
  if (requireAmount && amountAtomic <= 0n) throw new Error("--amount-in is required");
  const slippageBps = parseBps(opts.slippageBps);
  const slippageDecimal = slippageBps / 10_000;
  const fee = parseNonNegativeBigInt(opts.feeUstx, DEFAULT_FEE_USTX, "--fee-ustx");
  const minGasReserve = parseNonNegativeBigInt(opts.minGasReserveUstx, DEFAULT_MIN_GAS_RESERVE_USTX, "--min-gas-reserve-ustx");
  const mempoolDepthLimit = parseInteger(opts.mempoolDepthLimit, DEFAULT_MEMPOOL_DEPTH_LIMIT, "--mempool-depth-limit");
  const [quote, inputBalance, outputBalance, stxAvailable, pendingDepth] = await Promise.all([
    requireAmount ? sdkCall("getQuoteForRoute", () => sdk.getQuoteForRoute(tokenIn.tokenId, tokenOut.tokenId, amountHuman)) : Promise.resolve(null),
    getFtBalance(opts.wallet, tokenIn),
    getFtBalance(opts.wallet, tokenOut),
    getStxAvailable(opts.wallet),
    getPendingDepth(opts.wallet),
  ]);
  if (requireAmount && !quote?.bestRoute?.route) {
    throw new BlockedError("NO_ROUTE", "Bitflow aggregator did not return an executable route.", "Try a different token pair or amount.", { tokenIn: tokenIn.tokenId, tokenOut: tokenOut.tokenId, amountIn: amountHuman });
  }
  if (requireAmount && inputBalance < amountAtomic) {
    throw new BlockedError("INSUFFICIENT_INPUT_BALANCE", "Wallet input balance is below the requested swap amount.", "Fund the wallet or reduce --amount-in.", { inputBalance, amountAtomic, tokenIn: tokenSummary(tokenIn) });
  }
  if (requireAmount && isStx(tokenIn)) {
    const totalStxNeeded = amountAtomic + fee + minGasReserve;
    if (stxAvailable < totalStxNeeded) {
      throw new BlockedError("INSUFFICIENT_STX_FOR_SWAP_AND_GAS", "Native STX cannot cover input amount, fee, and residual gas reserve.", "Reduce --amount-in or fund the wallet.", { stxAvailable, amountAtomic, fee, minGasReserve, totalStxNeeded });
    }
  } else if (stxAvailable < fee + minGasReserve) {
    throw new BlockedError("INSUFFICIENT_GAS_RESERVE", "Native STX cannot cover fee and residual gas reserve.", "Fund STX for transaction fees.", { stxAvailable, fee, minGasReserve });
  }
  const partialContext = {
    wallet: opts.wallet,
    tokenIn,
    tokenOut,
    amountHuman,
    amountAtomic,
    slippageDecimal,
    fee,
    minGasReserve,
    pendingDepth,
    mempoolDepthLimit,
    inputBalance,
    outputBalance,
    stxAvailable,
    quote,
  };
  const swapParams = requireAmount ? await prepareSwap(sdk, partialContext) : null;
  if (requireAmount && !swapParams?.contractAddress) {
    throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return executable swap parameters.", "Inspect quote output and retry later.", { route: routeSummary(quote) });
  }
  return { ...partialContext, swapParams } as Context;
}

function contextData(context: Context): JsonMap {
  return {
    network: NETWORK,
    wallet: context.wallet,
    tokens: {
      input: tokenSummary(context.tokenIn),
      output: tokenSummary(context.tokenOut),
    },
    amount: {
      amountInHuman: context.amountHuman,
      amountInAtomic: context.amountAtomic,
      slippageBps: Math.round(context.slippageDecimal * 10_000),
    },
    quote: context.quote ? routeSummary(context.quote) : null,
    execution: context.swapParams
      ? {
          contract: `${context.swapParams.contractAddress}.${context.swapParams.contractName}`,
          function: context.swapParams.functionName,
          postConditionMode: "deny",
          postConditionCount: Array.isArray(context.swapParams.postConditions) ? context.swapParams.postConditions.length : 0,
          postConditions: postconditionSummary(context.swapParams.postConditions ?? []),
        }
      : null,
    balances: {
      inputBalance: context.inputBalance,
      outputBalance: context.outputBalance,
      stxAvailable: context.stxAvailable,
    },
    safety: {
      pendingDepth: context.pendingDepth,
      mempoolDepthLimit: context.mempoolDepthLimit,
      fee: context.fee,
      minGasReserve: context.minGasReserve,
    },
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function aibtcPath(...parts: string[]): string {
  return path.join(os.homedir(), ".aibtc", ...parts);
}

async function decryptSessionAccount(walletId: string): Promise<{ privateKey: string; address: string; source: string }> {
  const session = await readJsonFile<SessionFile>(aibtcPath("sessions", `${path.basename(walletId)}.json`));
  if (!session || session.version !== 1) throw new Error("unsupported AIBTC session format");
  if (session.expiresAt && new Date(session.expiresAt) < new Date()) throw new Error("AIBTC wallet session expired");
  const sessionKey = await fs.readFile(aibtcPath("sessions", ".session-key")).catch(() => null);
  if (!sessionKey || sessionKey.length !== 32) throw new Error("AIBTC session key missing");
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(session.encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(session.encrypted.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(session.encrypted.ciphertext, "base64")),
    decipher.final(),
  ]);
  const account = JSON.parse(decrypted.toString("utf8"));
  return { privateKey: account.privateKey, address: account.address, source: "AIBTC_SESSION_FILE" };
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = crypto.scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
}

async function decryptKeystoreAccount(walletId: string, password: string): Promise<{ privateKey: string; address: string; source: string }> {
  const keystore = await readJsonFile<any>(aibtcPath("wallets", path.basename(walletId), "keystore.json"));
  let mnemonic: string | null = null;
  if (keystore.encrypted?.ciphertext) {
    mnemonic = await decryptAibtcKeystore(keystore.encrypted, password);
  } else if (keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic) {
    const { decryptMnemonic } = await import("@stacks/encryption") as any;
    mnemonic = await decryptMnemonic(keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic, password);
  }
  if (!mnemonic) throw new Error("Unsupported AIBTC keystore format");
  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk") as any;
  const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
  const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
  return { privateKey: account.stxPrivateKey, address: getStxAddress(account), source: "AIBTC_KEYSTORE" };
}

async function resolveSigner(expectedWallet: string): Promise<{ privateKey: string; address: string; source: string }> {
  const attempts: string[] = [];
  const config = await readJsonFile<{ activeWalletId?: string }>(aibtcPath("config.json")).catch(() => ({}));
  const walletId = process.env.AIBTC_WALLET_ID || config.activeWalletId;
  if (walletId) {
    try {
      const account = await decryptSessionAccount(walletId);
      if (account.address !== expectedWallet) throw new Error(`AIBTC session resolves to ${account.address}, expected ${expectedWallet}`);
      return account;
    } catch (error) {
      attempts.push(`AIBTC_SESSION: ${error instanceof Error ? error.message : String(error)}`);
    }
    const password = process.env.AIBTC_WALLET_PASSWORD;
    if (password) {
      try {
        const account = await decryptKeystoreAccount(walletId, password);
        if (account.address !== expectedWallet) throw new Error(`AIBTC keystore resolves to ${account.address}, expected ${expectedWallet}`);
        return account;
      } catch (error) {
        attempts.push(`AIBTC_KEYSTORE: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      attempts.push("AIBTC_KEYSTORE: AIBTC_WALLET_PASSWORD not set");
    }
  } else {
    attempts.push("AIBTC: no active wallet id");
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

async function broadcast(tx: Awaited<ReturnType<typeof makeContractCall>>): Promise<string> {
  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result) throw new Error(JSON.stringify(result));
  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
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
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return last;
}

function txProof(txid: string, tx: JsonMap | null, fallback: { contract: string; functionName: string }, postConditionCount: number): JsonMap {
  return {
    txid,
    explorer: `${EXPLORER}/${txid}?chain=mainnet`,
    status: tx?.tx_status ?? "unknown",
    sender: tx?.sender_address ?? null,
    contract: (tx?.contract_call as JsonMap | undefined)?.contract_id ?? fallback.contract,
    function: (tx?.contract_call as JsonMap | undefined)?.function_name ?? fallback.functionName,
    result: (tx?.tx_result as JsonMap | undefined)?.repr ?? null,
    postConditionMode: tx?.post_condition_mode ?? "deny",
    postConditionCount: Array.isArray(tx?.post_conditions) ? (tx?.post_conditions as Json[]).length : postConditionCount,
  };
}

async function runDoctor(opts: SharedOptions) {
  try {
    if (NETWORK !== "mainnet") throw new BlockedError("MAINNET_ONLY", "bitflow-swap-aggregator is mainnet-only.", "Set NETWORK=mainnet.");
    const sdk = await createBitflowSdk();
    const tokens = await getTokens(sdk);
    const walletChecks: JsonMap = {};
    if (opts.wallet) {
      walletChecks.stxAvailable = await getStxAvailable(opts.wallet);
      walletChecks.pendingDepth = await getPendingDepth(opts.wallet);
    }
    success("doctor", {
      network: NETWORK,
      bitflowSdk: {
        getAvailableTokens: typeof sdk.getAvailableTokens === "function",
        getQuoteForRoute: typeof sdk.getQuoteForRoute === "function",
        prepareSwap: typeof sdk.prepareSwap === "function",
        getSwapParams: typeof sdk.getSwapParams === "function",
      },
      tokenCount: tokens.length,
      sampleTokens: tokens.slice(0, 10).map(tokenSummary),
      wallet: opts.wallet ?? null,
      walletChecks,
    });
  } catch (error) {
    fail("doctor", error);
  }
}

async function runTokens(opts: SharedOptions) {
  try {
    const sdk = await createBitflowSdk();
    let tokens = await getTokens(sdk);
    if (opts.search) tokens = tokens.filter((token) => matchesToken(token, opts.search!));
    const limit = parseInteger(opts.limit, 50, "--limit");
    success("tokens", {
      count: tokens.length,
      showing: Math.min(tokens.length, limit),
      tokens: tokens.slice(0, limit).map(tokenSummary),
    });
  } catch (error) {
    fail("tokens", error);
  }
}

async function runQuote(opts: SharedOptions) {
  try {
    const sdk = await createBitflowSdk();
    const tokens = await getTokens(sdk);
    const tokenIn = resolveTokenFromList(tokens, opts.tokenIn, "--token-in");
    const tokenOut = resolveTokenFromList(tokens, opts.tokenOut, "--token-out");
    const amountHuman = parsePositiveHuman(opts.amountIn, "--amount-in");
    const quote = await sdkCall("getQuoteForRoute", () => sdk.getQuoteForRoute(tokenIn.tokenId, tokenOut.tokenId, amountHuman));
    if (!quote?.bestRoute?.route) {
      throw new BlockedError("NO_ROUTE", "Bitflow aggregator did not return an executable route.", "Try a different token pair or amount.", { tokenIn: tokenIn.tokenId, tokenOut: tokenOut.tokenId, amountIn: amountHuman });
    }
    success("quote", {
      network: NETWORK,
      tokens: { input: tokenSummary(tokenIn), output: tokenSummary(tokenOut) },
      amountInHuman: amountHuman,
      quote: routeSummary(quote),
    });
  } catch (error) {
    fail("quote", error);
  }
}

async function runPlan(opts: SharedOptions) {
  try {
    const context = await buildContext(opts, true);
    success("plan", contextData(context));
  } catch (error) {
    fail("plan", error);
  }
}

async function runSwap(opts: RunOptions) {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This write skill requires --confirm=SWAP.", "Re-run with --confirm=SWAP after reviewing plan output.");
    }
    const context = await buildContext(opts, true);
    if (context.pendingDepth > context.mempoolDepthLimit) {
      throw new BlockedError("PENDING_TX_DEPTH", "Wallet has pending STX transactions above the configured limit.", "Wait for pending transactions to settle before broadcasting.", { pendingDepth: context.pendingDepth, mempoolDepthLimit: context.mempoolDepthLimit });
    }
    if (!context.swapParams) {
      throw new BlockedError("PREPARE_SWAP_FAILED", "Bitflow SDK did not return executable swap parameters.", "Inspect plan output and retry later.");
    }
    const swapParams = context.swapParams;
    const signer = await resolveSigner(context.wallet);
    const tx = await makeContractCall({
      contractAddress: swapParams.contractAddress,
      contractName: swapParams.contractName,
      functionName: swapParams.functionName,
      functionArgs: swapParams.functionArgs,
      postConditions: swapParams.postConditions,
      postConditionMode: PostConditionMode.Deny,
      network: STACKS_MAINNET,
      senderKey: signer.privateKey,
      anchorMode: AnchorMode.Any,
      fee: context.fee,
    });
    const txid = await broadcast(tx);
    const waitSeconds = parseInteger(opts.waitSeconds, DEFAULT_WAIT_SECONDS, "--wait-seconds");
    const mined = await waitForTx(txid, waitSeconds);
    const proof = txProof(
      txid,
      mined,
      { contract: `${swapParams.contractAddress}.${swapParams.contractName}`, functionName: swapParams.functionName },
      Array.isArray(swapParams.postConditions) ? swapParams.postConditions.length : 0
    );
    const [inputBalanceAfter, outputBalanceAfter, stxAvailableAfter] = await Promise.all([
      getFtBalance(context.wallet, context.tokenIn),
      getFtBalance(context.wallet, context.tokenOut),
      getStxAvailable(context.wallet),
    ]);
    const balancesAfter = { inputBalance: inputBalanceAfter, outputBalance: outputBalanceAfter, stxAvailable: stxAvailableAfter };
    if (proof.status !== "success") {
      const message =
        proof.status === "not_indexed"
          ? "Broadcast transaction was not confirmed as success within the wait window."
          : `Broadcast transaction finished with status ${proof.status}.`;
      throw new BlockedError("TX_NOT_SUCCESS", message, "Inspect the proof payload, adjust the plan, and retry only after the blocker is understood.", {
        ...contextData(context),
        signer: { source: signer.source, address: signer.address },
        proof,
        balancesAfter,
      });
    }
    success("run", {
      ...contextData(context),
      signer: { source: signer.source, address: signer.address },
      proof,
      balancesAfter,
    });
  } catch (error) {
    fail("run", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns the input asset")
    .option("--token-in <token>", "input token symbol, token ID, or contract ID")
    .option("--token-out <token>", "output token symbol, token ID, or contract ID")
    .option("--amount-in <decimal>", "human-readable input amount")
    .option("--slippage-bps <bps>", "slippage tolerance in basis points", String(DEFAULT_SLIPPAGE_BPS))
    .option("--fee-ustx <uSTX>", "transaction fee in micro-STX", DEFAULT_FEE_USTX.toString())
    .option("--min-gas-reserve-ustx <uSTX>", "minimum residual STX after write", DEFAULT_MIN_GAS_RESERVE_USTX.toString())
    .option("--mempool-depth-limit <number>", "maximum allowed pending STX transactions", String(DEFAULT_MEMPOOL_DEPTH_LIMIT))
    .option("--wait-seconds <seconds>", "transaction status wait window", String(DEFAULT_WAIT_SECONDS));
}

const program = new Command();

program
  .name("bitflow-swap-aggregator")
  .description("Quote, plan, and execute Bitflow aggregator swaps on Stacks mainnet")
  .version("0.1.0");

addSharedOptions(program.command("doctor").description("Check environment and Bitflow readiness")).action(runDoctor);

program
  .command("tokens")
  .description("List live Bitflow tokens")
  .option("--search <value>", "filter by symbol, token ID, or contract ID")
  .option("--limit <number>", "maximum tokens to return", "50")
  .action(runTokens);

addSharedOptions(program.command("quote").description("Fetch a live Bitflow aggregator quote")).action(runQuote);
addSharedOptions(program.command("plan").description("Prepare a Bitflow aggregator swap without broadcasting")).action(runPlan);
addSharedOptions(program.command("run").description("Execute a Bitflow aggregator swap"))
  .option("--confirm <SWAP>", "required confirmation token")
  .action(runSwap);

program.parse(process.argv);
