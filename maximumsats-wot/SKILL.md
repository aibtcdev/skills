---
name: maximumsats-wot
description: "Query MaximumSats Web of Trust scores, sybil detection, trust paths, and follow recommendations for Nostr pubkeys via wot.klabo.world. Free tier: 50 req/day; L402 Lightning auth for more."
metadata:
  author: "arc0btc"
  author-agent: "SATMAX Agent"
  user-invocable: "false"
  arguments: "get-score | check-sybil | recommend | trust-path | network-health"
  entry: "maximumsats-wot/cli.ts, maximumsats-wot/sensor.ts"
  requires: "credentials"
  tags: "read-only"
---

> **Deprecated:** This skill has been consolidated into [`wot`](../wot/SKILL.md). Use the `wot` skill for all Web of Trust operations. This skill will not receive further updates.

# maximumsats-wot

Query the MaximumSats Web of Trust (WoT) for Nostr pubkeys. Provides trust scoring (0–100), sybil detection, personalized follow recommendations, and trust path analysis. Backed by 52K+ pubkeys and 2.4M+ trust edges.

**API base**: `https://wot.klabo.world`
**Auth**: L402 protocol — 50 free requests/day; micropayment via Lightning for more.

## When to Load

Load when: evaluating counterparty trust before Lightning payments, vetting agents for smart contracts, filtering Nostr contacts by sybil risk, showcasing agent reputation.

## CLI Commands

```
arc skills run --name maximumsats-wot -- get-score --pubkey <npub|hex>
arc skills run --name maximumsats-wot -- check-sybil --pubkey <npub|hex>
arc skills run --name maximumsats-wot -- recommend --pubkey <npub|hex>
arc skills run --name maximumsats-wot -- trust-path --from <npub|hex> --to <npub|hex>
arc skills run --name maximumsats-wot -- network-health
```

## L402 Payment Flow

When the 50 req/day free tier is exhausted, the API returns HTTP 402 with a Lightning invoice in `WWW-Authenticate`. The CLI surfaces the invoice for manual payment. After paying:

```
arc creds set --service maximumsats-wot --key l402-token --value "<token>:<preimage>"
```

The credential is automatically read on subsequent CLI calls.

## Sensor Behavior

- **Cadence**: 360 minutes (6 hours)
- **Config**: `db/maximumsats-wot-watchlist.json` — list of `{ "pubkey": "npub...", "label": "name" }` entries
- **Triggers**: score drop ≥ 10 points since last check → creates alert task (P6, Sonnet)
- Skips silently if watchlist is empty or missing

## Composability

- Use alongside `arc-payments` to gate Lightning payments by WoT score threshold
- Use alongside `erc8004-trust` for cross-protocol trust signals
- Results are JSON; pipe to `jq` for filtering

## Checklist

- [x] SKILL.md exists with valid frontmatter
- [x] Frontmatter name matches directory name
- [x] SKILL.md under 2000 tokens
- [x] cli.ts: all commands implemented, errors exit 1
- [x] sensor.ts: exports async default, returns "skip"/"ok"/"error"
