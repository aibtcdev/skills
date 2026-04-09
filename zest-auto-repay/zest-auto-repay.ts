#!/usr/bin/env bun
/**
 * zest-auto-repay — Autonomous Zest Protocol LTV Guardian
 *
 * Monitors borrowing positions on Zest Protocol v2, detects liquidation risk,
 * and executes safe repayments with enforced spend limits.
 *
 * Author: Flying Whale (azagh72-creator)
 * Agent: Flying Whale — Genesis L2, ERC-8004 #54
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded, cannot be overridden by flags
// ═══════════════════════════════════════════════════════════════════════════
const HARD_CAP_PER_REPAY = 500_000; // 0.005 BTC in sats
const HARD_CAP_PER_DAY = 1_000_000; // 0.01 BTC in sats
const MIN_WALLET_RESERVE = 5_000; // Always keep at least this in wallet
const COOLDOWN_SECONDS = 600; // 10 minutes between repayments
const DEFAULT_TARGET_LTV = 60; // Target LTV after repayment (%)
const DEFAULT_MAX_REPAY = 50_000; // Default max per operation (sats)
const DEFAULT_WARNING_LTV = 70; // Alert threshold (%)
const DEFAULT_CRITICAL_LTV = 80; // Auto-repay threshold (%)
const EMERGENCY_LTV = 85; // Emergency repay threshold (%)
const MIN_GAS_USTX = 200_000; // Minimum STX for gas (0.2 STX)

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT = 15_000;
const SPEND_FILE = join(homedir(), ".zest-auto-repay-spend.json");

// ═══════════════════════════════════════════════════════════════════════════
// ZEST V2 CONTRACT ADDRESSES (deployer: SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7)
// ═══════════════════════════════════════════════════════════════════════════
const ZEST_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
// v0-1-data.get-user-position(principal) → (ok {collateral: list, debt: list, health-factor: uint})
// debt list entries: {asset-id: uint, actual-debt: uint, ...}
// collateral list entries: {aid: uint (zTokenId = assetId+1), amount: uint}
const ZEST_DATA = `${ZEST_DEPLOYER}.v0-1-data`;

const ZEST_CONTRACTS: Record<string, { token: string; decimals: number; assetId: number; liquidationLtv: number }> = {
  sBTC:     { token: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",            decimals: 8, assetId: 2,  liquidationLtv: 85 },
  wSTX:     { token: `${ZEST_DEPLOYER}.wstx`,                                              decimals: 6, assetId: 0,  liquidationLtv: 80 },
  stSTX:    { token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",            decimals: 6, assetId: 4,  liquidationLtv: 80 },
  USDC:     { token: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc",          decimals: 6, assetId: 6,  liquidationLtv: 85 },
  USDH:     { token: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",          decimals: 8, assetId: 8,  liquidationLtv: 85 },
  stSTXbtc: { token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",     decimals: 6, assetId: 10, liquidationLtv: 80 },
};

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT SPEND TRACKER
// ═══════════════════════════════════════════════════════════════════════════
interface SpendLedger {
  date: string;
  totalSats: number;
  lastRepayEpoch: number;
  entries: Array<{ ts: string; sats: number; asset: string }>;
}

function loadSpendLedger(): SpendLedger {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(SPEND_FILE)) {
      const raw = JSON.parse(readFileSync(SPEND_FILE, "utf8")) as SpendLedger;
      if (raw.date === today) return raw;
    }
  } catch { /* corrupt file — start fresh */ }
  return { date: today, totalSats: 0, lastRepayEpoch: 0, entries: [] };
}

function saveSpendLedger(ledger: SpendLedger): void {
  writeFileSync(SPEND_FILE, JSON.stringify(ledger, null, 2), "utf8");
}

// Load persisted state on startup
const spendLedger = loadSpendLedger();
let dailySpend = spendLedger.totalSats;
let lastRepayTime = spendLedger.lastRepayEpoch;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════
interface ZestPosition {
  asset: string;
  collateralShares: number;
  collateralValue: number;
  debtValue: number;
  ltv: number;
  healthFactor: number;
  liquidationLtv: number;
}

interface RiskClassification {
  level: "healthy" | "warning" | "critical" | "emergency";
  ltv: number;
  distance_to_liquidation: number;
  recommended_action: string;
}

interface RepayPlan {
  asset: string;
  currentLtv: number;
  targetLtv: number;
  repayAmount: number;
  cappedAmount: number;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function success(action: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ status: "success", action, data, error: null }));
}

function blocked(action: string, error: { code: string; message: string; next: string }) {
  console.log(JSON.stringify({ status: "blocked", action, data: null, error }));
}

function fail(action: string, error: { code: string; message: string; next: string }) {
  console.log(JSON.stringify({ status: "error", action, data: null, error }));
}

// ═══════════════════════════════════════════════════════════════════════════
// ZEST PROTOCOL INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

const ZEST_ASSETS = ["sBTC", "wSTX", "stSTX", "USDC", "USDH", "stSTXbtc"];

// ─── Clarity principal encoding (fix: was using string-ascii 0x0d, must be 0x05) ───

const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Decode c32check-encoded Stacks address body → raw bytes [checksum(4) | hash160(20)] */
function c32decode(input: string): Buffer {
  const s = input.toUpperCase();
  let bits = 0, value = 0;
  const output: number[] = [];
  for (const char of s) {
    const idx = C32_ALPHABET.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >> bits) & 0xff);
    }
  }
  const buf = Buffer.from(output);
  if (buf.length < 24) {
    throw new Error(`c32decode: expected 24 bytes (checksum+hash160), got ${buf.length} — address may be truncated or invalid`);
  }
  return buf;
}

/**
 * Encode a Stacks address as a Clarity principal hex argument.
 * Clarity StandardPrincipal: 0x05 + version byte (1) + hash160 (20) = 22 bytes.
 *
 * Stacks address format: 'S' + c32_version_char + c32check(checksum[4] + hash160[20])
 * The c32 alphabet index of the version char IS the version byte value.
 * SP (mainnet) → 'P' = index 22 = 0x16. ST (testnet) → 'T' = index 26 = 0x1a.
 */
function encodePrincipal(address: string): string {
  if (!address.startsWith("S") || address.length < 5) {
    throw new Error(`Invalid Stacks address: ${address}`);
  }
  const versionByte = C32_ALPHABET.indexOf(address[1].toUpperCase());
  const decoded = c32decode(address.slice(2)); // 24 bytes: checksum(4) + hash160(20)
  const hash160 = decoded.slice(4, 24);

  const buf = Buffer.alloc(22);
  buf[0] = 0x05; // Clarity StandardPrincipal type tag
  buf[1] = versionByte;
  hash160.copy(buf, 2);
  return "0x" + buf.toString("hex");
}

async function callReadOnly(
  contractAddr: string,
  contractName: string,
  fnName: string,
  args: string[],
  sender: string
): Promise<any> {
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddr}/${contractName}/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Parse a Clarity uint from a hex response value.
 * Clarity uint is: 0x01 + 16-byte big-endian unsigned integer
 */
function parseClarityUint(hex: string): number {
  if (!hex || !hex.startsWith("0x01")) return 0;
  const raw = hex.slice(4); // skip 0x01
  // Take last 8 bytes (16 hex chars) to fit in JS number safely
  const lo = raw.slice(-16);
  return parseInt(lo, 16) || 0;
}

/**
 * Extract a uint value from a Clarity hex response by field name.
 * Scans for the field name bytes followed by a uint128 (0x01 + 16 bytes).
 * Used to extract named fields from get-user-position tuple without a full CV parser.
 */
function extractUintField(hexResult: string, fieldName: string): number {
  const hex = hexResult.replace(/^0x/, "").toLowerCase();
  const nameBuf = Buffer.from(fieldName, "ascii");
  // Clarity tuple field: [1-byte name length][name bytes][value bytes]
  const lenByte = nameBuf.length.toString(16).padStart(2, "0");
  const nameHex = nameBuf.toString("hex");
  const pattern = lenByte + nameHex + "01"; // name + uint type tag
  let pos = 0;
  while (pos < hex.length) {
    const idx = hex.indexOf(pattern, pos);
    if (idx < 0) break;
    const valueStart = idx + pattern.length;
    const valueHex = hex.slice(valueStart, valueStart + 32); // 16 bytes = 32 hex chars
    if (valueHex.length === 32) return parseInt(valueHex.slice(16), 16) || 0; // last 8 bytes fits JS number
    pos = idx + 2;
  }
  return 0;
}

/**
 * Find the actual-debt for a specific assetId in a get-user-position hex response.
 * Locates the debt list entry where asset-id == assetId, then reads actual-debt.
 */
function extractDebtForAsset(hexResult: string, assetId: number): number {
  const hex = hexResult.replace(/^0x/, "").toLowerCase();
  // asset-id field pattern: [08]["asset-id"][01][16-byte uint = assetId]
  const assetIdNameHex = "08" + Buffer.from("asset-id", "ascii").toString("hex");
  const assetIdValueHex = "01" + "00".repeat(15) + assetId.toString(16).padStart(2, "0");
  const searchFor = assetIdNameHex + assetIdValueHex;

  let pos = 0;
  while (pos < hex.length) {
    const idx = hex.indexOf(searchFor, pos);
    if (idx < 0) break;
    // Found the entry for this asset — scan forward for actual-debt (within 300 chars / ~150 bytes)
    const window = hex.slice(idx, idx + 300);
    const debtFieldHex = "0b" + Buffer.from("actual-debt", "ascii").toString("hex") + "01";
    const debtIdx = window.indexOf(debtFieldHex);
    if (debtIdx >= 0) {
      const valueStart = debtIdx + debtFieldHex.length;
      const valueHex = window.slice(valueStart, valueStart + 32);
      if (valueHex.length === 32) return parseInt(valueHex.slice(16), 16) || 0;
    }
    pos = idx + 2;
  }
  return 0;
}

/**
 * Query actual collateral and debt for one asset directly from Zest v2 on-chain data.
 * Uses v0-1-data.get-user-position (read-only, direct Hiro API call — no MCP dependency).
 */
async function getZestPosition(asset: string): Promise<ZestPosition | null> {
  const address = process.env.STACKS_ADDRESS;
  if (!address) return null;

  const contract = ZEST_CONTRACTS[asset];
  if (!contract) return null;

  try {
    const [dataAddr, dataName] = ZEST_DATA.split(".");
    const posRes = await callReadOnly(dataAddr, dataName, "get-user-position",
      [encodePrincipal(address)], address);

    if (!posRes?.result || typeof posRes.result !== "string") return null;

    // Collateral: find entry where "aid" = zTokenId (assetId+1), extract "amount"
    const zTokenId = contract.assetId + 1;
    const hexResult = posRes.result;
    const aidNameHex = "03" + Buffer.from("aid", "ascii").toString("hex");
    const aidValueHex = "01" + "00".repeat(15) + zTokenId.toString(16).padStart(2, "0");
    let collateral = 0;
    const aidPattern = aidNameHex + aidValueHex;
    const hexLow = hexResult.replace(/^0x/, "").toLowerCase();
    const aidIdx = hexLow.indexOf(aidPattern);
    if (aidIdx >= 0) {
      const window = hexLow.slice(aidIdx, aidIdx + 200);
      const amtHex = "06" + Buffer.from("amount", "ascii").toString("hex") + "01";
      const amtIdx = window.indexOf(amtHex);
      if (amtIdx >= 0) {
        const vStart = amtIdx + amtHex.length;
        const vHex = window.slice(vStart, vStart + 32);
        if (vHex.length === 32) collateral = parseInt(vHex.slice(16), 16) || 0;
      }
    }

    // Debt: find entry where "asset-id" = assetId, extract "actual-debt"
    const debt = extractDebtForAsset(hexResult, contract.assetId);

    if (collateral === 0 && debt === 0) return null;

    const ltv = collateral > 0 ? (debt / collateral) * 100 : 0;
    const liquidationLtv = contract.liquidationLtv;
    const healthFactor = ltv > 0 ? liquidationLtv / ltv : Infinity;

    return {
      asset,
      collateralShares: collateral,
      collateralValue: collateral,
      debtValue: debt,
      ltv,
      healthFactor,
      liquidationLtv,
    };
  } catch {
    return null;
  }
}

function classifyRisk(ltv: number, liquidationLtv: number): RiskClassification {
  const distance = liquidationLtv - ltv;

  if (ltv >= EMERGENCY_LTV) {
    return {
      level: "emergency",
      ltv,
      distance_to_liquidation: distance,
      recommended_action: "Immediate emergency repayment required",
    };
  }
  if (ltv >= DEFAULT_CRITICAL_LTV) {
    return {
      level: "critical",
      ltv,
      distance_to_liquidation: distance,
      recommended_action: "Auto-repay to restore target LTV",
    };
  }
  if (ltv >= DEFAULT_WARNING_LTV) {
    return {
      level: "warning",
      ltv,
      distance_to_liquidation: distance,
      recommended_action: "Alert user — prepare repayment plan",
    };
  }
  return {
    level: "healthy",
    ltv,
    distance_to_liquidation: distance,
    recommended_action: "No action needed",
  };
}

function computeRepayPlan(
  position: ZestPosition,
  targetLtv: number,
  maxRepay: number
): RepayPlan {
  // Compute how much debt to repay to reach target LTV
  // LTV = debt / collateral => target_debt = collateral * target_ltv / 100
  const targetDebt = (position.collateralValue * targetLtv) / 100;
  const rawRepay = Math.max(0, position.debtValue - targetDebt);

  // Apply safety caps
  let cappedAmount = Math.min(rawRepay, maxRepay);
  cappedAmount = Math.min(cappedAmount, HARD_CAP_PER_REPAY);
  cappedAmount = Math.min(cappedAmount, HARD_CAP_PER_DAY - dailySpend);

  let reason = "Computed optimal repayment";
  if (cappedAmount < rawRepay) {
    if (rawRepay > HARD_CAP_PER_REPAY) reason = "Capped at per-operation hard limit";
    else if (rawRepay > HARD_CAP_PER_DAY - dailySpend) reason = "Capped at daily limit";
    else reason = "Capped at user-configured max";
  }

  return {
    asset: position.asset,
    currentLtv: position.ltv,
    targetLtv,
    repayAmount: rawRepay,
    cappedAmount,
    reason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRE-FLIGHT CHECKS
// ═══════════════════════════════════════════════════════════════════════════

async function preflight(): Promise<{
  ok: boolean;
  wallet: string | null;
  stxBalance: number;
  sbtcBalance: number;
  assetBalances: Record<string, number>;
  positions: ZestPosition[];
  errors: string[];
}> {
  const errors: string[] = [];
  const wallet = process.env.STACKS_ADDRESS || null;

  if (!wallet) {
    errors.push("STACKS_ADDRESS not set — unlock wallet first");
  }

  // Check STX balance for gas + per-asset balances for reserve checks
  let stxBalance = 0;
  let sbtcBalance = 0;
  const assetBalances: Record<string, number> = {};

  if (wallet) {
    try {
      const balRes = await fetch(
        `https://api.hiro.so/extended/v1/address/${wallet}/balances`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT) }
      );
      const bal = await balRes.json();
      stxBalance = parseInt(bal.stx?.balance || "0", 10);
      const ft: Record<string, { balance: string }> = bal.fungible_tokens || {};

      // Map each Zest asset to its wallet balance for per-asset reserve checks
      for (const [symbol, cfg] of Object.entries(ZEST_CONTRACTS)) {
        const tokenKey = Object.keys(ft).find((k) => k.startsWith(cfg.token));
        const raw = parseInt(ft[tokenKey ?? ""]?.balance || "0", 10);
        assetBalances[symbol] = raw;
        if (symbol === "sBTC") sbtcBalance = raw; // backwards compat
      }
    } catch {
      errors.push("Failed to fetch wallet balances from Hiro API");
    }

    if (stxBalance < MIN_GAS_USTX) {
      errors.push(
        `Insufficient STX for gas: ${stxBalance} < ${MIN_GAS_USTX} uSTX`
      );
    }
  }

  // Check Zest positions — parallel to avoid 90s worst-case sequential timeout
  const positions: ZestPosition[] = [];
  if (wallet) {
    const posResults = await Promise.all(ZEST_ASSETS.map((a) => getZestPosition(a)));
    for (const pos of posResults) {
      if (pos && pos.debtValue > 0) positions.push(pos);
    }
  }

  return {
    ok: errors.length === 0,
    wallet,
    stxBalance,
    sbtcBalance,
    assetBalances,
    positions,
    errors,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

const program = new Command();

program
  .name("zest-auto-repay")
  .description(
    "Autonomous Zest Protocol LTV guardian — monitors positions and executes safe repayments"
  )
  .version("1.0.0");

// --- DOCTOR ---
program
  .command("doctor")
  .description("Check environment readiness for Zest LTV monitoring")
  .action(async () => {
    const pf = await preflight();

    if (!pf.ok) {
      fail("Fix blockers before proceeding", {
        code: pf.wallet ? "preflight_failed" : "no_wallet",
        message: pf.errors.join("; "),
        next: pf.wallet
          ? "Ensure STX balance >= 0.2 STX for gas fees"
          : "Run: wallet_unlock to enable signing",
      });
      return;
    }

    success("Environment ready — all checks passed", {
      wallet: pf.wallet,
      stxBalance: `${(pf.stxBalance / 1_000_000).toFixed(2)} STX`,
      sbtcBalance: `${pf.sbtcBalance} sats`,
      activePositions: pf.positions.length,
      safetyLimits: {
        hardCapPerRepay: `${HARD_CAP_PER_REPAY} sats`,
        hardCapPerDay: `${HARD_CAP_PER_DAY} sats`,
        minReserve: `${MIN_WALLET_RESERVE} sats`,
        cooldown: `${COOLDOWN_SECONDS}s`,
      },
      supportedAssets: ZEST_ASSETS,
    });
  });

// --- RUN ---
program
  .command("run")
  .description("Execute LTV monitoring and repayment actions")
  .requiredOption("--action <action>", "Action: status, monitor, repay, emergency-repay")
  .option("--asset <asset>", "Asset to repay (e.g., sBTC, USDC)", "sBTC")
  .option("--target-ltv <pct>", "Target LTV after repayment (%)", String(DEFAULT_TARGET_LTV))
  .option("--max-repay <sats>", "Max repayment per operation (sats)", String(DEFAULT_MAX_REPAY))
  .option("--interval <seconds>", "Monitoring interval (seconds)", "300")
  .action(async (opts) => {
    const action = opts.action;
    const asset = opts.asset;
    const targetLtvRaw = parseInt(opts.targetLtv, 10);
    if (isNaN(targetLtvRaw) || targetLtvRaw < 30 || targetLtvRaw > 75) {
      fail("Invalid target LTV", {
        code: "invalid_target",
        message: `Target LTV must be 30-75%, got ${opts.targetLtv}%`,
        next: "Use --target-ltv with a value between 30 and 75",
      });
      return;
    }
    const targetLtv = targetLtvRaw;
    const maxRepay = Math.min(parseInt(opts.maxRepay, 10), HARD_CAP_PER_REPAY);
    const interval = Math.max(60, parseInt(opts.interval, 10));

    // Pre-flight
    const pf = await preflight();
    if (!pf.ok) {
      fail("Pre-flight failed", {
        code: "preflight_failed",
        message: pf.errors.join("; "),
        next: "Run doctor command to diagnose",
      });
      return;
    }

    // ── STATUS ──────────────────────────────────────────────────────────
    if (action === "status") {
      if (pf.positions.length === 0) {
        success("No active Zest borrowing positions found", {
          wallet: pf.wallet,
          sbtcBalance: `${pf.sbtcBalance} sats`,
          positions: [],
          recommendation: "No debt to monitor — position is fully collateralized or unused",
        });
        return;
      }

      const analysis = pf.positions.map((pos) => ({
        ...pos,
        risk: classifyRisk(pos.ltv, pos.liquidationLtv),
        repayPlan:
          pos.ltv >= DEFAULT_WARNING_LTV
            ? computeRepayPlan(pos, targetLtv, maxRepay)
            : null,
      }));

      const worstLtv = Math.max(...pf.positions.map((p) => p.ltv));
      const overallRisk = classifyRisk(worstLtv, 85);

      success("Position analysis complete", {
        wallet: pf.wallet,
        sbtcBalance: `${pf.sbtcBalance} sats`,
        overallRisk: overallRisk.level,
        positions: analysis,
        safetyState: {
          dailySpendRemaining: `${HARD_CAP_PER_DAY - dailySpend} sats`,
          cooldownActive: Date.now() / 1000 - lastRepayTime < COOLDOWN_SECONDS,
        },
      });
      return;
    }

    // ── MONITOR ─────────────────────────────────────────────────────────
    if (action === "monitor") {
      success("Monitoring mode — emitting read-only LTV checks", {
        wallet: pf.wallet,
        interval: `${interval}s`,
        thresholds: {
          warning: `${DEFAULT_WARNING_LTV}%`,
          critical: `${DEFAULT_CRITICAL_LTV}%`,
          emergency: `${EMERGENCY_LTV}%`,
        },
        positions: pf.positions.map((pos) => ({
          asset: pos.asset,
          ltv: pos.ltv,
          risk: classifyRisk(pos.ltv, pos.liquidationLtv),
        })),
        note: "Monitor mode is read-only. Use --action=repay to execute.",
      });
      return;
    }

    // ── REPAY ───────────────────────────────────────────────────────────
    if (action === "repay" || action === "emergency-repay") {
      const isEmergency = action === "emergency-repay";
      const effectiveMax = isEmergency
        ? HARD_CAP_PER_REPAY
        : maxRepay;

      // Find position for the requested asset
      const position = pf.positions.find((p) => p.asset === asset);
      if (!position) {
        fail("No borrowing position found for asset", {
          code: "no_position",
          message: `No active debt on ${asset}`,
          next: `Check status with --action=status to see all positions`,
        });
        return;
      }

      // Check LTV thresholds (skip for emergency)
      if (!isEmergency && position.ltv < DEFAULT_WARNING_LTV) {
        blocked("LTV is healthy — no repayment needed", {
          code: "healthy_ltv",
          message: `Current LTV ${position.ltv.toFixed(1)}% is below warning threshold ${DEFAULT_WARNING_LTV}%`,
          next: "No action required. Monitor will alert if LTV increases.",
        });
        return;
      }

      // Check cooldown
      const elapsed = Date.now() / 1000 - lastRepayTime;
      if (elapsed < COOLDOWN_SECONDS && !isEmergency) {
        blocked("Cooldown active", {
          code: "cooldown_active",
          message: `${Math.ceil(COOLDOWN_SECONDS - elapsed)}s remaining before next repayment`,
          next: `Wait or use --action=emergency-repay to override cooldown`,
        });
        return;
      }

      // Check daily cap
      if (dailySpend >= HARD_CAP_PER_DAY) {
        blocked("Daily safety limit reached", {
          code: "exceeds_daily_cap",
          message: `Already repaid ${dailySpend} sats today (cap: ${HARD_CAP_PER_DAY})`,
          next: "Manual intervention required if position is at risk",
        });
        return;
      }

      // Compute repayment plan
      const plan = computeRepayPlan(position, targetLtv, effectiveMax);

      // Check wallet reserve using the balance of the actual repay asset (not always sBTC)
      const repayAssetBalance = pf.assetBalances[asset] ?? pf.sbtcBalance;
      if (repayAssetBalance - plan.cappedAmount < MIN_WALLET_RESERVE) {
        const safeAmount = Math.max(0, repayAssetBalance - MIN_WALLET_RESERVE);
        if (safeAmount <= 0) {
          fail("Cannot repay — would breach wallet reserve", {
            code: "insufficient_balance",
            message: `Balance ${repayAssetBalance} sats minus reserve ${MIN_WALLET_RESERVE} sats = 0 available`,
            next: `Deposit more ${asset} or reduce reserve with caution`,
          });
          return;
        }
        plan.cappedAmount = safeAmount;
        plan.reason = "Reduced to preserve wallet reserve";
      }

      if (plan.cappedAmount <= 0) {
        blocked("No repayment needed", {
          code: "healthy_ltv",
          message: "Computed repayment amount is 0",
          next: "Position is within target LTV range",
        });
        return;
      }

      // Emit repayment command for agent framework
      success(
        isEmergency
          ? "Emergency repayment plan ready — execute immediately"
          : "Repayment plan ready — awaiting agent execution",
        {
          plan: {
            asset: plan.asset,
            repayAmount: plan.cappedAmount,
            currentLtv: `${plan.currentLtv.toFixed(1)}%`,
            projectedLtv: `${plan.targetLtv}%`,
            reason: plan.reason,
            isEmergency,
          },
          mcpCommand: {
            tool: "zest_repay",
            params: {
              asset: plan.asset,
              amount: String(plan.cappedAmount),
            },
          },
          // After executing mcpCommand, call: record-spend --asset <asset> --amount <sats>
          // Spend is NOT recorded here — only after on-chain confirmation to prevent
          // daily cap consumption on failed/rejected transactions.
          confirmStep: {
            command: "record-spend",
            args: `--asset ${plan.asset} --amount ${plan.cappedAmount}`,
          },
          safetyChecks: {
            withinPerOperationCap: plan.cappedAmount <= HARD_CAP_PER_REPAY,
            withinDailyCap: dailySpend + plan.cappedAmount <= HARD_CAP_PER_DAY,
            reservePreserved: repayAssetBalance - plan.cappedAmount >= MIN_WALLET_RESERVE,
            cooldownRespected: isEmergency || elapsed >= COOLDOWN_SECONDS,
          },
        }
      );
      // Do NOT update ledger here — agent calls record-spend after tx confirms
      return;
    }

    fail("Unknown action", {
      code: "unknown_action",
      message: `Action '${action}' not recognized`,
      next: "Use: status, monitor, repay, or emergency-repay",
    });
  });

// --- RECORD-SPEND ---
// Agent calls this after zest_repay MCP tool confirms success.
// Spend is recorded here — after on-chain execution — not when the plan is emitted.
program
  .command("record-spend")
  .description("Record a confirmed repayment in the daily spend ledger")
  .requiredOption("--asset <asset>", "Asset that was repaid")
  .requiredOption("--amount <sats>", "Amount repaid in base units (sats)")
  .action((opts) => {
    const amount = parseInt(opts.amount, 10);
    if (isNaN(amount) || amount <= 0) {
      fail("Invalid amount", {
        code: "invalid_amount",
        message: `Amount must be a positive integer, got ${opts.amount}`,
        next: "Pass the cappedAmount from the repay plan",
      });
      return;
    }
    lastRepayTime = Date.now() / 1000;
    dailySpend += amount;
    spendLedger.totalSats = dailySpend;
    spendLedger.lastRepayEpoch = lastRepayTime;
    spendLedger.entries.push({ ts: new Date().toISOString(), sats: amount, asset: opts.asset });
    saveSpendLedger(spendLedger);
    success("Spend recorded", {
      asset: opts.asset,
      amount,
      dailyTotal: dailySpend,
      dailyRemaining: HARD_CAP_PER_DAY - dailySpend,
    });
  });

program.parse();
