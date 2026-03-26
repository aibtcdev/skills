---
name: wot
description: "Web of Trust operations for Nostr pubkeys — trust scoring, sybil detection, trust path analysis, neighbor discovery, follow recommendations, and network health. Free tier (wot.klabo.world, 50 req/day) with paid fallback (maximumsats.com, 100 sats via L402). Covers 52K+ pubkeys and 2.4M+ zap-weighted trust edges. Use --key-source to select nip06 (default), taproot, or stacks derivation path."
metadata:
  author: "arc0btc"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "trust-score | sybil-check | neighbors | trust-path | recommend | network-health | config | cache-status"
  entry: "wot/SKILL.md"
  requires: "wallet"
  tags: "read-only"
---

# Web of Trust (WoT) Skill

Pre-transaction counterparty risk assessment using Nostr Web of Trust scores. Accepts Nostr hex pubkeys or `npub1...` bech32 addresses only.

- **52K+ pubkeys** indexed with **2.4M+ trust edges**
- Trust edges weighted by zap receipts (economic signal, harder to fake)
- Free tier: `wot.klabo.world` (50 req/day per IP), no key required
- Paid fallback: `maximumsats.com/api/wot-report` (100 sats via L402) when free tier exhausted
- 1-hour local cache to avoid redundant API calls

This is an MCP-tool skill. Agents use `--key-source` to derive the Nostr pubkey from their wallet, then pass it to WoT subcommands.

## Global Options

### --key-source

Selects the key derivation path to use when looking up the agent's own pubkey. Applies whenever the agent calls a subcommand without an explicit `--pubkey` argument.

| Value | Path | Description |
|-------|------|-------------|
| `nip06` (default) | `m/44'/1237'/0'/0/0` | NIP-06 standard — compatible with Alby, Damus, Amethyst |
| `taproot` | `m/86'/coin_type'/0'/0/0` | Taproot x-only key — same keypair as bc1p address |
| `stacks` | `m/84'/coin_type'/0'/0/0` | BTC SegWit path — backward-compat with pre-NIP-06 agents |

```bash
# Use NIP-06 derived pubkey (default)
bun run wot/wot.ts trust-score

# Use taproot-derived pubkey (same key as bc1p address)
bun run wot/wot.ts --key-source taproot trust-score

# Explicit pubkey (no wallet derivation needed)
bun run wot/wot.ts trust-score --pubkey 2b4603d2...
bun run wot/wot.ts trust-score --npub npub1abc...
```

## What WoT Accepts

WoT is a Nostr-native protocol. It indexes secp256k1 x-only public keys (32 bytes). The only valid inputs are:

| Format | Example | Works |
|--------|---------|-------|
| Nostr hex pubkey | `2b4603d2...` (64 hex chars) | Yes |
| Nostr npub bech32 | `npub1abc...` | Yes |
| Stacks address | `SP1ABC...` | **No** — hashed; original key not recoverable |
| BTC address (bc1q) | `bc1q...` | **No** — hashed P2WPKH |
| BTC address (bc1p) | `bc1p...` | **No** — hashed P2TR |
| Ordinals address | `bc1p...` | **No** — same as bc1p, hashed |

**Why hashed addresses don't work:** Bitcoin and Stacks addresses are derived by hashing the public key (HASH160 or SHA256). The original secp256k1 key cannot be recovered from the address. WoT requires the raw 32-byte x-only pubkey to look up nodes in the trust graph.

**Future cross-protocol identity:** Cross-protocol identity mapping (e.g. linking a Stacks address to a Nostr npub) is not yet standardized. When it is, the `taproot` key source provides the best bridge — the taproot x-only pubkey is both a valid Nostr pubkey AND the internal key of the agent's bc1p address, making it externally verifiable from on-chain data. The `stacks` key source cannot bridge this gap because the Stacks address uses a different hash.

## Usage

```
bun run wot/wot.ts [--key-source nip06|taproot|stacks] <subcommand> [options]
```

## Subcommands

### trust-score

Look up WoT trust score, rank, and percentile for a pubkey. Checks against configurable thresholds.

```bash
bun run wot/wot.ts trust-score --pubkey 2b4603d2...
bun run wot/wot.ts trust-score --npub npub1abc...
bun run wot/wot.ts --key-source taproot trust-score
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
bun run wot/wot.ts sybil-check --pubkey 2b4603d2...
bun run wot/wot.ts sybil-check --npub npub1abc...
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
bun run wot/wot.ts neighbors --pubkey 2b4603d2...
```

Output: array of connected pubkeys with their trust scores and edge weights.

### trust-path

Find the trust path between two pubkeys in the WoT graph. Shows the chain of trust edges connecting `--from` to `--to`.

```bash
bun run wot/wot.ts trust-path --from npub1abc... --to npub1xyz...
bun run wot/wot.ts trust-path --from 2b4603d2... --to dbe4d9fb...
```

Output: ordered list of pubkeys forming the trust path, with hop count and per-hop scores.

### recommend

Get personalized follow recommendations for a pubkey based on WoT graph proximity and trust score.

```bash
bun run wot/wot.ts recommend --pubkey 2b4603d2...
bun run wot/wot.ts recommend --npub npub1abc...
```

Output: array of recommended pubkeys with trust scores and reasoning.

### network-health

Graph-wide stats: total nodes, edges, Gini coefficient, power law alpha. No pubkey required.

```bash
bun run wot/wot.ts network-health
```

Output:
```json
{
  "success": true,
  "total_nodes": 52000,
  "total_edges": 2400000,
  "gini_coefficient": 0.72,
  "power_law_alpha": 2.1
}
```

### config

View or update trust thresholds. Stored at `~/.aibtc/wot/config.json`.

```bash
bun run wot/wot.ts config                    # view current thresholds
bun run wot/wot.ts config --min-rank 5000
bun run wot/wot.ts config --require-top100
bun run wot/wot.ts config --no-require-top100
```

Threshold fields:
- `minRank` — Maximum acceptable rank. Default: `10000`
- `requireTop100` — Reject if not in top 100. Default: `false`

### cache-status

Show cache statistics. Cache stored at `~/.aibtc/wot/cache.json` with 1-hour TTL.

```bash
bun run wot/wot.ts cache-status
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

## L402 Payment Flow

When the 50 req/day free tier is exhausted, the API returns HTTP 402 with a Lightning invoice in `WWW-Authenticate`. After paying:

```
arc creds set --service wot --key l402-token --value "<token>:<preimage>"
```

The credential is automatically read on subsequent calls.

## Key Derivation Reference

All three derivation paths produce secp256k1 x-only pubkeys that WoT can look up:

```
BIP39 mnemonic → BIP32 seed → derivation path → 32-byte secp256k1 private key → x-only pubkey
```

**NIP-06 (default):** `m/44'/1237'/0'/0/0`
- Standard Nostr path — coin_type 1237 registered for Nostr
- Same mnemonic produces the same npub in Alby, Damus, Amethyst, Snort, etc.
- Recommended for agents without a specific on-chain identity requirement

**Taproot:** `m/86'/coin_type'/0'/0/0`
- x-only pubkey is identical to the Taproot internal key (bc1p address)
- Externally verifiable: anyone with the agent's bc1p address can derive the expected npub
- Best path for cross-protocol identity (Nostr + on-chain BTC)

**Stacks (backward-compat):** `m/84'/coin_type'/0'/0/0`
- Original derivation used before NIP-06 update
- Only needed if the agent already has a published Nostr identity from the old path
- Not recommended for new agents
