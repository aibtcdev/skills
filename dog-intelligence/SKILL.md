---
name: dog-intelligence
description: On-chain intelligence for DOG•GO•TO•THE•MOON rune — forensic analysis, LTH vs STH metrics, whale tracking, and airdrop analytics powered by DOG DATA's Bitcoin full node.
author: LimaDevBTC
author_agent: Xored Pike
user-invocable: true
arguments: doctor | run --action pulse | run --action whales | run --action diamond | run --action airdrop | run --action lth-sth | install-packs
entry: dog-intelligence/dog-intelligence.ts
requires: [settings]
tags: [read-only, infrastructure, defi, l1]
---

# dog-intelligence

On-chain intelligence hub for **DOG•GO•TO•THE•MOON** — the largest Bitcoin rune by holders (89K+). Pulls data directly from a Bitcoin Core + Ord full node via the [DOG DATA](https://dogdata.xyz) API.

## What it does

DOG intelligence provides 5 sub-commands that give agents real-time and historical analytics on the DOG rune:

| Action | What it returns |
|--------|----------------|
| **pulse** | Full market snapshot: price (6 exchanges), MVRV ratio, holder count, LTH vs STH ratio, Diamond Paws count, retention rate. One call, complete picture. |
| **whales** | Top 25 holders with balances + recent transactions filtered for large moves (>1B DOG). Whale concentration and accumulation signals. |
| **diamond** | Forensic behavioral profiles — Diamond Paws, Dog Legends, Paper Hands breakdown. Proprietary Diamond Score ratings across 14 holder categories. |
| **airdrop** | Origin story analytics: the Runestone→DOG airdrop (100B tokens, 75,497 recipients, zero pre-sale). Retention rate, behavior breakdown, current holder status. |
| **lth-sth** | The trademark metric: Long-Term Holder vs Short-Term Holder supply ratio. HODL waves, UTXO age distribution, median age, and supply conviction analysis. |

## Why agents need it

DOG is the #1 rune by holder count (89,194+) and the most liquid rune across CEX + DEX markets. Agents operating in Bitcoin DeFi need:

- **Holder concentration** (Gini coefficient, top 10/100/1000 %) to assess LP impermanent loss risk
- **MVRV ratio** for timing entry/exit — currently 0.27, meaning DOG trades at 27% of its realized value (historically undervalued)
- **Whale alerts** for frontrunning protection — know when top holders move before it hits the orderbook
- **Forensic profiles** for narrative-grade intelligence — no other data source classifies 75K+ wallets into Diamond Paws, Paper Hands, Dog Legends, etc.
- **LTH vs STH ratio** — the single most predictive metric for supply-side conviction. 78.6% of DOG supply is in long-term hands (>155 days).

No other API offers Diamond Score, forensic categorization, or LTH/STH breakdown for any rune. This is Glassnode-grade analytics for Bitcoin's fungible token layer.

## Safety notes

- **Read-only skill.** Does not write to chain, does not move funds, does not sign transactions.
- No sensitive data processed. No private keys, no mnemonics, no wallet access required.
- All data sourced from DOG DATA's public API (dogdata.xyz).
- Safe for mainnet and testnet. No network-specific risk.
- Rate limited: 20 req/hr without API key, 100 req/hr with free key.
- If rate limited (HTTP 429), the skill returns `status: "blocked"` with retry information — never retries silently.

## Data source

[DOG DATA](https://dogdata.xyz) — the world's most comprehensive DOG rune data platform. Runs its own Bitcoin Core + Ord full node. No third-party API dependency. 35 REST endpoints, MCP server, SSE real-time events.

- API Discovery: https://www.dogdata.xyz/api
- OpenAPI Spec: https://www.dogdata.xyz/api/openapi.json
- LLM Context: https://www.dogdata.xyz/llms.txt

## Commands

### Pre-flight check

```bash
bun run dog-intelligence/dog-intelligence.ts doctor
```

Checks API health, connectivity, and API key status. **Always run before other commands.**

### Market pulse snapshot

```bash
bun run dog-intelligence/dog-intelligence.ts run --action pulse
```

### Whale tracking

```bash
bun run dog-intelligence/dog-intelligence.ts run --action whales
```

### Diamond Score forensics

```bash
bun run dog-intelligence/dog-intelligence.ts run --action diamond
```

### Airdrop origin story

```bash
bun run dog-intelligence/dog-intelligence.ts run --action airdrop
```

### LTH vs STH conviction analysis

```bash
bun run dog-intelligence/dog-intelligence.ts run --action lth-sth
```

### Install optional SDK

```bash
bun run dog-intelligence/dog-intelligence.ts install-packs
```
