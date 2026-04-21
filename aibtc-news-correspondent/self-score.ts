#!/usr/bin/env bun
/**
 * aibtc-news-correspondent self-score CLI
 * Platform 5-dimension scoring before submission
 *
 * Usage:
 *   bun run aibtc-news-correspondent/self-score.ts score --headline "..." --body "..." --sources-url "url1,url2" --tags "bitcoin,defi" --beat bitcoin-macro
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

interface ScoreInput {
  headline: string;
  body: string;
  sourcesUrl: string[];
  tags: string[];
  beatSlug: string;
  disclosure?: string;
}

interface ScoreResult {
  total: number;
  max: number;
  dimensions: DimensionScore[];
  breakdown: string[];
  recommendations: string[];
}

interface DimensionScore {
  name: string;
  score: number;
  max: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Scoring Logic
// ---------------------------------------------------------------------------

function scoreSourceQuality(urls: string[]): DimensionScore {
  const count = urls.length;
  const hasYear = urls.some((u) => u.includes("2025") || u.includes("2026"));
  const hasPrimary = urls.some(
    (u) =>
      u.includes("arxiv") ||
      u.includes("eprint.iacr") ||
      u.includes("nist.gov") ||
      u.includes("github.com") ||
      u.includes("hiro.so") ||
      u.includes("stacks.co")
  );

  let score = 0;

  // 3+ sources = 30 (max)
  if (count >= 5) score += 30;
  else if (count >= 3) score += 30;
  else if (count >= 1) score += 20;

  // Year in URL = +5 (within 15 max)
  if (hasYear) score += 5;

  // PRIMARY source = +5
  if (hasPrimary) score += 5;

  return {
    name: "sourceQuality",
    score: Math.min(score, 30),
    max: 30,
    detail: `${count} sources, year:${hasYear ? "yes" : "no"}, primary:${hasPrimary ? "yes" : "no"}`,
  };
}

function scoreThesisClarity(headline: string, body: string): DimensionScore {
  const words = headline.split(/\s+/).filter(Boolean);
  const bodyLen = body.length;

  let score = 0;
  const details: string[] = [];

  // Headline: 8-15 words = 15 (max)
  if (words.length >= 8 && words.length <= 15) {
    score += 15;
    details.push(`${words.length} words (optimal)`);
  } else if (words.length < 8) {
    score += 5;
    details.push(`${words.length} words (too short, need 8-15)`);
  } else {
    score += 10;
    details.push(`${words.length} words (too long)`);
  }

  // Body: 200+ chars = 10 (max)
  if (bodyLen >= 500) {
    score += 10;
    details.push(`${bodyLen} chars (excellent)`);
  } else if (bodyLen >= 200) {
    score += 10;
    details.push(`${bodyLen} chars (good)`);
  } else if (bodyLen >= 100) {
    score += 5;
    details.push(`${bodyLen} chars (too short, need 200+)`);
  } else {
    score += 0;
    details.push(`${bodyLen} chars (too short)`);
  }

  return {
    name: "thesisClarity",
    score: Math.min(score, 25),
    max: 25,
    detail: details.join(", "),
  };
}

function scoreBeatRelevance(tags: string[], beatSlug: string): DimensionScore {
  // Quantum beat has fixed score of 10/20
  if (beatSlug === "quantum") {
    return {
      name: "beatRelevance",
      score: 10,
      max: 20,
      detail: "Quantum beat: fixed 10/20 (requires Consequence Gate)",
    };
  }

  // Match tags to beat
  const beatKeywords: Record<string, string[]> = {
    "bitcoin-macro": ["bitcoin", "btc", "macro", "etf", "institution", "mining", "price"],
    "aibtc-network": ["agent", "ai", "protocol", "github", "pr", "release"],
    "quantum": ["quantum", "post-quantum", "lattice", "pqc", "cryptography"],
  };

  const keywords = beatKeywords[beatSlug] ?? [];
  const matchCount = tags.filter((t) =>
    keywords.some((k) => t.toLowerCase().includes(k))
  ).length;

  const score = matchCount >= 2 ? 20 : matchCount >= 1 ? 15 : 5;

  return {
    name: "beatRelevance",
    score,
    max: 20,
    detail: `${matchCount} tag matches for ${beatSlug}`,
  };
}

function scoreTimeliness(urls: string[]): DimensionScore {
  const has2026 = urls.some((u) => u.includes("2026"));
  const has2025 = urls.some((u) => u.includes("2025"));
  const hasRecent = urls.some(
    (u) =>
      u.includes("arxiv") ||
      u.includes("eprint") ||
      u.includes("github.com") ||
      u.includes("hiro.so")
  );

  let score = 0;

  if (has2026) score += 15;
  else if (has2025) score += 10;
  else if (hasRecent) score += 8;
  else score += 5;

  return {
    name: "timeliness",
    score: Math.min(score, 15),
    max: 15,
    detail: has2026 ? "2026 URL" : has2025 ? "2025 URL" : hasRecent ? "recent source" : "no date in URL",
  };
}

function scoreDisclosure(disclosure?: string): DimensionScore {
  if (!disclosure || disclosure.trim() === "") {
    return {
      name: "disclosure",
      score: 0,
      max: 10,
      detail: "MISSING — required field",
    };
  }

  const hasModel = disclosure.match(/\b( glm| claude| gpt| llama| openai| anthropic| zai| minimax)\b/i);
  const hasUrl = disclosure.match(/(https?:\/\/|skill|endpoint|api)/i);

  let score = 0;
  if (hasModel) score += 5;
  if (hasUrl) score += 5;

  return {
    name: "disclosure",
    score: Math.min(score, 10),
    max: 10,
    detail: hasModel && hasUrl ? "format correct" : hasModel ? "model only" : "incomplete",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runScore(input: ScoreInput): Promise<ScoreResult> {
  const { headline, body, sourcesUrl, tags, beatSlug, disclosure } = input;

  const sourceScore = scoreSourceQuality(sourcesUrl);
  const thesisScore = scoreThesisClarity(headline, body);
  const beatScore = scoreBeatRelevance(tags, beatSlug);
  const timeScore = scoreTimeliness(sourcesUrl);
  const disclosureScore = scoreDisclosure(disclosure);

  const dimensions = [sourceScore, thesisScore, beatScore, timeScore, disclosureScore];
  const total = dimensions.reduce((sum, d) => sum + d.score, 0);

  const breakdown: string[] = [];
  const recommendations: string[] = [];

  // Generate breakdown
  breakdown.push(`sourceQuality: ${sourceScore.score}/${sourceScore.max} — ${sourceScore.detail}`);
  breakdown.push(`thesisClarity: ${thesisScore.score}/${thesisScore.max} — ${thesisScore.detail}`);
  breakdown.push(`beatRelevance: ${beatScore.score}/${beatScore.max} — ${beatScore.detail}`);
  breakdown.push(`timeliness: ${timeScore.score}/${timeScore.max} — ${timeScore.detail}`);
  breakdown.push(`disclosure: ${disclosureScore.score}/${disclosureScore.max} — ${disclosureScore.detail}`);

  // Recommendations
  if (sourceScore.score < 25) {
    recommendations.push("Add more sources (3+), include URLs with 2025/2026");
  }
  if (thesisScore.score < 20) {
    const words = headline.split(/\s+/).filter(Boolean);
    if (words.length < 8) recommendations.push(`Headline too short (${words.length} words, need 8-15)`);
    if (body.length < 200) recommendations.push(`Body too short (${body.length} chars, need 200+)`);
  }
  if (beatScore.score < 15) {
    recommendations.push(`Tags may not match ${beatSlug} beat — check beat keywords`);
  }
  if (timeScore.score < 10) {
    recommendations.push("Source URLs should include year (2025/2026)");
  }
  if (disclosureScore.score < 10) {
    recommendations.push("Disclosure must include model name and skill/API endpoint");
  }

  if (total >= 80) {
    breakdown.push("🎯 High probability of approval (80+)");
  } else if (total >= 60) {
    breakdown.push("⚠️ Medium probability — review recommendations");
  } else {
    breakdown.push("❌ Low probability — address failed checks before submitting");
  }

  return {
    total,
    max: 100,
    dimensions,
    breakdown,
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("self-score")
  .description("Calculate platform score before submission")
  .version("1.0.0");

program
  .command("score")
  .description("Calculate score for a signal draft")
  .requiredOption("-h, --headline <text>", "Signal headline")
  .requiredOption("-b, --body <text>", "Signal body")
  .requiredOption("-s, --sources-url <urls>", "Comma-separated source URLs", (v) => v.split(",").map((s: string) => s.trim()))
  .requiredOption("-t, --tags <tags>", "Comma-separated tags", (v) => v.split(",").map((s: string) => s.trim()))
  .requiredOption("-beat, --beat <slug>", "Beat slug (aibtc-network, bitcoin-macro, quantum)")
  .option("-d, --disclosure <text>", "Disclosure field")
  .action(async (opts) => {
    try {
      const result = await runScore({
        headline: opts.headline,
        body: opts.body,
        sourcesUrl: opts.sourcesUrl,
        tags: opts.tags,
        beatSlug: opts.beat,
        disclosure: opts.disclosure,
      });
      printJson(result);
    } catch (err) {
      handleError(err);
      process.exit(1);
    }
  });

program.parse();