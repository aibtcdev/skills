#!/usr/bin/env bun
/**
 * Pillar skill CLI — Browser-handoff mode
 * Creates an operation on the Pillar backend, opens the Pillar frontend in
 * the user's browser for signing, then polls for the result.
 *
 * Usage: bun run pillar/pillar.ts <subcommand> [options]
 */

import { Command } from "commander";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getPillarApi } from "../src/lib/services/pillar-api.service.js";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PILLAR_FRONTEND_URL = "https://pillarbtc.com";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = parseInt(process.env.PILLAR_POLL_TIMEOUT_MS || "300000", 10);
const MCP_DEFAULT_REFERRAL =
  process.env.PILLAR_DEFAULT_REFERRAL ||
  "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.beta-v2-wallet";
const SESSION_FILE = path.join(os.homedir(), ".aibtc", "pillar-session.json");

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

interface PillarSession {
  walletAddress: string;
  walletName?: string;
  connectedAt: number;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSession(): PillarSession | null {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

function saveSession(session: PillarSession): void {
  ensureDir(SESSION_FILE);
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    // Ignore errors
  }
}

// ---------------------------------------------------------------------------
// Browser opener (cross-platform)
// ---------------------------------------------------------------------------

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let cmd: string;

    if (platform === "darwin") {
      cmd = `open "${url}"`;
    } else if (platform === "win32") {
      cmd = `start "" "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Operation polling
// ---------------------------------------------------------------------------

async function pollOperationStatus(
  opId: string,
  timeoutMs: number = POLL_TIMEOUT_MS
): Promise<{
  status: string;
  txId?: string;
  walletAddress?: string;
  walletName?: string;
  error?: string;
}> {
  const api = getPillarApi();
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await api.get<{
        status: string;
        txId?: string;
        walletAddress?: string;
        walletName?: string;
        error?: string;
      }>(`/api/mcp/op-status/${opId}`);

      if (result.status === "completed" || result.status === "failed" || result.status === "cancelled") {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  return { status: "timeout", error: "Operation timed out waiting for completion" };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("pillar")
  .description(
    "Pillar smart wallet browser-handoff operations: connect, send, fund, supply, boost, unwind, position, and DCA management"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

program
  .command("connect")
  .description(
    "Connect to your Pillar smart wallet. Opens the Pillar website — if logged in, " +
      "it automatically connects and saves your wallet address locally."
  )
  .action(async () => {
    try {
      const api = getPillarApi();

      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "connect",
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.walletAddress) {
        const session: PillarSession = {
          walletAddress: result.walletAddress,
          walletName: result.walletName,
          connectedAt: Date.now(),
        };
        saveSession(session);

        printJson({
          success: true,
          message: "Connected to Pillar!",
          walletAddress: result.walletAddress,
          walletName: result.walletName,
        });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: result.error || "Failed to connect. Make sure you're logged into Pillar.",
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Connection cancelled." });
        return;
      }

      printJson({
        success: false,
        message: "Timed out waiting for connection. Please try again.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

program
  .command("disconnect")
  .description("Disconnect from Pillar. Clears locally stored wallet address.")
  .action(() => {
    const session = loadSession();
    clearSession();
    printJson({
      success: true,
      message: session
        ? `Disconnected from ${session.walletName || session.walletAddress}`
        : "Not connected to Pillar.",
    });
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Check if connected to Pillar and get your wallet address.")
  .action(() => {
    const session = loadSession();
    if (session) {
      printJson({
        connected: true,
        walletAddress: session.walletAddress,
        walletName: session.walletName,
        connectedAt: new Date(session.connectedAt).toISOString(),
      });
    } else {
      printJson({
        connected: false,
        message: "Not connected to Pillar. Use 'connect' to connect.",
      });
    }
  });

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

program
  .command("send")
  .description(
    "Send sBTC from your Pillar smart wallet. Opens the frontend for signing, " +
      "then waits for confirmation. Requires being connected first."
  )
  .requiredOption(
    "--to <recipient>",
    "Recipient: BNS name (muneeb.btc), Pillar wallet name, or Stacks address (SP...)"
  )
  .requiredOption("--amount <satoshis>", "Amount in satoshis")
  .option(
    "--recipient-type <type>",
    "Type of recipient: bns (default), wallet, or address",
    "bns"
  )
  .action(async (opts: { to: string; amount: string; recipientType: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const amount = parseInt(opts.amount, 10);
      if (isNaN(amount) || amount <= 0) {
        throw new Error("--amount must be a positive integer (satoshis)");
      }

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "send",
        walletAddress: session.walletAddress,
        params: { to: opts.to, amount, recipientType: opts.recipientType },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        printJson({
          success: true,
          message: "Transaction submitted successfully!",
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Transaction was cancelled by user." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Transaction failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({
        success: false,
        message: "Timed out waiting for transaction. Check the frontend to see if it completed.",
        opId,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// fund
// ---------------------------------------------------------------------------

program
  .command("fund")
  .description(
    "Fund your Pillar smart wallet. Supports: exchange (from Coinbase/Binance), " +
      "btc (from Leather/Xverse BTC), sbtc (from Leather/Xverse sBTC)."
  )
  .requiredOption(
    "--method <method>",
    "Funding method: exchange, btc, or sbtc"
  )
  .option("--amount <satoshis>", "Amount in satoshis (optional, can be set in UI)")
  .action(async (opts: { method: string; amount?: string }) => {
    try {
      const validMethods = ["exchange", "btc", "sbtc"];
      if (!validMethods.includes(opts.method)) {
        throw new Error(`--method must be one of: ${validMethods.join(", ")}`);
      }

      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const amount = opts.amount ? parseInt(opts.amount, 10) : undefined;
      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "fund",
        walletAddress: session.walletAddress,
        params: { method: opts.method, amount },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        const methodLabels: Record<string, string> = {
          exchange: "Exchange deposit",
          btc: "BTC deposit",
          sbtc: "sBTC deposit",
        };
        printJson({
          success: true,
          message: `${methodLabels[opts.method] || "Deposit"} submitted successfully!`,
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Deposit cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Deposit failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for deposit.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// add-admin
// ---------------------------------------------------------------------------

program
  .command("add-admin")
  .description(
    "Add a backup admin address to your Pillar smart wallet for recovery purposes."
  )
  .option(
    "--admin-address <address>",
    "Stacks address (SP...) to add as backup admin (can be set in UI)"
  )
  .action(async (opts: { adminAddress?: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "add-admin",
        walletAddress: session.walletAddress,
        params: { adminAddress: opts.adminAddress },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        printJson({
          success: true,
          message: "Backup admin added successfully!",
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Add admin cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Add admin failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for add admin.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// supply
// ---------------------------------------------------------------------------

program
  .command("supply")
  .description(
    "Earn yield on your Bitcoin. Supply sBTC to Zest Protocol. " +
      "No leverage, no liquidation risk."
  )
  .option("--amount <satoshis>", "Amount in satoshis (optional, can be set in UI)")
  .action(async (opts: { amount?: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const amount = opts.amount ? parseInt(opts.amount, 10) : undefined;
      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "supply",
        walletAddress: session.walletAddress,
        params: { amount },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        printJson({
          success: true,
          message: "Supply to Zest submitted successfully!",
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Supply cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Supply failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for supply.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// auto-compound
// ---------------------------------------------------------------------------

program
  .command("auto-compound")
  .description(
    "Configure auto-compound for your Pillar wallet. When enabled, a keeper " +
      "automatically boosts when sBTC accumulates in your wallet."
  )
  .option("--min-sbtc <sats>", "Minimum sBTC to keep in wallet (sats)")
  .option(
    "--trigger <sats>",
    "Amount above minimum that triggers auto-compound (sats)"
  )
  .action(async (opts: { minSbtc?: string; trigger?: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const minSbtc = opts.minSbtc ? parseInt(opts.minSbtc, 10) : undefined;
      const trigger = opts.trigger ? parseInt(opts.trigger, 10) : undefined;

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "auto-compound",
        walletAddress: session.walletAddress,
        params: { minSbtc, trigger },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed") {
        printJson({ success: true, message: "Auto-compound settings saved!" });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Auto-compound setup cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Auto-compound setup failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for auto-compound setup.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// unwind
// ---------------------------------------------------------------------------

program
  .command("unwind")
  .description(
    "Close or reduce your leveraged sBTC position. Opens a modal to repay " +
      "borrowed sBTC and withdraw collateral back to your wallet."
  )
  .option("--percentage <percent>", "Percentage of position to unwind (1-100)")
  .action(async (opts: { percentage?: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const percentage = opts.percentage ? parseInt(opts.percentage, 10) : undefined;
      if (percentage !== undefined && (percentage < 1 || percentage > 100)) {
        throw new Error("--percentage must be between 1 and 100");
      }

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "unwind",
        walletAddress: session.walletAddress,
        params: { percentage },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        printJson({
          success: true,
          message: "Unwind position submitted successfully!",
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Unwind cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Unwind failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for unwind.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// boost
// ---------------------------------------------------------------------------

program
  .command("boost")
  .description(
    "Create or increase a leveraged sBTC position (up to 1.5x) on your Pillar smart wallet. " +
      "Opens the Boost tab where you can set the amount and confirm. " +
      "Amounts over 100,000 sats automatically enter DCA mode."
  )
  .option("--amount <satoshis>", "Amount in satoshis to boost (optional, shown as suggestion)")
  .action(async (opts: { amount?: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const amount = opts.amount ? parseInt(opts.amount, 10) : undefined;

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "boost",
        walletAddress: session.walletAddress,
        params: { amount },
      });

      const { opId } = createResult;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.txId) {
        printJson({
          success: true,
          message: "Boost position submitted successfully!",
          txId: result.txId,
          explorerUrl: getExplorerTxUrl(result.txId, NETWORK),
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Boost cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Boost failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({ success: false, message: "Timed out waiting for boost.", opId });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// position
// ---------------------------------------------------------------------------

program
  .command("position")
  .description(
    "View your Pillar wallet balance and Zest position. Opens the Position page " +
      "in the browser AND returns data (sBTC balance, collateral, USD values)."
  )
  .action(async () => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const walletAddress = session.walletAddress;

      // Fetch balances from Hiro API
      let sbtcBalance = 0;
      let zsbtcBalance = 0;

      try {
        const balanceRes = await fetch(
          `https://api.hiro.so/extended/v1/address/${walletAddress}/balances`
        );

        if (balanceRes.ok) {
          const balanceData = (await balanceRes.json()) as {
            fungible_tokens?: Record<string, { balance: string }>;
          };

          const sbtcKey = Object.keys(balanceData.fungible_tokens || {}).find((k) =>
            k.includes("sbtc-token")
          );
          if (sbtcKey && balanceData.fungible_tokens) {
            sbtcBalance = parseInt(balanceData.fungible_tokens[sbtcKey].balance) || 0;
          }

          const zsbtcKey = Object.keys(balanceData.fungible_tokens || {}).find((k) =>
            k.includes("zsbtc")
          );
          if (zsbtcKey && balanceData.fungible_tokens) {
            zsbtcBalance = parseInt(balanceData.fungible_tokens[zsbtcKey].balance) || 0;
          }
        }
      } catch {
        // Continue without balance data
      }

      // Fetch BTC price
      let btcPrice = 0;
      try {
        const priceRes = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
        );
        if (priceRes.ok) {
          const priceData = (await priceRes.json()) as { bitcoin?: { usd?: number } };
          btcPrice = priceData.bitcoin?.usd || 0;
        }
      } catch {
        // Continue without price
      }

      const formatBtc = (sats: number) =>
        (sats / 1e8).toFixed(8).replace(/\.?0+$/, "");
      const formatUsd = (usd: number) =>
        `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      const sbtcUsd = (sbtcBalance / 1e8) * btcPrice;
      const collateralUsd = (zsbtcBalance / 1e8) * btcPrice;
      const hasPosition = zsbtcBalance > 0;

      await openBrowser(`${PILLAR_FRONTEND_URL}/position`);

      printJson({
        success: true,
        walletAddress,
        walletName: session.walletName,
        walletBalance: {
          sbtc: sbtcBalance,
          sbtcFormatted: `${formatBtc(sbtcBalance)} sBTC`,
          sbtcUsd: btcPrice > 0 ? formatUsd(sbtcUsd) : null,
        },
        position: hasPosition
          ? {
              collateral: zsbtcBalance,
              collateralFormatted: `${formatBtc(zsbtcBalance)} BTC (zsBTC in Zest)`,
              collateralUsd: btcPrice > 0 ? formatUsd(collateralUsd) : null,
            }
          : null,
        message: hasPosition
          ? `Wallet: ${formatBtc(sbtcBalance)} sBTC | Collateral: ${formatBtc(zsbtcBalance)} BTC. See position page for borrowed, LTV, and liquidation price.`
          : `Wallet: ${formatBtc(sbtcBalance)} sBTC | No active position`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// create-wallet
// ---------------------------------------------------------------------------

program
  .command("create-wallet")
  .description(
    "Create a new Pillar smart wallet. Opens the Pillar website to complete registration."
  )
  .option(
    "--referral <address>",
    "Referral wallet address (optional, defaults to MCP referral)"
  )
  .action(async (opts: { referral?: string }) => {
    try {
      const existingSession = loadSession();
      if (existingSession) {
        printJson({
          success: false,
          message: `Already connected to wallet ${existingSession.walletName || existingSession.walletAddress}. Use 'disconnect' first if you want to create a new wallet.`,
        });
        return;
      }

      const api = getPillarApi();
      const createResult = await api.post<{ opId: string }>("/api/mcp/create-op", {
        action: "create-wallet",
        params: { referral: opts.referral || MCP_DEFAULT_REFERRAL },
      });

      const { opId } = createResult;
      const ref = opts.referral || MCP_DEFAULT_REFERRAL;
      await openBrowser(`${PILLAR_FRONTEND_URL}/?op=${opId}&ref=${ref}`);
      const result = await pollOperationStatus(opId);

      if (result.status === "completed" && result.walletAddress) {
        const session: PillarSession = {
          walletAddress: result.walletAddress,
          walletName: result.walletName,
          connectedAt: Date.now(),
        };
        saveSession(session);

        printJson({
          success: true,
          message: "Wallet created successfully!",
          walletAddress: result.walletAddress,
          walletName: result.walletName,
        });
        return;
      }

      if (result.status === "cancelled") {
        printJson({ success: false, message: "Wallet creation cancelled." });
        return;
      }

      if (result.status === "failed") {
        printJson({
          success: false,
          message: `Wallet creation failed: ${result.error || "Unknown error"}`,
        });
        return;
      }

      printJson({
        success: false,
        message: "Timed out waiting for wallet creation.",
        opId,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------

program
  .command("invite")
  .description("Get your Pillar referral link to invite friends.")
  .action(() => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const referralLink = `${PILLAR_FRONTEND_URL}/?ref=${session.walletAddress}`;

      printJson({
        success: true,
        referralLink,
        walletAddress: session.walletAddress,
        message: `Share this link to invite friends: ${referralLink}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// dca-invite
// ---------------------------------------------------------------------------

program
  .command("dca-invite")
  .description(
    "Invite a DCA partner by email or wallet address. " +
      "Both must boost each week to keep the streak alive."
  )
  .requiredOption(
    "--partner <email-or-address>",
    "Partner's email address or Stacks wallet address (SP...)"
  )
  .action(async (opts: { partner: string }) => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const isEmail = opts.partner.includes("@");
      const api = getPillarApi();
      const result = await api.post<{
        partnershipId: string;
        status: string;
        inviteLink?: string;
      }>("/api/dca-partner/invite", {
        walletAddress: session.walletAddress,
        ...(isEmail
          ? { partnerEmail: opts.partner }
          : { partnerWalletAddress: opts.partner }),
      });

      printJson({
        success: true,
        partnershipId: result.partnershipId,
        status: result.status,
        message: isEmail
          ? `Invite sent to ${opts.partner}. They'll receive an email with a link to accept.`
          : `Partnership invite sent to ${opts.partner}.`,
        ...(result.inviteLink ? { inviteLink: result.inviteLink } : {}),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// dca-partners
// ---------------------------------------------------------------------------

program
  .command("dca-partners")
  .description(
    "View your DCA partners and weekly status. Shows active partnerships with " +
      "streak, PnL, and weekly status badges, plus any pending invites."
  )
  .action(async () => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const api = getPillarApi();
      const result = await api.get<{
        partnerships: Array<{
          partnershipId: string;
          partnerName?: string;
          partnerAddress: string;
          streak: number;
          pnl?: number;
          myStatus: string;
          partnerStatus: string;
          status: string;
        }>;
        pendingInvites: Array<{
          partnershipId: string;
          partnerEmail?: string;
          partnerAddress?: string;
          direction: string;
        }>;
      }>("/api/dca-partner/my-partners", { walletAddress: session.walletAddress });

      const active = result.partnerships.filter((p) => p.status === "active");
      const pending = result.pendingInvites || [];

      printJson({
        success: true,
        activePartnerships: active.map((p) => ({
          partnershipId: p.partnershipId,
          partner: p.partnerName || p.partnerAddress,
          streak: p.streak,
          pnl: p.pnl,
          myStatus: p.myStatus,
          partnerStatus: p.partnerStatus,
        })),
        pendingInvites: pending.length,
        pendingDetails: pending.map((p) => ({
          partnershipId: p.partnershipId,
          partner: p.partnerEmail || p.partnerAddress,
          direction: p.direction,
        })),
        message:
          active.length > 0
            ? `${active.length} active partnership${active.length > 1 ? "s" : ""}, ${pending.length} pending invite${pending.length !== 1 ? "s" : ""}`
            : `No active partnerships. ${pending.length} pending invite${pending.length !== 1 ? "s" : ""}. Use 'dca-invite' to invite a partner.`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// dca-leaderboard
// ---------------------------------------------------------------------------

program
  .command("dca-leaderboard")
  .description(
    "View the DCA streak leaderboard. Shows top partnerships by streak length."
  )
  .action(async () => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const api = getPillarApi();
      const result = await api.get<{
        leaderboard: Array<{
          rank: number;
          partnerNames: string[];
          streak: number;
          pnl?: number;
          isUser?: boolean;
        }>;
        userEntry?: {
          rank: number;
          partnerName: string;
          streak: number;
          pnl?: number;
        };
      }>("/api/dca-partner/leaderboard", { walletAddress: session.walletAddress });

      printJson({
        success: true,
        leaderboard: result.leaderboard.map((entry) => ({
          rank: entry.rank,
          partners: entry.partnerNames.join(" & "),
          streak: entry.streak,
          pnl: entry.pnl,
          isYou: entry.isUser || false,
        })),
        yourRank: result.userEntry
          ? {
              rank: result.userEntry.rank,
              partner: result.userEntry.partnerName,
              streak: result.userEntry.streak,
              pnl: result.userEntry.pnl,
            }
          : null,
        message: result.userEntry
          ? `You're ranked #${result.userEntry.rank} with a ${result.userEntry.streak}-week streak with ${result.userEntry.partnerName}.`
          : "You don't have an active partnership on the leaderboard yet. Use 'dca-invite' to get started.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// dca-status
// ---------------------------------------------------------------------------

interface DcaScheduleInfo {
  id: string;
  totalSbtcAmount: number;
  chunkSizeSats: number;
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  status: string;
  btcPriceAtCreation: number | null;
  createdAt: number;
  completedAt: number | null;
}

interface DcaChunkInfo {
  id: string;
  chunkIndex: number;
  sbtcAmount: number;
  status: string;
  scheduledAt: number;
  executedAt: number | null;
  txId: string | null;
  retryCount: number;
  errorMessage: string | null;
}

interface DcaStatusResult {
  schedule: DcaScheduleInfo;
  chunks: DcaChunkInfo[];
  allSchedules?: { schedule: DcaScheduleInfo; chunks: DcaChunkInfo[] }[];
  activeCount?: number;
  maxSchedules?: number;
}

function formatSchedule(s: DcaScheduleInfo, chunks: DcaChunkInfo[]) {
  const pendingChunks = chunks.filter(
    (c) => c.status === "pending" || c.status === "executing"
  ).length;
  const nextPending = chunks
    .filter((c) => c.status === "pending")
    .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
  const nextExecution = nextPending
    ? new Date(nextPending.scheduledAt).toISOString()
    : null;

  return {
    id: s.id,
    status: s.status,
    totalSbtcAmount: s.totalSbtcAmount,
    chunkSizeSats: s.chunkSizeSats,
    progress: `${s.completedChunks}/${s.totalChunks} chunks completed`,
    completedChunks: s.completedChunks,
    pendingChunks,
    failedChunks: s.failedChunks,
    nextExecution,
    createdAt: new Date(s.createdAt).toISOString(),
  };
}

program
  .command("dca-status")
  .description(
    "Check your DCA schedule status. Shows all active DCA schedules (up to 10) " +
      "with chunk progress and next execution time."
  )
  .action(async () => {
    try {
      const session = loadSession();
      if (!session) {
        printJson({
          success: false,
          message: "Not connected to Pillar. Please use 'connect' first.",
        });
        return;
      }

      const api = getPillarApi();
      const raw = await api.get<{ success: boolean; data: DcaStatusResult | null }>(
        "/api/pillar/dca-status",
        { walletAddress: session.walletAddress }
      );

      const result = raw.data;

      if (!result) {
        printJson({
          success: true,
          hasSchedule: false,
          activeCount: 0,
          maxSchedules: 10,
          message: "No active DCA schedule. Use 'boost' with an amount over 100,000 sats to start one.",
        });
        return;
      }

      const allSchedules = result.allSchedules || [
        { schedule: result.schedule, chunks: result.chunks },
      ];
      const activeCount =
        result.activeCount ?? (result.schedule.status === "active" ? 1 : 0);
      const maxSchedules = result.maxSchedules ?? 10;

      const schedules = allSchedules.map((entry) =>
        formatSchedule(entry.schedule, entry.chunks)
      );

      const activeSchedules = schedules.filter((s) => s.status === "active");

      if (activeSchedules.length === 0) {
        const latest = schedules[0];
        printJson({
          success: true,
          hasSchedule: true,
          activeCount: 0,
          maxSchedules,
          schedule: latest,
          message: `DCA ${latest.status}: ${latest.progress}.`,
        });
        return;
      }

      if (activeSchedules.length === 1) {
        const s = activeSchedules[0];
        printJson({
          success: true,
          hasSchedule: true,
          activeCount,
          maxSchedules,
          schedule: s,
          message: `DCA active: ${s.progress} (${s.chunkSizeSats} sats/chunk). Next: ${s.nextExecution || "pending"}.`,
        });
        return;
      }

      const summaries = activeSchedules.map(
        (s) =>
          `Schedule ${s.id.slice(0, 8)}: ${s.progress}, next: ${s.nextExecution || "pending"}`
      );
      printJson({
        success: true,
        hasSchedule: true,
        activeCount,
        maxSchedules,
        schedules: activeSchedules,
        message: `${activeCount} active DCA schedules (max ${maxSchedules}):\n${summaries.join("\n")}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
