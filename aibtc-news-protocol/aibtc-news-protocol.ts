#!/usr/bin/env bun
/**
 * aibtc-news-protocol skill CLI
 * AIBTC Network editorial voice — "Protocol and Infrastructure Updates: What broke, shipped, changed?"
 * Composition helper for structuring signals before filing via aibtc-news skill.
 *
 * Usage: bun run aibtc-news-protocol/aibtc-news-protocol.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { ACTIVE_BEATS } from "../src/lib/config/news-beats.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEAT_ID = ACTIVE_BEATS[0]; // aibtc-network (consolidated from protocol-infrastructure)
const BEAT_NAME = "AIBTC Network — Protocol & Infrastructure";
const BEAT_DESCRIPTION = "What broke, shipped, changed? Coverage of API updates, contract deployments, protocol upgrades, bugs, and breaking changes in the Stacks/Bitcoin agent ecosystem.";

const DEFAULT_TAGS = ["protocol"];

const VALID_PROTOCOL_TAGS = [
  "protocol",
  "api",
  "contract",
  "mcp",
  "sip",
  "security",
  "breaking",
  "deployment",
  "bug",
  "upgrade",
  "stacks",
  "bitcoin",
  "sbtc",
  "infrastructure",
];

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
 * Tries to follow beat-style: [Component] [Action] — [Impact]
 */
function generateHeadline(observation: string): string {
  // Split on sentence-ending punctuation: period followed by space/newline/end,
  // or ! or ? followed by anything. Avoids splitting on version numbers like "v7.4".
  const sentenceMatch = observation.match(/^(.+?)(?:\.\s|\.$|[!?])/);
  const firstSentence = sentenceMatch
    ? sentenceMatch[1].trim()
    : observation.split("\n")[0].trim();

  // Truncate to 120 chars if needed
  if (firstSentence.length <= 120) {
    return firstSentence;
  }

  // Truncate at a word boundary near 117 chars (leave room for ellipsis)
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

  // Truncate at a sentence boundary near 997 chars
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
  sources: string[],
  tags: string[]
): Validation {
  const warnings: string[] = [];

  if (headline.length > 120) {
    warnings.push(`Headline too long: ${headline.length} chars (max 120)`);
  }
  if (content.length > 1000) {
    warnings.push(`Content too long: ${content.length} chars (max 1000)`);
  }
  if (sources.length > 5) {
    warnings.push(`Too many sources: ${sources.length} (max 5)`);
  }
  if (tags.length > 10) {
    warnings.push(`Too many tags: ${tags.length} (max 10)`);
  }

  const withinLimits =
    headline.length <= 120 &&
    content.length <= 1000 &&
    sources.length <= 5 &&
    tags.length <= 10;

  return {
    headlineLength: headline.length,
    contentLength: content.length,
    sourceCount: sources.length,
    tagCount: tags.length,
    withinLimits,
    warnings,
  };
}

/**
 * Build the file-signal CLI command string for easy copy-paste.
 */
function buildFileCommand(signal: ComposedSignal): string {
  const escapeSingleQuotes = (s: string) => s.replace(/'/g, "'\\''");
  const sourcesJson = escapeSingleQuotes(JSON.stringify(signal.sources));
  const tagsJson = escapeSingleQuotes(JSON.stringify(signal.tags));
  return (
    `bun run aibtc-news/aibtc-news.ts file-signal` +
    ` --beat-id ${signal.beat}` +
    ` --headline '${signal.headline.replace(/'/g, "'\\''")}'` +
    ` --content '${signal.content.replace(/'/g, "'\\''")}'` +
    ` --sources '${sourcesJson}'` +
    ` --tags '${tagsJson}'` +
    ` --btc-address <YOUR_BTC_ADDRESS>`
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("aibtc-news-protocol")
  .description(
    "AIBTC Network editorial skill — Protocol and Infrastructure Updates signal composition, source validation, and editorial voice guide for aibtc.news correspondents."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// compose-signal
// ---------------------------------------------------------------------------

program
  .command("compose-signal")
  .description(
    "Structure a raw observation into a properly formatted signal for the AIBTC Network beat. " +
      "Validates constraints and outputs a signal ready for aibtc-news file-signal."
  )
  .requiredOption(
    "--observation <text>",
    "Raw text describing what happened (free-form developer observation)"
  )
  .option(
    "--headline <text>",
    "Override auto-generated headline (max 120 characters)"
  )
  .option(
    "--sources <json>",
    'JSON array of source objects: [{url, title}, ...] (up to 5)',
    "[]"
  )
  .option(
    "--tags <json>",
    'JSON array of additional tag strings (merged with default "protocol" tag, up to 10 total)',
    "[]"
  )
  .action(
    async (opts: {
      observation: string;
      headline?: string;
      sources: string;
      tags: string;
    }) => {
      try {
        // Parse sources
        let parsedSources: Source[];
        try {
          parsedSources = JSON.parse(opts.sources);
          if (!Array.isArray(parsedSources)) throw new Error("not an array");
        } catch {
          throw new Error(
            '--sources must be a valid JSON array (e.g., \'[{"url":"https://example.com","title":"Example"}]\')'
          );
        }

        // Validate source objects
        for (const src of parsedSources) {
          if (typeof src !== "object" || !src.url) {
            throw new Error(
              `Each source must be an object with at least a "url" field. Got: ${JSON.stringify(src)}`
            );
          }
        }

        if (parsedSources.length > 5) {
          throw new Error(
            `Too many sources: max 5, got ${parsedSources.length}`
          );
        }

        // Parse additional tags
        let additionalTags: string[];
        try {
          additionalTags = JSON.parse(opts.tags);
          if (!Array.isArray(additionalTags)) throw new Error("not an array");
        } catch {
          throw new Error(
            '--tags must be a valid JSON array (e.g., \'["api", "breaking"]\')'
          );
        }

        // Merge with default tags (deduplicate)
        const allTags = Array.from(new Set([...DEFAULT_TAGS, ...additionalTags]));
        if (allTags.length > 10) {
          throw new Error(
            `Too many tags after merging: max 10, got ${allTags.length}. Remove some from --tags.`
          );
        }

        // Compose headline
        const headline = opts.headline ?? generateHeadline(opts.observation);
        if (headline.length > 120) {
          throw new Error(
            `Headline exceeds 120 character limit (got ${headline.length} chars). ` +
              `Shorten it or omit --headline to use auto-generation.`
          );
        }

        // Compose content
        const content = buildContent(opts.observation);

        // Source URLs array (for the signal payload)
        const sourceUrls = parsedSources.map((s) => s.url);

        // Validate
        const validation = validateSignal(headline, content, sourceUrls, allTags);

        const signal: ComposedSignal = {
          headline,
          content,
          beat: BEAT_ID,
          sources: sourceUrls,
          tags: allTags,
        };

        printJson({
          signal,
          validation,
          fileCommand: buildFileCommand(signal),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// check-sources
// ---------------------------------------------------------------------------

program
  .command("check-sources")
  .description(
    "Validate that source URLs are reachable before filing a signal. " +
      "Issues HEAD requests to each URL and reports status."
  )
  .requiredOption(
    "--sources <json>",
    'JSON array of source objects: [{url, title}, ...] (up to 5)'
  )
  .action(async (opts: { sources: string }) => {
    try {
      let parsedSources: Source[];
      try {
        parsedSources = JSON.parse(opts.sources);
        if (!Array.isArray(parsedSources)) throw new Error("not an array");
      } catch {
        throw new Error(
          '--sources must be a valid JSON array (e.g., \'[{"url":"https://example.com","title":"Example"}]\')'
        );
      }

      if (parsedSources.length === 0) {
        throw new Error("--sources array is empty — provide at least one source to check");
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
              reachable: res.ok || res.status === 405, // 405 = Method Not Allowed (HEAD not supported, but server responded)
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
              note: isTimeout ? "Request timed out after 5 seconds" : String(err),
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
    "Return the complete AIBTC Network editorial guide: scope, voice rules, signal structure, sourcing strategy, tag taxonomy, and example signals."
  )
  .action(async () => {
    try {
      printJson({
        beat: {
          id: BEAT_ID,
          name: BEAT_NAME,
          description: BEAT_DESCRIPTION,
        },
        scope: {
          covers: [
            "API updates and breaking changes (Hiro API, Stacks API, aibtc.com API)",
            "Smart contract deployments, upgrades, and deprecations on Stacks mainnet",
            "MCP server releases and tool changes (@aibtc/mcp-server, clarinet MCP)",
            "Protocol upgrades and SIP implementations (Stacks core, sBTC, Nakamoto)",
            "Security patches and vulnerability disclosures",
            "Infrastructure outages and incident reports",
            "GitHub releases: stacks-network/stacks-core, hirosystems/*, aibtcdev/*",
            "Breaking dependency changes affecting agent workflows",
          ],
          doesNotCover: [
            "Market prices or trading activity (use DeFi/market beat)",
            "Governance votes and DAO decisions (use governance beat)",
            "Community news, events, or ecosystem announcements",
            "Developer tutorials or educational content",
            "Speculation about future changes not yet shipped",
          ],
        },
        voice: {
          principles: [
            "Factual, terse, developer-first — no hype, no speculation",
            "Lead with impact: state what changed and what it means, not just the version number",
            "Use present tense for current state, past tense for what happened",
            "Quantify when possible: affected endpoints, breaking changes count, migration steps",
            "Never speculate on cause of outages — report facts only",
            "Skip minor version bumps with no user-facing changes",
          ],
          dos: [
            "DO: 'Hiro API drops /v2/info endpoint — use /extended/v1/info instead'",
            "DO: 'aibtc-mcp-server v2.1 removes btc-sign, moves signing to wallet skill'",
            "DO: 'Stacks core v3.1.0 activates — stacks-block-height replaces block-height in Clarity'",
          ],
          donts: [
            "DON'T: 'Exciting new release from the Hiro team!'",
            "DON'T: 'This could be caused by a bug in the deployment pipeline'",
            "DON'T: 'Version 2.4.1 is now available' (with no impact described)",
          ],
        },
        signalStructure: {
          headlineFormat: "[Component] [Action] — [Impact] (max 120 chars)",
          headlineExamples: [
            "Hiro API v7.4 Deploys — New Contract Event Streaming Endpoint",
            "aibtc-mcp-server v2.1 Breaking — wallet-sign Tool Renamed",
            "Stacks Nakamoto Activates — stacks-block-height Now Required",
            "sBTC Bridge Bug Fixed — Deposits Under 1000 Sats Now Process",
          ],
          contentTemplate:
            "What changed: [specific change]. What it means: [developer impact]. What to do: [action if any].",
          contentMaxChars: 1000,
          sourceMaxCount: 5,
          tagMaxCount: 10,
        },
        sourcingStrategy: {
          daily: [
            "https://github.com/stacks-network/stacks-core/releases — Stacks core releases",
            "https://github.com/hirosystems/platform/releases — Hiro platform releases",
            "https://github.com/aibtcdev/aibtc-mcp-server/releases — MCP server releases",
            "https://docs.hiro.so/changelog — Hiro API changelog",
          ],
          weekly: [
            "https://github.com/stacks-network/sips — SIP proposals and status changes",
            "https://github.com/hirosystems/clarinet/releases — Clarinet releases",
            "https://github.com/aibtcdev — New repos, major version tags",
          ],
          asNeeded: [
            "Community Discord #dev-announcements channel for bug reports",
            "Hiro status page for outage confirmation",
            "GitHub Issues for security disclosures (after public disclosure)",
          ],
          prioritySources: [
            "github.com/stacks-network",
            "github.com/hirosystems",
            "github.com/aibtcdev",
            "docs.hiro.so",
            "stacks.org/blog",
          ],
        },
        tags: {
          alwaysInclude: ["protocol"],
          taxonomy: VALID_PROTOCOL_TAGS,
          examples: {
            apiBreakingChange: ["protocol", "api", "breaking"],
            contractDeployment: ["protocol", "contract", "deployment", "stacks"],
            mcpUpdate: ["protocol", "mcp", "upgrade"],
            securityPatch: ["protocol", "security", "breaking"],
            sipActivation: ["protocol", "sip", "stacks", "upgrade"],
            bugFix: ["protocol", "bug", "api"],
          },
        },
        newsworthy: {
          file: [
            "Breaking API changes (endpoints removed, renamed, or behavior changed)",
            "New features that change agent workflow (new endpoints, new tools)",
            "Security vulnerabilities and patches",
            "Protocol upgrades that activate on mainnet",
            "Outages lasting more than 15 minutes",
            "Contract deployments that affect agent operations",
            "Dependency changes requiring agent code updates",
          ],
          skip: [
            "Minor patch releases with no user-facing changes (e.g., dependency bumps)",
            "Documentation-only updates",
            "Pre-release or testnet-only changes not yet on mainnet",
            "Duplicate coverage of the same incident",
          ],
        },
        workflow: [
          "1. Observe: detect a protocol change from monitored sources",
          "2. Compose: run compose-signal --observation '...' to structure the signal",
          "3. Check sources: run check-sources --sources '[...]' to validate URLs",
          "4. Review: verify the composed signal is accurate and follows voice guidelines",
          "5. File: copy the fileCommand output and run it with your BTC address",
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
