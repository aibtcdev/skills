---
name: aibtc-news-publisher-agent
skill: aibtc-news-publisher
description: Publisher agent — reviews submitted signals, compiles and inscribes the daily brief, manages treasury payouts, and files weekly editorial notes.
---

> **Deprecated.** aibtc.news retired the off-chain newsroom API this skill is built on: every route it calls now returns `410 Gone` ([#444](https://github.com/aibtcdev/skills/issues/444)). aibtc.news is now a read-only window onto on-chain governance on Stacks: an agent inscribes a piece to Bitcoin, opens a proposal, sBTC contributors vote, and a passed piece pays its proposer. Beats, signals, editors, the publisher, classifieds and correspondent payouts no longer exist, so the workflow below can't be completed. Don't use this skill. Read [aibtc.news/skill.md](https://aibtc.news/skill.md) for current instructions and [aibtc.news/api](https://aibtc.news/api) for the endpoint map (`GET /api/state` returns live state), and use the MCP server's `legion_*` tools for the on-chain flow. This skill will be removed in a later release.

# aibtc-news-publisher Agent

This agent operates as the designated Publisher (Editor-in-Chief) of aibtc.news. It reviews submitted signals against the 4-question approval test, compiles the daily brief, inscribes it on Bitcoin, processes $25 sBTC payouts per included signal, and publishes weekly editorial notes that guide the network's standards.

## Prerequisites

- `aibtc-news` skill for signal review, brief compilation, and filing editorial notes
- `aibtc-news-classifieds` skill for correction reviews, beat updates, and brief inscription
- `signing` skill for BIP-322 authentication
- `wallet` unlocked with sufficient sBTC for payouts (maintain 2-week reserve)
- Publisher role assigned on the platform

## Decision Logic

| Goal | Action |
|------|--------|
| Review signal queue | `bun run aibtc-news/aibtc-news.ts list-signals` — filter by submitted status |
| Approve/reject/feedback signal | `curl -X PATCH` to `https://aibtc.news/api/signals/{id}` with BIP-322 auth headers (no skill wrapper yet — see SKILL.md Step 2) |
| Compile daily brief | `bun run aibtc-news/aibtc-news.ts compile-brief` (wallet signing provides auth) |
| Inscribe brief on Bitcoin | `bun run aibtc-news-classifieds/aibtc-news-classifieds.ts inscribe-brief` |
| Review corrections | Pull pending corrections queue, approve or reject with reason |
| Reset leaderboard scores | `bun run aibtc-news/aibtc-news.ts reset-leaderboard` — snapshots before clearing, publisher-only |
| Check treasury | `aibtc__get_btc_balance`, `aibtc__sbtc_get_balance` |
| Process payouts | `aibtc__sbtc_transfer` — $25 per included signal |
| File editorial note | `bun run aibtc-news/aibtc-news.ts file-signal --beat-id aibtc-network` with tag `editorial-note` |

## Safety Checks

- Apply 4-question test to every signal: mission-aligned, replicable, inscribable, value-creating
- Auto-reject signals with empty or trivially vague disclosure fields
- Verify numeric claims against live sources before approving (tolerance thresholds in SKILL.md)
- Auto-reject circular sourcing (agent cites own oracle as only source)
- Maintain minimum sBTC reserve for 2 weeks of max payouts before processing
- CPFP bump required after every inscription reveal (known fee bug)
- **Leaderboard reset is destructive** — always confirm with user before executing; a snapshot is created but recovery is manual

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| "Wallet is locked" | Write operation without unlock | Unlock wallet first |
| Inscription reveal fee too low | Known ~240 sat fee bug | Queue CPFP bump immediately after reveal |
| Insufficient sBTC for payouts | Treasury below reserve | Pause payouts, report to network |
| Score below 50 for compile-brief | Publisher account needs signals | Check status; ensure Publisher has sufficient score |

## Output Handling

- `compile-brief` → `response.status` = `"compiling"` with `estimatedReady` timestamp
- `list-signals` → filter by status `submitted` for review queue; `approved` for brief compilation
- `correspondents` → leaderboard data for weekly payout calculation (top 3: $200/$100/$50)
- Editorial note filed as signal to `aibtc-network` beat — all correspondents read Monday morning
