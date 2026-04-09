#!/usr/bin/env bun
/**
 * Relay Diagnostic skill CLI
 * Operator relay diagnostics and sponsor nonce recovery for stuck sponsored transactions.
 * This tool does not define caller-facing payment states.
 *
 * Usage: bun run relay-diagnostic/relay-diagnostic.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getSponsorRelayUrl, getSponsorApiKey } from "../src/lib/config/sponsor.js";
import { checkRelayHealth } from "../src/lib/services/relay-health.service.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelayRecoveryResult {
  supported: boolean;
  message?: string;
  result?: unknown;
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
    "Operator relay diagnostics and sponsor nonce recovery — diagnose stuck sponsored transactions and attempt automated RBF or gap-fill recovery without redefining caller-facing payment state"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// check-health
// ---------------------------------------------------------------------------

program
  .command("check-health")
  .description(
    "Check the sponsor relay health and nonce status. Read-only — no wallet required. " +
      "Inspects operator diagnostics only: relay availability, sponsor nonce state, nonce gaps, mempool desync, and stuck transactions."
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
          ? "Recovery request sent to relay. Run check-health to verify nonce state improved."
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
