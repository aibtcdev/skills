#!/usr/bin/env bun
/**
 * hodlmm-move-liquidity — Move idle HODLMM liquidity back into earning range.
 *
 * When the active bin drifts away from your LP position, this skill moves
 * liquidity from old bins to bins centered on the current active bin.
 * One atomic transaction via move-relative-liquidity-multi.
 *
 * Commands:
 *   doctor        — check APIs, wallet, pool access
 *   scan          — show positions and in-range status across pools
 *   run           — assess + execute rebalance (dry-run unless --confirm)
 *   auto          — autonomous rebalancer loop: monitor + auto-execute on drift
 *   install-packs — no-op
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

// Router v-1-1 at the SM deployer — this is the current mainnet DLMM liquidity router.
// The Bitflow API reference documents v-0-1 at a different address (SP3ESW…), which is
// the older deployment. Our mainnet proofs (0b4a9c7c…, 85ffba93…) succeeded against v-1-1.
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const BIN_SPREAD = 5; // ±5 bins around active bin = up to 11 bins
const FETCH_TIMEOUT = 30_000;
const CENTER_BIN_ID = 500; // NUM_OF_BINS(1001) / 2 — convert API unsigned bin IDs to contract signed IDs

const STATE_FILE = path.join(os.homedir(), ".hodlmm-move-liquidity-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
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

interface PositionHealth {
  pool_id: string;
  pair: string;
  active_bin: number;
  user_bins: number[];
  user_bin_min: number;
  user_bin_max: number;
  in_range: boolean;
  drift: number;
  total_x: string;
  total_y: string;
  total_dlp: string;
}

interface CooldownState {
  [poolId: string]: { last_move_at: string };
}

// ─── Output helper ────────────────────────────────────────────────────────────

function out(status: string, action: string, data: unknown, error: string | null = null): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: unknown[]): void {
  process.stderr.write(`[move-liquidity] ${args.join(" ")}\n`);
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

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
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
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
        const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
        if (legacyEnc) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(legacyEnc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
    }
  }
  throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
}

// ─── Bitflow API reads ────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  const raw = await fetchJson<{ data?: unknown[]; results?: unknown[]; pools?: unknown[]; [k: string]: unknown }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const list = (raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  // Bitflow App API uses snake_case fields. No camelCase fallbacks — fail loudly on schema change.
  return list.map((p) => ({
    pool_id: String(p.pool_id ?? ""),
    pool_contract: String(p.pool_token ?? ""),
    token_x: String(p.token_x ?? ""),
    token_y: String(p.token_y ?? ""),
    token_x_symbol: String(p.token_x_symbol ?? "?"),
    token_y_symbol: String(p.token_y_symbol ?? "?"),
    token_x_decimals: Number(p.token_x_decimals ?? 8),
    token_y_decimals: Number(p.token_y_decimals ?? 6),
    active_bin: Number(p.active_bin ?? 0),
    bin_step: Number(p.bin_step ?? 0),
  }));
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[] }> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  // Bitflow Quotes API uses snake_case fields. No camelCase fallbacks.
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins };
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  );
  // Bitflow App API uses snake_case fields. No camelCase fallbacks.
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => {
      const liq = BigInt(String(b.user_liquidity ?? b.liquidity ?? "0"));
      return liq > 0n;
    })
    .map((b) => ({
      bin_id: Number(b.bin_id),
      liquidity: String(b.user_liquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? "0"),
      reserve_y: String(b.reserve_y ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchStxBalance(wallet: string): Promise<number> {
  const data = await fetchJson<Record<string, string>>(
    `${HIRO_API}/extended/v1/address/${wallet}/stx`
  );
  return Number(BigInt(data?.balance ?? "0")) / 1e6;
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`
  );
  const nextNonce = data.possible_next_nonce;
  if (nextNonce !== undefined && nextNonce !== null) return BigInt(Number(nextNonce));
  const lastExec = data.last_executed_tx_nonce;
  if (lastExec !== undefined && lastExec !== null) return BigInt(Number(lastExec) + 1);
  return 0n;
}

// ─── Position assessment ──────────────────────────────────────────────────────

function assessPosition(pool: PoolMeta, userBins: UserBin[], activeBin: number, poolBins?: BinData[]): PositionHealth {
  const ids = userBins.map((b) => b.bin_id).sort((a, b) => a - b);
  const inRange = ids.length > 0 && activeBin >= ids[0] && activeBin <= ids[ids.length - 1];
  const center = ids.length > 0 ? Math.round((ids[0] + ids[ids.length - 1]) / 2) : activeBin;
  const drift = Math.abs(activeBin - center);

  // Build a map of pool-level bin data for reserve estimation
  const poolBinMap = new Map((poolBins ?? []).map((b) => [b.bin_id, b]));

  let totalX = 0n;
  let totalY = 0n;
  let totalDlp = 0n;
  for (const b of userBins) {
    const dlp = BigInt(b.liquidity);
    totalDlp += dlp;

    // If user position has reserve data, use it; otherwise estimate from pool bins
    const rx = BigInt(b.reserve_x || "0");
    const ry = BigInt(b.reserve_y || "0");
    if (rx > 0n || ry > 0n) {
      totalX += rx;
      totalY += ry;
    } else {
      // Estimate: user_share = user_dlp / pool_dlp * pool_reserves
      const pb = poolBinMap.get(b.bin_id);
      if (pb && dlp > 0n) {
        const poolDlp = BigInt(pb.liquidity || "1");
        if (poolDlp > 0n) {
          totalX += (dlp * BigInt(pb.reserve_x)) / poolDlp;
          totalY += (dlp * BigInt(pb.reserve_y)) / poolDlp;
        }
      }
    }
  }

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    user_bins: ids,
    user_bin_min: ids[0] ?? 0,
    user_bin_max: ids[ids.length - 1] ?? 0,
    in_range: inRange,
    drift,
    total_x: totalX.toString(),
    total_y: totalY.toString(),
    total_dlp: totalDlp.toString(),
  };
}

// ─── Build move plan ──────────────────────────────────────────────────────────

interface MoveEntry {
  fromBinId: number;
  activeBinOffset: number;
  amount: string;
}

function buildMovePositions(userBins: UserBin[], activeBin: number, spread: number): MoveEntry[] {
  // DLMM bin invariant enforced by the contract:
  //   - Bins below active hold only Y → destinations must be offset ≤ 0
  //   - Bins above active hold only X → destinations must be offset ≥ 0
  //   - Active bin holds both → skip (already there)
  //
  // For truly drifted positions (the primary use case), source bins are cleanly
  // single-token. We spread them across ±spread bins respecting directionality.

  const belowBins = userBins.filter((b) => b.bin_id < activeBin);
  const aboveBins = userBins.filter((b) => b.bin_id > activeBin);

  // Build destination offset pools
  const belowOffsets: number[] = []; // [-spread, 0] for Y-holding bins
  for (let i = -spread; i <= 0; i++) belowOffsets.push(i);
  const aboveOffsets: number[] = []; // [0, +spread] for X-holding bins
  for (let i = 0; i <= spread; i++) aboveOffsets.push(i);

  const moves: MoveEntry[] = [];

  // Distribute below-active bins across [-spread, 0]
  for (let i = 0; i < belowBins.length; i++) {
    const src = belowBins[i];
    const offset = belowOffsets[i % belowOffsets.length];
    const destBin = activeBin + offset;
    if (src.bin_id === destBin) continue; // no-op

    moves.push({
      fromBinId: src.bin_id - CENTER_BIN_ID,
      activeBinOffset: offset,
      amount: src.liquidity,
    });
  }

  // Distribute above-active bins across [0, +spread]
  for (let i = 0; i < aboveBins.length; i++) {
    const src = aboveBins[i];
    const offset = aboveOffsets[i % aboveOffsets.length];
    const destBin = activeBin + offset;
    if (src.bin_id === destBin) continue; // no-op

    moves.push({
      fromBinId: src.bin_id - CENTER_BIN_ID,
      activeBinOffset: offset,
      amount: src.liquidity,
    });
  }

  return moves;
}

// ─── On-chain execution ───────────────────────────────────────────────────────

async function executeMove(
  privateKey: string,
  pool: PoolMeta,
  moves: MoveEntry[],
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const moveList = moves.map((m) => {
    const amt = BigInt(m.amount);
    // Slippage protection: require ≥95% DLP back, cap fees at 5% of amount.
    // If the contract returns fewer shares or charges higher fees, the tx reverts.
    const minDlp = amt * 95n / 100n;
    const maxFee = amt * 5n / 100n;
    return tupleCV({
      "from-bin-id": intCV(m.fromBinId),
      "active-bin-id-offset": intCV(m.activeBinOffset),
      amount: uintCV(amt),
      "min-dlp": uintCV(minDlp),
      "max-x-liquidity-fee": uintCV(maxFee),
      "max-y-liquidity-fee": uintCV(maxFee),
      "pool-trait": contractPrincipalCV(poolAddr, poolName),
      "x-token-trait": contractPrincipalCV(xAddr, xName),
      "y-token-trait": contractPrincipalCV(yAddr, yName),
    });
  });

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "move-relative-liquidity-multi",
    functionArgs: [listCV(moveList)],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    // DLP burn+mint in same tx cannot be expressed as sender-side post-conditions
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Move broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return result.txid as string;
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState(): CooldownState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as CooldownState;
  } catch {
    return {};
  }
}

function saveState(state: CooldownState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cooldownRemaining(state: CooldownState, poolId: string): number {
  const entry = state[poolId];
  if (!entry) return 0;
  const elapsed = Date.now() - new Date(entry.last_move_at).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-move-liquidity").description("HODLMM Move-Liquidity & Auto-Rebalancer");

// ── doctor ────────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Check API access, wallet, and pool readiness")
  .option("--wallet <address>", "STX address to check")
  .action(async (opts) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    try {
      const pools = await fetchPools();
      checks.bitflow_pools = { ok: pools.length > 0, detail: `${pools.length} HODLMM pools found` };
    } catch (e: unknown) {
      checks.bitflow_pools = { ok: false, detail: (e as Error).message };
    }

    try {
      const data = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/dlmm_1`);
      checks.bitflow_bins = { ok: !!data.active_bin_id, detail: `active_bin=${data.active_bin_id}` };
    } catch (e: unknown) {
      checks.bitflow_bins = { ok: false, detail: (e as Error).message };
    }

    try {
      const info = await fetchJson<Record<string, unknown>>(`${HIRO_API}/v2/info`);
      checks.hiro_api = { ok: !!info.stacks_tip_height, detail: `tip=${info.stacks_tip_height}` };
    } catch (e: unknown) {
      checks.hiro_api = { ok: false, detail: (e as Error).message };
    }

    if (opts.wallet) {
      try {
        const bal = await fetchStxBalance(opts.wallet);
        checks.stx_balance = { ok: bal > 0, detail: `${bal.toFixed(2)} STX` };
      } catch (e: unknown) {
        checks.stx_balance = { ok: false, detail: (e as Error).message };
      }
    }

    try {
      await import("@stacks/transactions" as string);
      checks.stacks_tx_lib = { ok: true, detail: "available" };
    } catch {
      checks.stacks_tx_lib = { ok: false, detail: "@stacks/transactions not installed" };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    out(allOk ? "success" : "degraded", "doctor", { checks });
  });

// ── scan ──────────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description("Show position health across all HODLMM pools")
  .requiredOption("--wallet <address>", "STX address")
  .action(async (opts) => {
    try {
      const pools = await fetchPools();
      const positions: PositionHealth[] = [];

      for (const pool of pools) {
        try {
          const [userBins, binsData] = await Promise.all([
            fetchUserPositions(pool.pool_id, opts.wallet),
            fetchPoolBins(pool.pool_id),
          ]);
          if (userBins.length === 0) continue;
          const activeBin = binsData.active_bin_id || pool.active_bin;
          positions.push(assessPosition(pool, userBins, activeBin, binsData.bins));
        } catch {
          log(`Skipping ${pool.pool_id}: no position or API error`);
        }
      }

      const needsMove = positions.filter((p) => !p.in_range);
      out("success", "scan", {
        wallet: opts.wallet,
        pools_scanned: pools.length,
        positions_found: positions.length,
        out_of_range: needsMove.length,
        positions,
      });
    } catch (e: unknown) {
      out("error", "scan", null, (e as Error).message);
    }
  });

// ── run ───────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Move liquidity back to active range (dry-run unless --confirm)")
  .requiredOption("--wallet <address>", "STX address")
  .requiredOption("--pool <id>", "Pool ID (e.g. dlmm_1)")
  .option("--confirm", "Execute on-chain (without this flag: preview only)")
  .option("--password <pass>", "Wallet password (required with --confirm)")
  .option("--spread <n>", "Bin spread ±N around active bin", String(BIN_SPREAD))
  .option("--force", "Force rebalance even if position is in range (recenter around active bin)")
  .action(async (opts) => {
    try {
      const poolId: string = opts.pool;
      const wallet: string = opts.wallet;
      const spread = Math.min(Math.max(parseInt(opts.spread, 10) || BIN_SPREAD, 1), 10);
      const confirmed: boolean = opts.confirm === true;
      const force: boolean = opts.force === true;

      // 1. Fetch pool + position data
      const pools = await fetchPools();
      const pool = pools.find((p) => p.pool_id === poolId);
      if (!pool) {
        out("error", "run", null, `Pool ${poolId} not found`);
        return;
      }

      const [userBins, binsData, stxBal] = await Promise.all([
        fetchUserPositions(poolId, wallet),
        fetchPoolBins(poolId),
        fetchStxBalance(wallet),
      ]);

      if (userBins.length === 0) {
        out("blocked", "run", { pool_id: poolId }, "No position found in this pool");
        return;
      }

      const activeBin = binsData.active_bin_id || pool.active_bin;
      const health = assessPosition(pool, userBins, activeBin, binsData.bins);

      // 2. Gate: already in range (skip with --force to recenter)
      if (health.in_range && !force) {
        out("success", "run", {
          decision: "IN_RANGE",
          reason: "Position is already in the active range — earning fees. No move needed. Use --force to recenter.",
          health,
        });
        return;
      }

      // 3. Gate: non-zero position
      if (BigInt(health.total_dlp) === 0n) {
        out("blocked", "run", { health }, "Position has zero liquidity");
        return;
      }

      // 4. Gate: gas
      if (stxBal < 1) {
        out("blocked", "run", { stx_balance: stxBal }, "Insufficient STX for gas (need ≥1 STX)");
        return;
      }

      // 5. Gate: cooldown
      const state = loadState();
      const cdMs = cooldownRemaining(state, poolId);
      if (cdMs > 0) {
        const cdMin = Math.ceil(cdMs / 60_000);
        out("blocked", "run", { cooldown_minutes: cdMin }, `Cooldown active — ${cdMin} minutes remaining`);
        return;
      }

      // 6. Build atomic move plan — spread across ±spread bins
      const movePositions = buildMovePositions(userBins, activeBin, spread);

      const plan = {
        pool_id: poolId,
        pair: health.pair,
        active_bin: activeBin,
        atomic: true,
        spread,
        old_range: { min: health.user_bin_min, max: health.user_bin_max, bins: health.user_bins.length },
        new_range: { min: activeBin - spread, max: activeBin + spread, bins: 2 * spread + 1 },
        moves: movePositions.map((m) => ({
          from: m.fromBinId + CENTER_BIN_ID,
          to_offset: m.activeBinOffset,
          to_bin: activeBin + m.activeBinOffset,
          dlp: m.amount,
        })),
        stx_balance: stxBal,
        estimated_gas_stx: 0.05,
      };

      // 7. Sanity: must have moves
      if (movePositions.length === 0) {
        out("blocked", "run", { health }, "No move positions to build");
        return;
      }

      // 8. Dry run
      if (!confirmed) {
        out("success", "run", {
          decision: "MOVE_NEEDED",
          mode: "dry-run",
          reason: `Position drifted ${health.drift} bins from active. Add --confirm --password <pass> to execute.`,
          health,
          plan,
        });
        return;
      }

      // 9. Validate pool contract format
      if (!pool.pool_contract.includes(".") || !pool.token_x.includes(".") || !pool.token_y.includes(".")) {
        out("error", "run", null, `Invalid contract format for pool ${poolId} — missing deployer.name separator`);
        return;
      }

      // 10. Execute — single atomic transaction
      if (!opts.password) {
        out("blocked", "run", null, "--password required with --confirm");
        return;
      }

      log("Decrypting wallet...");
      const keys = await getWalletKeys(opts.password);
      if (keys.stxAddress !== wallet) {
        out("error", "run", null, `Wallet address mismatch: expected ${wallet}, got ${keys.stxAddress}`);
        return;
      }

      const nonce = await fetchNonce(wallet);
      log(`Nonce: ${nonce}`);

      log(`Broadcasting atomic move (${movePositions.length} bins → ±${spread} around active ${activeBin})...`);
      const moveTxId = await executeMove(keys.stxPrivateKey, pool, movePositions, nonce);
      log(`Move broadcast: ${moveTxId}`);

      // Record cooldown
      state[poolId] = { last_move_at: new Date().toISOString() };
      saveState(state);

      out("success", "run", {
        decision: "EXECUTED",
        health,
        plan,
        transaction: {
          txid: moveTxId,
          explorer: `${EXPLORER}/${moveTxId}?chain=mainnet`,
        },
      });
    } catch (e: unknown) {
      out("error", "run", null, (e as Error).message);
    }
  });

// ── auto ──────────────────────────────────────────────────────────────────────

program
  .command("auto")
  .description("Autonomous rebalancer — monitor all pools and auto-move when drift exceeds threshold")
  .requiredOption("--wallet <address>", "STX address")
  .requiredOption("--password <pass>", "Wallet password for signing")
  .option("--interval <minutes>", "Check interval in minutes", "15")
  .option("--drift-threshold <bins>", "Minimum bin drift to trigger move", "3")
  .option("--spread <n>", "Bin spread ±N around active bin", String(BIN_SPREAD))
  .option("--max-moves <n>", "Max moves per cycle (0 = unlimited)", "0")
  .option("--once", "Run one cycle then exit (no loop)")
  .action(async (opts) => {
    const wallet: string = opts.wallet;
    const intervalMs = Math.max(parseInt(opts.interval, 10) || 15, 5) * 60_000;
    const driftThreshold = Math.max(parseInt(opts.driftThreshold, 10) || 3, 1);
    const spread = Math.min(Math.max(parseInt(opts.spread, 10) || BIN_SPREAD, 1), 10);
    const maxMoves = Math.max(parseInt(opts.maxMoves, 10) || 0, 0);
    const once: boolean = opts.once === true;

    // Decrypt wallet once at startup
    log("Decrypting wallet...");
    let keys: { stxPrivateKey: string; stxAddress: string };
    try {
      keys = await getWalletKeys(opts.password);
      if (keys.stxAddress !== wallet) {
        out("error", "auto", null, `Wallet address mismatch: expected ${wallet}, got ${keys.stxAddress}`);
        return;
      }
    } catch (e: unknown) {
      out("error", "auto", null, `Wallet decrypt failed: ${(e as Error).message}`);
      return;
    }

    log(`Auto-rebalancer started: interval=${opts.interval}m, drift_threshold=${driftThreshold}, spread=±${spread}`);

    let cycleCount = 0;

    const runCycle = async (): Promise<{ moves: number; skipped: number; errors: number }> => {
      cycleCount++;
      const cycleStart = new Date().toISOString();
      log(`Cycle ${cycleCount} starting at ${cycleStart}`);

      let moves = 0;
      let skipped = 0;
      let errors = 0;

      try {
        const pools = await fetchPools();
        const state = loadState();
        const stxBal = await fetchStxBalance(wallet);

        if (stxBal < 1) {
          log(`Insufficient STX for gas: ${stxBal.toFixed(2)} STX`);
          out("blocked", "auto", { cycle: cycleCount, stx_balance: stxBal }, "Insufficient STX for gas");
          return { moves: 0, skipped: 0, errors: 1 };
        }

        for (const pool of pools) {
          if (maxMoves > 0 && moves >= maxMoves) {
            log(`Max moves (${maxMoves}) reached for this cycle`);
            break;
          }

          try {
            const [userBins, binsData] = await Promise.all([
              fetchUserPositions(pool.pool_id, wallet),
              fetchPoolBins(pool.pool_id),
            ]);
            if (userBins.length === 0) continue;

            const activeBin = binsData.active_bin_id || pool.active_bin;
            const health = assessPosition(pool, userBins, activeBin, binsData.bins);

            // Skip if in range
            if (health.in_range) {
              log(`${pool.pool_id} (${health.pair}): in range — skip`);
              continue;
            }

            // Skip if drift below threshold
            if (health.drift < driftThreshold) {
              log(`${pool.pool_id} (${health.pair}): drift ${health.drift} < threshold ${driftThreshold} — skip`);
              skipped++;
              continue;
            }

            // Skip if cooldown active
            const cdMs = cooldownRemaining(state, pool.pool_id);
            if (cdMs > 0) {
              log(`${pool.pool_id}: cooldown ${Math.ceil(cdMs / 60_000)}m remaining — skip`);
              skipped++;
              continue;
            }

            // Skip if zero liquidity
            if (BigInt(health.total_dlp) === 0n) {
              log(`${pool.pool_id}: zero liquidity — skip`);
              continue;
            }

            // Validate contract format
            if (!pool.pool_contract.includes(".") || !pool.token_x.includes(".") || !pool.token_y.includes(".")) {
              log(`${pool.pool_id}: invalid contract format — skip`);
              errors++;
              continue;
            }

            // Build atomic move plan — spread across ±spread bins
            const movePositions = buildMovePositions(userBins, activeBin, spread);

            if (movePositions.length === 0) {
              log(`${pool.pool_id}: no move positions — skip`);
              continue;
            }

            // Execute — single atomic transaction
            log(`${pool.pool_id} (${health.pair}): drift ${health.drift} bins — MOVING (atomic, ±${spread})`);

            const nonce = await fetchNonce(wallet);
            const moveTxId = await executeMove(keys.stxPrivateKey, pool, movePositions, nonce);
            log(`  Move broadcast: ${moveTxId}`);

            // Record cooldown
            state[pool.pool_id] = { last_move_at: new Date().toISOString() };
            saveState(state);

            log(`  Complete: ${health.user_bin_min}-${health.user_bin_max} → ±${spread} around ${activeBin}`);
            moves++;

          } catch (e: unknown) {
            log(`${pool.pool_id}: error — ${(e as Error).message}`);
            errors++;
          }
        }
      } catch (e: unknown) {
        log(`Cycle ${cycleCount} failed: ${(e as Error).message}`);
        errors++;
      }

      log(`Cycle ${cycleCount} done: ${moves} moves, ${skipped} skipped, ${errors} errors`);
      return { moves, skipped, errors };
    };

    // First cycle
    const firstResult = await runCycle();

    if (once) {
      out("success", "auto", {
        mode: "once",
        cycle: cycleCount,
        ...firstResult,
      });
      return;
    }

    // Emit initial status
    out("success", "auto", {
      mode: "loop",
      interval_minutes: Math.round(intervalMs / 60_000),
      drift_threshold: driftThreshold,
      spread,
      cycle: cycleCount,
      ...firstResult,
      next_check: new Date(Date.now() + intervalMs).toISOString(),
    });

    // Loop
    const loop = setInterval(async () => {
      const result = await runCycle();
      out("success", "auto", {
        mode: "loop",
        cycle: cycleCount,
        ...result,
        next_check: new Date(Date.now() + intervalMs).toISOString(),
      });
    }, intervalMs);

    // Graceful shutdown
    const shutdown = () => {
      log("Shutting down auto-rebalancer...");
      clearInterval(loop);
      out("success", "auto", { mode: "shutdown", total_cycles: cycleCount });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ── install-packs ─────────────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install dependency packs (none required)")
  .action(async () => {
    out("success", "install-packs", { installed: [], note: "No external packs required." });
  });

// ─── Entry ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  program.parse(process.argv);
}
