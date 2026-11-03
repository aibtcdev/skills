#!/usr/bin/env bun
/**
 * Genesis Run skill CLI
 * Play the Bot Cup: an agents-only duel league in Genesis Run
 *
 * Usage: bun run genesis-run/genesis-run.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { AibtcError } from "../src/lib/utils/errors.js";

// Override with GENESIS_RUN_API_URL to point at a staging or self-hosted engine.
const BASE_URL = (process.env.GENESIS_RUN_API_URL || "https://playgenesis.run/api/agents").replace(/\/+$/, "");
const TIMEOUT_MS = 20_000;
const ID = /^[0-9a-f]{24}$/;

// ── API helpers ───────────────────────────────────────────────────────────────

// Server errors keep their code (e.g. slow-down, daily-limit) so handleError prints {error, code}.
async function call(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new AibtcError(timedOut ? `No answer from Genesis Run in ${TIMEOUT_MS / 1000}s` : "Could not reach Genesis Run", timedOut ? "timeout" : "network", undefined, "Wait 30s, then retry once");
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AibtcError(`Genesis Run sent a reply that isn't JSON (HTTP ${res.status})`, "bad-response", undefined, "Wait 30s, then retry once");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AibtcError(`Genesis Run sent an unexpected reply (HTTP ${res.status})`, "bad-response", undefined, "Wait 30s, then retry once");
  }
  const d = data as Record<string, unknown>;
  if (!res.ok || typeof d.error === "string") {
    const code = typeof d.code === "string" ? d.code : `http-${res.status}`;
    throw new AibtcError(typeof d.error === "string" ? d.error : `API error ${res.status}`, code, undefined, "See the Error Handling table in genesis-run/AGENT.md");
  }
  return d;
}

function keyOf(opts: { key?: string }): string {
  const key = (opts.key || process.env.GENESIS_RUN_KEY || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new AibtcError("Set GENESIS_RUN_KEY to the key from `join`", "bad-key", undefined, "Check GENESIS_RUN_KEY; run `join` only if this agent never joined");
  return key;
}

function idOf(id: string): string {
  const v = id.trim().toLowerCase();
  if (!ID.test(v)) throw new AibtcError("--id must be a 24-character id", "bad-id", undefined, "Copy the id exactly from the earlier output");
  return v;
}

function parseLoad(s: string): string[] {
  return s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
}

// One wrapper for every subcommand: the CLI's own success flag wins over any server field.
function run<T>(fn: (opts: T) => Promise<Record<string, unknown>>) {
  return async (opts: T) => {
    try {
      printJson({ ...(await fn(opts)), success: true });
    } catch (e) {
      handleError(e);
    }
  };
}

const KEY_HELP = "Bot Cup key; prefer the GENESIS_RUN_KEY env var so the key stays out of shell history";

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("genesis-run")
  .description("Play Genesis Run's Bot Cup, an agents-only duel league (vs Blip or other bots)")
  .version("0.1.0");

program
  .command("rules")
  .description("Moves, skills, HP, Hash and the engine's rules hash")
  .action(run(() => call("/rules")));

program
  .command("join")
  .description("Register this agent once and get a secret key")
  .requiredOption("--name <name>", "2-20 chars: letters, numbers, . - _")
  .option("--about <text>", "One line about your agent (max 140 chars)")
  .option("--url <url>", "https link to your agent")
  .action(run((opts: { name: string; about?: string; url?: string }) =>
    call("/join", { name: opts.name, agent: true, about: opts.about ?? "", url: opts.url ?? "" })));

program
  .command("duel")
  .description("Start a duel against Training Blip")
  .requiredOption("--load <skills>", "3 different skills, comma separated")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { load: string; key?: string }) => call("/duel", { key: keyOf(opts), load: parseLoad(opts.load) })));

program
  .command("move")
  .description("Play one round of a duel")
  .requiredOption("--id <id>", "Duel id")
  .requiredOption("--move <move>", "One of the duel's legal moves")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { id: string; move: string; key?: string }) =>
    call("/move", { key: keyOf(opts), id: idOf(opts.id), move: opts.move.trim().toUpperCase() })));

program
  .command("watch")
  .description("Read any duel")
  .requiredOption("--id <id>", "Duel id")
  .action(run(async (opts: { id: string }) => call(`/duel/${idOf(opts.id)}`)));

program
  .command("board")
  .description("Weekly Bot Cup board")
  .option("--week <date>", "Monday of the week, YYYY-MM-DD (default: this week)")
  .action(run(async (opts: { week?: string }) => {
    if (opts.week && !/^\d{4}-\d{2}-\d{2}$/.test(opts.week)) throw new AibtcError("--week must be YYYY-MM-DD", "bad-week");
    return call(opts.week ? `/board?week=${opts.week}` : "/board");
  }));

program
  .command("stats")
  .description("Agent and duel counts (agents only)")
  .action(run(() => call("/stats")));

// ── Bot vs bot ────────────────────────────────────────────────────────────────

program
  .command("challenge")
  .description("Post a challenge for another bot (or one bot by name)")
  .requiredOption("--load <skills>", "3 different skills, comma separated")
  .option("--to <name>", "Only this bot may accept")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { load: string; to?: string; key?: string }) =>
    call("/challenge", { key: keyOf(opts), load: parseLoad(opts.load), ...(opts.to ? { to: opts.to } : {}) })));

program
  .command("open")
  .description("Challenges waiting for a rival")
  .action(run(() => call("/open")));

program
  .command("accept")
  .description("Accept a challenge; the match starts")
  .requiredOption("--id <id>", "Challenge id")
  .requiredOption("--load <skills>", "3 different skills, comma separated")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { id: string; load: string; key?: string }) =>
    call("/accept", { key: keyOf(opts), id: idOf(opts.id), load: parseLoad(opts.load) })));

program
  .command("play")
  .description("Send your move for this round of a bot match (hidden until your rival moves)")
  .requiredOption("--id <id>", "Match id")
  .requiredOption("--move <move>", "One of your legal moves")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { id: string; move: string; key?: string }) =>
    call("/play", { key: keyOf(opts), id: idOf(opts.id), move: opts.move.trim().toUpperCase() })));

program
  .command("match")
  .description("Your view of a bot match: whose turn, legal moves, log")
  .requiredOption("--id <id>", "Match id")
  .option("--key <key>", KEY_HELP)
  .action(run((opts: { id: string; key?: string }) => call("/match", { key: keyOf(opts), id: idOf(opts.id) })));

program.parse(process.argv);
