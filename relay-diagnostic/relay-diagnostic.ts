#!/usr/bin/env bun
/**
 * Relay Diagnostic skill CLI
 * Sponsor relay health checks and nonce recovery for stuck sponsored transactions
 *
 * Usage: bun run relay-diagnostic/relay-diagnostic.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getApiBaseUrl } from "../src/lib/config/networks.js";
import { getSponsorRelayUrl, getSponsorApiKey } from "../src/lib/config/sponsor.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StuckTransaction {
  txid: string;
  nonce: number;
  pendingSeconds: number;
}

interface NonceStatus {
  lastExecuted: number;
  lastMempool: number | null;
  possibleNext: number;
  missingNonces: number[];
  mempoolNonces: number[];
  hasGaps: boolean;
  gapCount: number;
  mempoolDesync: boolean;
  desyncGap: number;
}

interface RelayHealthStatus {
  healthy: boolean;
  network: string;
  version?: string;
  sponsorAddress?: string;
  nonceStatus?: NonceStatus;
  stuckTransactions?: StuckTransaction[];
  issues?: string[];
}

interface HiroNonceInfo {
  last_executed_tx_nonce: number | null;
  last_mempool_tx_nonce: number | null;
  possible_next_nonce: number;
  detected_missing_nonces: number[];
  detected_mempool_nonces: number[];
}

interface RelayRecoveryResult {
  supported: boolean;
  message?: string;
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPONSOR_ADDRESSES: Partial<Record<string, string>> = {
  mainnet: "SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7",
};

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function getNonceInfo(
  network: "mainnet" | "testnet",
  address: string
): Promise<HiroNonceInfo> {
  const baseUrl = getApiBaseUrl(network);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(
      `${baseUrl}/extended/v1/address/${address}/nonces`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      throw new Error(
        `Failed to fetch nonce info for ${address}: HTTP ${res.status}`
      );
    }
    return (await res.json()) as HiroNonceInfo;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkRelayHealth(
  network: "mainnet" | "testnet"
): Promise<RelayHealthStatus & { formatted: string }> {
  const relayUrl = getSponsorRelayUrl(network);
  const issues: string[] = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let healthData: { status?: string; version?: string };
    try {
      const healthRes = await fetch(`${relayUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });

      if (!healthRes.ok) {
        issues.push(`Relay health check failed: HTTP ${healthRes.status}`);
        const status: RelayHealthStatus = { healthy: false, network, issues };
        return { ...status, formatted: formatRelayHealthStatus(status) };
      }

      healthData = (await healthRes.json()) as {
        status?: string;
        version?: string;
      };
    } finally {
      clearTimeout(timeout);
    }

    const version = healthData.version;

    if (healthData.status !== "ok") {
      issues.push(`Relay status: ${healthData.status ?? "unknown"}`);
    }

    const sponsorAddress = SPONSOR_ADDRESSES[network];
    if (!sponsorAddress) {
      issues.push("Unknown sponsor address for network");
      const status: RelayHealthStatus = {
        healthy: issues.length === 0,
        network,
        version,
        issues: issues.length > 0 ? issues : undefined,
      };
      return { ...status, formatted: formatRelayHealthStatus(status) };
    }

    const nonceInfo = await getNonceInfo(network, sponsorAddress);

    const hasGaps = nonceInfo.detected_missing_nonces.length > 0;
    const gapCount = nonceInfo.detected_missing_nonces.length;
    const lastExecuted = nonceInfo.last_executed_tx_nonce ?? 0;
    const lastMempool = nonceInfo.last_mempool_tx_nonce ?? null;
    const desyncGap = lastMempool !== null ? lastMempool - lastExecuted : 0;
    const mempoolDesync = desyncGap > 5;

    if (hasGaps) {
      const preview = nonceInfo.detected_missing_nonces.slice(0, 5).join(", ");
      issues.push(
        `Sponsor has ${gapCount} missing nonce(s): ${preview}${gapCount > 5 ? "..." : ""}`
      );
    }

    if (mempoolDesync) {
      issues.push(
        `Mempool desync detected: sponsor nonce ${lastExecuted} (executed) vs ${lastMempool} (mempool), gap of ${desyncGap}`
      );
    } else if (nonceInfo.detected_mempool_nonces.length > 10) {
      issues.push(
        `Sponsor has ${nonceInfo.detected_mempool_nonces.length} transactions stuck in mempool`
      );
    }

    const nonceStatus: NonceStatus = {
      lastExecuted,
      lastMempool,
      possibleNext: nonceInfo.possible_next_nonce,
      missingNonces: nonceInfo.detected_missing_nonces,
      mempoolNonces: nonceInfo.detected_mempool_nonces,
      hasGaps,
      gapCount,
      mempoolDesync,
      desyncGap,
    };

    let stuckTransactions: StuckTransaction[] | undefined;
    try {
      const hiroApi = getHiroApi(network);
      const mempoolRes = await hiroApi.getMempoolTransactions({
        sender_address: sponsorAddress,
        limit: 50,
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const stuck = mempoolRes.results
        .filter((tx) => nowSeconds - tx.receipt_time > 600)
        .map((tx) => ({
          txid: tx.tx_id,
          nonce: tx.nonce,
          pendingSeconds: nowSeconds - tx.receipt_time,
        }))
        .sort((a, b) => b.pendingSeconds - a.pendingSeconds)
        .slice(0, 10);

      if (stuck.length > 0) {
        stuckTransactions = stuck;
      }
    } catch {
      // Non-fatal: stuck-tx fetch is best-effort
    }

    const status: RelayHealthStatus = {
      healthy: issues.length === 0,
      network,
      version,
      sponsorAddress,
      nonceStatus,
      stuckTransactions,
      issues: issues.length > 0 ? issues : undefined,
    };

    return { ...status, formatted: formatRelayHealthStatus(status) };
  } catch (error) {
    issues.push(
      `Relay health check error: ${error instanceof Error ? error.message : String(error)}`
    );
    const status: RelayHealthStatus = { healthy: false, network, issues };
    return { ...status, formatted: formatRelayHealthStatus(status) };
  }
}

function formatRelayHealthStatus(status: RelayHealthStatus): string {
  const lines: string[] = [];

  lines.push(`Relay Health Check (${status.network})`);
  lines.push(`Status: ${status.healthy ? "HEALTHY" : "UNHEALTHY"}`);

  if (status.version) lines.push(`Version: ${status.version}`);
  if (status.sponsorAddress) lines.push(`Sponsor: ${status.sponsorAddress}`);

  if (status.nonceStatus) {
    const ns = status.nonceStatus;
    lines.push("");
    lines.push("Nonce Status:");
    lines.push(`  Last executed: ${ns.lastExecuted}`);
    lines.push(`  Last mempool: ${ns.lastMempool ?? "none"}`);
    lines.push(`  Next nonce: ${ns.possibleNext}`);

    if (ns.hasGaps) {
      const preview = ns.missingNonces.slice(0, 10).join(", ");
      lines.push(
        `  GAPS Missing nonces (${ns.gapCount}): ${preview}${ns.gapCount > 10 ? "..." : ""}`
      );
    } else {
      lines.push("  OK No nonce gaps");
    }

    if (ns.mempoolDesync) {
      lines.push(
        `  DESYNC Mempool desync: executed=${ns.lastExecuted}, mempool=${ns.lastMempool ?? "none"}, gap=${ns.desyncGap}`
      );
    }

    if (ns.mempoolNonces.length > 0) {
      const preview = ns.mempoolNonces.slice(0, 10).join(", ");
      lines.push(
        `  WARN Mempool nonces (${ns.mempoolNonces.length}): ${preview}${ns.mempoolNonces.length > 10 ? "..." : ""}`
      );
    }
  }

  if (status.stuckTransactions && status.stuckTransactions.length > 0) {
    lines.push("");
    lines.push("Stuck Transactions:");
    for (const tx of status.stuckTransactions) {
      const minutes = Math.floor(tx.pendingSeconds / 60);
      const seconds = tx.pendingSeconds % 60;
      const duration = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      lines.push(`  nonce=${tx.nonce} pending=${duration} txid=${tx.txid}`);
    }
  }

  if (status.issues && status.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of status.issues) {
      lines.push(`  - ${issue}`);
    }
  }

  return lines.join("\n");
}

async function attemptRbf(
  network: "mainnet" | "testnet",
  txids?: string[],
  apiKey?: string
): Promise<RelayRecoveryResult> {
  const relayUrl = getSponsorRelayUrl(network);
  const resolvedKey = apiKey || getSponsorApiKey();

  if (!resolvedKey) {
    return {
      supported: true,
      message:
        "No sponsor API key available. Set SPONSOR_API_KEY env var or use a wallet with sponsorApiKey configured.",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolvedKey}`,
  };

  const body: Record<string, unknown> = {};
  if (txids && txids.length > 0) body.txids = txids;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${relayUrl}/recovery/rbf`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 501) {
      return {
        supported: false,
        message:
          "Relay does not support RBF recovery yet. Share stuck txids with the AIBTC team for manual recovery.",
      };
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay RBF failed: HTTP ${res.status} — ${text}`);
    }

    const result = await res.json();
    return { supported: true, result };
  } finally {
    clearTimeout(timeout);
  }
}

async function attemptFillGaps(
  network: "mainnet" | "testnet",
  nonces?: number[],
  apiKey?: string
): Promise<RelayRecoveryResult> {
  const relayUrl = getSponsorRelayUrl(network);
  const resolvedKey = apiKey || getSponsorApiKey();

  if (!resolvedKey) {
    return {
      supported: true,
      message:
        "No sponsor API key available. Set SPONSOR_API_KEY env var or use a wallet with sponsorApiKey configured.",
    };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolvedKey}`,
  };

  const body: Record<string, unknown> = {};
  if (nonces && nonces.length > 0) body.nonces = nonces;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${relayUrl}/recovery/fill-gaps`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 404 || res.status === 501) {
      return {
        supported: false,
        message:
          "Relay does not support nonce gap-fill recovery yet. Share missing nonces with the AIBTC team for manual recovery.",
      };
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Relay gap-fill failed: HTTP ${res.status} — ${text}`);
    }

    const result = await res.json();
    return { supported: true, result };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("relay-diagnostic")
  .description(
    "Sponsor relay health checks and nonce recovery — diagnose stuck sponsored transactions and attempt automated RBF or gap-fill recovery"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// check-health
// ---------------------------------------------------------------------------

program
  .command("check-health")
  .description(
    "Check the sponsor relay health and nonce status. Read-only — no wallet required. " +
      "Inspects relay availability, sponsor nonce state, nonce gaps, mempool desync, and stuck transactions."
  )
  .action(async () => {
    try {
      const status = await checkRelayHealth(NETWORK);
      printJson(status);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

program
  .command("recover")
  .description(
    "Attempt automated recovery of stuck sponsor transactions. " +
      "Run check-health first to identify stuck txids and missing nonces. " +
      "Requires an unlocked wallet to source the sponsor API key."
  )
  .option(
    "--action <action>",
    "Recovery mode: rbf, fill-gaps, or both (default: both)",
    "both"
  )
  .option(
    "--txids <txids>",
    "Comma-separated stuck transaction IDs for RBF (omit to bump all stuck txs)"
  )
  .option(
    "--nonces <nonces>",
    "Comma-separated missing nonces for gap-fill (omit to fill all detected gaps)"
  )
  .action(
    async (opts: { action: string; txids?: string; nonces?: string }) => {
      try {
        const action = opts.action as "rbf" | "fill-gaps" | "both";
        if (!["rbf", "fill-gaps", "both"].includes(action)) {
          throw new Error(
            `--action must be one of: rbf, fill-gaps, both (got "${opts.action}")`
          );
        }

        const txids = opts.txids
          ? opts.txids
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;

        const nonces = opts.nonces
          ? opts.nonces
              .split(",")
              .map((n) => parseInt(n.trim(), 10))
              .filter((n) => !isNaN(n) && n >= 0)
          : undefined;

        // Resolve API key from wallet (if unlocked)
        let walletApiKey: string | undefined;
        try {
          const walletAccount = getWalletManager().getAccount();
          walletApiKey = (walletAccount as Record<string, unknown>)
            ?.sponsorApiKey as string | undefined;
        } catch {
          // Wallet not unlocked — fall back to env var in attemptRbf/attemptFillGaps
        }

        const results: Record<string, unknown> = { action };

        if (action === "rbf" || action === "both") {
          results.rbf = await attemptRbf(NETWORK, txids, walletApiKey);
        }

        if (action === "fill-gaps" || action === "both") {
          results.fillGaps = await attemptFillGaps(NETWORK, nonces, walletApiKey);
        }

        const anyUnsupported = Object.values(results).some(
          (r) =>
            r &&
            typeof r === "object" &&
            "supported" in r &&
            !(r as { supported: boolean }).supported
        );
        const anySupported = Object.values(results).some(
          (r) =>
            r &&
            typeof r === "object" &&
            "supported" in r &&
            (r as { supported: boolean }).supported
        );

        results.summary = anySupported
          ? "Recovery request submitted to relay. Run check-health to verify nonce state improved."
          : anyUnsupported
          ? "Relay does not yet support automated recovery. Run check-health for txids and nonces to share with the AIBTC team."
          : "Recovery attempted.";

        printJson(results);
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
