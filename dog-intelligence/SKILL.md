---
name: dog-intelligence
description: "On-chain intelligence for DOG•GO•TO•THE•MOON rune — forensic analysis, LTH vs STH metrics, multi-chain whale tracking, multi-exchange markets, cross-chain data, and airdrop analytics powered by DOG DATA's Bitcoin full node."
metadata:
  author: "LimaDevBTC"
  author-agent: "Xored Pike"
  user-invocable: "false"
  arguments: "doctor | run --action pulse | run --action whales | run --action diamond | run --action airdrop | run --action lth-sth | run --action markets | run --action multichain | run --action bitcoin | install-packs"
  entry: "dog-intelligence/dog-intelligence.ts"
  requires: ""
  tags: "read-only, infrastructure, defi, l1"
---

# dog-intelligence

On-chain intelligence hub for **DOG•GO•TO•THE•MOON** — the largest Bitcoin rune by holders (89K+). Pulls data directly from a Bitcoin Core + Ord full node via the [DOG DATA](https://dogdata.xyz) API.

## What it does

DOG intelligence provides 8 sub-commands that give agents real-time and historical analytics on the DOG rune:

| Action | What it returns |
|--------|----------------|
| **pulse** | Full market snapshot: price aggregated across all exchanges, MVRV ratio, holder count, LTH vs STH ratio, Diamond Paws count, retention rate. One call, complete picture. |
| **whales** | Multi-chain whale alerts with severity (CRITICAL/HIGH), USD value, classification, and top 25 holder positions. Covers Bitcoin L1, Stacks, and Solana. |
| **diamond** | Forensic behavioral profiles — Diamond Paws, Dog Legends, Paper Hands breakdown. Proprietary Diamond Score ratings across 14 holder categories. |
| **airdrop** | Origin story analytics: the Runestone→DOG airdrop (100B tokens, 75,490 recipients, zero pre-sale). Retention rate, behavior breakdown, current holder status. |
| **lth-sth** | The trademark metric: Long-Term Holder vs Short-Term Holder supply ratio. HODL waves, UTXO age distribution, median age, and supply conviction analysis. |
| **markets** | Full multi-exchange view: prices and volumes from 20+ exchanges (CEX + Solana DEX). Spread analysis, trust scores, and 24h high/low from Kraken. |
| **multichain** | Cross-chain DOG intelligence: bridged supply on Stacks and Solana. Holder count, market cap, liquidity, and 24h metrics per chain. |
| **bitcoin** | Bitcoin network context: latest block, hashrate, difficulty adjustment progress, mempool depth, and fee recommendations. |

## Why agents need it

DOG is the #1 rune by holder count (89,020+) and the most liquid rune across CEX + DEX markets. Agents operating in Bitcoin DeFi need:

- **Holder concentration** (Gini coefficient, top 10/100/1000 %) to assess LP impermanent loss risk
- **MVRV ratio** for timing entry/exit — currently 0.27, meaning DOG trades at 27% of its realized value (historically undervalued)
- **Multi-chain whale alerts** for frontrunning protection — severity ratings (CRITICAL/HIGH), USD value, and classification across Bitcoin L1, Stacks, and Solana. Threshold: >1M DOG per transaction.
- **Forensic profiles** for narrative-grade intelligence — no other data source classifies 75K+ wallets into Diamond Paws, Paper Hands, Dog Legends, etc.
- **LTH vs STH ratio** — the single most predictive metric for supply-side conviction. 79%+ of DOG supply is in long-term hands.
- **Multi-exchange markets** — 20+ exchanges including Solana DEX (Orca, Raydium, Meteora, Jupiter) and 6 CEX. Full spread and volume analysis.
- **Cross-chain data** — DOG bridged to Stacks (via Bitflow) and Solana. Track bridged supply, liquidity, and holder count per chain.
- **Bitcoin network context** — fee conditions and mempool state matter when planning large DOG transactions.

No other API offers Diamond Score, forensic categorization, or LTH/STH breakdown for any rune. This is Glassnode-grade analytics for Bitcoin's fungible token layer.

## Safety notes

- **Read-only skill.** Does not write to chain, does not move funds, does not sign transactions.
- No sensitive data processed. No private keys, no mnemonics, no wallet access required.
- All data sourced from DOG DATA's public API (dogdata.xyz) — GET requests only.
- Safe for mainnet and testnet. No network-specific risk.
- Rate limited: 20 req/hr without API key, 100 req/hr with free key, 5,000 req/hr with pro key.
- If rate limited (HTTP 429), the skill returns `status: "blocked"` with retry information — never retries silently.

## Data source

[DOG DATA](https://dogdata.xyz) — the world's most comprehensive DOG rune data platform. Runs its own Bitcoin Core + Ord full node. No third-party API dependency. 40 REST endpoints, MCP server, SSE real-time events.

- API Discovery: https://www.dogdata.xyz/api
- Agent Capabilities: https://www.dogdata.xyz/api/agent/capabilities
- OpenAPI Spec: https://www.dogdata.xyz/api/openapi.json
- LLM Context: https://www.dogdata.xyz/llms.txt

## Commands

### Pre-flight check

```bash
bun run dog-intelligence/dog-intelligence.ts doctor
```

Checks API health, connectivity, API key status, and smoke-tests all new endpoints. **Always run before other commands.**

### Market pulse snapshot

```bash
bun run dog-intelligence/dog-intelligence.ts run --action pulse
```

### Whale tracking (multi-chain, >1M DOG threshold)

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

### Multi-exchange market data

```bash
bun run dog-intelligence/dog-intelligence.ts run --action markets
```

### Cross-chain data (Stacks + Solana)

```bash
bun run dog-intelligence/dog-intelligence.ts run --action multichain
```

### Bitcoin network status

```bash
bun run dog-intelligence/dog-intelligence.ts run --action bitcoin
```

### Install optional SDK

```bash
bun run dog-intelligence/dog-intelligence.ts install-packs
```

## Output contract

All outputs are JSON to stdout using a consistent envelope:

**Success:**
```json
{
  "status": "success",
  "action": "descriptive message",
  "data": {},
  "error": null,
  "source": "dogdata.xyz",
  "timestamp": "ISO-8601"
}
```

**Error:**
```json
{
  "status": "error",
  "action": "context of what failed",
  "data": null,
  "error": "descriptive error message",
  "source": "dogdata.xyz",
  "timestamp": "ISO-8601"
}
```

**Rate limited:**
```json
{
  "status": "blocked",
  "action": "rate_limited",
  "data": null,
  "error": "Rate limited on /endpoint. Retry after 60s.",
  "source": "dogdata.xyz",
  "timestamp": "ISO-8601"
}
```

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @LimaDevBTC
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/14
