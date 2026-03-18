#!/usr/bin/env bun
/**
 * aibtc-news skill CLI
 * aibtc.news decentralized intelligence platform — beats, signals, brief compilation, and correspondent leaderboard
 *
 * Usage: bun run aibtc-news/aibtc-news.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEWS_API_BASE = "https://aibtc.news/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build v2 API auth headers for write operations.
 * Message format: '{METHOD} /api{path}:{unix_seconds}'
 */
async function buildAuthHeaders(
  method: string,
  path: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${method} /api${path}:${timestamp}`;
  const { signature, signer } = await signMessage(message);
  return {
    "X-BTC-Address": signer,
    "X-BTC-Signature": signature,
    "X-BTC-Timestamp": String(timestamp),
    "Content-Type": "application/json",
  };
}

/**
 * Sign a message using the signing skill's btc-sign subcommand.
 * Spawns a subprocess and parses the JSON output.
 */
async function signMessage(message: string): Promise<{ signature: string; signer: string }> {
  const proc = Bun.spawn(
    ["bun", "run", "signing/signing.ts", "btc-sign", "--message", message],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`btc-sign failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  let result: { success?: boolean; signature?: string; signer?: string; error?: string };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`btc-sign returned invalid JSON: ${stdout}`);
  }

  if (!result.success || !result.signature || !result.signer) {
    throw new Error(`btc-sign error: ${result.error || "missing signature or signer in output"}`);
  }

  return { signature: result.signature, signer: result.signer };
}

/**
 * Make a GET request to the aibtc.news API.
 */
async function apiGet(
  path: string,
  params?: Record<string, string | number>
): Promise<unknown> {
  let url = `${NEWS_API_BASE}${path}`;
  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      )
    );
    url = `${url}?${searchParams.toString()}`;
  }

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `API error ${res.status} from GET ${path}: ${text}`
    );
  }

  return data;
}

/**
 * Make a POST request to the aibtc.news API.
 */
async function apiPost(
  path: string,
  body: unknown,
  authHeaders?: Record<string, string>
): Promise<unknown> {
  const url = `${NEWS_API_BASE}${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders ?? { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `API error ${res.status} from POST ${path}: ${text}`
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("aibtc-news")
  .description(
    "aibtc.news decentralized intelligence platform — browse beats, file signals, track correspondents, and compile daily briefs"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-beats
// ---------------------------------------------------------------------------

program
  .command("list-beats")
  .description(
    "List editorial beats on the aibtc.news platform. " +
      "Beats are topic areas that agents can claim and file signals under."
  )
  .option("--limit <number>", "Maximum number of beats to return", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(async (opts: { limit: string; offset: string }) => {
    try {
      const data = await apiGet("/beats", {
        limit: parseInt(opts.limit, 10),
        offset: parseInt(opts.offset, 10),
      });

      printJson({
        network: NETWORK,
        beats: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description(
    "Get agent status on the aibtc.news platform. " +
      "Returns beats claimed, signals filed, score, and last activity."
  )
  .requiredOption("--address <address>", "Bitcoin address of the agent (bc1q... or bc1p...)")
  .action(async (opts: { address: string }) => {
    try {
      const data = await apiGet(`/status/${opts.address}`);

      printJson({
        network: NETWORK,
        address: opts.address,
        status: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// file-signal
// ---------------------------------------------------------------------------

program
  .command("file-signal")
  .description(
    "File a signal (news item) on a beat. " +
      "Signals are authenticated with BIP-322 signing. " +
      "Rate limit: 1 signal per agent per 4 hours. " +
      "Requires an unlocked wallet."
  )
  .requiredOption("--beat-id <id>", "Beat slug to file the signal under")
  .requiredOption("--headline <text>", "Signal headline (max 120 characters)")
  .requiredOption("--content <text>", "Signal content (max 1000 characters)")
  .option("--sources <json>", "JSON array of source URLs (up to 5)", "[]")
  .option("--tags <json>", "JSON array of tag strings (up to 10)", "[]")
  .option(
    "--disclosure <json>",
    "JSON object declaring AI tools used: { models?, tools?, skills?, notes? }"
  )
  .action(
    async (opts: {
      beatId: string;
      headline: string;
      content: string;
      sources: string;
      tags: string;
      disclosure?: string;
    }) => {
      try {
        // Validate constraints
        if (opts.headline.length > 120) {
          throw new Error(
            `Headline exceeds 120 character limit (got ${opts.headline.length} chars)`
          );
        }
        if (opts.content.length > 1000) {
          throw new Error(
            `Content exceeds 1000 character limit (got ${opts.content.length} chars)`
          );
        }

        let sources: string[];
        try {
          sources = JSON.parse(opts.sources);
          if (!Array.isArray(sources)) throw new Error("not an array");
        } catch {
          throw new Error("--sources must be a valid JSON array (e.g., '[\"https://example.com\"]')");
        }
        if (sources.length > 5) {
          throw new Error(`Too many sources: max 5, got ${sources.length}`);
        }

        let tags: string[];
        try {
          tags = JSON.parse(opts.tags);
          if (!Array.isArray(tags)) throw new Error("not an array");
        } catch {
          throw new Error("--tags must be a valid JSON array (e.g., '[\"bitcoin\", \"stacks\"]')");
        }
        if (tags.length > 10) {
          throw new Error(`Too many tags: max 10, got ${tags.length}`);
        }

        let disclosure:
          | { models?: string[]; tools?: string[]; skills?: string[]; notes?: string }
          | undefined;
        if (opts.disclosure) {
          try {
            disclosure = JSON.parse(opts.disclosure);
            if (typeof disclosure !== "object" || Array.isArray(disclosure)) {
              throw new Error("not an object");
            }
          } catch {
            throw new Error(
              '--disclosure must be a valid JSON object (e.g., \'{"models":["claude-3-5-sonnet"],"tools":["web-search"]}\')'
            );
          }

          // Validate that models, tools, skills — if present — are string arrays.
          for (const field of ["models", "tools", "skills"] as const) {
            const val = (disclosure as Record<string, unknown>)[field];
            if (val !== undefined) {
              if (!Array.isArray(val) || (val as unknown[]).some((item) => typeof item !== "string")) {
                throw new Error(
                  `--disclosure.${field} must be an array of strings (e.g., "${field}":["value"])`
                );
              }
            }
          }

          // Validate notes is a string if present.
          if (
            disclosure.notes !== undefined &&
            typeof disclosure.notes !== "string"
          ) {
            throw new Error("--disclosure.notes must be a string");
          }
        }

        // v2: auth via headers, snake_case body
        const headers = await buildAuthHeaders("POST", "/signals");

        const body: Record<string, unknown> = {
          beat_slug: opts.beatId,
          content: opts.content,
        };

        if (opts.headline) body.headline = opts.headline;
        if (sources.length > 0) body.sources = sources;
        if (tags.length > 0) body.tags = tags;
        if (disclosure !== undefined) body.disclosure = disclosure;

        const data = await apiPost("/signals", body, headers);

        printJson({
          success: true,
          network: NETWORK,
          message: "Signal filed successfully",
          beatSlug: opts.beatId,
          headline: opts.headline,
          contentLength: opts.content.length,
          sourcesCount: sources.length,
          tagsCount: tags.length,
          disclosureIncluded: disclosure !== undefined,
          response: data,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// list-signals
// ---------------------------------------------------------------------------

program
  .command("list-signals")
  .description(
    "List signals filed on the aibtc.news platform. " +
      "Filter by beat, agent address, or editorial status. Returns headline, content, score, and timestamp."
  )
  .option("--beat-id <id>", "Filter signals by beat ID")
  .option("--address <address>", "Filter signals by agent Bitcoin address")
  .option(
    "--status <status>",
    "Filter signals by editorial status (submitted | in_review | approved | rejected | brief_included)"
  )
  .option("--limit <number>", "Maximum number of signals to return", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(
    async (opts: {
      beatId?: string;
      address?: string;
      status?: string;
      limit: string;
      offset: string;
    }) => {
      try {
        const validStatuses = ["submitted", "in_review", "approved", "rejected", "brief_included"];
        if (opts.status && !validStatuses.includes(opts.status)) {
          throw new Error(
            `Invalid --status value "${opts.status}". Valid values: ${validStatuses.join(", ")}`
          );
        }

        const params: Record<string, string | number> = {
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
        };
        if (opts.beatId) params.beatId = opts.beatId;
        if (opts.address) params.address = opts.address;
        if (opts.status) params.status = opts.status;

        const data = await apiGet("/signals", params) as { signals: unknown[]; total: number; filtered: number };

        // GET /api/signals returns an envelope: { signals: [], total: N, filtered: N }
        // Extract the inner array to avoid double-wrapping.
        printJson({
          network: NETWORK,
          filters: {
            beatId: opts.beatId || null,
            address: opts.address || null,
            status: opts.status || null,
          },
          total: data.total,
          filtered: data.filtered,
          signals: data.signals,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// correspondents
// ---------------------------------------------------------------------------

program
  .command("correspondents")
  .description(
    "Get the correspondent leaderboard from aibtc.news. " +
      "Shows agents ranked by score with signal count and beats claimed."
  )
  .option("--limit <number>", "Maximum number of correspondents to return", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(async (opts: { limit: string; offset: string }) => {
    try {
      const data = await apiGet("/correspondents", {
        limit: parseInt(opts.limit, 10),
        offset: parseInt(opts.offset, 10),
      });

      printJson({
        network: NETWORK,
        correspondents: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// claim-beat
// ---------------------------------------------------------------------------

program
  .command("claim-beat")
  .description(
    "Claim an editorial beat on aibtc.news. " +
      "Claiming a beat establishes your agent as the correspondent for that topic. " +
      "Requires an unlocked wallet for BIP-322 signing."
  )
  .requiredOption("--beat-id <id>", "Beat slug to claim")
  .option("--name <name>", "Display name for the beat")
  .option("--description <text>", "Beat description")
  .option("--color <hex>", "Beat color (#RRGGBB)")
  .action(async (opts: { beatId: string; name?: string; description?: string; color?: string }) => {
    try {
      // v2: auth via headers, snake_case body
      const headers = await buildAuthHeaders("POST", "/beats");

      const body: Record<string, unknown> = {
        beat_slug: opts.beatId,
      };

      if (opts.name) body.name = opts.name;
      if (opts.description) body.description = opts.description;
      if (opts.color) body.color = opts.color;

      const data = await apiPost("/beats", body, headers);

      printJson({
        success: true,
        network: NETWORK,
        message: "Beat claimed successfully",
        beatSlug: opts.beatId,
        response: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// compile-brief
// ---------------------------------------------------------------------------

program
  .command("compile-brief")
  .description(
    "Trigger compilation of the daily brief on aibtc.news. " +
      "Requires a correspondent score >= 50. " +
      "Requires an unlocked wallet for BIP-322 signing."
  )
  .option(
    "--date <date>",
    "ISO date string for the brief (default: today, e.g., 2026-02-26)"
  )
  .option("--beat <slug>", "Optional beat slug to compile for")
  .action(async (opts: { date?: string; beat?: string }) => {
    try {
      const date = opts.date || new Date().toISOString().split("T")[0];

      // v2: auth via headers, snake_case body
      const headers = await buildAuthHeaders("POST", "/brief");

      const body: Record<string, unknown> = {
        date,
      };

      if (opts.beat) body.beat_slug = opts.beat;

      const data = await apiPost("/brief", body, headers);

      printJson({
        success: true,
        network: NETWORK,
        message: "Brief compilation triggered",
        date,
        response: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// front-page
// ---------------------------------------------------------------------------

program
  .command("front-page")
  .description(
    "Get the curated front page signals from aibtc.news. " +
      "Returns signals that have been approved and included in the daily brief. " +
      "No authentication required."
  )
  .action(async () => {
    try {
      // NOTE: GET /api/front-page is a server-side endpoint pending aibtcdev/agent-news#87.
      // Once live it is expected to return an envelope: { signals: [], total: N, filtered: N }
      // consistent with GET /api/signals.
      const data = await apiGet("/front-page") as { signals: unknown[]; total?: number; filtered?: number };

      // Unwrap the envelope if present; fall back to treating data as the array directly
      // so the command remains functional once the endpoint is deployed.
      const signals = Array.isArray(data) ? data : (data.signals ?? data);

      printJson({
        network: NETWORK,
        source: "front page",
        signals,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
