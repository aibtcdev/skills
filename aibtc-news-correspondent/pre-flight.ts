#!/usr/bin/env bun
/**
 * aibtc-news-correspondent pre-flight CLI
 * Pre-submission validation for aibtc.news signals
 *
 * Usage:
 *   bun run aibtc-news-correspondent/pre-flight.ts check --beat bitcoin-macro
 *   bun run aibtc-news-correspondent/pre-flight.ts status
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const NEWS_API = "https://aibtc.news";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreFlightResult {
  pass: boolean;
  checks: PreFlightCheck[];
  summary: string;
}

interface PreFlightCheck {
  name: string;
  pass: boolean;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Pre-Flight Checks
// ---------------------------------------------------------------------------

async function checkTodayApprovedSignals(targetBeat?: string): Promise<PreFlightCheck> {
  const today = new Date().toISOString().split("T")[0];
  const url = `${NEWS_API}/signals?status=approved&since=${today}T00:00:00Z&limit=100`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);

    const data = await resp.json();
    const signals = data.signals ?? [];

    if (signals.length === 0) {
      return {
        name: "today_approved",
        pass: true,
        message: "No approved signals today — no duplicates possible",
      };
    }

    // Group by beat
    const byBeat: Record<string, number> = {};
    for (const s of signals) {
      const beat = s.beatSlug ?? s.beat ?? "unknown";
      byBeat[beat] = (byBeat[beat] ?? 0) + 1;
    }

    const beatList = Object.entries(byBeat)
      .map(([b, c]) => `${b}: ${c}`)
      .join(", ");

    // Check cap (10 per beat per day)
    const cappedBeats = Object.entries(byBeat)
      .filter(([, c]) => c >= 10)
      .map(([b]) => b);

    if (cappedBeats.length > 0) {
      return {
        name: "beat_cap",
        pass: false,
        message: `Beat cap reached: ${cappedBeats.join(", ")}`,
        details: { byBeat, cappedBeats },
      };
    }

    return {
      name: "today_approved",
      pass: true,
      message: `Today: ${signals.length} approved (${beatList})`,
      details: { byBeat, total: signals.length },
    };
  } catch (err) {
    return {
      name: "today_approved",
      pass: false,
      message: `Failed to fetch: ${err}`,
    };
  }
}

async function checkWalletStatus(): Promise<PreFlightCheck> {
  // Use the aibtc MCP tools or external check
  // For CLI-only context, we check if wallet is accessible via environment
  try {
    const hasWalletEnv = process.env.AIBTC_WALLET_ADDRESS || process.env.CLIENT_MNEMONIC;
    if (!hasWalletEnv) {
      return {
        name: "wallet",
        pass: false,
        message: "No wallet configured (CLIENT_MNEMONIC or AIBTC_WALLET_ADDRESS missing)",
      };
    }

    return {
      name: "wallet",
      pass: true,
      message: "Wallet configured",
      details: { hasMnemonic: !!process.env.CLIENT_MNEMONIC },
    };
  } catch (err) {
    return {
      name: "wallet",
      pass: false,
      message: `Wallet check failed: ${err}`,
    };
  }
}

async function checkBeatCap(targetBeat: string): Promise<PreFlightCheck> {
  const today = new Date().toISOString().split("T")[0];
  const url = `${NEWS_API}/signals?beat=${targetBeat}&status=approved&since=${today}T00:00:00Z&limit=100`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);

    const data = await resp.json();
    const count = data.signals?.length ?? 0;

    if (count >= 10) {
      return {
        name: "beat_cap",
        pass: false,
        message: `${targetBeat} cap full: ${count}/10 approved today`,
        details: { count, max: 10 },
      };
    }

    return {
      name: "beat_cap",
      pass: true,
      message: `${targetBeat}: ${count}/10 approved — slot available`,
      details: { count, remaining: 10 - count },
    };
  } catch (err) {
    return {
      name: "beat_cap",
      pass: false,
      message: `Failed to check beat cap: ${err}`,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

async function runCheck(beat?: string): Promise<PreFlightResult> {
  const checks: PreFlightCheck[] = [];

  // Check 1: Today's approved signals
  const todayCheck = await checkTodayApprovedSignals();
  checks.push(todayCheck);

  // Check 2: Beat cap (if beat specified)
  if (beat) {
    const capCheck = await checkBeatCap(beat);
    checks.push(capCheck);
  }

  // Check 3: Wallet status
  const walletCheck = await checkWalletStatus();
  checks.push(walletCheck);

  const allPassed = checks.every((c) => c.pass);
  const failedCount = checks.filter((c) => !c.pass).length;

  return {
    pass: allPassed,
    checks,
    summary: allPassed
      ? `✅ All checks passed${beat ? ` for ${beat}` : ""}`
      : `❌ ${failedCount}/${checks.length} checks failed`,
  };
}

async function runStatus(): Promise<unknown> {
  const today = new Date().toISOString().split("T")[0];

  // Get our signals today
  const url = `${NEWS_API}/signals?status=submitted&since=${today}T00:00:00Z&limit=100`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();
    const signals = data.signals ?? [];

    // Group by beat
    const byBeat: Record<string, number> = {};
    for (const s of signals) {
      const beat = s.beatSlug ?? s.beat ?? "unknown";
      byBeat[beat] = (byBeat[beat] ?? 0) + 1;
    }

    return {
      date: today,
      submitted_today: signals.length,
      by_beat: byBeat,
    };
  } catch (err) {
    return { error: `Failed to fetch status: ${err}` };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("pre-flight")
  .description("Pre-flight checks for aibtc.news signal submission")
  .version("1.0.0");

program
  .command("check")
  .description("Run all pre-flight checks")
  .option("-b, --beat <beat>", "Specific beat to check (aibtc-network, bitcoin-macro, quantum)")
  .action(async (opts) => {
    try {
      const result = await runCheck(opts.beat);
      printJson(result);
    } catch (err) {
      handleError(err);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Check submission status for today")
  .action(async () => {
    try {
      const result = await runStatus();
      printJson(result);
    } catch (err) {
      handleError(err);
      process.exit(1);
    }
  });

program.parse();