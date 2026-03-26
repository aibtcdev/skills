---
name: nostr-wot
description: "Nostr Web of Trust — trust scoring and sybil detection for Nostr pubkeys. Free tier (wot.klabo.world, 50 req/day) with paid fallback (maximumsats.com, 100 sats via L402). Covers 52K+ pubkeys and 2.4M+ zap-weighted trust edges."
metadata:
  author: "arc0btc"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "trust-score | sybil-check | neighbors | network-health | config | cache-status"
  entry: "nostr-wot/nostr-wot.ts"
  requires: ""
  tags: "read-only"
---

> **Deprecated:** This skill has been consolidated into [`wot`](../wot/SKILL.md). Use the `wot` skill for all Web of Trust operations. This skill will not receive further updates.

# Nostr Web of Trust Skill

Pre-transaction counterparty risk assessment using Nostr Web of Trust scores. Accepts hex pubkeys or `npub1...` bech32 addresses.

- **52K+ pubkeys** indexed with **2.4M+ trust edges**
- Trust edges weighted by zap receipts (economic signal, harder to fake)
- Free tier: `wot.klabo.world` (50 req/day per IP), no key required
- Paid fallback: `maximumsats.com/api/wot-report` (100 sats via L402) when free tier exhausted
- 1-hour local cache to avoid redundant API calls

## Usage

```
bun run nostr-wot/nostr-wot.ts <subcommand> [options]
```

## Subcommands

### trust-score

Look up WoT trust score, rank, and percentile. Checks against configurable thresholds.

```bash
bun run nostr-wot/nostr-wot.ts trust-score --pubkey 2b4603d2...
bun run nostr-wot/nostr-wot.ts trust-score --npub npub1abc...
```

Output:
```json
{
  "success": true,
  "cached": false,
  "api": "free",
  "pubkey": "2b4603d2...",
  "trusted": true,
  "normalized_score": 87,
  "rank": 142,
  "percentile": 99.7
}
```

### sybil-check

Classify a pubkey as `normal`, `suspicious`, or `likely_sybil` using follower quality, mutual trust ratio, and community integration signals.

```bash
bun run nostr-wot/nostr-wot.ts sybil-check --pubkey 2b4603d2...
bun run nostr-wot/nostr-wot.ts sybil-check --npub npub1abc...
```

Output:
```json
{
  "success": true,
  "pubkey": "2b4603d2...",
  "classification": "normal",
  "is_sybil": false,
  "is_suspicious": false
}
```

### neighbors

Discover trust graph neighbors — connected pubkeys with combined trust scores.

```bash
bun run nostr-wot/nostr-wot.ts neighbors --pubkey 2b4603d2...
```

### network-health

Graph-wide stats: total nodes, edges, Gini coefficient, power law alpha. No pubkey required.

```bash
bun run nostr-wot/nostr-wot.ts network-health
```

### config

View or update trust thresholds. Stored at `~/.aibtc/nostr-wot/config.json`.

```bash
bun run nostr-wot/nostr-wot.ts config                    # view current thresholds
bun run nostr-wot/nostr-wot.ts config --min-rank 5000
bun run nostr-wot/nostr-wot.ts config --require-top100
bun run nostr-wot/nostr-wot.ts config --no-require-top100
```

Threshold fields:
- `minRank` — Maximum acceptable rank. Default: `10000`
- `requireTop100` — Reject if not in top 100. Default: `false`

### cache-status

Show cache statistics. Cache stored at `~/.aibtc/nostr-wot/cache.json` with 1-hour TTL.

```bash
bun run nostr-wot/nostr-wot.ts cache-status
```

## Trust Thresholds

| Rank | Meaning |
|------|---------|
| 1–100 | Elite (top 100 Nostr users by WoT) |
| 101–1000 | Well-connected, high economic activity |
| 1001–10000 | Active community member |
| >10000 | Low trust, new account, or no Nostr activity |

## API Details

Two endpoints, tried in order:

| Base | Auth | Cost | Rate |
|------|------|------|------|
| `https://wot.klabo.world` | None | Free | 50 req/day/IP |
| `https://maximumsats.com/api/wot-report` | L402 | 100 sats | Unlimited |

Free tier returns HTTP 402 when exhausted; skill auto-falls back to paid endpoint. L402 payment requires a Lightning client — without one, paid calls return an error with the BOLT11 invoice.
