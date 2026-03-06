#!/usr/bin/env bun
/**
 * Yield Dashboard Skill
 * Single view of DeFi positions across Zest, Bitflow, Pillar, stacking.
 * Integrates YieldAgent x402 yields for opportunity discovery.
 * Platform: Stacks v1 + x402 (AIBTC dashboard ecosystem).
 *
 * Usage: bun run yield-dashboard/yield-dashboard.ts <subcommand> [options]
 */

import { Command } from "commander";
import path from "path";

const YIELD_AGENT_URL = "https://api.yieldagentx402.app/api/yields";
// Resolve skill paths relative to skills repo root (parent of yield-dashboard/)
const SKILLS_ROOT = path.join(import.meta.dir, "..");
const SKILL_TIMEOUT_MS = 25_000;
const X402_TIMEOUT_MS = 45_000;

async function runSkill(script: string, args: string[]): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), SKILL_TIMEOUT_MS);
  try {
    const scriptPath = path.isAbsolute(script) ? script : path.join(SKILLS_ROOT, script);
    const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: SKILLS_ROOT,
      env: { ...process.env, NETWORK: process.env.NETWORK || "mainnet" },
      signal: controller.signal,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(t);
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error(stderr || stdout || `Skill ${script} failed with exit ${exit}`);
    }
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return { raw: stdout };
    }
  } catch (e) {
    clearTimeout(t);
    if ((e as { name?: string }).name === "AbortError") {
      throw new Error(`Skill ${script} timed out after ${SKILL_TIMEOUT_MS}ms`);
    }
    throw e;
  }
}

async function fetchYieldAgentYields(): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), X402_TIMEOUT_MS);
  try {
    const x402Path = path.join(SKILLS_ROOT, "x402", "x402.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        x402Path,
        "execute-endpoint",
        "--url",
        YIELD_AGENT_URL,
        "--method",
        "GET",
        "--auto-approve",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        cwd: SKILLS_ROOT,
        env: { ...process.env, NETWORK: "mainnet" },
        signal: controller.signal,
      }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(t);
    const exit = await proc.exited;
    if (exit !== 0) {
      return { error: stderr || "YieldAgent x402 payment or fetch failed", yields: [] };
    }
    const data = JSON.parse(stdout.trim());
    return data.response ?? data;
  } catch (e) {
    clearTimeout(t);
    if ((e as { name?: string }).name === "AbortError") {
      return { error: `YieldAgent x402 timed out after ${X402_TIMEOUT_MS}ms`, yields: [] };
    }
    return { error: String(e), yields: [] };
  }
}

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

// Stacks mainnet address: SP (single-sig) or ST (multisig), base58check, 34–43 chars
function isValidStacksAddress(addr: string): boolean {
  if (!addr || typeof addr !== "string") return false;
  return /^S[PQ][1-9A-HJ-NP-Za-km-z]{32,41}$/.test(addr.trim());
}

function validateAddress(addr: string | undefined): string[] {
  if (!addr) return [];
  if (!isValidStacksAddress(addr)) {
    throw new Error(`Invalid Stacks address: ${addr}. Expected SP... or ST... (mainnet, 34–43 chars).`);
  }
  return ["--address", addr];
}

type ZestResponse = { position?: { asset: string; supplied: string; borrowed: string } };

async function gatherZestPositions(address: string[]): Promise<unknown[]> {
  let zestAssets: string[] = [];
  try {
    const assets = (await runSkill("defi/defi.ts", ["zest-list-assets"])) as {
      assets?: { symbol: string }[];
    };
    zestAssets = assets?.assets?.map((a) => a.symbol) ?? ["sBTC", "stSTX", "aeUSDC"];
  } catch {
    zestAssets = ["sBTC", "stSTX", "aeUSDC"];
  }
  const zestPositions: unknown[] = [];
  for (const symbol of zestAssets.slice(0, 5)) {
    try {
      const res = (await runSkill("defi/defi.ts", [
        "zest-get-position",
        "--asset",
        symbol,
        ...address,
      ])) as ZestResponse;
      if (res?.position) zestPositions.push({ symbol, ...res.position });
    } catch {
      // skip
    }
  }
  return zestPositions;
}

async function gatherPositions(address: string[]): Promise<Record<string, unknown>> {
  const positions: Record<string, unknown> = {};

  positions.zest = await gatherZestPositions(address);

  try {
    positions.pillar = await runSkill("pillar/pillar-direct.ts", ["direct-position"]);
  } catch {
    positions.pillar = { error: "Pillar not configured or failed" };
  }

  try {
    positions.bitflow = await runSkill("bitflow/bitflow.ts", ["get-keeper-user", ...address]);
  } catch {
    positions.bitflow = { error: "Bitflow query failed" };
  }

  try {
    positions.stacking = await runSkill("stacking/stacking.ts", ["get-stacking-status", ...address]);
  } catch {
    positions.stacking = { error: "Stacking query failed" };
  }

  return positions;
}

const program = new Command();

program
  .name("yield-dashboard")
  .description(
    "Single view of DeFi positions across Zest, Bitflow, Pillar, stacking. Optional YieldAgent yields. Stacks v1 + x402."
  )
  .version("0.1.0");

program
  .command("dashboard")
  .description("Full dashboard: positions + optional YieldAgent opportunities + rebalance suggestions")
  .option("--include-yieldagent", "Fetch yield opportunities from YieldAgent (x402 payment)")
  .option("--address <addr>", "Stacks address (uses active wallet if omitted)")
  .action(async (opts: { includeYieldagent?: boolean; address?: string }) => {
    try {
      const address = validateAddress(opts.address);
      const positions = await gatherPositions(address);

      let opportunities: unknown = null;
      if (opts.includeYieldagent) {
        opportunities = await fetchYieldAgentYields();
      }

      const rebalanceSuggestions: unknown[] = [];
      if (opportunities && typeof opportunities === "object" && "yields" in opportunities) {
        const yields =
          (opportunities as { yields?: { apy?: number; chain?: string; project?: string }[] }).yields ?? [];
        const top = yields
          .filter((y) => y.apy && y.apy > 0)
          .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
          .slice(0, 5);
        for (const y of top) {
          rebalanceSuggestions.push({
            protocol: y.project,
            chain: y.chain,
            apy: y.apy,
            suggestion: `Consider allocating to ${y.project} on ${y.chain} for ~${y.apy}% APY`,
          });
        }
      }

      printJson({
        network: process.env.NETWORK ?? "mainnet",
        address: opts.address ?? "active-wallet",
        positions,
        opportunities: opts.includeYieldagent
          ? opportunities
          : "Omit --include-yieldagent to skip",
        rebalanceSuggestions:
          rebalanceSuggestions.length > 0
            ? rebalanceSuggestions
            : "Run with --include-yieldagent for suggestions",
      });
    } catch (e) {
      printJson({ error: String(e) });
      process.exit(1);
    }
  });

program
  .command("positions")
  .description("Positions only — no YieldAgent, no rebalance logic")
  .option("--address <addr>", "Stacks address")
  .action(async (opts: { address?: string }) => {
    try {
      const address = validateAddress(opts.address);
      const positions = await gatherPositions(address);
      printJson({
        network: process.env.NETWORK ?? "mainnet",
        address: opts.address ?? "active-wallet",
        positions,
      });
    } catch (e) {
      printJson({ error: String(e) });
      process.exit(1);
    }
  });

program
  .command("opportunities")
  .description("Yield opportunities from YieldAgent x402 (requires sBTC payment)")
  .option("--limit <n>", "Max opportunities to return", "20")
  .action(async (opts: { limit: string }) => {
    try {
      const data = await fetchYieldAgentYields();
      const limit = parseInt(opts.limit, 10) || 20;
      if (data && typeof data === "object" && "yields" in data) {
        const yields = (data as { yields?: unknown[] }).yields ?? [];
        (data as { yields?: unknown[] }).yields = yields.slice(0, limit);
      }
      printJson(data);
    } catch (e) {
      printJson({ error: String(e) });
      process.exit(1);
    }
  });

program
  .command("rebalance-suggestions")
  .description("Rebalance suggestions from YieldAgent opportunities (fetches x402 yields directly)")
  .action(async () => {
    try {
      const data = await fetchYieldAgentYields();
      const suggestions: unknown[] = [];
      if (data && typeof data === "object" && "yields" in data) {
        const yields =
          (data as { yields?: { apy?: number; chain?: string; project?: string }[] }).yields ?? [];
        const top = yields
          .filter((y) => y.apy && y.apy > 0)
          .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
          .slice(0, 10);
        for (const y of top) {
          suggestions.push({
            protocol: y.project,
            chain: y.chain,
            apy: y.apy,
            action: `Consider: ${y.project} on ${y.chain} (~${y.apy}% APY)`,
          });
        }
      }
      printJson({
        network: process.env.NETWORK ?? "mainnet",
        suggestions,
        note: "Based on YieldAgent x402 yields. Run 'opportunities' for full list.",
      });
    } catch (e) {
      printJson({ error: String(e) });
      process.exit(1);
    }
  });

program.parse(process.argv);
