#!/usr/bin/env bun
/**
 * aibtc-news-correspondent source-tier CLI
 * Classify sources as T1/T2/T3/T4 before submission
 *
 * Usage:
 *   bun run aibtc-news-correspondent/source-tier.ts classify --urls "url1,url2"
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

interface SourceTier {
  tier: "T1" | "T2" | "T3" | "T4";
  url: string;
  classification: string;
  risk: "safe" | "warning" | "rejected";
  reason: string;
}

interface TierResult {
  sources: SourceTier[];
  summary: {
    t1: number;
    t2: number;
    t3: number;
    t4: number;
    pass: boolean;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Classification Logic
// ---------------------------------------------------------------------------

const PRIMARY_DOMAINS = [
  "arxiv.org",
  "eprint.iacr.org",
  "nist.gov",
  "bitcoinops.org",
  "blockstream.com",
];

const T1_PATTERNS = [
  /hiro\.so/i,
  /stacks\.co/i,
  /alex\.run/i,
  /bitflow\.finance/i,
  /zest\.protocol/i,
  /explorer/i,
  /api\./i,
  /v1\//i,
];

const T2_PATTERNS = [
  /github\.com\/(?:aibtcdev|bitcoin|stacks-project|OrdinalHub|GammaProtocol)/i,
  /github\.com\/releases/i,
  /medium\.com/i,
  /bitcoinmagazine\.com/i,
  /coindesk\.com/i,
  /decrypt\.co/i,
];

const T3_PATTERNS = [
  /twitter\.com/i,
  /x\.com/i,
  /t\.co/i,
  /moltbook/i,
  /youtube\.com/i,
  /substack\.com/i,
];

const T4_PATTERNS = [
  /wikipedia\.org/i,
  /reddit\.com/i,
  /discord\.com/i,
  /telegram\.org/i,
];

function classifyUrl(url: string): SourceTier {
  const normalized = url.trim().toLowerCase();

  // T1: Primary on-chain or official API
  for (const pattern of T1_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "T1",
        url,
        classification: "Primary on-chain or official API",
        risk: "safe",
        reason: "Direct blockchain or official API endpoint",
      };
    }
  }

  // T1: PRIMARY domains for quantum beat
  for (const domain of PRIMARY_DOMAINS) {
    if (normalized.includes(domain)) {
      return {
        tier: "T1",
        url,
        classification: "PRIMARY domain (quantum-required)",
        risk: "safe",
        reason: `${domain} — recognized PRIMARY for quantum beat`,
      };
    }
  }

  // T2: Official project sources
  for (const pattern of T2_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "T2",
        url,
        classification: "Official project source",
        risk: "safe",
        reason: "Official project page, GitHub release, or reputable publication",
      };
    }
  }

  // T3: Secondary references
  for (const pattern of T3_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "T3",
        url,
        classification: "Secondary reference",
        risk: "warning",
        reason: "Use as supporting evidence, not sole source",
      };
    }
  }

  // T4: Tertiary/indirect
  for (const pattern of T4_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        tier: "T4",
        url,
        classification: "Tertiary/indirect",
        risk: "rejected",
        reason: "Not acceptable as primary source",
      };
    }
  }

  // Default: check for year (timeliness indicator)
  const hasYear = /202[5-6]/.test(normalized);
  const hasSpecificPath = /\/(?:PR|issues|pulls|commit|release|api|docs)/i.test(normalized);

  if (hasYear || hasSpecificPath) {
    return {
      tier: "T3",
      url,
      classification: "Web source (unclassified)",
      risk: "warning",
      reason: hasYear ? "Has year indicator" : "Has specific path (not homepage-level)",
    };
  }

  return {
    tier: "T4",
    url,
    classification: "Unclassified / homepage-level",
    risk: "rejected",
    reason: "No tier indicators found — likely too generic",
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runClassify(urls: string[]): TierResult {
  const sources = urls.map(classifyUrl);

  const counts = { t1: 0, t2: 0, t3: 0, t4: 0 };
  for (const s of sources) {
    if (s.tier === "T1") counts.t1++;
    else if (s.tier === "T2") counts.t2++;
    else if (s.tier === "T3") counts.t3++;
    else counts.t4++;
  }

  // Pass: at least 1 T1 or T2, no T4-only
  const hasT1orT2 = counts.t1 + counts.t2 >= 1;
  const allT4 = counts.t4 === sources.length && sources.length > 0;

  let pass = hasT1orT2 && !allT4;
  let message = "";

  if (!hasT1orT2) {
    pass = false;
    message = "❌ REJECTED: Need at least 1 T1 or T2 source";
  } else if (counts.t4 > 0) {
    pass = true;
    message = "⚠️ WARNING: T4 sources present — use as supporting only";
  } else {
    message = "✅ PASS: Source tier check cleared";
  }

  return {
    sources,
    summary: { ...counts, pass, message },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("source-tier")
  .description("Classify source URLs by tier (T1/T2/T3/T4)")
  .version("1.0.0");

program
  .command("classify")
  .description("Classify URLs into T1/T2/T3/T4")
  .requiredOption("-u, --urls <urls>", "Comma-separated URLs", (v) => v.split(",").map((s: string) => s.trim()))
  .action(async (opts) => {
    try {
      const result = runClassify(opts.urls as string[]);
      printJson(result);
    } catch (err) {
      handleError(err);
      process.exit(1);
    }
  });

program.parse();