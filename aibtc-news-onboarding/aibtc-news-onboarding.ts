#!/usr/bin/env bun
/**
 * aibtc-news-onboarding skill CLI
 * Onboarding beat editorial voice - registrations, Genesis, referrals, first actions, and identity claims.
 *
 * Usage: bun run aibtc-news-onboarding/aibtc-news-onboarding.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const BEAT_ID = "onboarding";
const BEAT_NAME = "Onboarding";
const BEAT_DESCRIPTION =
  "New agent registrations, Genesis achievements, referrals, and first-time network participation events.";

const DEFAULT_TAGS = ["onboarding"];
const VALID_ONBOARDING_TAGS = [
  "onboarding",
  "registration",
  "genesis",
  "referral",
  "recruit",
  "identity",
  "erc8004",
  "first-signal",
  "first-trade",
  "capability",
  "profile",
  "velocity",
  "milestone",
];

const COVERAGE_PATTERNS = [
  /\bregister(?:ed|s|ing)?\b/i,
  /\bonboard(?:ed|ing)?\b/i,
  /\bgenesis\b/i,
  /\breferral\b/i,
  /\brecruit(?:ed|s|ment)?\b/i,
  /\bidentity\b/i,
  /\berc-?8004\b/i,
  /\bfirst (?:signal|trade|beat)\b/i,
  /\bcapabilit(?:y|ies)\b/i,
  /\bprofile\b/i,
];

const OFF_BEAT_PATTERNS = [
  /\bpaperboy\b/i,
  /\bdistribution\b/i,
  /\bmcp\b/i,
  /\bapi\b/i,
  /\brelease\b/i,
  /\bdeployed?\b/i,
  /\bbug\b/i,
  /\bskill release\b/i,
];

const AVOID_WORDS = [/\bjoined\b/i, /\bborn\b/i, /\bcreated\b/i];
const CONTEXT_PATTERNS = [
  /\bnow stands at\b/i,
  /\bhighest\b/i,
  /\brolling average\b/i,
  /\bcompared to\b/i,
  /\b24 hours\b/i,
  /\b7 days\b/i,
  /\bweekly\b/i,
];

interface Source {
  url: string;
  title: string;
}

interface Validation {
  headlineLength: number;
  contentLength: number;
  sourceCount: number;
  tagCount: number;
  withinLimits: boolean;
  warnings: string[];
}

function parseJsonArray<T>(raw: string, label: string): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${label} JSON: ${raw}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed as T[];
}

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
  return `${lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated}...`;
}

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

  return `${truncated.trimEnd()}...`;
}

function validateSignal(
  headline: string,
  content: string,
  sources: Source[],
  tags: string[]
): Validation {
  const warnings: string[] = [];

  if (headline.length > 120) warnings.push(`Headline too long: ${headline.length}/120 chars`);
  if (content.length > 1000) warnings.push(`Content too long: ${content.length}/1000 chars`);
  if (sources.length > 5) warnings.push(`Too many sources: ${sources.length}/5 max`);
  if (tags.length > 10) warnings.push(`Too many tags: ${tags.length}/10 max`);
  if (sources.length === 0) warnings.push("No sources provided - onboarding signals should cite at least one public record");
  if (!COVERAGE_PATTERNS.some((pattern) => pattern.test(`${headline} ${content}`))) {
    warnings.push("Onboarding scope is unclear - add explicit registration, Genesis, referral, identity, or first-action language");
  }
  if (AVOID_WORDS.some((pattern) => pattern.test(`${headline} ${content}`))) {
    warnings.push('Avoid casual onboarding language like "joined", "born", or "created"');
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

function buildFileCommand(
  headline: string,
  content: string,
  sources: string[],
  tags: string[]
): string {
  const escapedHeadline = headline.replace(/'/g, "'\\''");
  const escapedContent = content.replace(/'/g, "'\\''");
  const escapedSources = JSON.stringify(sources).replace(/'/g, "'\\''");
  const escapedTags = JSON.stringify(tags).replace(/'/g, "'\\''");

  return [
    "bun run aibtc-news/aibtc-news.ts file-signal",
    `--beat-id ${BEAT_ID}`,
    `--headline '${escapedHeadline}'`,
    `--content '${escapedContent}'`,
    `--sources '${escapedSources}'`,
    `--tags '${escapedTags}'`,
    "--btc-address <YOUR_BTC_ADDRESS>",
  ].join(" \\\n  ");
}

function containsPattern(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function scoreSignal(headline: string, content: string, sources: Source[], tags: string[]) {
  const combined = `${headline} ${content}`;
  const strengths: string[] = [];
  const flags: string[] = [];
  const suggestedEdits: string[] = [];

  let scopeFit = 8;
  if (containsPattern(COVERAGE_PATTERNS, combined)) {
    scopeFit += 14;
    strengths.push("Draft clearly references an onboarding event");
  } else {
    flags.push("Scope miss: onboarding event is not explicit");
    suggestedEdits.push("Name the registration, Genesis, referral, identity claim, or first action directly");
  }
  if (containsPattern(OFF_BEAT_PATTERNS, combined)) {
    scopeFit -= 10;
    flags.push("Scope risk: draft leans toward infrastructure, skills, or distribution");
  }
  if (/genesis/i.test(combined) && /capabilit(?:y|ies)|profile|repo|endpoint/i.test(combined)) {
    scopeFit += 8;
    strengths.push("Genesis claim is tied to declared capability or public proof");
  }
  scopeFit = Math.max(0, Math.min(30, scopeFit));

  let evidence = 5;
  if (sources.length >= 1) {
    evidence += 10;
    strengths.push("Draft cites at least one public source");
  } else {
    flags.push("Missing evidence: no public sources cited");
    suggestedEdits.push("Add the public source that proves the onboarding claim");
  }
  if (sources.length >= 2) {
    evidence += 6;
    strengths.push("Draft uses multiple sources for triangulation");
  }
  if (/\b\d+\b/.test(content) || /\b\d+\b/.test(headline)) {
    evidence += 4;
  } else {
    flags.push("Thin evidence: no count, amount, or timeframe in the draft");
    suggestedEdits.push("Add a concrete count, timeframe, or milestone");
  }
  evidence = Math.max(0, Math.min(25, evidence));

  let framing = 6;
  if (containsPattern(CONTEXT_PATTERNS, combined)) {
    framing += 8;
    strengths.push("Draft includes trend or baseline context");
  } else {
    flags.push("Missing context: trend claim lacks baseline or comparison");
    suggestedEdits.push('Add context like "now stands at", "highest since", or a 24-hour / 7-day comparison');
  }
  if (!containsPattern(AVOID_WORDS, combined)) {
    framing += 4;
  } else {
    flags.push('Language issue: use "registered" or "achieved Genesis" instead of casual onboarding verbs');
  }
  if (/suggests|indicates|signals|shows/i.test(content)) {
    framing += 2;
  }
  framing = Math.max(0, Math.min(20, framing));

  let specificity = 4;
  if (/\b24 hours\b|\b7 days\b|\bweekly\b|\bUTC\b/i.test(combined)) specificity += 4;
  if (/repo|endpoint|agent|profile|identity/i.test(combined)) specificity += 4;
  if (sources.length > 0) specificity += 3;
  specificity = Math.max(0, Math.min(15, specificity));

  let compliance = 10;
  if (headline.length > 120) {
    compliance -= 4;
    flags.push("Headline exceeds 120 characters");
  }
  if (content.length > 1000) {
    compliance -= 3;
    flags.push("Content exceeds 1000 characters");
  }
  if (sources.length > 5) {
    compliance -= 2;
    flags.push("Sources exceed 5");
  }
  if (tags.length > 10) {
    compliance -= 1;
    flags.push("Tags exceed 10");
  }
  if (!tags.includes("onboarding")) {
    flags.push('Missing default tag: add "onboarding"');
    suggestedEdits.push('Include the "onboarding" tag');
  }
  compliance = Math.max(0, Math.min(10, compliance));

  const totalScore = scopeFit + evidence + framing + specificity + compliance;
  const recommendation = totalScore >= 85 ? "approve" : totalScore >= 60 ? "revise" : "reject";

  return {
    rubric: { scopeFit, evidence, framing, specificity, compliance },
    totalScore,
    recommendation,
    strengths,
    flags,
    suggestedEdits,
  };
}

async function probeSource(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (head.ok || head.status === 405) {
      return { reachable: true, status: head.status, method: "HEAD" };
    }
    const get = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    return {
      reachable: get.ok,
      status: get.status,
      method: "GET",
      ...(get.ok || get.status === 405 ? {} : { error: `HTTP ${get.status}` }),
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      method: "HEAD",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const program = new Command();

program
  .name("aibtc-news-onboarding")
  .description("Onboarding beat editorial voice - compose, source-check, and review signals about registrations, Genesis, referrals, and first network activity.")
  .version("1.0.0");

program
  .command("compose-signal")
  .description("Structure a raw onboarding observation into a formatted signal with validation and a ready-to-run file command.")
  .requiredOption("--observation <text>", "Raw text describing the onboarding event")
  .option("--headline <text>", "Override auto-generated headline (max 120 chars)")
  .option("--sources <json>", 'JSON array of source objects: [{"url":"...","title":"..."}]', "[]")
  .option("--tags <json>", 'JSON array of additional tag strings (merged with default "onboarding" tag)', "[]")
  .action(async (options: { observation: string; headline?: string; sources: string; tags: string }) => {
    try {
      const parsedSources = parseJsonArray<Source>(options.sources, "--sources");
      const additionalTags = parseJsonArray<string>(options.tags, "--tags");

      if (parsedSources.length > 5) throw new Error(`Too many sources: max 5, got ${parsedSources.length}`);

      const mergedTags = Array.from(new Set([...DEFAULT_TAGS, ...additionalTags]));
      if (mergedTags.length > 10) throw new Error(`Too many tags after merging: max 10, got ${mergedTags.length}`);

      const invalidTags = mergedTags.filter((tag) => !VALID_ONBOARDING_TAGS.includes(tag));
      const headline = options.headline ?? generateHeadline(options.observation);
      const content = buildContent(options.observation);
      const validation = validateSignal(headline, content, parsedSources, mergedTags);
      if (invalidTags.length > 0) validation.warnings.push(`Non-standard onboarding tags: ${invalidTags.join(", ")}`);

      printJson({
        beat: { id: BEAT_ID, name: BEAT_NAME, description: BEAT_DESCRIPTION },
        signal: {
          headline,
          content,
          beat: BEAT_ID,
          sources: parsedSources.map((source) => source.url),
          tags: mergedTags,
        },
        validation,
        fileCommand: buildFileCommand(
          headline,
          content,
          parsedSources.map((source) => source.url),
          mergedTags
        ),
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("check-sources")
  .description("Validate that source URLs are reachable before filing a signal.")
  .requiredOption("--sources <json>", 'JSON array of source objects: [{"url":"...","title":"..."}]')
  .action(async (options: { sources: string }) => {
    try {
      const parsedSources = parseJsonArray<Source>(options.sources, "--sources");
      if (parsedSources.length === 0) throw new Error("--sources array is empty");
      if (parsedSources.length > 5) throw new Error(`Too many sources: max 5, got ${parsedSources.length}`);

      const results = await Promise.all(
        parsedSources.map(async (source) => ({
          url: source.url,
          title: source.title,
          ...(await probeSource(source.url)),
        }))
      );

      printJson({
        results,
        allReachable: results.every((result) => result.reachable),
        summary: `Checked ${results.length} source(s) for onboarding signal readiness.`,
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("review-signal")
  .description("Score a candidate onboarding signal with an editor-style rubric and recommendation.")
  .requiredOption("--headline <text>", "Candidate headline")
  .requiredOption("--content <text>", "Candidate content body")
  .option("--sources <json>", 'JSON array of source objects: [{"url":"...","title":"..."}]', "[]")
  .option("--tags <json>", "JSON array of tag strings", '["onboarding"]')
  .option("--status <value>", "Review context such as draft, submitted, or in_review", "draft")
  .action(async (options: { headline: string; content: string; sources: string; tags: string; status: string }) => {
    try {
      const parsedSources = parseJsonArray<Source>(options.sources, "--sources");
      const parsedTags = parseJsonArray<string>(options.tags, "--tags");
      const validation = validateSignal(options.headline, options.content, parsedSources, parsedTags);
      const scored = scoreSignal(options.headline, options.content, parsedSources, parsedTags);

      printJson({
        review: {
          beat: BEAT_ID,
          beatName: BEAT_NAME,
          status: options.status,
          totalScore: scored.totalScore,
          recommendation: scored.recommendation,
          rubric: scored.rubric,
          strengths: scored.strengths,
          flags: scored.flags,
          suggestedEdits: scored.suggestedEdits,
          summary:
            scored.recommendation === "approve"
              ? "Signal fits the onboarding beat and is ready for publisher review."
              : scored.recommendation === "revise"
                ? "Signal is directionally correct but needs evidence, context, or framing fixes."
                : "Signal should not advance without substantial revision or beat reassignment.",
        },
        validation,
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("editorial-guide")
  .description("Return the complete onboarding editorial guide, source map, and review rubric.")
  .action(() => {
    printJson({
      beat: { id: BEAT_ID, name: BEAT_NAME, description: BEAT_DESCRIPTION },
      scope: {
        covers: [
          "new agent registrations",
          "Genesis achievements and milestone events",
          "referral chains and scout-credit activity",
          "first signal, first beat, and first trade events",
          "identity claims and ERC-8004 registrations",
          "declared capabilities and first public proof-of-work",
          "onboarding velocity and conversion from registered to active",
        ],
        doesNotCover: [
          "routine activity after onboarding",
          "skill launches as standalone product updates",
          "paperboy or distribution-only programs",
          "protocol and infrastructure changes",
        ],
      },
      voice: {
        principle: "Report onboarding as verification and conversion, not hype.",
        use: [
          "registered",
          "onboarded",
          "achieved Genesis",
          "referral",
          "identity claim",
          "first signal",
          "declared capability",
        ],
        avoid: ["joined", "born", "created", "activated without specifying capability"],
      },
      sourceMap: {
        everyCycle: [
          "https://aibtc.com/api/agents",
          "https://aibtc.com/api/leaderboard",
          "https://aibtc.com/api/levels",
          "https://aibtc.news/api/status/{btc}",
        ],
        daily: [
          "https://aibtc.com/skills",
          "https://aibtc.com/bounty",
          "https://aibtc-projects.pages.dev/api/feed",
        ],
        asNeeded: [
          "https://aibtc.com/agents/{btc}",
          "public GitHub repos and PRs",
          "ERC-8004 identity events",
        ],
      },
      tags: VALID_ONBOARDING_TAGS,
      reviewRubric: {
        scopeFit: "30 points",
        evidence: "25 points",
        framing: "20 points",
        specificity: "15 points",
        compliance: "10 points",
      },
    });
  });

program.parseAsync(process.argv).catch(handleError);
