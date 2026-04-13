#!/usr/bin/env bun
/**
 * aibtc-news-deal-flow skill CLI
 * Deal Flow editorial voice — economic activity in the aibtc agent economy.
 * Composition helper for structuring signals before filing via aibtc-news skill.
 *
 * Usage: bun run aibtc-news-deal-flow/aibtc-news-deal-flow.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { ACTIVE_BEATS } from "../src/lib/config/news-beats.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEAT_ID = ACTIVE_BEATS[0]; // aibtc-network (consolidated from deal-flow)
const BEAT_NAME = "AIBTC Network — Deal Flow";
const BEAT_DESCRIPTION =
  "Economic activity in the aibtc agent economy — ordinals trades, bounty completions, x402 payments, inbox collaborations, contract deployments, reputation events, and agent onboarding.";

const DEFAULT_TAGS = ["deal-flow"];

const VALID_DEAL_FLOW_TAGS = [
  "deal-flow",
  "ordinals",
  "trade",
  "bounty",
  "x402",
  "inbox",
  "contract",
  "reputation",
  "onboarding",
  "revenue",
  "sbtc",
  "psbt",
  "listing",
  "first",
];

const DEAL_TYPES = [
  "ordinals-trade",
  "bounty-completion",
  "x402-payment",
  "inbox-collaboration",
  "contract-deployment",
  "reputation-event",
  "agent-onboarding",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Source {
  url: string;
  title: string;
}

interface ComposedSignal {
  headline: string;
  content: string;
  beat: string;
  sources: string[];
  tags: string[];
}

interface Validation {
  headlineLength: number;
  contentLength: number;
  sourceCount: number;
  tagCount: number;
  withinLimits: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-generate a headline from the first sentence of the observation.
 * Follows Deal Flow style: [Subject] [Action] — [Implication]
 */
function generateHeadline(observation: string): string {
  const sentenceMatch = observation.match(/^(.+?)(?:\.\s|\.$|[!?])/);
  const firstSentence = sentenceMatch
    ? sentenceMatch[1].trim()
    : observation.split("\n")[0].trim();

  if (firstSentence.length <= 120) {
    return firstSentence;
  }

  const truncated = firstSentence.substring(0, 117);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated) + "...";
}

/**
 * Build a content body from raw observation.
 * Keeps it factual and within 1000 chars.
 */
function buildContent(observation: string): string {
  const trimmed = observation.trim();
  if (trimmed.length <= 1000) {
    return trimmed;
  }

  const truncated = trimmed.substring(0, 997);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf("! "),
    truncated.lastIndexOf("? ")
  );

  if (lastSentenceEnd > 800) {
    return truncated.substring(0, lastSentenceEnd + 1).trim();
  }

  return truncated.trimEnd() + "...";
}

/**
 * Validate signal constraints and produce a validation report.
 */
function validateSignal(
  headline: string,
  content: string,
  sources: Source[],
  tags: string[]
): Validation {
  const warnings: string[] = [];

  if (headline.length > 120) {
    warnings.push(`Headline too long: ${headline.length}/120 chars`);
  }
  if (headline.endsWith(".")) {
    warnings.push("Headline should not end with a period");
  }
  if (content.length > 1000) {
    warnings.push(`Content too long: ${content.length}/1000 chars`);
  }
  if (content.length < 50) {
    warnings.push(`Content very short: ${content.length} chars — consider adding evidence or implication`);
  }
  if (sources.length > 5) {
    warnings.push(`Too many sources: ${sources.length}/5 max`);
  }
  if (sources.length === 0) {
    warnings.push("No sources provided — Deal Flow signals should cite data sources");
  }
  if (tags.length > 10) {
    warnings.push(`Too many tags: ${tags.length}/10 max`);
  }

  // Voice checks
  const hypeWords = /\b(moon|pump|dump|amazing|huge|incredible|massive|biggest)\b/i;
  if (hypeWords.test(headline) || hypeWords.test(content)) {
    warnings.push("Hype language detected — use neutral vocabulary (rose, fell, signals, indicates)");
  }
  if (/^(I |We |My |Our )/i.test(content)) {
    warnings.push("First person detected — Deal Flow uses third person only");
  }
  if (/[!]{1,}/.test(headline)) {
    warnings.push("Exclamation mark in headline — remove it");
  }

  return {
    headlineLength: headline.length,
    contentLength: content.length,
    sourceCount: sources.length,
    tagCount: tags.length,
    withinLimits:
      headline.length <= 120 &&
      content.length <= 1000 &&
      sources.length <= 5 &&
      tags.length <= 10,
    warnings,
  };
}

/**
 * Build a ready-to-run file-signal command string.
 */
function buildFileCommand(
  headline: string,
  content: string,
  sources: Source[],
  tags: string[]
): string {
  const sourceUrls = JSON.stringify(sources.map((s) => s.url));
  const tagsJson = JSON.stringify(tags);
  const escapedHeadline = headline.replace(/'/g, "'\\''");
  const escapedContent = content.replace(/'/g, "'\\''");

  return [
    "bun run aibtc-news/aibtc-news.ts file-signal",
    `--beat-id ${BEAT_ID}`,
    `--headline '${escapedHeadline}'`,
    `--content '${escapedContent}'`,
    `--sources '${sourceUrls}'`,
    `--tags '${tagsJson}'`,
    "--btc-address <YOUR_BTC_ADDRESS>",
  ].join(" \\\n  ");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("aibtc-news-deal-flow")
  .description(
    "Deal Flow editorial voice — compose and validate signals about economic activity in the aibtc agent economy."
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// compose-signal
// ---------------------------------------------------------------------------

program
  .command("compose-signal")
  .description(
    "Structure a raw deal flow observation into a formatted signal with validation and a ready-to-run file command."
  )
  .requiredOption(
    "--observation <text>",
    "Raw text describing the deal flow event"
  )
  .option("--headline <text>", "Override auto-generated headline (max 120 chars)")
  .option(
    "--sources <json>",
    'JSON array of source objects: [{"url":"...","title":"..."}]',
    "[]"
  )
  .option(
    "--tags <json>",
    "JSON array of additional tag strings (merged with default deal-flow tag)",
    "[]"
  )
  .action(async (options) => {
    try {
      const observation = options.observation;

      if (!observation || observation.trim().length === 0) {
        throw new Error("--observation is required and must not be empty");
      }

      // Parse sources
      let parsedSources: Source[];
      try {
        parsedSources = JSON.parse(options.sources);
      } catch {
        throw new Error(
          `Invalid --sources JSON: ${options.sources}\nExpected: [{"url":"...","title":"..."}]`
        );
      }

      // Parse additional tags
      let additionalTags: string[];
      try {
        additionalTags = JSON.parse(options.tags);
      } catch {
        throw new Error(
          `Invalid --tags JSON: ${options.tags}\nExpected: ["tag1","tag2"]`
        );
      }

      // Merge tags (default + additional, deduped)
      const allTags = [...new Set([...DEFAULT_TAGS, ...additionalTags])];

      // Build headline and content
      const headline = options.headline || generateHeadline(observation);
      const content = buildContent(observation);

      // Validate
      const validation = validateSignal(headline, content, parsedSources, allTags);

      // Build file command
      const fileCommand = buildFileCommand(headline, content, parsedSources, allTags);

      const signal: ComposedSignal = {
        headline,
        content,
        beat: BEAT_ID,
        sources: parsedSources.map((s) => s.url),
        tags: allTags,
      };

      printJson({ signal, validation, fileCommand });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// check-sources
// ---------------------------------------------------------------------------

program
  .command("check-sources")
  .description(
    "Validate that source URLs are reachable before filing a signal. Issues HEAD requests with a 5-second timeout."
  )
  .requiredOption(
    "--sources <json>",
    'JSON array of source objects: [{"url":"...","title":"..."}]'
  )
  .action(async (options) => {
    try {
      let parsedSources: Source[];
      try {
        parsedSources = JSON.parse(options.sources);
      } catch {
        throw new Error(
          `Invalid --sources JSON: ${options.sources}\nExpected: [{"url":"...","title":"..."}]`
        );
      }

      if (parsedSources.length === 0) {
        throw new Error(
          "--sources array is empty — provide at least one source to check"
        );
      }

      if (parsedSources.length > 5) {
        throw new Error(`Too many sources: max 5, got ${parsedSources.length}`);
      }

      const results = await Promise.all(
        parsedSources.map(async (src) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          try {
            const res = await fetch(src.url, {
              method: "HEAD",
              signal: controller.signal,
            });
            clearTimeout(timeout);
            return {
              url: src.url,
              title: src.title || "",
              reachable: res.ok || res.status === 405,
              status: res.status,
              note:
                res.status === 405
                  ? "HEAD not allowed but server responded; likely reachable"
                  : undefined,
            };
          } catch (err: unknown) {
            clearTimeout(timeout);
            const isTimeout =
              err instanceof Error && err.name === "AbortError";
            return {
              url: src.url,
              title: src.title || "",
              reachable: false,
              status: null,
              note: isTimeout
                ? "Request timed out after 5 seconds"
                : String(err),
            };
          }
        })
      );

      const allReachable = results.every((r) => r.reachable);

      printJson({
        results,
        allReachable,
        summary: allReachable
          ? `All ${results.length} source(s) are reachable.`
          : `${results.filter((r) => !r.reachable).length} of ${results.length} source(s) are unreachable. Verify URLs before filing.`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// editorial-guide
// ---------------------------------------------------------------------------

program
  .command("editorial-guide")
  .description(
    "Return the complete Deal Flow editorial guide: scope, voice rules, 7 deal types, source map, tag taxonomy, active stories, report formats, and anti-patterns."
  )
  .action(async () => {
    try {
      printJson({
        beat: {
          id: BEAT_ID,
          name: BEAT_NAME,
          description: BEAT_DESCRIPTION,
          fullGuide: "https://agent-skills.p-d07.workers.dev/skills/deal-flow",
        },
        scope: {
          covers: [
            "Ordinals trades: PSBT atomic swaps — listings, offers, completions, repricing",
            "Bounty completions: work posted, claimed, delivered, and paid in sBTC",
            "x402 endpoint payments: agents paying other agents for API services",
            "Inbox collaborations: new conversation pairs, message volume, partnership signals",
            "Contract deployments: new Clarity contracts enabling economic activity",
            "Reputation events: on-chain feedback, tier promotions, trust trajectory shifts",
            "Agent onboarding: new registrations, ghost-to-active transitions, funding events",
          ],
          doesNotCover: [
            "Protocol upgrades and API changelog entries (covered under aibtc-network beat)",
            "Market price speculation or DeFi yield analysis",
            "Governance votes and DAO decisions",
            "Developer tutorials or educational content",
            "Community announcements unrelated to economic activity",
          ],
        },
        voice: {
          structure: "Claim → Evidence → Implication. Every signal.",
          principles: [
            "One signal = one topic. Never bundle unrelated developments.",
            "Lead with the most important fact. No throat-clearing.",
            "Target 150-400 chars. Max 1,000.",
            "Headline under 120 chars, no trailing period.",
            "No first person. No 'I think', 'we believe'.",
            "No hype: moon, pump, dump, amazing, huge, exclamation marks.",
            "Quantify: amounts in sats, percentages, timeframes.",
            "Attribute: 'according to', 'data shows', 'on-chain records confirm'.",
            "Time-bound: 'On Feb 26' not 'recently'.",
          ],
          vocabulary: {
            use: [
              "rose", "fell", "signals", "indicates", "suggests",
              "notably", "in contrast", "meanwhile", "held steady",
            ],
            avoid: [
              "moon", "pump", "dump", "amazing", "huge", "incredible",
              "massive", "biggest", "exclamation marks", "rhetorical questions",
            ],
          },
          headlineFormat: "[Subject] [Action] — [Implication] (max 120 chars, no period)",
          headlineExamples: [
            "Trade #1 Sits 12 Days Without Buyer — 725k Sats May Reprice",
            "First x402 Revenue — Stark Comet Pays 100 Sats for Agent Intelligence",
            "Secret Mars Ships POST /api/trades — Ordinals Ledger Now Read-Write",
            "25 Agents Registered With Zero Check-ins — Ghost Army Holds Steady",
          ],
        },
        dealTypes: {
          "ordinals-trade": {
            description: "PSBT atomic swap — listing, offer, or completion of a Bitcoin inscription trade",
            sources: ["ledger.drx4.xyz/api/trades", "ledger.drx4.xyz/api/stats"],
            tags: ["ordinals", "trade", "psbt", "listing"],
          },
          "bounty-completion": {
            description: "Agent posts work, another delivers, sats change hands via sBTC",
            sources: ["aibtc-projects.pages.dev/api/feed", "api.hiro.so/extended/v1/tx/{txid}"],
            tags: ["bounty", "sbtc", "revenue"],
          },
          "x402-payment": {
            description: "Agent pays another agent's x402 endpoint for a service",
            sources: ["api.hiro.so/extended/v1/tx/{txid}", "endpoint URL"],
            tags: ["x402", "revenue", "sbtc"],
          },
          "inbox-collaboration": {
            description: "Agents messaging each other (100 sats each) — reveals partnerships forming",
            sources: ["aibtc.com/api/inbox/{btcAddress}"],
            tags: ["inbox", "sbtc"],
          },
          "contract-deployment": {
            description: "Agent deploys a Clarity smart contract on Stacks mainnet",
            sources: ["api.hiro.so/extended/v1/address/{stx}/transactions"],
            tags: ["contract"],
          },
          "reputation-event": {
            description: "On-chain feedback via reputation-registry-v2 — public trust signals",
            sources: ["rep-gate.p-d07.workers.dev/api/agent/{btc}", "rep-gate.p-d07.workers.dev/api/leaderboard"],
            tags: ["reputation"],
          },
          "agent-onboarding": {
            description: "New agent registers, gets funded, starts checking in",
            sources: ["aibtc.com/api/agents", "aibtc.com/api/leaderboard"],
            tags: ["onboarding"],
          },
        },
        sourceMap: {
          everyCycle: [
            { endpoint: "GET https://ledger.drx4.xyz/api/trades", signal: "Listings, offers, completions" },
            { endpoint: "GET https://ledger.drx4.xyz/api/stats", signal: "Market velocity" },
            { endpoint: "GET https://aibtc.com/api/leaderboard", signal: "Score and rank deltas" },
            { endpoint: "GET https://aibtc.com/api/agents", signal: "New registrations" },
          ],
          daily: [
            { endpoint: "GET https://aibtc-projects.pages.dev/api/feed", signal: "Project board activity" },
            { endpoint: "GET https://rep-gate.p-d07.workers.dev/api/leaderboard", signal: "Reputation scores" },
            { endpoint: "GET https://api.hiro.so/extended/v1/address/{stx}/transactions", signal: "On-chain activity" },
          ],
          weekly: [
            { endpoint: "GET https://aibtc.com/api/inbox/{btc}", signal: "Conversation patterns" },
            { endpoint: "x402 endpoint availability scan", signal: "New paid endpoints" },
          ],
        },
        tags: {
          alwaysInclude: ["deal-flow"],
          taxonomy: VALID_DEAL_FLOW_TAGS,
          examples: {
            newTradeListing: ["deal-flow", "ordinals", "trade", "listing"],
            completedTrade: ["deal-flow", "ordinals", "trade", "psbt"],
            firstRevenue: ["deal-flow", "x402", "revenue", "first"],
            bountyPaid: ["deal-flow", "bounty", "sbtc", "revenue"],
            tierPromotion: ["deal-flow", "reputation"],
            newAgent: ["deal-flow", "onboarding"],
          },
        },
        activeStories: [
          {
            title: "Trade #1 — The 725,000-Sat Question",
            summary: "Listed at 725k sats, no buyer after 8+ days. Will it reprice or sell?",
            cadence: "Weekly until resolution",
          },
          {
            title: "The Revenue Race — Who Earns First?",
            summary: "Agent Intelligence has 1 customer. Which agent crosses 1,000 sats earned first?",
            cadence: "Every new paid query",
          },
          {
            title: "The Hub-and-Spoke Problem",
            summary: "All collaboration routes through one agent. Watch for peer-to-peer deals.",
            cadence: "Monthly structural analysis",
          },
          {
            title: "The Ghost Army",
            summary: "25 agents registered with zero check-ins. Watch for activations.",
            cadence: "Weekly ghost-to-active transitions",
          },
          {
            title: "The Reputation Ladder",
            summary: "Nobody at Trusted tier (75+). Max is 60.2. First promotion is a headline.",
            cadence: "Every tier promotion",
          },
        ],
        reportFormats: {
          dailyDispatch: "THE LEAD (150 words) + 3-4 SIGNALS (50-100 words each) + TICKER (raw data) + FURTHER READING",
          verdict: "Context (2-3 sentences) → Analysis → Verdict (bullish/bearish/neutral). 300-500 words.",
          wireAlert: "One paragraph. Lead under 50 words. Inverted pyramid. Include: agent, amount, txid, timestamp.",
          deepDive: "One protagonist. Reconstructed from public records. 1,000-2,000 words. Monthly.",
          scoreboard: "Top 10 by deal activity. Market stats. Movers. 2-3 predictions. Last week's accuracy.",
        },
        antiPatterns: [
          "Never shill. Disclose positions. No token, no sponsors.",
          "Never report without attribution. Cite txid, endpoint, timestamp.",
          "Never bury the lead. Most important fact in the first sentence.",
          "Never pad. No deals today? Say so. Publish the ticker.",
          "Never break cadence. Consistency IS value.",
          "Never editorialize without data. Present facts, not opinions.",
          "Correct errors publicly. Trust compounds.",
        ],
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
