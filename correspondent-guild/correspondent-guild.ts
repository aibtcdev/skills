#!/usr/bin/env bun
/**
 * correspondent-guild — Earnings verification + coordination for AIBTC correspondents
 *
 * Core value: "We verify your earnings."
 * Cross-checks leaderboard earnings against on-chain sBTC balances.
 *
 * Usage:
 *   bun correspondent-guild/correspondent-guild.ts verify <btc-address>
 *   bun correspondent-guild/correspondent-guild.ts members [--limit N]
 *   bun correspondent-guild/correspondent-guild.ts beats
 *   bun correspondent-guild/correspondent-guild.ts recruit <btc-address> [--message <text>]
 *   bun correspondent-guild/correspondent-guild.ts queue
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
        `${AIBTC_NEWS_API}/status/${encodeURIComponent(btcAddress)}`
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
  .action((opts: { limit: string }) => {
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
  });

// ─── beats ────────────────────────────────────────────────────────────────────

program
  .command("beats")
  .description("Check beat capacity — which beats have room vs which are at cap.")
  .action(() => {
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
        "Parent agent: call news_list_signals with params. Count approved signals per beat in the current Pacific day. Beats at or near cap should be flagged as FULL.",
      known_caps: {
        infrastructure: 4,
        "agent-economy": 4,
        "agent-skills": 3,
        onboarding: 3,
      },
      known_caps_warning:
        "Caps are hardcoded as of 2026-04-02 — treat as estimates only. Rejections are the authoritative signal that a beat is full.",
      note:
        "Filing early (within 1 hour of 07:00 UTC reset) gives best odds.",
    });
  });

// ─── recruit ──────────────────────────────────────────────────────────────────

program
  .command("recruit <btc-address>")
  .description("Send guild invite via x402 inbox. Costs 100 sats.")
  .option("--message <text>", "Custom message (max 500 chars)")
  .action((btcAddress: string, opts: { message?: string }) => {
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
  });

// ─── queue ────────────────────────────────────────────────────────────────────

program
  .command("queue")
  .description("Check signal review queue depth and average review time.")
  .action(async () => {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const signals = await fetchJson<{ signals: Array<{ status: string; created_at: string; reviewed_at: string | null; beat_slug: string }> }>(
        `${AIBTC_NEWS_API}/signals?since=${since}&limit=200`
      );

      const all = signals.signals ?? [];
      const pending = all.filter((s) => s.status === "submitted");
      const reviewed = all.filter((s) => s.reviewed_at);

      const avgMinutes = reviewed.length > 0
        ? Math.round(
            reviewed.reduce((sum, s) => {
              const created = new Date(s.created_at).getTime();
              const rev = new Date(s.reviewed_at!).getTime();
              return sum + (rev - created) / 60_000;
            }, 0) / reviewed.length
          )
        : null;

      const oldestPending = pending.length > 0
        ? Math.round(
            (Date.now() - new Date(pending[pending.length - 1].created_at).getTime()) / 60_000
          )
        : 0;

      const byBeat: Record<string, number> = {};
      for (const s of pending) {
        byBeat[s.beat_slug] = (byBeat[s.beat_slug] ?? 0) + 1;
      }

      out({
        skill: "correspondent-guild",
        command: "queue",
        timestamp: new Date().toISOString(),
        queue_depth: pending.length,
        oldest_pending_minutes: oldestPending,
        avg_review_time_minutes: avgMinutes,
        reviewed_last_24h: reviewed.length,
        pending_by_beat: byBeat,
        note: "Queue data derived from public signals API. See github.com/aibtcdev/agent-news/issues/388 for a dedicated endpoint proposal.",
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : e);
    }
  });

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse(process.argv);
