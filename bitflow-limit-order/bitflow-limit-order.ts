#!/usr/bin/env bun
/**
 * bitflow-limit-order — Agent-powered limit orders on Bitflow
 *
 * Subcommands:
 *   doctor        — Verify wallet, API, and order storage health
 *   set           — Create a new limit order
 *   list          — Show all orders with status
 *   cancel <id>   — Cancel a pending order
 *   run           — Check active orders against pool prices, execute triggers
 *   install-packs — Install required npm dependencies
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_API = "https://bff.bitflowapis.finance";
const STACKS_API = "https://api.mainnet.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const ORDERS_DIR = path.join(os.homedir(), ".aibtc", "limit-orders");
const ORDERS_FILE = path.join(ORDERS_DIR, "orders.json");
const EVENTS_FILE = path.join(ORDERS_DIR, "events.jsonl");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");

// Hiro fungible-token key for sBTC (confirmed live against /extended/v1/address/{addr}/balances)
const SBTC_HIRO_KEY = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";

// Safety limits (hardcoded floors — NOT configurable)
const MAX_ORDER_STX = 2000;
const MAX_ORDER_SBTC = 0.005;
const MAX_ACTIVE_ORDERS = 10;
const MAX_SLIPPAGE_PCT = 5;
const DEFAULT_SLIPPAGE_PCT = 1;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_EXPIRY_DAYS = 7;
const API_TIMEOUT_MS = 10_000;
const TX_FEE_ESTIMATE = 5000; // microSTX
const STX_FEE_RESERVE = TX_FEE_ESTIMATE / 1e6; // STX needed for tx fee regardless of side

// Watch-mode + anti-wick
const DEFAULT_CONFIRM_TICKS = 2;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 3_600_000;

// Event log rotation
const EVENTS_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Types ────────────────────────────────────────────────────────────────────

interface LimitOrder {
  orderId: number;
  pair: string;
  poolId: string;
  side: "buy" | "sell";
  targetPrice: number;
  amount: number;
  slippage: number;
  status: "active" | "filled" | "cancelled" | "expired" | "error";
  createdAt: string;
  expiresAt: string;
  tokenIn: string;
  tokenOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  fillData?: {
    txId: string;
    fillPrice: number;
    filledAt: string;
    explorerUrl: string;
  };
  errorMessage?: string;
  lastSkipReason?: string;
  lastSkipAt?: string;
}

interface OrderBook {
  nextId: number;
  orders: LimitOrder[];
}

interface PoolInfo {
  pool_id: string;
  token_x: string;
  token_y: string;
  bin_step: number;
  active_bin: number;
  active: boolean;
  pool_name: string;
  pool_symbol: string;
}

interface ActiveBin {
  success: boolean;
  pool_id: string;
  bin_id: number;
  price: string;
  error: string | null;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function output(status: string, action: string, data: any, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function success(action: string, data: any): void {
  output("success", action, data);
}

function blocked(action: string, data: any, error: string): void {
  output("blocked", action, data, error);
}

function fail(action: string, error: string): void {
  output("error", action, null, error);
}

function log(msg: string): void {
  process.stderr.write(`[limit-order] ${msg}\n`);
}

// ─── Order storage ────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(ORDERS_DIR)) {
    fs.mkdirSync(ORDERS_DIR, { recursive: true });
  }
}

function loadOrderBook(): OrderBook {
  ensureDir();
  if (!fs.existsSync(ORDERS_FILE)) {
    return { nextId: 1, orders: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
  } catch (e: any) {
    log(`Warning: orders.json corrupted, starting fresh — ${e.message}`);
    return { nextId: 1, orders: [] };
  }
}

function saveOrderBook(book: OrderBook): void {
  ensureDir();
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(book, null, 2));
}

// ─── Bitflow API helpers ──────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolInfo[]> {
  const res = await fetch(`${BITFLOW_API}/api/quotes/v1/pools`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Pools API ${res.status}`);
  const data = await res.json() as { pools: PoolInfo[] };
  return data.pools;
}

async function findPool(pair: string): Promise<PoolInfo | null> {
  const pools = await fetchPools();
  const normalized = pair.toUpperCase().replace(/[_\s]/g, "-");
  // Match by pool_symbol (e.g., "STX-sBTC")
  return pools.find(p =>
    p.pool_symbol.toUpperCase().replace(/[_\s]/g, "-") === normalized
  ) ?? null;
}

async function getActiveBinPrice(poolId: string): Promise<{ price: number; binId: number }> {
  const res = await fetch(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}/active`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Active bin API ${res.status}`);
  const data = await res.json() as ActiveBin;
  if (!data.success) throw new Error(`Active bin error: ${data.error}`);
  return { price: Number(data.price), binId: data.bin_id };
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function walletExists(): boolean {
  return (
    fs.existsSync(WALLETS_FILE) ||
    fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json")) ||
    !!process.env.STACKS_PRIVATE_KEY
  );
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct env var
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  // 2. AIBTC wallets.json + keystore.json
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      log(`Wallet decrypt error: ${e.message}`);
    }
  }

  // 3. Legacy wallet.json
  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const mnemonic = w.mnemonic ?? w.encrypted_mnemonic ?? w.encryptedMnemonic;
      if (mnemonic) {
        const wallet = await generateWallet({ secretKey: mnemonic, password });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }

  throw new Error(
    "No wallet found or decryption failed.\n" +
    "Options:\n" +
    "  1. Run: npx @aibtc/mcp-server@latest --install\n" +
    "  2. Set STACKS_PRIVATE_KEY env var"
  );
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Balance API ${res.status}`);
  const data = await res.json() as any;
  return Number(BigInt(data.balance) - BigInt(data.locked)) / 1e6;
}

async function getSbtcBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/extended/v1/address/${address}/balances`, {
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Balance API ${res.status}`);
  const data = await res.json() as any;
  const tok = data?.fungible_tokens?.[SBTC_HIRO_KEY];
  if (!tok || tok.balance === undefined) return 0;
  return Number(BigInt(tok.balance)) / 1e8; // sBTC has 8 decimals
}

// ─── Event log (JSONL audit trail) ───────────────────────────────────────────

function appendEvent(event: Record<string, any>): void {
  try {
    ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    if (fs.existsSync(EVENTS_FILE)) {
      const sz = fs.statSync(EVENTS_FILE).size;
      if (sz + Buffer.byteLength(line) > EVENTS_MAX_BYTES) {
        const rotated = EVENTS_FILE + ".1";
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(EVENTS_FILE, rotated);
      }
    }
    fs.appendFileSync(EVENTS_FILE, line);
  } catch (e: any) {
    log(`Event log write failed: ${e.message}`);
  }
}

function readEvents(orderId?: number): any[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  const raw = fs.readFileSync(EVENTS_FILE, "utf-8").trim();
  if (!raw) return [];
  const events = raw.split("\n").map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) as any[];
  return orderId === undefined ? events : events.filter(e => e.orderId === orderId);
}

// ─── BitflowSDK helpers ──────────────────────────────────────────────────────

function createBitflowSDK(): any {
  const { BitflowSDK } = require("@bitflowlabs/core-sdk");
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    API_HOST: process.env.API_HOST || "https://api.bitflowapis.finance",
    STACKS_API_HOST: process.env.STACKS_API_HOST || STACKS_API,
    KEEPER_API_HOST: process.env.KEEPER_API_HOST || "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL || "https://api.bitflowapis.finance",
  });
}

async function findSdkToken(
  sdk: any,
  symbol: string
): Promise<{ tokenId: string; tokenDecimals: number; symbol: string } | null> {
  const tokens = await sdk.getAvailableTokens();
  const sym = symbol.toLowerCase();
  const match = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === sym ||
    (t.tokenId ?? "").toLowerCase() === sym ||
    (t["token-id"] ?? "").toLowerCase() === sym
  );
  if (!match) return null;
  return {
    tokenId: match.tokenId ?? match["token-id"],
    tokenDecimals: match.tokenDecimals ?? 6,
    symbol: match.symbol ?? symbol.toUpperCase(),
  };
}

// ─── Swap execution ──────────────────────────────────────────────────────────

async function executeSwap(opts: {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountHuman: number;
  senderAddress: string;
  stxPrivateKey: string;
  slippagePct: number;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string }> {
  const sdk = createBitflowSDK();

  // Resolve token IDs via SDK (not raw contract addresses)
  const tokenIn = await findSdkToken(sdk, opts.tokenInSymbol);
  if (!tokenIn) throw new Error(`Token not found in Bitflow SDK: ${opts.tokenInSymbol}`);
  const tokenOut = await findSdkToken(sdk, opts.tokenOutSymbol);
  if (!tokenOut) throw new Error(`Token not found in Bitflow SDK: ${opts.tokenOutSymbol}`);

  log(`Resolved tokens: ${tokenIn.symbol} (${tokenIn.tokenId}) → ${tokenOut.symbol} (${tokenOut.tokenId})`);

  const slippageDecimal = opts.slippagePct / 100;

  const quoteResult = await sdk.getQuoteForRoute(
    tokenIn.tokenId, tokenOut.tokenId, opts.amountHuman
  );
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(`No swap route for ${tokenIn.symbol} → ${tokenOut.symbol}`);
  }

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountHuman,
    tokenXDecimals: tokenIn.tokenDecimals,
    tokenYDecimals: tokenOut.tokenDecimals,
  };

  const swapParams = await sdk.prepareSwap(
    swapExecutionData,
    opts.senderAddress,
    slippageDecimal
  );

  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return { txId: fakeTxId, explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet` };
  }

  const {
    makeContractCall, broadcastTransaction,
    AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET,
    senderKey: opts.stxPrivateKey,
    anchorMode: AnchorMode.Any,
    fee: BigInt(TX_FEE_ESTIMATE),
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  }

  const txId: string = broadcastRes.txid;
  return { txId, explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet` };
}

// ─── Duration parser ──────────────────────────────────────────────────────────

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`Invalid duration: ${s}. Use format like 1h, 24h, 7d`);
  const n = parseInt(m[1]);
  const unit = m[2];
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  const maxMs = MAX_EXPIRY_DAYS * 86_400_000;
  if (ms > maxMs) throw new Error(`Max expiry is ${MAX_EXPIRY_DAYS}d`);
  if (ms < 60_000) throw new Error("Min expiry is 1m");
  return ms;
}

function parseInterval(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) throw new Error(`Invalid interval: ${s}. Use format like 5s, 30s, 1m, 5m`);
  const n = parseInt(m[1]);
  const ms = m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
  if (ms < MIN_INTERVAL_MS) throw new Error("Min watch interval is 1s");
  if (ms > MAX_INTERVAL_MS) throw new Error("Max watch interval is 1h");
  return ms;
}

// ─── Token ID resolver ────────────────────────────────────────────────────────

function resolveTokenIds(pool: PoolInfo, side: "buy" | "sell"): {
  tokenIn: string; tokenOut: string;
  tokenInDecimals: number; tokenOutDecimals: number;
} {
  // For HODLMM pools, price = token_y per token_x
  // buy  = buying token_x with token_y → tokenIn = token_y, tokenOut = token_x
  // sell = selling token_x for token_y → tokenIn = token_x, tokenOut = token_y
  if (side === "buy") {
    return {
      tokenIn: pool.token_y,
      tokenOut: pool.token_x,
      tokenInDecimals: getDecimals(pool.token_y),
      tokenOutDecimals: getDecimals(pool.token_x),
    };
  } else {
    return {
      tokenIn: pool.token_x,
      tokenOut: pool.token_y,
      tokenInDecimals: getDecimals(pool.token_x),
      tokenOutDecimals: getDecimals(pool.token_y),
    };
  }
}

function getDecimals(tokenId: string): number {
  // STX wrapped token
  if (tokenId.includes("token-stx")) return 6;
  // sBTC
  if (tokenId.includes("sbtc")) return 8;
  // USDC variants
  if (tokenId.toLowerCase().includes("usdc")) return 6;
  // USDh
  if (tokenId.toLowerCase().includes("usdh")) return 8;
  // Default for SIP-010 tokens
  return 6;
}

function isStxToken(tokenId: string): boolean {
  return tokenId.includes("token-stx");
}

function isSbtcToken(tokenId: string): boolean {
  return tokenId.includes("sbtc");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-limit-order")
  .description("Agent-powered limit orders on Bitflow — set price targets, auto-execute swaps");

// Redirect Commander output to stderr
program.configureOutput({
  writeOut: (str) => process.stderr.write(str),
  writeErr: (str) => process.stderr.write(str),
});

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Verify wallet, Bitflow API, and order storage health")
  .action(async () => {
    const checks: Record<string, { ok: boolean; message: string }> = {};

    // 1. Bitflow API
    try {
      const pools = await fetchPools();
      const dlmm = pools.filter(p => p.pool_id.startsWith("dlmm"));
      checks.bitflowApi = { ok: true, message: `Reachable — ${dlmm.length} DLMM pools available` };
    } catch (e: any) {
      checks.bitflowApi = { ok: false, message: `Unreachable: ${e.message}` };
    }

    // 2. Wallet
    try {
      if (walletExists()) {
        checks.wallet = { ok: true, message: "Wallet configuration found" };
      } else {
        checks.wallet = { ok: false, message: "No wallet found. Run: npx @aibtc/mcp-server@latest --install" };
      }
    } catch (e: any) {
      checks.wallet = { ok: false, message: e.message };
    }

    // 3. Order storage
    try {
      ensureDir();
      const book = loadOrderBook();
      const active = book.orders.filter(o => o.status === "active").length;
      checks.storage = { ok: true, message: `OK — ${book.orders.length} total orders, ${active} active` };
    } catch (e: any) {
      checks.storage = { ok: false, message: e.message };
    }

    // 4. Active bin check (STX-sBTC pool)
    try {
      const bin = await getActiveBinPrice("dlmm_6");
      checks.priceFeed = { ok: true, message: `STX-sBTC active bin #${bin.binId}, price: ${bin.price}` };
    } catch (e: any) {
      checks.priceFeed = { ok: false, message: `Price feed error: ${e.message}` };
    }

    const allOk = Object.values(checks).every(c => c.ok);
    success("doctor", { healthy: allOk, checks });
  });

// ── set ───────────────────────────────────────────────────────────────────────

program
  .command("set")
  .description("Create a new limit order")
  .requiredOption("--pair <pair>", "Trading pair (e.g., STX-sBTC)")
  .requiredOption("--side <side>", "buy or sell")
  .requiredOption("--price <price>", "Target price", parseFloat)
  .requiredOption("--amount <amount>", "Amount of input token", parseFloat)
  .option("--slippage <pct>", "Max slippage percent", parseFloat, DEFAULT_SLIPPAGE_PCT)
  .option("--expires <duration>", "Expiry duration (e.g., 1h, 24h, 7d)", DEFAULT_EXPIRY_HOURS + "h")
  .action(async (opts) => {
    try {
      // Validate side
      if (!["buy", "sell"].includes(opts.side)) {
        return fail("set", `Invalid side: ${opts.side}. Use 'buy' or 'sell'`);
      }

      // Validate slippage
      if (opts.slippage > MAX_SLIPPAGE_PCT) {
        return fail("set", `Slippage ${opts.slippage}% exceeds max ${MAX_SLIPPAGE_PCT}%`);
      }
      if (opts.slippage <= 0) {
        return fail("set", "Slippage must be positive");
      }

      // Validate price
      if (opts.price <= 0) {
        return fail("set", "Price must be positive");
      }

      // Validate amount
      if (opts.amount <= 0) {
        return fail("set", "Amount must be positive");
      }

      // Parse expiry
      let expiryMs: number;
      try {
        expiryMs = parseDuration(opts.expires);
      } catch (e: any) {
        return fail("set", e.message);
      }

      // Find pool
      log(`Looking up pool: ${opts.pair}`);
      const pool = await findPool(opts.pair);
      if (!pool) {
        return fail("set", `Pool ${opts.pair} not found. Check available pairs with doctor.`);
      }
      if (!pool.active) {
        return fail("set", `Pool ${opts.pair} is inactive`);
      }

      // Resolve tokens
      const tokens = resolveTokenIds(pool, opts.side);

      // Enforce max order size
      if (isStxToken(tokens.tokenIn) && opts.amount > MAX_ORDER_STX) {
        return fail("set", `Max order size is ${MAX_ORDER_STX} STX`);
      }
      if (isSbtcToken(tokens.tokenIn) && opts.amount > MAX_ORDER_SBTC) {
        return fail("set", `Max order size is ${MAX_ORDER_SBTC} sBTC`);
      }

      // Check active order limit
      const book = loadOrderBook();
      const activeCount = book.orders.filter(o => o.status === "active").length;
      if (activeCount >= MAX_ACTIVE_ORDERS) {
        return blocked("set", { activeOrders: activeCount }, `Max ${MAX_ACTIVE_ORDERS} active orders. Cancel some first.`);
      }

      // Create order
      const now = new Date();
      const order: LimitOrder = {
        orderId: book.nextId,
        pair: opts.pair,
        poolId: pool.pool_id,
        side: opts.side,
        targetPrice: opts.price,
        amount: opts.amount,
        slippage: opts.slippage,
        status: "active",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
        tokenIn: tokens.tokenIn,
        tokenOut: tokens.tokenOut,
        tokenInDecimals: tokens.tokenInDecimals,
        tokenOutDecimals: tokens.tokenOutDecimals,
      };

      book.orders.push(order);
      book.nextId++;
      saveOrderBook(book);

      success("set", {
        orderId: order.orderId,
        pair: order.pair,
        side: order.side,
        targetPrice: order.targetPrice,
        amount: order.amount,
        slippage: order.slippage,
        expires: order.expiresAt,
        tokenIn: order.tokenIn,
        tokenOut: order.tokenOut,
      });
    } catch (e: any) {
      fail("set", e.message);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("Show all orders with status, or read the event-log audit trail")
  .option("--status <status>", "Filter by status (active, filled, cancelled, expired, error)")
  .option("--events", "Read the JSONL event-log audit trail instead of orders")
  .option("--order-id <n>", "Filter events to a specific order ID (use with --events)", (v: string) => parseInt(v, 10))
  .action(async (opts) => {
    try {
      // Event-log read mode
      if (opts.events) {
        const events = readEvents(opts.orderId);
        return success("list-events", {
          source: EVENTS_FILE,
          orderIdFilter: opts.orderId ?? null,
          count: events.length,
          events,
        });
      }

      const book = loadOrderBook();
      let orders = book.orders;

      if (opts.status) {
        orders = orders.filter(o => o.status === opts.status);
      }

      const summary = {
        total: orders.length,
        active: orders.filter(o => o.status === "active").length,
        filled: orders.filter(o => o.status === "filled").length,
        cancelled: orders.filter(o => o.status === "cancelled").length,
        expired: orders.filter(o => o.status === "expired").length,
        errors: orders.filter(o => o.status === "error").length,
      };

      success("list", {
        summary,
        orders: orders.map(o => ({
          orderId: o.orderId,
          pair: o.pair,
          side: o.side,
          targetPrice: o.targetPrice,
          amount: o.amount,
          status: o.status,
          createdAt: o.createdAt,
          expiresAt: o.expiresAt,
          fillData: o.fillData ?? null,
          errorMessage: o.errorMessage ?? null,
          lastSkipReason: o.lastSkipReason ?? null,
          lastSkipAt: o.lastSkipAt ?? null,
        })),
      });
    } catch (e: any) {
      fail("list", e.message);
    }
  });

// ── cancel ────────────────────────────────────────────────────────────────────

program
  .command("cancel <id>")
  .description("Cancel a pending order by ID")
  .action(async (idStr: string) => {
    try {
      const id = parseInt(idStr);
      if (isNaN(id)) return fail("cancel", "Order ID must be a number");

      const book = loadOrderBook();
      const order = book.orders.find(o => o.orderId === id);
      if (!order) return fail("cancel", `Order #${id} not found`);
      if (order.status !== "active") {
        return fail("cancel", `Order #${id} is ${order.status}, cannot cancel`);
      }

      order.status = "cancelled";
      saveOrderBook(book);

      success("cancel", {
        orderId: id,
        pair: order.pair,
        side: order.side,
        targetPrice: order.targetPrice,
        amount: order.amount,
      });
    } catch (e: any) {
      fail("cancel", e.message);
    }
  });

// ── run / runCycle ────────────────────────────────────────────────────────────

interface CycleStats {
  checked: number;
  triggered: number;
  skipped: number;
  expired: number;
  errors: number;
  closest: { orderId: number; distance: string } | null;
}

interface CycleCtx {
  walletPassword: string;
  dryRun: boolean;
  useTicks: boolean;        // anti-wick gating active (watch mode only)
  confirmTicks: number;
  tickCounts: Map<number, number>;
  walletCache: { stxPrivateKey: string; stxAddress: string } | null;
  emitPerOrderJson: boolean; // true = one-shot; watch mode emits per-cycle summary instead
}

function recordSkip(book: OrderBook, order: LimitOrder, reason: string): void {
  log(`  → ${reason} — skipping cycle for order #${order.orderId}`);
  order.lastSkipReason = reason;
  order.lastSkipAt = new Date().toISOString();
  saveOrderBook(book);
  appendEvent({ orderId: order.orderId, event: "skipped", reason });
}

async function runCycle(ctx: CycleCtx): Promise<CycleStats> {
  const book = loadOrderBook();
  const now = new Date();

  // Phase 1: expire
  let expired = 0;
  for (const o of book.orders) {
    if (o.status === "active" && new Date(o.expiresAt) <= now) {
      o.status = "expired";
      expired++;
      appendEvent({ orderId: o.orderId, event: "expired" });
    }
  }
  if (expired > 0) {
    saveOrderBook(book);
    log(`Expired ${expired} order(s)`);
  }

  const active = book.orders.filter(o => o.status === "active");
  const stats: CycleStats = {
    checked: active.length, triggered: 0, skipped: 0, expired,
    errors: 0, closest: null,
  };
  if (active.length === 0) return stats;

  let walletFailedThisCycle = false;
  let closestDist = Infinity;

  for (const order of active) {
    try {
      log(`Checking #${order.orderId}: ${order.pair} ${order.side} @ ${order.targetPrice}`);
      const { price: currentPrice } = await getActiveBinPrice(order.poolId);
      const distPct = Math.abs(currentPrice - order.targetPrice) / order.targetPrice * 100;

      if (distPct < closestDist) {
        closestDist = distPct;
        stats.closest = { orderId: order.orderId, distance: `${distPct.toFixed(2)}%` };
      }

      const shouldTrigger =
        (order.side === "buy" && currentPrice <= order.targetPrice) ||
        (order.side === "sell" && currentPrice >= order.targetPrice);

      if (!shouldTrigger) {
        if (ctx.useTicks && ctx.tickCounts.has(order.orderId)) {
          ctx.tickCounts.delete(order.orderId);
          log(`  → #${order.orderId} no longer triggering, anti-wick counter reset`);
        }
        log(`  → Not triggered. Current: ${currentPrice}, Target: ${order.targetPrice}, Distance: ${distPct.toFixed(2)}%`);
        continue;
      }

      // Anti-wick gate (watch mode only)
      if (ctx.useTicks) {
        const next = (ctx.tickCounts.get(order.orderId) ?? 0) + 1;
        ctx.tickCounts.set(order.orderId, next);
        if (next < ctx.confirmTicks) {
          log(`  → #${order.orderId} pending anti-wick tick ${next}/${ctx.confirmTicks} (current ${currentPrice}, target ${order.targetPrice})`);
          appendEvent({
            orderId: order.orderId, event: "pending_trigger",
            tick: next, of: ctx.confirmTicks, current: currentPrice, target: order.targetPrice,
          });
          continue;
        }
      }

      log(`  → TRIGGERED #${order.orderId}: current ${currentPrice}, target ${order.targetPrice}`);
      appendEvent({ orderId: order.orderId, event: "triggered", current: currentPrice, target: order.targetPrice });

      // Wallet (lazy, cached for the rest of the process)
      if (!ctx.walletCache && !walletFailedThisCycle) {
        try {
          ctx.walletCache = await getWalletKeys(ctx.walletPassword);
          log(`Wallet resolved: ${ctx.walletCache.stxAddress}`);
        } catch (e: any) {
          walletFailedThisCycle = true;
          const reason = `Wallet unavailable: ${e.message}`;
          recordSkip(book, order, reason);
          appendEvent({ orderId: order.orderId, event: "error", stage: "wallet", detail: e.message });
          stats.skipped++;
          if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
          break; // no point checking more orders this cycle
        }
      }
      if (walletFailedThisCycle || !ctx.walletCache) break;
      const wallet = ctx.walletCache;

      // Balance checks — skip cycle on insufficient funds OR check failure
      try {
        if (isStxToken(order.tokenIn)) {
          const bal = await getStxBalance(wallet.stxAddress);
          const needed = order.amount + STX_FEE_RESERVE;
          if (bal < needed) {
            recordSkip(book, order, `Insufficient STX: have ${bal.toFixed(6)}, need ${needed.toFixed(6)}`);
            stats.skipped++; if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
            continue;
          }
        } else if (isSbtcToken(order.tokenIn)) {
          const sbtc = await getSbtcBalance(wallet.stxAddress);
          if (sbtc < order.amount) {
            recordSkip(book, order, `Insufficient sBTC: have ${sbtc.toFixed(8)}, need ${order.amount.toFixed(8)}`);
            stats.skipped++; if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
            continue;
          }
          // sBTC swap still needs STX for tx fee
          const stx = await getStxBalance(wallet.stxAddress);
          if (stx < STX_FEE_RESERVE) {
            recordSkip(book, order, `Insufficient STX for tx fee: have ${stx.toFixed(6)}, need ${STX_FEE_RESERVE.toFixed(6)}`);
            stats.skipped++; if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
            continue;
          }
        }
      } catch (e: any) {
        recordSkip(book, order, `Balance check failed: ${e.message}`);
        stats.skipped++; if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
        continue;
      }

      // Execute
      try {
        const parts = order.pair.split("-");
        const tokenInSymbol = order.side === "sell" ? parts[0] : parts[1];
        const tokenOutSymbol = order.side === "sell" ? parts[1] : parts[0];

        const result = await executeSwap({
          tokenInSymbol, tokenOutSymbol,
          amountHuman: order.amount,
          senderAddress: wallet.stxAddress,
          stxPrivateKey: wallet.stxPrivateKey,
          slippagePct: order.slippage,
          dryRun: ctx.dryRun,
        });

        order.status = "filled";
        delete order.lastSkipReason;
        delete order.lastSkipAt;
        order.fillData = {
          txId: result.txId,
          fillPrice: currentPrice,
          filledAt: new Date().toISOString(),
          explorerUrl: result.explorerUrl,
        };
        saveOrderBook(book);
        if (ctx.useTicks) ctx.tickCounts.delete(order.orderId);
        appendEvent({
          orderId: order.orderId, event: "filled",
          txid: result.txId, amount: order.amount,
          fillPrice: currentPrice, target: order.targetPrice, dryRun: ctx.dryRun,
        });
        stats.triggered++;

        if (ctx.emitPerOrderJson) {
          success("execute", {
            orderId: order.orderId, pair: order.pair, side: order.side,
            fillPrice: currentPrice, targetPrice: order.targetPrice,
            amount: order.amount, txId: result.txId,
            explorerUrl: result.explorerUrl, dryRun: ctx.dryRun,
          });
        }
        break; // one fill per cycle
      } catch (e: any) {
        order.status = "error";
        order.errorMessage = `Swap failed: ${e.message}`;
        saveOrderBook(book);
        appendEvent({ orderId: order.orderId, event: "error", stage: "swap", detail: e.message });
        stats.errors++;
        if (ctx.emitPerOrderJson) {
          fail("execute", `Order #${order.orderId} swap failed: ${e.message}`);
        }
        continue;
      }
    } catch (e: any) {
      log(`  → Error checking #${order.orderId}: ${e.message}`);
      appendEvent({ orderId: order.orderId, event: "error", stage: "check", detail: e.message });
      stats.errors++;
      continue;
    }
  }

  return stats;
}

program
  .command("run")
  .description("Check active orders against pool prices, execute triggers (one-shot or --watch loop)")
  .option("--confirm", "Execute swaps on-chain (without this flag, dry-run only)")
  .option("--watch <interval>", "Run as in-process heartbeat loop (e.g., 5s, 30s, 1m, 5m). Without this flag, runs once and exits.")
  .option("--confirm-ticks <n>", `Anti-wick: require N consecutive triggering cycles before firing (default ${DEFAULT_CONFIRM_TICKS}, watch-mode only)`, (v) => parseInt(v, 10), DEFAULT_CONFIRM_TICKS)
  .option("--wallet-password <pw>", "Wallet password for keystore decryption (or set AIBTC_WALLET_PASSWORD)")
  .action(async (opts) => {
    try {
      const dryRun = !opts.confirm;
      const watchMs = opts.watch ? parseInterval(opts.watch) : null;
      const useTicks = watchMs !== null;
      const confirmTicks = Math.max(1, Number(opts.confirmTicks) || DEFAULT_CONFIRM_TICKS);

      const ctx: CycleCtx = {
        walletPassword: opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "",
        dryRun, useTicks, confirmTicks,
        tickCounts: new Map(),
        walletCache: null,
        emitPerOrderJson: !watchMs,
      };

      // ── One-shot ──
      if (!watchMs) {
        const stats = await runCycle(ctx);
        if (stats.triggered === 0) {
          success("check", { ...stats, dryRun });
        }
        return;
      }

      // ── Watch loop ──
      const startedAt = new Date().toISOString();
      let cycles = 0, totalFilled = 0, totalSkipped = 0, totalErrors = 0;
      let stopping = false;

      const printSummary = (action: string) => {
        output("success", action, {
          startedAt, endedAt: new Date().toISOString(),
          cycles, filled: totalFilled, skipped: totalSkipped, errors: totalErrors,
          dryRun, intervalMs: watchMs, confirmTicks,
        });
      };

      const onSig = (sig: string) => {
        if (stopping) return;
        stopping = true;
        log(`${sig} received, stopping watch after current cycle`);
      };
      process.on("SIGINT", () => onSig("SIGINT"));
      process.on("SIGTERM", () => onSig("SIGTERM"));

      log(`Watch mode: every ${opts.watch} (${watchMs}ms), confirm-ticks=${confirmTicks}, dryRun=${dryRun}`);
      appendEvent({ event: "watch_started", intervalMs: watchMs, confirmTicks, dryRun });

      while (!stopping) {
        cycles++;
        const cycleStartedAt = new Date().toISOString();
        try {
          const stats = await runCycle(ctx);
          totalFilled += stats.triggered;
          totalSkipped += stats.skipped;
          totalErrors += stats.errors;
          output("success", "watch-cycle", {
            cycle: cycles, cycleStartedAt, ...stats, dryRun,
          });
        } catch (e: any) {
          totalErrors++;
          output("error", "watch-cycle", { cycle: cycles, cycleStartedAt }, e.message);
        }
        if (stopping) break;
        // Sleep in short chunks so SIGINT exits promptly
        const sleepUntil = Date.now() + watchMs;
        while (!stopping && Date.now() < sleepUntil) {
          await new Promise(r => setTimeout(r, Math.min(250, sleepUntil - Date.now())));
        }
      }

      appendEvent({ event: "watch_stopped", cycles, filled: totalFilled, errors: totalErrors });
      printSummary("watch-summary");
      process.exit(0);
    } catch (e: any) {
      fail("run", e.message);
    }
  });

// ── install-packs ─────────────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install required npm dependencies")
  .action(async () => {
    const { execSync } = await import("child_process" as any);
    const deps = [
      "commander",
      "@bitflowlabs/core-sdk",
      "@stacks/transactions",
      "@stacks/network",
      "@stacks/wallet-sdk",
      "@stacks/encryption",
    ];
    try {
      log(`Installing: ${deps.join(", ")}`);
      execSync(`bun add ${deps.join(" ")}`, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: path.resolve(__dirname),
      });
      success("install-packs", { installed: deps });
    } catch (e: any) {
      fail("install-packs", `Install failed: ${e.message}`);
    }
  });

// ── Parse & run ───────────────────────────────────────────────────────────────

program.parse(process.argv);
