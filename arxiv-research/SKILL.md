---
name: arxiv-research
description: "Fetch and compile arXiv papers on LLMs, autonomous agents, and AI infrastructure into scored, grouped research digests. Stores digests at ~/.aibtc/arxiv-research/digests/. No API key required."
metadata:
  author: "arc0btc"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "fetch | compile | list"
  entry: "arxiv-research/arxiv-research.ts"
  mcp-tools: "arxiv_search, arxiv_compile_digest, arxiv_list_digests"
  requires: ""
  tags: "read-only"
---

# arXiv Research Skill

Monitors arXiv for notable papers on LLMs, autonomous agents, and AI infrastructure. Scores papers by relevance, groups them by topic, and produces Markdown digests.

- Covers `cs.AI`, `cs.CL`, `cs.LG`, `cs.MA` by default (configurable)
- Relevance scoring: keywords, category boosts, topic tags
- Groups into: agent, multi-agent, LLM, tool-use, reasoning, RAG, alignment, orchestration, MCP
- Output: ISO-8601 timestamped Markdown digests at `~/.aibtc/arxiv-research/digests/`
- No API key required — uses public arXiv Atom feed

## Usage

```
bun run arxiv-research/arxiv-research.ts <subcommand> [options]
```

## Subcommands

### fetch

Fetch recent papers from arXiv Atom API, score for LLM/agent relevance, and save to a local staging file.

```bash
bun run arxiv-research/arxiv-research.ts fetch
bun run arxiv-research/arxiv-research.ts fetch --categories "cs.CL,cs.MA" --max 100
```

Options:
- `--categories` — Comma-separated arXiv category codes. Default: `cs.AI,cs.CL,cs.LG,cs.MA`
- `--max` — Maximum papers to fetch. Default: `50`

Output: JSON summary with total/relevant counts and top 10 papers by relevance score.

### compile

Compile a digest from the most recently fetched papers. Filters for relevance score ≥ 3, groups by topic, writes a Markdown file.

```bash
bun run arxiv-research/arxiv-research.ts compile
bun run arxiv-research/arxiv-research.ts compile --date 2026-03-19
```

Options:
- `--date` — Date label for the digest header. Default: today's date.

Output: Writes `~/.aibtc/arxiv-research/digests/{ISO8601}_arxiv_digest.md` and prints summary JSON.

### list

Show recent compiled digests.

```bash
bun run arxiv-research/arxiv-research.ts list
bun run arxiv-research/arxiv-research.ts list --limit 20
```

Options:
- `--limit` — Maximum entries to show. Default: `10`

## Relevance Scoring

Papers are scored by matching title+abstract against topic signals:

| Topic | Example Keywords | Weight |
|-------|-----------------|--------|
| agent | autonomous agent, AI agent, agent-based | 3–4 |
| multi-agent | multi-agent | 4 |
| LLM | large language model, LLM, GPT | 2–3 |
| tool-use | tool use, function call | 3 |
| reasoning | chain-of-thought, reasoning, planning | 2 |
| RAG | retrieval-augmented, RAG | 2 |
| alignment | RLHF, alignment | 2 |
| orchestration | orchestrat* | 3 |
| MCP | MCP, model context protocol | 3 |

Category boosts: `cs.MA` +3, `cs.CL` +1, `cs.AI` +1. Minimum score for digest inclusion: 3.

## Output Format

Digests are Markdown with:
- Header: date, paper counts, categories
- `## Highlights` — top 5 papers with scores
- Per-topic sections with title, authors, arXiv link, abstract excerpt
- `## Stats` table at the bottom
