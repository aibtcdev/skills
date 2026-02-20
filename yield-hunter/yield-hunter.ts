#!/usr/bin/env bun
/**
 * Yield Hunter skill CLI
 * Autonomous sBTC yield hunting daemon using Zest Protocol
 *
 * Monitors wallet for sBTC and automatically deposits to Zest Protocol
 * when balance exceeds a configurable threshold.
 *
 * Usage: bun run yield-hunter/yield-hunter.ts <subcommand> [options]
 */

import { Command } from "commander";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { NETWORK } from "../src/lib/config/networks.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { getZestProtocolService } from "../src/lib/services/defi.service.js";
import { getSbtcBalance } from "../src/lib/utils/tokens.js";
import { ZEST_ASSETS, MAINNET_CONTRACTS } from "../src/lib/config/contracts.js";
import {
  cvToJSON,
  hexToCV,
  contractPrincipalCV,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State file management
// ---------------------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".aibtc");
const STATE_FILE = path.join(STATE_DIR, "yield-hunter-state.json");
const PID_FILE = path.join(STATE_DIR, "yield-hunter.pid");

interface YieldHunterConfig {
  minDepositThreshold: string;
  reserve: string;
  checkIntervalMs: number;
  asset: string;
}

interface YieldHunterStats {
  lastCheck: string | null;
  totalDeposited: string;
  checksRun: number;
  depositsExecuted: number;
  lastError: string | null;
  currentApy: number | null;
  lastApyFetch: string | null;
}

interface YieldHunterState {
  running: boolean;
  pid: number | null;
  config: YieldHunterConfig;
  stats: YieldHunterStats;
  logs: Array<{
    timestamp: string;
    type: "info" | "action" | "error" | "warning";
    message: string;
  }>;
}

const DEFAULT_STATE: YieldHunterState = {
  running: false,
  pid: null,
  config: {
    minDepositThreshold: "10000",
    reserve: "0",
    checkIntervalMs: 600_000,
    asset: "sBTC",
  },
  stats: {
    lastCheck: null,
    totalDeposited: "0",
    checksRun: 0,
    depositsExecuted: 0,
    lastError: null,
    currentApy: null,
    lastApyFetch: null,
  },
  logs: [],
};

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function readState(): Promise<YieldHunterState> {
  try {
    await ensureStateDir();
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as YieldHunterState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeState(state: YieldHunterState): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(PID_FILE, "utf-8");
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

async function writePid(pid: number): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(PID_FILE, String(pid), "utf-8");
}

async function removePid(): Promise<void> {
  try {
    await fs.unlink(PID_FILE);
  } catch {
    // ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without sending a real signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSats(sats: bigint | string): string {
  const n = typeof sats === "string" ? BigInt(sats) : sats;
  const btc = Number(n) / 100_000_000;
  return `${btc.toFixed(8)} sBTC`;
}

function formatApy(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Zest APY fetching
// ---------------------------------------------------------------------------

async function fetchZestApy(): Promise<number | null> {
  try {
    const hiro = getHiroApi(NETWORK);
    const [reserveAddr, reserveName] =
      MAINNET_CONTRACTS.ZEST_POOL_RESERVE.split(".");
    const [sbtcAddr, sbtcName] = ZEST_ASSETS.sBTC.token.split(".");

    const result = await hiro.callReadOnlyFunction(
      MAINNET_CONTRACTS.ZEST_POOL_RESERVE,
      "get-reserve-state",
      [contractPrincipalCV(sbtcAddr, sbtcName)],
      reserveAddr
    );

    if (!result.okay || !result.result) {
      return null;
    }

    const decoded = cvToJSON(hexToCV(result.result));
    const data = decoded?.value?.value || decoded?.value || decoded;
    const liquidityRate = data?.["current-liquidity-rate"]?.value;

    if (liquidityRate) {
      return Number(BigInt(liquidityRate) / 10000n);
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core yield check
// ---------------------------------------------------------------------------

async function runYieldCheck(state: YieldHunterState): Promise<YieldHunterState> {
  const updatedState = { ...state };
  const now = new Date().toISOString();

  function addLog(
    type: "info" | "action" | "error" | "warning",
    message: string
  ) {
    updatedState.logs.unshift({ timestamp: new Date().toISOString(), type, message });
    if (updatedState.logs.length > 100) {
      updatedState.logs = updatedState.logs.slice(0, 100);
    }
    console.error(`[YieldHunter] [${type.toUpperCase()}] ${message}`);
  }

  try {
    const walletManager = getWalletManager();
    const account = walletManager.getActiveAccount();
    if (!account) {
      throw new Error("Wallet is not unlocked. Use wallet/wallet.ts unlock first.");
    }

    const zest = getZestProtocolService(NETWORK);
    const minThreshold = BigInt(updatedState.config.minDepositThreshold);
    const reserve = BigInt(updatedState.config.reserve);

    // Fetch live APY
    const apy = await fetchZestApy();
    if (apy !== null) {
      updatedState.stats.currentApy = apy;
      updatedState.stats.lastApyFetch = now;
      addLog("info", `Current Zest sBTC APY: ${formatApy(apy)}`);
    }

    // Get wallet sBTC balance
    const walletBalance = await getSbtcBalance(account.address, NETWORK);
    addLog("info", `Wallet sBTC: ${formatSats(walletBalance)}`);

    // Get current Zest position
    const position = await zest.getUserPosition(ZEST_ASSETS.sBTC.token, account.address);
    const zestSupplied = position ? BigInt(position.supplied) : 0n;
    addLog("info", `Zest supplied: ${formatSats(zestSupplied)}`);

    const effectiveThreshold = minThreshold + reserve;
    const depositAmount =
      walletBalance > reserve ? walletBalance - reserve : 0n;

    if (walletBalance >= effectiveThreshold && depositAmount > 0n) {
      addLog(
        "action",
        `Balance (${formatSats(walletBalance)}) above threshold (${formatSats(effectiveThreshold)}). ` +
          `Depositing ${formatSats(depositAmount)}...`
      );

      const result = await zest.supply(
        account,
        updatedState.config.asset,
        depositAmount
      );

      addLog("action", `Deposit tx submitted: ${result.txid}`);
      updatedState.stats.totalDeposited = (
        BigInt(updatedState.stats.totalDeposited) + depositAmount
      ).toString();
      updatedState.stats.depositsExecuted += 1;
    } else if (walletBalance > 0n && walletBalance < effectiveThreshold) {
      addLog(
        "info",
        `Balance (${formatSats(walletBalance)}) below threshold (${formatSats(effectiveThreshold)}), ` +
          `need ${formatSats(effectiveThreshold - walletBalance)} more to deposit.`
      );
    } else {
      addLog("info", "No sBTC in wallet, nothing to deposit");
    }

    updatedState.stats.lastCheck = now;
    updatedState.stats.checksRun += 1;
    updatedState.stats.lastError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updatedState.stats.lastError = message;
    console.error(`[YieldHunter] [ERROR] Check failed: ${message}`);
  }

  return updatedState;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("yield-hunter")
  .description(
    "Autonomous sBTC yield hunting daemon — monitors wallet and deposits to Zest Protocol when balance exceeds threshold. " +
      "Only works on mainnet. Requires an unlocked wallet with sBTC balance."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command("start")
  .description(
    "Start autonomous yield hunting. " +
      "Runs in the foreground, periodically checking wallet balance and depositing to Zest Protocol. " +
      "Press Ctrl+C to stop. Only available on mainnet."
  )
  .option("--threshold <sats>", "Minimum sBTC balance (in sats) before depositing", "10000")
  .option("--reserve <sats>", "sBTC (in sats) to keep liquid, never deposited", "0")
  .option("--interval <seconds>", "Check interval in seconds", "600")
  .action(
    async (opts: { threshold: string; reserve: string; interval: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error("Yield hunting only available on mainnet (Zest Protocol is mainnet-only)");
        }

        // Check if already running
        const existingPid = await readPid();
        if (existingPid && isProcessRunning(existingPid)) {
          printJson({
            success: false,
            error: `Yield hunter is already running (PID: ${existingPid}). Use stop to stop it first.`,
          });
          process.exit(1);
        }

        // Verify wallet is unlocked
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error(
            "Wallet not unlocked. Use wallet/wallet.ts unlock first to enable transactions."
          );
        }

        const intervalMs = parseInt(opts.interval, 10) * 1000;
        if (isNaN(intervalMs) || intervalMs < 10000) {
          throw new Error("--interval must be at least 10 seconds");
        }

        let state = await readState();
        state.running = true;
        state.pid = process.pid;
        state.config = {
          minDepositThreshold: opts.threshold,
          reserve: opts.reserve,
          checkIntervalMs: intervalMs,
          asset: "sBTC",
        };

        await writeState(state);
        await writePid(process.pid);

        printJson({
          success: true,
          message: "Yield hunter started",
          pid: process.pid,
          config: {
            minDepositThreshold: opts.threshold,
            minDepositThresholdFormatted: formatSats(BigInt(opts.threshold)),
            reserve: opts.reserve,
            reserveFormatted: formatSats(BigInt(opts.reserve)),
            checkIntervalSeconds: parseInt(opts.interval, 10),
            asset: "sBTC",
          },
          note: "Running in foreground. Press Ctrl+C to stop.",
        });

        // Fetch initial APY
        const apy = await fetchZestApy();
        if (apy !== null) {
          console.error(`[YieldHunter] Current Zest sBTC APY: ${formatApy(apy)}`);
        }

        // Run first check immediately
        state = await runYieldCheck(state);
        await writeState(state);

        // Handle graceful shutdown
        let stopping = false;
        const shutdown = async () => {
          if (stopping) return;
          stopping = true;
          state.running = false;
          state.pid = null;
          await writeState(state);
          await removePid();
          console.error("[YieldHunter] Stopped gracefully.");
          process.exit(0);
        };

        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());

        // Schedule periodic checks
        const runLoop = async () => {
          while (!stopping) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            if (stopping) break;
            state = await runYieldCheck(state);
            await writeState(state);
          }
        };

        await runLoop();
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

program
  .command("stop")
  .description(
    "Stop the running yield hunter process. " +
      "Sends SIGTERM to the running process. Your Zest positions remain untouched."
  )
  .action(async () => {
    try {
      const pid = await readPid();

      if (!pid) {
        printJson({
          success: false,
          error: "No yield hunter PID file found. The daemon may not be running.",
        });
        process.exit(1);
      }

      if (!isProcessRunning(pid)) {
        // Stale PID file — clean it up
        await removePid();
        const state = await readState();
        state.running = false;
        state.pid = null;
        await writeState(state);
        printJson({
          success: false,
          error: `Process ${pid} is not running (stale PID file cleaned up).`,
        });
        process.exit(1);
      }

      process.kill(pid, "SIGTERM");

      // Wait briefly and check if it stopped
      await new Promise((resolve) => setTimeout(resolve, 1500));

      if (isProcessRunning(pid)) {
        // Force kill if still running after SIGTERM
        process.kill(pid, "SIGKILL");
      }

      await removePid();
      const state = await readState();
      state.running = false;
      state.pid = null;
      await writeState(state);

      printJson({
        success: true,
        message: `Yield hunter stopped (PID: ${pid})`,
        stats: {
          checksRun: state.stats.checksRun,
          depositsExecuted: state.stats.depositsExecuted,
          totalDeposited: state.stats.totalDeposited,
          totalDepositedFormatted: formatSats(state.stats.totalDeposited),
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description(
    "Get the current yield hunter status including config, stats, and recent activity logs."
  )
  .action(async () => {
    try {
      const state = await readState();
      const pid = await readPid();

      // Verify if process is actually running
      const actuallyRunning = pid ? isProcessRunning(pid) : false;

      // Optionally get current wallet and Zest info if on mainnet
      let currentPosition = undefined;
      let currentApyFormatted = undefined;

      if (NETWORK === "mainnet") {
        try {
          const walletManager = getWalletManager();
          const session = walletManager.getSessionInfo();

          if (session?.address) {
            const zest = getZestProtocolService(NETWORK);
            const [position, walletBalance, apy] = await Promise.all([
              zest.getUserPosition(ZEST_ASSETS.sBTC.token, session.address),
              getSbtcBalance(session.address, NETWORK),
              fetchZestApy(),
            ]);

            const reserve = BigInt(state.config.reserve);
            const availableToDeposit =
              walletBalance > reserve ? walletBalance - reserve : 0n;
            const zestSupplied = position ? BigInt(position.supplied) : 0n;

            currentPosition = {
              walletSbtc: walletBalance.toString(),
              walletSbtcFormatted: formatSats(walletBalance),
              availableToDeposit: availableToDeposit.toString(),
              availableToDepositFormatted: formatSats(availableToDeposit),
              reserve: state.config.reserve,
              reserveFormatted: formatSats(state.config.reserve),
              zestSupplied: zestSupplied.toString(),
              zestSuppliedFormatted: formatSats(zestSupplied),
              zestBorrowed: position?.borrowed || "0",
            };

            if (apy !== null) {
              currentApyFormatted = formatApy(apy);
            }
          }
        } catch {
          // Not fatal — wallet may not be unlocked
        }
      }

      printJson({
        running: actuallyRunning,
        pid: actuallyRunning ? pid : null,
        network: NETWORK,
        config: {
          minDepositThreshold: state.config.minDepositThreshold,
          minDepositThresholdFormatted: formatSats(state.config.minDepositThreshold),
          reserve: state.config.reserve,
          reserveFormatted: formatSats(state.config.reserve),
          effectiveThreshold: (
            BigInt(state.config.minDepositThreshold) +
            BigInt(state.config.reserve)
          ).toString(),
          checkIntervalMs: state.config.checkIntervalMs,
          checkIntervalSeconds: state.config.checkIntervalMs / 1000,
          asset: state.config.asset,
        },
        stats: {
          lastCheck: state.stats.lastCheck,
          totalDeposited: state.stats.totalDeposited,
          totalDepositedFormatted: formatSats(state.stats.totalDeposited),
          checksRun: state.stats.checksRun,
          depositsExecuted: state.stats.depositsExecuted,
          lastError: state.stats.lastError,
          currentApy:
            currentApyFormatted ||
            (state.stats.currentApy !== null
              ? formatApy(state.stats.currentApy)
              : null),
        },
        ...(currentPosition && { currentPosition }),
        recentLogs: state.logs.slice(0, 15),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// configure
// ---------------------------------------------------------------------------

program
  .command("configure")
  .description(
    "Update yield hunter configuration. Changes are saved to the state file and take effect on the next check cycle."
  )
  .option("--threshold <sats>", "Minimum sBTC balance (in sats) before depositing")
  .option("--reserve <sats>", "sBTC (in sats) to keep liquid, never deposited")
  .option("--interval <seconds>", "Check interval in seconds")
  .action(
    async (opts: {
      threshold?: string;
      reserve?: string;
      interval?: string;
    }) => {
      try {
        if (!opts.threshold && !opts.reserve && !opts.interval) {
          const state = await readState();
          printJson({
            success: false,
            error: "No configuration changes specified. Provide --threshold, --reserve, or --interval.",
            currentConfig: {
              minDepositThreshold: state.config.minDepositThreshold,
              minDepositThresholdFormatted: formatSats(state.config.minDepositThreshold),
              reserve: state.config.reserve,
              reserveFormatted: formatSats(state.config.reserve),
              checkIntervalMs: state.config.checkIntervalMs,
              checkIntervalSeconds: state.config.checkIntervalMs / 1000,
              asset: state.config.asset,
            },
          });
          return;
        }

        const state = await readState();
        const changes: string[] = [];

        if (opts.threshold) {
          const value = BigInt(opts.threshold);
          if (value < 0n) throw new Error("--threshold must be non-negative");
          state.config.minDepositThreshold = opts.threshold;
          changes.push(`Deposit threshold set to ${formatSats(value)}`);
        }

        if (opts.reserve) {
          const value = BigInt(opts.reserve);
          if (value < 0n) throw new Error("--reserve must be non-negative");
          state.config.reserve = opts.reserve;
          changes.push(`Reserve set to ${formatSats(value)}`);
        }

        if (opts.interval) {
          const seconds = parseInt(opts.interval, 10);
          if (isNaN(seconds) || seconds < 10) {
            throw new Error("--interval must be at least 10 seconds");
          }
          state.config.checkIntervalMs = seconds * 1000;
          changes.push(`Check interval set to ${seconds} seconds`);
        }

        await writeState(state);

        printJson({
          success: true,
          changes,
          config: {
            minDepositThreshold: state.config.minDepositThreshold,
            minDepositThresholdFormatted: formatSats(state.config.minDepositThreshold),
            reserve: state.config.reserve,
            reserveFormatted: formatSats(state.config.reserve),
            checkIntervalMs: state.config.checkIntervalMs,
            checkIntervalSeconds: state.config.checkIntervalMs / 1000,
            asset: state.config.asset,
          },
          note: state.running
            ? "Changes saved. The running daemon will pick them up on the next check cycle."
            : "Changes saved. Start the daemon with 'start' to apply.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
