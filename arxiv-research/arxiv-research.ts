#!/usr/bin/env bun
/**
 * arxiv-research — Fetch and compile arXiv research digests
 *
 * Fetches papers on LLMs, agents, and AI from the public arXiv Atom API.
 * No API key required. Digests stored at ~/.aibtc/arxiv-research/digests/
 *
 * Usage: bun run arxiv-research/arxiv-research.ts <subcommand> [options]
 */

import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---- Constants ----

const STATE_DIR = join(process.env.HOME ?? "~", ".aibtc", "arxiv-research");
const DIGESTS_DIR = join(STATE_DIR, "digests");
const FETCH_CACHE = join(STATE_DIR, ".latest_fetch.json");
const ARXIV_API = "http://export.arxiv.org/api/query";
const DEFAULT_CATEGORIES = ["cs.AI", "cs.CL", "cs.LG", "cs.MA"];
const DEFAULT_MAX = 50;
const MIN_RELEVANCE_SCORE = 3;

// ---- Types ----

interface ArxivPaper {
  arxiv_id: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  primary_category: string;
  published: string;
  updated: string;
  pdf_url: string;
  abs_url: string;
}

interface ScoredPaper extends ArxivPaper {
  relevance_score: number;
  relevance_tags: string[];
}

// ---- Helpers ----

function ensureDirs(): void {
  if (!existsSync(DIGESTS_DIR)) mkdirSync(DIGESTS_DIR, { recursive: true });
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

// ---- XML parsing (no dependencies) ----

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].replace(/\s+/g, " ").trim());
  }
  return results;
}

function extractAttr(xml: string, tag: string, attr: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function parseArxivResponse(xml: string): ArxivPaper[] {
  const papers: ArxivPaper[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];

    const rawId = extractTag(block, "id");
    const arxivId = rawId.replace("http://arxiv.org/abs/", "").replace(/v\d+$/, "");
    const title = extractTag(block, "title");
    const abstract = extractTag(block, "summary");
    const published = extractTag(block, "published");
    const updated = extractTag(block, "updated");

    const authorBlocks = extractAllTags(block, "author");
    const authors = authorBlocks.map((a) => extractTag(a, "name")).filter(Boolean);

    const categories = extractAttr(block, "category", "term");
    const primaryCat =
      block.match(/arxiv:primary_category[^>]*term="([^"]*)"/)?.[1] ??
      categories[0] ??
      "";

    const pdfMatch = block.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/);
    const pdfUrl = pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${arxivId}`;
    const absUrl = `https://arxiv.org/abs/${arxivId}`;

    if (arxivId && title) {
      papers.push({
        arxiv_id: arxivId,
        title,
        authors,
        abstract,
        categories,
        primary_category: primaryCat,
        published,
        updated,
        pdf_url: pdfUrl,
        abs_url: absUrl,
      });
    }
  }

  return papers;
}

// ---- Relevance scoring ----

const RELEVANCE_SIGNALS: Array<{ pattern: RegExp; weight: number; tag: string }> = [
  { pattern: /\blarge language model/i, weight: 3, tag: "LLM" },
  { pattern: /\bLLM\b/, weight: 3, tag: "LLM" },
  { pattern: /\bGPT[-\s]?[34o]/i, weight: 2, tag: "LLM" },
  { pattern: /\bClaude\b/i, weight: 2, tag: "LLM" },
  { pattern: /\btransformer/i, weight: 1, tag: "transformer" },
  { pattern: /\bautonomous agent/i, weight: 4, tag: "agent" },
  { pattern: /\bAI agent/i, weight: 4, tag: "agent" },
  { pattern: /\bagent[-\s]?based/i, weight: 3, tag: "agent" },
  { pattern: /\bmulti[-\s]?agent/i, weight: 4, tag: "multi-agent" },
  { pattern: /\btool[-\s]?use\b/i, weight: 3, tag: "tool-use" },
  { pattern: /\bfunction[-\s]?call/i, weight: 3, tag: "tool-use" },
  { pattern: /\bchain[-\s]?of[-\s]?thought/i, weight: 2, tag: "reasoning" },
  { pattern: /\breasoning\b/i, weight: 2, tag: "reasoning" },
  { pattern: /\bplanning\b/i, weight: 2, tag: "planning" },
  { pattern: /\bRL[HF]+\b/, weight: 2, tag: "alignment" },
  { pattern: /\balignment\b/i, weight: 2, tag: "alignment" },
  { pattern: /\bsafety\b/i, weight: 1, tag: "safety" },
  { pattern: /\bfine[-\s]?tun/i, weight: 2, tag: "fine-tuning" },
  { pattern: /\bprompt\b/i, weight: 1, tag: "prompting" },
  { pattern: /\bin[-\s]?context learning/i, weight: 2, tag: "ICL" },
  { pattern: /\bretrieval[-\s]?augmented/i, weight: 2, tag: "RAG" },
  { pattern: /\bRAG\b/, weight: 2, tag: "RAG" },
  { pattern: /\bcode[-\s]?gen/i, weight: 2, tag: "code-gen" },
  { pattern: /\bbenchmark/i, weight: 1, tag: "benchmark" },
  { pattern: /\bscaling\b/i, weight: 1, tag: "scaling" },
  { pattern: /\bmemory\b/i, weight: 1, tag: "memory" },
  { pattern: /\borchestrat/i, weight: 3, tag: "orchestration" },
  { pattern: /\bMCP\b/, weight: 3, tag: "MCP" },
  { pattern: /\bmodel context protocol/i, weight: 3, tag: "MCP" },
];

function scorePaper(paper: ArxivPaper): ScoredPaper {
  const text = `${paper.title} ${paper.abstract}`;
  let score = 0;
  const tags = new Set<string>();

  for (const signal of RELEVANCE_SIGNALS) {
    if (signal.pattern.test(text)) {
      score += signal.weight;
      tags.add(signal.tag);
    }
  }

  // Category boosts
  if (paper.primary_category === "cs.MA") score += 3;
  if (paper.primary_category === "cs.CL") score += 1;
  if (paper.primary_category === "cs.AI") score += 1;

  return { ...paper, relevance_score: score, relevance_tags: [...tags] };
}

// ---- Subcommands ----

async function cmdFetch(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const categories = flags.categories ? flags.categories.split(",") : DEFAULT_CATEGORIES;
  const maxResults = flags.max ? parseInt(flags.max, 10) : DEFAULT_MAX;

  const catQuery = categories.map((c) => `cat:${c}`).join("+OR+");
  const url = `${ARXIV_API}?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

  process.stderr.write(`Fetching arXiv papers: ${categories.join(", ")} (max ${maxResults})...\n`);

  const response = await fetch(url, {
    headers: { "User-Agent": "aibtcdev-skills/arxiv-research" },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    process.stderr.write(`Error: arXiv API returned ${response.status}\n`);
    process.exit(1);
  }

  const xml = await response.text();
  const papers = parseArxivResponse(xml);

  if (papers.length === 0) {
    process.stderr.write("No papers found.\n");
    process.exit(0);
  }

  const scored = papers.map(scorePaper).sort((a, b) => b.relevance_score - a.relevance_score);

  ensureDirs();
  await Bun.write(FETCH_CACHE, JSON.stringify(scored, null, 2));

  const relevant = scored.filter((p) => p.relevance_score >= MIN_RELEVANCE_SCORE);
  process.stdout.write(
    JSON.stringify(
      {
        total: scored.length,
        relevant: relevant.length,
        categories,
        top_papers: relevant.slice(0, 10).map((p) => ({
          id: p.arxiv_id,
          title: p.title,
          score: p.relevance_score,
          tags: p.relevance_tags,
          published: p.published,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

async function cmdCompile(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  ensureDirs();

  if (!existsSync(FETCH_CACHE)) {
    process.stderr.write("Error: no fetched papers found. Run 'fetch' first.\n");
    process.exit(1);
  }

  const raw = await Bun.file(FETCH_CACHE).text();
  const papers: ScoredPaper[] = JSON.parse(raw);
  const relevant = papers.filter((p) => p.relevance_score >= MIN_RELEVANCE_SCORE);

  if (relevant.length === 0) {
    process.stderr.write(
      `No papers scored >= ${MIN_RELEVANCE_SCORE}. Try fetching more or adjusting categories.\n`
    );
    process.exit(0);
  }

  // Group by primary topic tag
  const groups = new Map<string, ScoredPaper[]>();
  for (const paper of relevant) {
    const primaryTag = paper.relevance_tags[0] ?? "general";
    const group = groups.get(primaryTag) ?? [];
    group.push(paper);
    groups.set(primaryTag, group);
  }

  const dateStr = flags.date ?? new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const filename = `${timestamp}_arxiv_digest.md`;
  const filepath = join(DIGESTS_DIR, filename);

  const lines: string[] = [
    `# arXiv Digest — ${dateStr}`,
    "",
    `**Generated:** ${timestamp}`,
    `**Papers reviewed:** ${papers.length}`,
    `**Relevant papers:** ${relevant.length}`,
    `**Categories:** ${DEFAULT_CATEGORIES.join(", ")}`,
    "",
    "---",
    "",
    "## Highlights",
    "",
  ];

  const topPapers = relevant.slice(0, 5);
  for (const paper of topPapers) {
    lines.push(
      `- **${paper.title}** (${paper.relevance_tags.join(", ")}) — score ${paper.relevance_score}`
    );
  }
  lines.push("", "---", "");

  const tagOrder = [
    "agent", "multi-agent", "LLM", "tool-use", "reasoning",
    "RAG", "alignment", "orchestration", "MCP",
  ];
  const sortedTags = [...groups.keys()].sort((a, b) => {
    const aIdx = tagOrder.indexOf(a);
    const bIdx = tagOrder.indexOf(b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  for (const tag of sortedTags) {
    const group = groups.get(tag)!;
    const tagLabel = tag.charAt(0).toUpperCase() + tag.slice(1);
    lines.push(`## ${tagLabel}`, "");

    for (const paper of group) {
      lines.push(
        `### ${paper.title}`,
        "",
        `- **arXiv:** [${paper.arxiv_id}](${paper.abs_url})`,
        `- **Authors:** ${paper.authors.slice(0, 5).join(", ")}${paper.authors.length > 5 ? " et al." : ""}`,
        `- **Published:** ${paper.published.split("T")[0]}`,
        `- **Categories:** ${paper.categories.join(", ")}`,
        `- **Relevance:** ${paper.relevance_score} (${paper.relevance_tags.join(", ")})`,
        "",
        `> ${paper.abstract.length > 500 ? paper.abstract.slice(0, 497) + "..." : paper.abstract}`,
        ""
      );
    }

    lines.push("---", "");
  }

  // Stats table
  const tagCounts = [...groups.entries()]
    .map(([tag, ps]) => `${tag}: ${ps.length}`)
    .join(", ");
  lines.push(
    "## Stats",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total papers | ${papers.length} |`,
    `| Relevant (score >= ${MIN_RELEVANCE_SCORE}) | ${relevant.length} |`,
    `| Categories | ${DEFAULT_CATEGORIES.join(", ")} |`,
    `| By topic | ${tagCounts} |`,
    "",
    "*Compiled by aibtcdev-skills/arxiv-research*",
    ""
  );

  await Bun.write(filepath, lines.join("\n"));

  process.stdout.write(
    JSON.stringify(
      {
        file: filepath,
        total_papers: papers.length,
        relevant_papers: relevant.length,
        topics: Object.fromEntries([...groups.entries()].map(([k, v]) => [k, v.length])),
      },
      null,
      2
    ) + "\n"
  );
}

function cmdList(args: string[]): void {
  const flags = parseFlags(args);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 10;

  if (!existsSync(DIGESTS_DIR)) {
    process.stdout.write("No arXiv digests yet. Run 'fetch' then 'compile' first.\n");
    return;
  }

  const entries = readdirSync(DIGESTS_DIR)
    .filter((e) => e.endsWith("_arxiv_digest.md"))
    .sort()
    .reverse()
    .slice(0, limit);

  if (entries.length === 0) {
    process.stdout.write("No arXiv digests yet. Run 'fetch' then 'compile' first.\n");
    return;
  }

  process.stdout.write(`arXiv digests (${entries.length}):\n\n`);
  for (const entry of entries) {
    const timestamp = entry.replace("_arxiv_digest.md", "");
    process.stdout.write(`  ${timestamp}  ${join(DIGESTS_DIR, entry)}\n`);
  }
}

function printUsage(): void {
  process.stdout.write(`arxiv-research — Fetch and compile arXiv research digests

Usage: bun run arxiv-research/arxiv-research.ts <subcommand> [options]

Subcommands:
  fetch [--categories "cs.AI,cs.CL,cs.LG,cs.MA"] [--max 50]
    Fetch recent papers from arXiv, score for LLM/agent relevance.

  compile [--date YYYY-MM-DD]
    Compile a digest from fetched papers. Writes timestamped Markdown file.

  list [--limit 10]
    Show recent digests.

State: ~/.aibtc/arxiv-research/  (fetch cache + digests)
`);
}

// ---- Entry point ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sub = args[0];

  switch (sub) {
    case "fetch":
      await cmdFetch(args.slice(1));
      break;
    case "compile":
      await cmdCompile(args.slice(1));
      break;
    case "list":
      cmdList(args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      process.stderr.write(`Error: unknown subcommand '${sub}'\n\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(
    `Error: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
