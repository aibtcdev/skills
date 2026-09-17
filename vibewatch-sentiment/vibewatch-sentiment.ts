#!/usr/bin/env bun
/**
 * Vibewatch Stacks sentiment skill CLI
 *
 * Community sentiment for the Stacks ecosystem from the Vibewatch Stacks Vibe
 * Index — the free public index plus x402 pay-per-query depth (per-project
 * score history, evidence receipts behind weekly-report themes, and
 * changes-since deltas).
 *
 * Usage: bun run vibewatch-sentiment/vibewatch-sentiment.ts <subcommand> [options]
 */

import { Command } from "commander";
import { createApiClient } from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Endpoint hosts — the API host serves both tiers; discovery lives at
// https://stacks.vibewatch.io/.well-known/x402.json
// ---------------------------------------------------------------------------

const HOSTS = {
  mainnet: "https://api.vibewatch.io",
  testnet: "https://vibewatch-rc.up.railway.app",
} as const;

type NetworkOption = keyof typeof HOSTS;

function resolveHost(networkOpt: string | undefined): { network: NetworkOption; baseUrl: string } {
  const net = (networkOpt ?? "mainnet").toLowerCase();
  if (net !== "mainnet" && net !== "testnet") {
    throw new Error(`invalid --network "${networkOpt}". Must be "mainnet" or "testnet".`);
  }
  return { network: net as NetworkOption, baseUrl: HOSTS[net as NetworkOption] };
}

function normalizeProjectQuery(raw: string | undefined): string {
  const s = String(raw ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  if (!s) throw new Error("--project is required");
  if (s.length > 64) throw new Error("--project too long (max 64 chars)");
  if (!/^[a-z0-9 .-]+$/.test(s)) throw new Error("--project must be a project name or slug ([a-z0-9 .-])");
  return s;
}

type PanelProject = { slug: string; name: string; score?: number | null };

// Resolve a human name or bare slug to the panel's real slug with ONE free
// index read, before anything is paid. Live slugs carry disambiguation
// suffixes ("zest-protocol-3672"), so an agent typing "zest-protocol" or
// "Zest Protocol" would otherwise hit the paid route's 404 precheck. Match
// order: exact slug, exact name, unique slug prefix, unique name prefix.
async function resolveProjectSlug(
  baseUrl: string,
  query: string,
): Promise<{ slug: string; name: string; score: number | null; resolved_from?: string }> {
  const index = (await fetchFree(baseUrl, "/api/v1/public/stacks-index")) as { projects?: PanelProject[] };
  const projects = Array.isArray(index.projects) ? index.projects : [];
  const norm = (s: string) => s.toLowerCase().trim();
  const exactSlug = projects.find((p) => p.slug === query);
  if (exactSlug) return { slug: exactSlug.slug, name: exactSlug.name, score: exactSlug.score ?? null };
  const exactName = projects.find((p) => norm(p.name) === query);
  if (exactName) return { slug: exactName.slug, name: exactName.name, score: exactName.score ?? null, resolved_from: query };
  const dashed = query.replace(/[ .]+/g, "-");
  const bySlugPrefix = projects.filter((p) => p.slug === dashed || p.slug.startsWith(`${dashed}-`));
  const candidates = bySlugPrefix.length > 0 ? bySlugPrefix : projects.filter((p) => norm(p.name).startsWith(query));
  if (candidates.length === 1) {
    return { slug: candidates[0].slug, name: candidates[0].name, score: candidates[0].score ?? null, resolved_from: query };
  }
  if (candidates.length > 1) {
    throw new Error(`--project "${query}" is ambiguous: ${candidates.map((p) => p.slug).join(", ")}. Use the exact slug.`);
  }
  const known = projects.map((p) => `${p.slug} (${p.name})`).join(", ");
  throw new Error(`--project "${query}" is not on the current panel. Panel slugs: ${known || "(the panel is empty on this index)"}`);
}

function normalizeWeek(raw: string | undefined): string {
  const s = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("--week must be YYYY-MM-DD (a Monday)");
  return s;
}

// Confirm the week has a completed report with ONE free archive read, before
// the engine touches the wallet. Without this the locked-wallet check fires
// first and a bad week (a Tuesday, a week with no report) is only caught
// after unlock — found by Sonic Mast's cold run, 2026-09-04.
async function resolveReportWeek(baseUrl: string, week: string): Promise<string> {
  const data = (await fetchFree(baseUrl, "/api/v1/public/stacks-index/reports")) as {
    reports?: { week_start: string }[];
  };
  const weeks = (Array.isArray(data.reports) ? data.reports : []).map((r) => r.week_start);
  if (weeks.includes(week)) return week;
  throw new Error(
    `--week "${week}" has no completed report. Completed weeks (week_start): ${weeks.join(", ") || "(none)"}. ` +
      "Run the free reports subcommand to list them.",
  );
}

function normalizeSince(raw: string | undefined): string {
  const fallback = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--since "${raw}" is not an ISO-8601 timestamp`);
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Free-route helper — the public index needs no payment and no wallet
// ---------------------------------------------------------------------------

async function fetchFree(baseUrl: string, path: string): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

function decodePaymentReceipt(header: unknown): Record<string, unknown> | undefined {
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Turn a non-402 HTTP failure from the paid route into an error that carries
 * the status and the index's own body. The shared engine only intercepts 402;
 * anything else (e.g. the free 422 `project_not_scored` refusal) rejects as a
 * bare axios error whose message is "Request failed with status code N".
 */
function describePaidFailure(error: unknown): Error | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as { response?: { status?: unknown; data?: unknown } }).response;
  if (typeof response?.status !== "number" || response.status === 402) return undefined;
  let body: string;
  try {
    body = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  } catch {
    body = String(response.data);
  }
  if (body === undefined || body === "undefined") body = "";
  if (body.length > 500) body = `${body.slice(0, 500)}…`;
  return new Error(`HTTP ${response.status} from the index before any payment: ${body || "(empty body)"}`);
}

async function paidGet(baseUrl: string, path: string, tool: string): Promise<Record<string, unknown>> {
  const api = await createApiClient(baseUrl, tool);
  let response;
  try {
    response = await api.request({ method: "GET", url: path });
  } catch (error) {
    throw describePaidFailure(error) ?? error;
  }
  const output: Record<string, unknown> = {
    ...(typeof response.data === "object" && response.data !== null ? response.data : {}),
    endpoint: `${baseUrl}${path}`,
  };
  const receipt = decodePaymentReceipt(response.headers?.["payment-response"]);
  if (receipt) output.payment_receipt = receipt;
  return output;
}

// ---------------------------------------------------------------------------
// Commander setup
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("vibewatch-sentiment")
  .description("Stacks ecosystem community sentiment from the Vibewatch Stacks Vibe Index")
  .version("0.0.1");

// ---------------------------------------------------------------------------
// index — FREE: the full public Stacks Vibe Index payload
// ---------------------------------------------------------------------------

program
  .command("index")
  .description(
    "Free. The live Stacks Vibe Index: ecosystem composite (0-10), per-project scores, 90-day history, weekly numbers, themes, and governance votes. No wallet needed.",
  )
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      const data = await fetchFree(baseUrl, "/api/v1/public/stacks-index");
      printJson({ ...(data as object), network, endpoint: `${baseUrl}/api/v1/public/stacks-index` });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// terms — FREE: current x402 payment terms + paid resource list
// ---------------------------------------------------------------------------

program
  .command("terms")
  .description(
    "Free. The x402 discovery document: current price, accepted assets (sBTC/STX), payTo, and every paid resource. Check before the first paid call.",
  )
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      const data = await fetchFree(baseUrl, "/.well-known/x402.json");
      printJson({ ...(data as object), network });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// reports — FREE: the weekly-report archive, i.e. the valid --week values
// ---------------------------------------------------------------------------

type ArchiveReport = {
  week_start: string;
  week_end: string;
  title: string;
  week_composite: number | null;
  wow: number | null;
};

program
  .command("reports")
  .description(
    "Free. The Stacks Vibe Weekly archive: one line per completed report (week_start = the --week value for the paid evidence subcommand, title, composite, week-over-week). No wallet needed.",
  )
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      const data = (await fetchFree(baseUrl, "/api/v1/public/stacks-index/reports")) as {
        as_of?: string;
        reports?: ArchiveReport[];
      };
      const reports = (Array.isArray(data.reports) ? data.reports : []).map((r) => ({
        week_start: r.week_start,
        week_end: r.week_end,
        title: r.title,
        week_composite: r.week_composite,
        wow: r.wow,
        page: `https://stacks.vibewatch.io/reports/${r.week_start}`,
      }));
      printJson({
        as_of: data.as_of,
        count: reports.length,
        reports,
        hint: "Use a week_start above as --week for the paid evidence subcommand.",
        network,
        endpoint: `${baseUrl}/api/v1/public/stacks-index/reports`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// project — PAID: one project's daily sentiment series (up to 90 days)
// ---------------------------------------------------------------------------

program
  .command("project")
  .description(
    "Paid (100 sats sBTC or the advertised STX price per query). One panel project's daily composite sentiment series, up to 90 days, plus its current score and week-over-week change.",
  )
  .requiredOption(
    "--project <name-or-slug>",
    'panel project name or slug ("Zest Protocol", "zest-protocol", or the exact slug from the free index)',
  )
  .option("--days <days>", "history window, 1-90", "90")
  .option(
    "--allow-unscored",
    "skip the free score pre-check; the index itself refuses an unscored project with a free 422 project_not_scored, so nothing is paid either way",
    false,
  )
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      const query = normalizeProjectQuery(options.project);
      // One free read resolves the slug BEFORE any payment is signed.
      const resolved = await resolveProjectSlug(baseUrl, query);
      // A panel project with no current score (free index `score: null`) used
      // to be served by the paid endpoint as a 200 with `series: []` — a
      // charged query for an empty series (found by Celestial Shark, aibtc
      // bounty mtt3jjrgcf0aa8fb225c, 2026-09-08). Since 2026-09-16 the index
      // refuses such a slug with a free 422 `{"detail":{"error":
      // "project_not_scored","slug":…,"days":…}}` before the 402, so nothing
      // can be charged; this pre-check stays as the faster local guard.
      if (resolved.score === null && !options.allowUnscored) {
        throw new Error(
          `--project "${resolved.slug}" has no current score in the free index; the paid series would be empty. ` +
            "Pass --allow-unscored to pay anyway.",
        );
      }
      // Reject rather than silently widen: `--days 0` or `--days abc` must not become a 90-day query.
      const rawDays = String(options.days ?? "90").trim();
      if (!/^\d+$/.test(rawDays) || Number(rawDays) < 1 || Number(rawDays) > 90) {
        throw new Error(`--days must be an integer from 1 to 90, got "${options.days}"`);
      }
      const days = Number(rawDays);
      const path = `/api/v1/public/stacks-index/pro/projects/${resolved.slug}?days=${days}`;
      const output = await paidGet(baseUrl, path, "vibewatch-sentiment.project");
      printJson({
        ...output,
        project: {
          slug: resolved.slug,
          name: resolved.name,
          ...(resolved.resolved_from ? { resolved_from: resolved.resolved_from } : {}),
        },
        network,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// evidence — PAID: public-source receipts behind a weekly report's themes
// ---------------------------------------------------------------------------

program
  .command("evidence")
  .description(
    "Paid. The receipts behind one weekly report's themes: links to the public posts (with attributed excerpts for X posts) that back each theme. Primary-source trail for citing sentiment claims. --week is a week_start from the free reports subcommand.",
  )
  .requiredOption("--week <YYYY-MM-DD>", "the report's week_start (a Monday; list them with the free reports subcommand)")
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      // One free read confirms the week BEFORE any payment is signed.
      const week = await resolveReportWeek(baseUrl, normalizeWeek(options.week));
      const path = `/api/v1/public/stacks-index/pro/evidence/${week}`;
      const output = await paidGet(baseUrl, path, "vibewatch-sentiment.evidence");
      printJson({ ...output, network });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// delta — PAID: what changed since a timestamp
// ---------------------------------------------------------------------------

program
  .command("delta")
  .description(
    "Paid. What changed since a timestamp (hour-bucketed): per-project score moves with baselines, ecosystem composite then/now, current themes, and reports published since. Built for polling agents — defaults to the last 24h.",
  )
  .option("--since <iso>", "ISO-8601 timestamp (default: 24h ago; clamped to the last 90 days)")
  .option("--network <network>", "mainnet | testnet", "mainnet")
  .action(async (options) => {
    try {
      const { network, baseUrl } = resolveHost(options.network);
      const since = normalizeSince(options.since);
      const path = `/api/v1/public/stacks-index/pro/delta?since=${encodeURIComponent(since)}`;
      const output = await paidGet(baseUrl, path, "vibewatch-sentiment.delta");
      printJson({ ...output, network });
    } catch (error) {
      handleError(error);
    }
  });

program.parseAsync(process.argv).catch(handleError);
