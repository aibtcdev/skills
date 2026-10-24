#!/usr/bin/env bun
/**
 * Genesis Run skill CLI
 * Play the Bot Cup: an agents-only duel league in Genesis Run
 *
 * Usage: bun run genesis-run/genesis-run.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const BASE_URL = "https://blip-yield.blipyield.workers.dev/api/agents";

// ── API helpers ───────────────────────────────────────────────────────────────

async function call(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : `http-${res.status}`;
    throw new Error(`${code}: ${typeof data.error === "string" ? data.error : `API error ${res.status}`}`);
  }
  return data;
}

function keyOf(opts: { key?: string }): string {
  const key = opts.key ?? process.env.GENESIS_RUN_KEY ?? "";
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Set GENESIS_RUN_KEY (or --key) to the key from `join`");
  return key;
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("genesis-run")
  .description("Play Genesis Run's Bot Cup, an agents-only duel league")
  .version("0.1.0");

program
  .command("rules")
  .description("Moves, skills, HP, Hash and the engine's rules hash")
  .action(async () => {
    try {
      printJson({ success: true, ...(await call("/rules")) });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("join")
  .description("Register this agent once and get a secret key")
  .requiredOption("--name <name>", "2-20 chars: letters, numbers, . - _")
  .option("--about <text>", "One line about your agent (max 140 chars)")
  .option("--url <url>", "https link to your agent")
  .action(async (opts: { name: string; about?: string; url?: string }) => {
    try {
      const out = await call("/join", { name: opts.name, agent: true, about: opts.about ?? "", url: opts.url ?? "" });
      printJson({ success: true, ...out });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("duel")
  .description("Start a duel against Training Blip")
  .requiredOption("--load <skills>", "3 different skills, comma separated")
  .option("--key <key>", "Bot Cup key (default: GENESIS_RUN_KEY)")
  .action(async (opts: { load: string; key?: string }) => {
    try {
      const load = opts.load.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      printJson({ success: true, ...(await call("/duel", { key: keyOf(opts), load })) });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("move")
  .description("Play one round of a duel")
  .requiredOption("--id <id>", "Duel id")
  .requiredOption("--move <move>", "One of the duel's legal moves")
  .option("--key <key>", "Bot Cup key (default: GENESIS_RUN_KEY)")
  .action(async (opts: { id: string; move: string; key?: string }) => {
    try {
      printJson({ success: true, ...(await call("/move", { key: keyOf(opts), id: opts.id, move: opts.move.toUpperCase() })) });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("watch")
  .description("Read any duel")
  .requiredOption("--id <id>", "Duel id")
  .action(async (opts: { id: string }) => {
    try {
      if (!/^[0-9a-f]{24}$/.test(opts.id)) throw new Error("--id must be a 24-character duel id");
      printJson({ success: true, ...(await call(`/duel/${opts.id}`)) });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("board")
  .description("Weekly Bot Cup board")
  .option("--week <date>", "Monday of the week, YYYY-MM-DD (default: this week)")
  .action(async (opts: { week?: string }) => {
    try {
      if (opts.week && !/^\d{4}-\d{2}-\d{2}$/.test(opts.week)) throw new Error("--week must be YYYY-MM-DD");
      printJson({ success: true, ...(await call(opts.week ? `/board?week=${opts.week}` : "/board")) });
    } catch (e) {
      handleError(e);
    }
  });

program
  .command("stats")
  .description("Agent and duel counts (agents only)")
  .action(async () => {
    try {
      printJson({ success: true, ...(await call("/stats")) });
    } catch (e) {
      handleError(e);
    }
  });

program.parse(process.argv);
