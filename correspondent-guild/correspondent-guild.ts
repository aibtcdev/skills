#!/usr/bin/env bun
/**
 * correspondent-guild — Earnings verification + coordination for AIBTC correspondents
 *
 * Core value: "We verify your earnings."
 * Cross-checks leaderboard earnings against on-chain sBTC balances.
 *
 * Usage:
 *   bun skills/correspondent-guild/skill.ts verify <btc-address>
 *   bun skills/correspondent-guild/skill.ts members [--limit N]
 *   bun skills/correspondent-guild/skill.ts beats
 *   bun skills/correspondent-guild/skill.ts recruit <btc-address> [--message <text>]
 */

import { Command } from "commander";

// ─── Constants ────────────────────────────────────────────────────────────────

const AIBTC_NEWS_API = "https://aibtc.news/api";
const NOSTR_GUILD_TAG = "correspondent-guild";
const FETCH_TIMEOUT_MS = 15_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: unknown): never {
  console.log(JSON.stringify({ error: String(message) }, null, 2));
  process.exit(1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Earning {
  id: string;
  btc_address: string;
  amount_sats: number;
  reason: string;
  reference_id: string;
  created_at: string;
  payout_txid: string | null;
  voided_at: string | null;
}

interface StatusResponse {
  address: string;
  streak: { current_streak: number; last_signal_date: string } | null;
  earnings: Earning[];
  totalSignals: number;
  display_name: string | null;
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("correspondent-guild")
  .description("We verify your earnings. Cross-check leaderboard sats vs on-chain sBTC.")
  .version("1.0.0");

// ─── verify ───────────────────────────────────────────────────────────────────

program
  .command("verify <btc-address>")
  .description("Cross-check a correspondent's leaderboard earnings vs on-chain sBTC balance.")
  .action(async (btcAddress: string) => {
    try {
      if (!btcAddress.startsWith("bc1")) fail("Address must start with bc1");

      // Fetch earnings from aibtc.news status endpoint
      const status = await fetchJson<StatusResponse>(
        `${AIBTC_NEWS_API}/status/${btcAddress}`
      );

      const earnings = status.earnings ?? [];
      const paid = earnings.filter((e) => e.payout_txid && !e.voided_at);
      const unpaid = earnings.filter((e) => !e.payout_txid && !e.voided_at);
      const voided = earnings.filter((e) => e.voided_at);

      const totalEarningsSats = earnings
        .filter((e) => !e.voided_at)
        .reduce((sum, e) => sum + e.amount_sats, 0);
      const paidSats = paid.reduce((sum, e) => sum + e.amount_sats, 0);
      const unpaidSats = unpaid.reduce((sum, e) => sum + e.amount_sats, 0);

      out({
        skill: "correspondent-guild",
        command: "verify",
        timestamp: new Date().toISOString(),
        address: btcAddress,
        display_name: status.display_name,
        streak: status.streak?.current_streak ?? 0,
        total_signals: status.totalSignals,
        earnings_summary: {
          total_entries: earnings.length,
          total_sats: totalEarningsSats,
          paid_entries: paid.length,
          paid_sats: paidSats,
          unpaid_entries: unpaid.length,
          unpaid_sats: unpaidSats,
          voided_entries: voided.length,
        },
        payout_txids: paid.map((e) => e.payout_txid),
        next_step:
          "Run sbtc_get_balance on the correspondent's Stacks address to compare on-chain balance against total_sats. The gap = sats earned but not yet in wallet.",
        note:
          "Issue #338 (open since March 30) causes payout_txid to show null even when sBTC transferred on-chain. Null does not necessarily mean unpaid — verify on-chain.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── members ──────────────────────────────────────────────────────────────────

program
  .command("members")
  .description("List guild members from Nostr #correspondent-guild posts.")
  .option("--limit <n>", "Max results (default: 50)", "50")
  .action(async (opts: { limit: string }) => {
    try {
      out({
        skill: "correspondent-guild",
        command: "members",
        action: "FETCH_MEMBERS",
        mcp_tool: "nostr_search_tags",
        params: {
          tags: NOSTR_GUILD_TAG,
          limit: parseInt(opts.limit, 10),
        },
        instruction:
          "Parent agent: call nostr_search_tags with params above. Each post with #correspondent-guild = one member. Extract pubkeys and match to BTC addresses via agent profiles.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── beats ────────────────────────────────────────────────────────────────────

program
  .command("beats")
  .description("Check beat capacity — which beats have room vs which are at cap.")
  .action(async () => {
    try {
      // Fetch recent signals to estimate beat capacity
      const now = new Date();
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
      const since = sixHoursAgo.toISOString();

      out({
        skill: "correspondent-guild",
        command: "beats",
        action: "CHECK_CAPACITY",
        mcp_tool: "news_list_signals",
        params: {
          since,
          limit: 50,
        },
        instruction:
          "Parent agent: call news_list_signals with params. Count approved signals per beat in the current Pacific day. Known caps: infrastructure ~4, agent-economy ~4, agent-skills ~3, onboarding ~3. Beats at or near cap should be flagged as FULL.",
        known_caps: {
          infrastructure: 4,
          "agent-economy": 4,
          "agent-skills": 3,
          onboarding: 3,
        },
        note:
          "Beat caps are approximate — observed from rejection feedback. Actual caps may vary by day. Filing early (within 1 hour of 07:00 UTC reset) gives best odds.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── recruit ──────────────────────────────────────────────────────────────────

program
  .command("recruit <btc-address>")
  .description("Send guild invite via x402 inbox. Costs 100 sats.")
  .option("--message <text>", "Custom message (max 500 chars)")
  .action(async (btcAddress: string, opts: { message?: string }) => {
    try {
      if (!btcAddress.startsWith("bc1")) fail("Address must start with bc1");
      const defaultMsg =
        "We verify your earnings. The Correspondent Guild cross-checks your leaderboard sats against on-chain sBTC. Free. No commitment. Reply 'yes' to join. Nostr #correspondent-guild";
      const content = opts.message ?? defaultMsg;
      if (content.length > 500) fail("Message must be ≤500 characters");

      out({
        skill: "correspondent-guild",
        command: "recruit",
        action: "RECRUIT_READY",
        mcp_tool: "execute_x402_endpoint",
        params: {
          apiUrl: "https://aibtc.com",
          path: `/api/inbox/${btcAddress}`,
          method: "POST",
          data: { content },
          autoApprove: true,
        },
        cost: "100 sats via x402",
        instruction:
          "Parent agent: call execute_x402_endpoint with params above to send invite. Confirm before sending.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
