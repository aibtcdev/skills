---
name: maximumsats-wot
description: "MaximumSats Web of Trust — query Nostr trust scores for counterparty risk assessment. 52K+ pubkeys, 2.4M+ trust edges. Scores are weighted by zap receipts. Payment: 100 sats via L402 per lookup."
metadata:
  author: "joelklabo"
  author-agent: "SATMAX Agent"
  user-invocable: "false"
  arguments: "check | check-agent | config | cache-status"
  entry: "maximumsats-wot/maximumsats-wot.ts"
  requires: ""
  tags: "read-only"
---

# MaximumSats Web of Trust Skill

Pre-transaction counterparty risk assessment using MaximumSats Web of Trust scores. Check a Nostr pubkey's trust rank before committing to on-chain interactions.

- **52K+ pubkeys** indexed with **2.4M+ trust edges**
- Scores weighted by zap receipts (economic signal, harder to fake)
- Sybil-resistant: high-rank requires real economic activity on Nostr
- 100 sats per lookup via L402 Lightning payment

## Usage

```
bun run maximumsats-wot/maximumsats-wot.ts <subcommand> [options]
```

## Subcommands

### check

Look up WoT trust score for a Nostr pubkey. Accepts hex pubkey or `npub1...` bech32.

```bash
bun run maximumsats-wot/maximumsats-wot.ts check --npub npub1abc...
bun run maximumsats-wot/maximumsats-wot.ts check --pubkey 2b4603d2...
```

Output:
```json
{
  "success": true,
  "cached": false,
  "pubkey": "2b4603d2...",
  "trusted": true,
  "rank": 142,
  "in_top_100": false,
  "thresholds": { "minRank": 10000, "requireTop100": false },
  "report": "...",
  "graph": { "nodes": 52000, "edges": 2400000 }
}
```

**Note:** The API requires a 100-sat L402 Lightning payment per request. Without an L402 client, the API returns HTTP 402.

### check-agent

Derive a Nostr pubkey from a wallet's BIP84 path and look up its WoT score. Requires an unlocked wallet (uses BTC-shared derivation path `m/84'/0'/0'/0/0`).

```bash
bun run maximumsats-wot/maximumsats-wot.ts check-agent
```

Output: Same as `check` with an additional `derivationPath` field.

### config

View or update trust thresholds. Thresholds are stored at `~/.aibtc/maximumsats-config.json`.

```bash
bun run maximumsats-wot/maximumsats-wot.ts config                # view current config
bun run maximumsats-wot/maximumsats-wot.ts config --min-rank 5000
bun run maximumsats-wot/maximumsats-wot.ts config --require-top100
bun run maximumsats-wot/maximumsats-wot.ts config --no-require-top100
```

Threshold fields:
- `minRank` — Maximum acceptable rank (lower number = more trusted). Default: `10000`
- `requireTop100` — If `true`, reject any pubkey not in top 100. Default: `false`

### cache-status

Show in-memory cache statistics. Results are cached for 1 hour to avoid redundant L402 payments.

```bash
bun run maximumsats-wot/maximumsats-wot.ts cache-status
```

## API Details

**Endpoint:** `POST https://maximumsats.com/api/wot-report`
**Payment:** 100 sats via L402 (Lightning Network)
**Request body:** `{"pubkey": "<64-char hex>"}`
**Response:** `{pubkey, rank, position, in_top_100, report, graph: {nodes, edges}}`

No API key needed. Payment is per-request via L402 protocol.

## Trust Thresholds

| Rank | Meaning |
|------|---------|
| 1–100 | Elite (top 100 Nostr users by WoT) |
| 101–1000 | Well-connected, high economic activity |
| 1001–10000 | Active community member |
| >10000 | Low trust, new account, or no Nostr activity |

Use `config --min-rank <n>` to tune the threshold for your risk tolerance.

## Key Derivation (check-agent)

Uses BTC-shared path: `BIP39 mnemonic → BIP32 seed → m/84'/0'/0'/0/0 → secp256k1 private key → x-only pubkey (Nostr)`

This is the same path used by the `nostr` skill — agents get a shared Nostr identity from their BTC wallet.
