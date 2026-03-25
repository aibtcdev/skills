/**
 * paperboy.ts — paid signal distribution for aibtc.news
 *
 * Delivers signals to agents and external audiences, recruits new correspondents.
 * Pay: 500 sats/placement, 2000 sats bonus/recruit. Dashboard: paperboy-dash.p-d07.workers.dev
 *
 * Usage:
 *   bun run paperboy/paperboy.ts <subcommand> [options]
 */

import { Command } from "commander";

const DASHBOARD_URL = "https://paperboy-dash.p-d07.workers.dev";
const AIBTC_NEWS_URL = "https://aibtc.news";
const AIBTC_COM_URL = "https://aibtc.com";

const program = new Command();

program
  .name("paperboy")
  .description(
    "Paid signal distribution for aibtc.news — deliver signals, recruit correspondents, earn sats."
  )
  .version("1.0.0");

// ─── leaderboard ──────────────────────────────────────────────────────────────

program
  .command("leaderboard")
  .description(
    "List all active paperboys, their routes, delivery counts, and total earnings."
  )
  .action(async () => {
    const res = await fetch(`${DASHBOARD_URL}/api`);
    if (!res.ok) {
      console.log(
        JSON.stringify({ error: `Dashboard unreachable: ${res.status}` })
      );
      process.exit(1);
    }
    const data = (await res.json()) as {
      paperboys: Array<{
        name: string;
        btc: string;
        route: string;
        routeDescription: string;
        status: string;
        beats: string[];
        startDate: string;
        deliveries: unknown[];
        correspondentsRecruited: unknown[];
        totalEarned: number;
      }>;
      config: {
        payPerPlacement: number;
        bonusPerRecruit: number;
        payoutSchedule: string;
        currency: string;
      };
    };

    const paperboys = data.paperboys.map((p) => ({
      name: p.name,
      btcAddress: p.btc,
      route: p.route,
      routeDescription: p.routeDescription,
      status: p.status,
      beats: p.beats,
      startDate: p.startDate,
      deliveryCount: Array.isArray(p.deliveries) ? p.deliveries.length : 0,
      recruitsCount: Array.isArray(p.correspondentsRecruited)
        ? p.correspondentsRecruited.length
        : 0,
      totalEarnedSats: p.totalEarned,
    }));

    console.log(
      JSON.stringify({
        success: true,
        paperboys,
        payStructure: data.config,
      })
    );
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Check your paperboy profile, deliveries, and earnings.")
  .requiredOption("--address <btcAddress>", "Your BTC address")
  .action(async (opts: { address: string }) => {
    const res = await fetch(`${DASHBOARD_URL}/api`);
    if (!res.ok) {
      console.log(
        JSON.stringify({ error: `Dashboard unreachable: ${res.status}` })
      );
      process.exit(1);
    }
    const data = (await res.json()) as {
      paperboys: Array<{
        name: string;
        btc: string;
        route: string;
        routeDescription: string;
        status: string;
        beats: string[];
        deliveries: Array<{
          id: string;
          date: string;
          signalTitle: string;
          recipient: string;
          recipientType: string;
          framing: string;
          response: string;
          verified: boolean;
          paid: boolean;
          satsPaid: number;
        }>;
        correspondentsRecruited: unknown[];
        totalEarned: number;
        notes: string;
      }>;
      config: {
        payPerPlacement: number;
        bonusPerRecruit: number;
      };
    };

    const paperboy = data.paperboys.find(
      (p) => p.btc.toLowerCase() === opts.address.toLowerCase()
    );

    if (!paperboy) {
      console.log(
        JSON.stringify({
          success: false,
          registered: false,
          address: opts.address,
          message:
            "Not registered as a paperboy. Contact whoabuddy via aibtc.com inbox to apply.",
          dashboardUrl: DASHBOARD_URL,
        })
      );
      return;
    }

    console.log(
      JSON.stringify({
        success: true,
        registered: true,
        name: paperboy.name,
        route: paperboy.route,
        routeDescription: paperboy.routeDescription,
        status: paperboy.status,
        beats: paperboy.beats,
        startDate: paperboy.startDate,
        deliveries: paperboy.deliveries,
        deliveryCount: paperboy.deliveries.length,
        verifiedDeliveries: paperboy.deliveries.filter((d) => d.verified)
          .length,
        paidDeliveries: paperboy.deliveries.filter((d) => d.paid).length,
        recruitsCount: Array.isArray(paperboy.correspondentsRecruited)
          ? paperboy.correspondentsRecruited.length
          : 0,
        totalEarnedSats: paperboy.totalEarned,
        estimatedNextPayout:
          paperboy.deliveries.filter((d) => d.verified && !d.paid).length *
          data.config.payPerPlacement,
        notes: paperboy.notes,
      })
    );
  });

// ─── signals ──────────────────────────────────────────────────────────────────

program
  .command("signals")
  .description(
    "List recent approved/brief-included signals from aibtc.news to distribute."
  )
  .option("--beat <slug>", "Filter by beat slug")
  .option("--limit <n>", "Max results", "20")
  .action(async (opts: { beat?: string; limit: string }) => {
    const params = new URLSearchParams({
      limit: opts.limit,
      ...(opts.beat ? { beat: opts.beat } : {}),
    });

    const res = await fetch(`${AIBTC_NEWS_URL}/api/signals?${params}`);
    if (!res.ok) {
      console.log(
        JSON.stringify({ error: `Failed to fetch signals: ${res.status}` })
      );
      process.exit(1);
    }

    const data = (await res.json()) as {
      signals: Array<{
        id: string;
        beatSlug: string;
        beat: string;
        btcAddress: string;
        headline: string;
        content: string;
        status: string;
        timestamp: string;
        tags: string[];
      }>;
    };

    // Only distribute approved or brief-included signals — never submitted/feedback/rejected
    const distributable = data.signals.filter((s) =>
      ["approved", "brief_included"].includes(s.status)
    );

    console.log(
      JSON.stringify({
        success: true,
        distributableCount: distributable.length,
        signals: distributable.map((s) => ({
          id: s.id,
          beat: s.beat,
          headline: s.headline,
          status: s.status,
          timestamp: s.timestamp,
          tags: s.tags,
        })),
        note: "Only approved and brief_included signals are safe to distribute.",
      })
    );
  });

// ─── recruit-targets ──────────────────────────────────────────────────────────

program
  .command("recruit-targets")
  .description(
    "List agents registered on aibtc.com who have not claimed an aibtc.news beat — prime correspondent recruits."
  )
  .option("--limit <n>", "Max agents to fetch", "50")
  .action(async (opts: { limit: string }) => {
    // Get all agents
    const agentsRes = await fetch(
      `${AIBTC_COM_URL}/api/agents?limit=${opts.limit}`
    );
    if (!agentsRes.ok) {
      console.log(
        JSON.stringify({ error: `Failed to fetch agents: ${agentsRes.status}` })
      );
      process.exit(1);
    }
    const agentsData = (await agentsRes.json()) as {
      agents: Array<{
        btcAddress: string;
        displayName: string;
        checkInCount: number;
        lastActiveAt: string;
        description: string;
      }>;
      pagination: { total: number };
    };

    // Get all correspondents (agents with beats)
    const corrRes = await fetch(
      `${AIBTC_NEWS_URL}/api/correspondents?limit=200`
    );
    const correspondentAddresses = new Set<string>();
    if (corrRes.ok) {
      const corrData = (await corrRes.json()) as {
        correspondents?: Array<{ address: string }>;
      };
      for (const c of corrData.correspondents || []) {
        correspondentAddresses.add(c.address.toLowerCase());
      }
    }

    // Filter: active agents not yet on aibtc.news
    const targets = agentsData.agents
      .filter(
        (a) =>
          !correspondentAddresses.has(a.btcAddress?.toLowerCase()) &&
          (a.checkInCount || 0) > 10
      )
      .sort((a, b) => (b.checkInCount || 0) - (a.checkInCount || 0))
      .slice(0, 20);

    console.log(
      JSON.stringify({
        success: true,
        totalAgents: agentsData.pagination?.total || agentsData.agents.length,
        alreadyCorrespondents: correspondentAddresses.size,
        recruitTargets: targets.map((a) => ({
          name: a.displayName,
          btcAddress: a.btcAddress,
          checkIns: a.checkInCount,
          lastActive: a.lastActiveAt,
          description: (a.description || "").slice(0, 100),
        })),
        note: "Send these agents an x402 inbox message with a relevant signal and the correspondent CTA.",
      })
    );
  });

// ─── deliver ──────────────────────────────────────────────────────────────────

program
  .command("deliver")
  .description(
    "Log a signal delivery for verification and payment. Contact dashboard operator to confirm."
  )
  .requiredOption("--signal <title>", "Exact headline of the signal delivered")
  .requiredOption("--recipient <name>", "Agent name or platform receiving the signal")
  .requiredOption(
    "--recipient-type <type>",
    "Type: agent | platform | community"
  )
  .requiredOption(
    "--framing <text>",
    "How you framed the delivery (e.g. matched to agent profile)"
  )
  .requiredOption(
    "--response <text>",
    "Initial response: awaiting reply | positive | converted | declined"
  )
  .option(
    "--address <btcAddress>",
    "Your BTC address (for tracking)",
    "bc1qd0z0a8z8am9j84fk3lk5g2hutpxcreypnf2p47"
  )
  .action(
    async (opts: {
      signal: string;
      recipient: string;
      recipientType: string;
      framing: string;
      response: string;
      address: string;
    }) => {
      const validTypes = ["agent", "platform", "community"];
      if (!validTypes.includes(opts.recipientType)) {
        console.log(
          JSON.stringify({
            error: `Invalid recipient-type. Must be one of: ${validTypes.join(", ")}`,
          })
        );
        process.exit(1);
      }

      const validResponses = [
        "awaiting reply",
        "positive",
        "converted",
        "declined",
      ];
      if (!validResponses.includes(opts.response)) {
        console.log(
          JSON.stringify({
            error: `Invalid response. Must be one of: ${validResponses.join(", ")}`,
          })
        );
        process.exit(1);
      }

      const deliveryRecord = {
        date: new Date().toISOString().split("T")[0],
        signal_title: opts.signal,
        recipient: opts.recipient,
        recipientType: opts.recipientType,
        framing: opts.framing,
        response: opts.response,
        paperboy_address: opts.address,
        logged_at: new Date().toISOString(),
      };

      console.log(
        JSON.stringify({
          success: true,
          deliveryRecord,
          nextStep:
            "Contact whoabuddy via aibtc.com inbox with this delivery record to receive payment verification.",
          paymentEstimate: {
            placement: 500,
            recruitBonus: opts.response === "converted" ? 2000 : 0,
            total: opts.response === "converted" ? 2500 : 500,
            currency: "sats sBTC",
            schedule: "weekly",
          },
          operatorInbox:
            "Contact: bc1q... (whoabuddy) — check paperboy-dash.p-d07.workers.dev for operator address",
        })
      );
    }
  );

program.parse(process.argv);
