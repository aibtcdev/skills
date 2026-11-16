#!/usr/bin/env bun
/**
 * Agent Lookup skill CLI
 * Query the AIBTC agent network registry
 *
 * Usage: bun run agent-lookup/agent-lookup.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

const BASE_URL = "https://aibtc.com/api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  stxAddress: string;
  btcAddress: string;
  stxPublicKey: string;
  btcPublicKey: string;
  taprootAddress: string | null;
  displayName: string | null;
  description: string | null;
  bnsName: string | null;
  owner: string | null;
  verifiedAt: string;
  lastActiveAt: string | null;
  checkInCount: number;
  erc8004AgentId: number | null;
  nostrPublicKey: string | null;
  referredBy: string | null;
  level: number;
  levelName: string;
  achievementCount: number;
}

interface AgentsResponse {
  agents: Agent[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function fetchPage(offset: number): Promise<AgentsResponse> {
  const res = await fetch(`${BASE_URL}/agents?limit=100&offset=${offset}`);
  if (!res.ok) throw new Error(`API error ${res.status} on /agents`);
  return res.json() as Promise<AgentsResponse>;
}

async function fetchAllAgents(): Promise<Agent[]> {
  const first = await fetchPage(0);
  const agents: Agent[] = [...first.agents];
  const { total } = first.pagination;

  if (total > 100) {
    const offsets: number[] = [];
    for (let o = 100; o < total; o += 100) offsets.push(o);
    const pages = await Promise.all(offsets.map(fetchPage));
    for (const page of pages) agents.push(...page.agents);
  }

  return agents;
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("agent-lookup")
  .description("Query the AIBTC agent network registry")
  .version("0.1.0");

// ── lookup ────────────────────────────────────────────────────────────────────

program
  .command("lookup")
  .description("Look up a specific agent by address or display name")
  .option("--address <address>", "BTC (bc1q…) or STX (SP…) address")
  .option("--name <name>", "Display name (case-insensitive)")
  .action(async (opts: { address?: string; name?: string }) => {
    try {
      if (!opts.address && !opts.name) {
        throw new Error("Provide --address <address> or --name <name>");
      }

      const agents = await fetchAllAgents();
      let match: Agent | undefined;

      if (opts.address) {
        const addr = opts.address.trim();
        match = agents.find(
          (a) => a.btcAddress === addr || a.stxAddress === addr
        );
      } else if (opts.name) {
        const needle = opts.name.toLowerCase();
        match = agents.find((a) => a.displayName?.toLowerCase() === needle);
      }

      if (!match) throw new Error("Agent not found");

      printJson({ success: true, agent: match });
    } catch (e) {
      handleError(e);
    }
  });

// ── stats ─────────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("Network-wide agent statistics")
  .action(async () => {
    try {
      const agents = await fetchAllAgents();

      const byLevel: Record<string, number> = {};
      let totalCheckIns = 0;
      let totalAchievements = 0;
      let activeCount = 0;

      for (const a of agents) {
        byLevel[a.levelName] = (byLevel[a.levelName] ?? 0) + 1;
        totalCheckIns += a.checkInCount;
        totalAchievements += a.achievementCount;
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        if (a.lastActiveAt && a.lastActiveAt >= cutoff) activeCount++;
      }

      printJson({
        success: true,
        totalAgents: agents.length,
        activeAgents: activeCount,
        totalCheckIns,
        totalAchievements,
        averageCheckIns:
          agents.length > 0
            ? parseFloat((totalCheckIns / agents.length).toFixed(1))
            : 0,
        byLevel,
      });
    } catch (e) {
      handleError(e);
    }
  });

// ── top ───────────────────────────────────────────────────────────────────────

program
  .command("top")
  .description("Rank agents by a chosen metric")
  .option("--by <metric>", "checkins | achievements | level", "checkins")
  .option("--limit <n>", "Number of results", "10")
  .action(async (opts: { by: string; limit: string }) => {
    try {
      const n = parseInt(opts.limit, 10);
      if (isNaN(n) || n < 1) {
        throw new Error("--limit must be a positive integer");
      }

      const validMetrics = ["checkins", "achievements", "level"];
      if (!validMetrics.includes(opts.by)) {
        throw new Error(
          `--by must be one of: ${validMetrics.join(", ")}`
        );
      }

      const agents = await fetchAllAgents();

      const sorted = [...agents].sort((a, b) => {
        switch (opts.by) {
          case "achievements":
            return b.achievementCount - a.achievementCount;
          case "level":
            return b.level - a.level || b.checkInCount - a.checkInCount;
          default: // checkins
            return b.checkInCount - a.checkInCount;
        }
      });

      const results = sorted.slice(0, n).map((a, i) => ({
        rank: i + 1,
        displayName: a.displayName ?? "Unknown",
        btcAddress: a.btcAddress,
        stxAddress: a.stxAddress,
        level: a.level,
        levelName: a.levelName,
        checkInCount: a.checkInCount,
        achievementCount: a.achievementCount,
        lastActiveAt: a.lastActiveAt,
      }));

      printJson({
        success: true,
        rankedBy: opts.by,
        count: results.length,
        agents: results,
      });
    } catch (e) {
      handleError(e);
    }
  });

// ── Entry ─────────────────────────────────────────────────────────────────────

program.parse(process.argv);
