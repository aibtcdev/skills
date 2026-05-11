---
name: wot-agent
skill: wot
description: Web of Trust operations for Nostr pubkeys — trust scoring, sybil detection, trust paths, neighbor discovery, follow recommendations, and network health stats. Use nip06 key source by default; taproot for on-chain-verifiable identity.
---

# WoT Agent

Query the Nostr Web of Trust to assess counterparty trust before payments, vet agents for contract interactions, or filter contacts by sybil risk.

This is a doc-only MCP-tool skill. There is no `wot.ts` CLI entrypoint. Use `nostr_get_pubkey({})` to get a Nostr pubkey, then call the WoT HTTP API directly. All WoT operations are read-only.

## Prerequisites

- Input must be a Nostr hex pubkey (64 hex chars) or `npub1...` bech32 — not a Stacks address, BTC address, or ordinals address (those are hashed and cannot be looked up in the WoT graph)
- To look up the agent's own pubkey: call `nostr_get_pubkey({})` — no wallet unlock needed for read-only WoT queries

## Decision Logic

| Goal | API Endpoint |
|------|-------------|
| Check trust score and rank for a pubkey | `GET https://wot.klabo.world/api/trust-score?pubkey=<hex>` |
| Classify a pubkey as normal/suspicious/sybil | `GET https://wot.klabo.world/api/sybil-check?pubkey=<hex>` |
| Find trusted neighbors of a pubkey | `GET https://wot.klabo.world/api/neighbors?pubkey=<hex>` |
| Find trust path between two pubkeys | `GET https://wot.klabo.world/api/trust-path?from=<hex>&to=<hex>` |
| Get follow recommendations for a pubkey | `GET https://wot.klabo.world/api/recommend?pubkey=<hex>` |
| Check graph-wide WoT statistics | `GET https://wot.klabo.world/api/network-health` |

## When to Use Each --key-source

| `--key-source` | Derivation path | Use when |
|----------------|----------------|----------|
| `nip06` (default) | `m/44'/1237'/0'/0/0` | Agent's Nostr identity was created with NIP-06 standard path |
| `taproot` | `m/86'/coin_type'/0'/0/0` | Agent has a known bc1p address; cross-protocol identity verification needed |
| `stacks` | `m/84'/coin_type'/0'/0/0` | Agent already has WoT data published under the original pre-NIP-06 path |

**Default to `nip06` unless there is a specific reason to use another path.**

Note: all three paths produce valid secp256k1 x-only pubkeys that WoT can look up. However, each path produces a *different* pubkey — consistently use the same key source for the same agent identity.

## Key Format Rules

WoT only accepts Nostr pubkeys. Never pass these to WoT subcommands:
- Stacks addresses (`SP1...`, `ST1...`) — these are HASH160 of a key; original not recoverable
- BTC legacy or SegWit addresses (`1...`, `3...`, `bc1q...`) — same, hashed
- Taproot addresses (`bc1p...`) — also hashed; use `--key-source taproot` to get the pre-hash key

If you have only a Stacks or BTC address and need the WoT score, you cannot look it up directly. You need the owner's Nostr pubkey (hex or npub) separately. Future cross-protocol identity mapping may bridge this gap — check the `identity` skill for on-chain identity links.

## Safety Checks

- **Rate limit awareness**: free tier is 50 req/day/IP. `cache-status` shows how many entries are cached; cached hits do not count against the limit. Batch lookups if checking many pubkeys.
- **L402 credentials**: if free tier is exhausted, an L402 Lightning payment is required (100 sats). Without a paid credential, the skill returns an error with the BOLT11 invoice. Store credentials with `arc creds set --service wot --key l402-token --value "<token>:<preimage>"`.
- **Trust thresholds**: check `config` to see current `minRank` and `requireTop100` settings before interpreting `trust-score` output. The `trusted` field in output already applies these thresholds.
- **Consistent key source per identity**: always use the same `--key-source` for a given agent's Nostr identity. Switching produces a different pubkey and looks up a different WoT node.

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `"Invalid pubkey format"` | Input is not a valid hex or npub | Confirm input is a 64-char hex or `npub1...` bech32 string |
| `"Pubkey not found in WoT graph"` | Pubkey not indexed (new account, not active on Nostr) | Pubkey has no WoT data; treat as untrusted |
| `"HTTP 402 — free tier exhausted"` | 50 req/day limit hit | Pay L402 invoice and store credential, or wait until next day |
| `"L402 payment required"` | No paid credential stored | Pay invoice and store with `arc creds set` |
| `"Wallet is not unlocked"` | --key-source used without unlocked wallet | Run `wallet unlock` first |
| `"NIP-06 Nostr private key not available"` | Session from older wallet version | Re-unlock the wallet |
| `"Taproot private key not available"` | Taproot key missing from session | Re-unlock the wallet |
| `"No trust path found"` | No chain of trust edges between --from and --to | Pubkeys are in disconnected parts of the graph |

## Output Handling

| Subcommand | Key fields to extract |
|-----------|----------------------|
| `trust-score` | `trusted` (boolean gate), `normalized_score` (0–100), `rank` (lower is better), `percentile` |
| `sybil-check` | `classification` (normal/suspicious/likely_sybil), `is_sybil`, `is_suspicious` |
| `neighbors` | Array of `{pubkey, score, edge_weight}` — use `score` to rank neighbors |
| `trust-path` | `path` array (ordered pubkeys), `hop_count`, per-hop scores |
| `recommend` | Array of `{pubkey, score, reason}` — sorted by score descending |
| `network-health` | `total_nodes`, `total_edges`, `gini_coefficient`, `power_law_alpha` |
| `config` | `minRank`, `requireTop100` — confirms current thresholds |
| `cache-status` | `entries`, `hits`, `misses`, `ttl_seconds` |

## Example Invocations

This skill has no CLI entrypoint. All operations use MCP tool calls or HTTP requests.

```
// Get agent's own Nostr pubkey
nostr_get_pubkey({})

// Check trust score for a specific npub
GET https://wot.klabo.world/api/trust-score?npub=npub1abc...

// Sybil check before sending Lightning payment
GET https://wot.klabo.world/api/sybil-check?pubkey=2b4603d2...

// Look up agent's own WoT score
nostr_get_pubkey({})
// → { pubkey: "2b4603d2..." }
GET https://wot.klabo.world/api/trust-score?pubkey=2b4603d2...

// Find trust path between two agents
GET https://wot.klabo.world/api/trust-path?from=2b4603d2...&to=dbe4d9fb...

// Get follow recommendations for an agent
GET https://wot.klabo.world/api/recommend?pubkey=2b4603d2...

// Check WoT graph health (no pubkey needed)
GET https://wot.klabo.world/api/network-health
```
