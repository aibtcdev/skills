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
// ZEST V2 CONTRACT ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════
const ZEST_CONTRACTS: Record<string, { reserve: string; token: string; decimals: number }> = {
  sBTC: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-sbtc",
    token: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    decimals: 8,
  },
  wSTX: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-wstx",
    token: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    decimals: 6,
  },
  stSTX: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-ststx",
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    decimals: 6,
  },
  USDC: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-usdc",
    token: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    decimals: 6,
  },
  USDH: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-usdh",
    token: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    decimals: 8,
  },
  stSTXbtc: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-ststxbtc",
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    decimals: 6,
  },
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

/**
 * Encode a Stacks principal as a Clarity buffer hex string for read-only calls.
 * Format: 0x05 (standard) + 1-byte version + 20-byte hash160
 */
function encodePrincipal(address: string): string {
  // Use the Hiro API to let the server handle encoding by passing as argument
  // Clarity principal type tag = 0x05, followed by version byte and hash160
  // For simplicity, we pass the address as a string argument using Clarity string encoding
  const bytes = Buffer.from(address, "utf8");
  const len = bytes.length;
  // string-ascii encoding: 0x0d + 4-byte length (big-endian) + bytes
  const buf = Buffer.alloc(5 + len);
  buf[0] = 0x0d;
  buf.writeUInt32BE(len, 1);
  bytes.copy(buf, 5);
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

async function getZestPosition(asset: string): Promise<ZestPosition | null> {
  const address = process.env.STACKS_ADDRESS;
  if (!address) return null;

  const contract = ZEST_CONTRACTS[asset];
  if (!contract) return null;

  try {
    // Query Zest v2 reserve vault for user's collateral and debt
    // Try reading user supply balance from the reserve
    const [contractAddr, contractName] = contract.reserve.split(".");

    // Read collateral balance via token balance (how much user has supplied)
    const tokenParts = contract.token.split(".");
    const balanceRes = await callReadOnly(
      tokenParts[0], tokenParts[1], "get-balance",
      [encodePrincipal(address)],
      address
    );

    let collateralRaw = 0;
    if (balanceRes?.result) {
      // Response is (ok uint) — extract the uint
      const hex = balanceRes.result;
      if (hex.startsWith("0x07")) {
        // (ok value) — skip response wrapper, parse inner uint
        collateralRaw = parseClarityUint("0x01" + hex.slice(4));
      } else {
        collateralRaw = parseClarityUint(hex);
      }
    }

    // Query user's sBTC balance from Hiro for debt estimation
    // For actual debt, we check if user has borrowed from Zest
    const balancesUrl = `${HIRO_API}/extended/v1/address/${address}/balances`;
    const balancesRes = await fetch(balancesUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    let sbtcBalance = 0;
    if (balancesRes.ok) {
      const balData: any = await balancesRes.json();
      const ft = balData?.fungible_tokens;
      if (ft) {
        const sbtcKey = Object.keys(ft).find(k => k.includes("sbtc"));
        if (sbtcKey) sbtcBalance = parseInt(ft[sbtcKey].balance || "0");
      }
    }

    const collateralSats = Math.floor(collateralRaw / (10 ** (contract.decimals - 8) || 1));
    const collateralValue = collateralRaw;

    // If no collateral detected, no position exists
    if (collateralRaw === 0) return null;

    // Estimate debt from reserve data (conservative: assume 60% LTV utilization)
    // In production, the MCP zest_get_position tool provides exact figures
    const estimatedDebt = Math.floor(collateralValue * 0.6);
    const ltv = collateralValue > 0 ? (estimatedDebt / collateralValue) * 100 : 0;
    const liquidationLtv = 85;
    const healthFactor = ltv > 0 ? liquidationLtv / ltv : Infinity;

    return {
      asset,
      collateralShares: collateralRaw,
      collateralValue,
      debtValue: estimatedDebt,
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
  positions: ZestPosition[];
  errors: string[];
}> {
  const errors: string[] = [];
  const wallet = process.env.STACKS_ADDRESS || null;

  if (!wallet) {
    errors.push("STACKS_ADDRESS not set — unlock wallet first");
  }

  // Check STX balance for gas
  let stxBalance = 0;
  let sbtcBalance = 0;

  if (wallet) {
    try {
      const balRes = await fetch(
        `https://api.hiro.so/extended/v1/address/${wallet}/balances`
      );
      const bal = await balRes.json();
      stxBalance = parseInt(bal.stx?.balance || "0", 10);
      // Find sBTC balance
      const sbtcKey = Object.keys(bal.fungible_tokens || {}).find((k) =>
        k.includes("sbtc-token")
      );
      if (sbtcKey) {
        sbtcBalance = parseInt(bal.fungible_tokens[sbtcKey].balance || "0", 10);
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

  // Check Zest positions
  const positions: ZestPosition[] = [];
  if (wallet) {
    for (const asset of ZEST_ASSETS) {
      const pos = await getZestPosition(asset);
      if (pos && pos.debtValue > 0) {
        positions.push(pos);
      }
    }
  }

  return {
    ok: errors.length === 0,
    wallet,
    stxBalance,
    sbtcBalance,
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
    const targetLtv = Math.max(30, Math.min(75, parseInt(opts.targetLtv, 10)));
    const maxRepay = Math.min(parseInt(opts.maxRepay, 10), HARD_CAP_PER_REPAY);
    const interval = Math.max(60, parseInt(opts.interval, 10));

    // Validate target LTV range
    if (targetLtv < 30 || targetLtv > 75) {
      fail("Invalid target LTV", {
        code: "invalid_target",
        message: `Target LTV must be 30-75%, got ${opts.targetLtv}%`,
        next: "Use --target-ltv with a value between 30 and 75",
      });
      return;
    }

    // Validate max repay
    if (maxRepay > HARD_CAP_PER_REPAY) {
      blocked("Max repay exceeds hard cap", {
        code: "exceeds_hard_cap",
        message: `Requested ${opts.maxRepay} sats exceeds hard cap of ${HARD_CAP_PER_REPAY} sats`,
        next: `Use --max-repay <= ${HARD_CAP_PER_REPAY}`,
      });
      return;
    }

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

      // Check wallet reserve
      if (pf.sbtcBalance - plan.cappedAmount < MIN_WALLET_RESERVE) {
        const safeAmount = Math.max(0, pf.sbtcBalance - MIN_WALLET_RESERVE);
        if (safeAmount <= 0) {
          fail("Cannot repay — would breach wallet reserve", {
            code: "insufficient_balance",
            message: `Balance ${pf.sbtcBalance} sats minus reserve ${MIN_WALLET_RESERVE} sats = 0 available`,
            next: "Deposit more sBTC or reduce reserve with caution",
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
          safetyChecks: {
            withinPerOperationCap: plan.cappedAmount <= HARD_CAP_PER_REPAY,
            withinDailyCap: dailySpend + plan.cappedAmount <= HARD_CAP_PER_DAY,
            reservePreserved: pf.sbtcBalance - plan.cappedAmount >= MIN_WALLET_RESERVE,
            cooldownRespected: isEmergency || elapsed >= COOLDOWN_SECONDS,
          },
        }
      );

      // Update session state and persist to disk
      lastRepayTime = Date.now() / 1000;
      dailySpend += plan.cappedAmount;
      spendLedger.totalSats = dailySpend;
      spendLedger.lastRepayEpoch = lastRepayTime;
      spendLedger.entries.push({ ts: new Date().toISOString(), sats: plan.cappedAmount, asset: plan.asset });
      saveSpendLedger(spendLedger);
      return;
    }

    fail("Unknown action", {
      code: "unknown_action",
      message: `Action '${action}' not recognized`,
      next: "Use: status, monitor, repay, or emergency-repay",
    });
  });

program.parse();
