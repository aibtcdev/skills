---
name: nostr-agent
skill: nostr
description: Nostr protocol operations for AI agents — post kind:1 notes, read feeds, search by hashtag tags, get/set profiles, derive keys (NIP-06 default) from wallet, amplify signals to Nostr, and manage relay connections.
---

# Nostr Agent

This agent handles Nostr protocol operations using keys derived from the wallet. The default key derivation uses NIP-06 (`m/44'/1237'/0'/0/0`) — the standard path used by Alby, Damus, Amethyst, and other Nostr clients. Use `--key-source taproot` for on-chain-verifiable identity, or `--key-source stacks` for backward compatibility with agents that posted before the NIP-06 update.

Read-only operations require no wallet. Write operations require an unlocked wallet.

## Prerequisites

- **Read operations** (read-feed, search-tags, get-profile, relay-list): No prerequisites — no wallet needed
- **Write operations** (post, set-profile, get-pubkey, amplify-signal, amplify-text):
  - Wallet must exist: `bun run wallet/wallet.ts status`
  - Wallet must be unlocked: `bun run wallet/wallet.ts unlock --password <password>`
- `nostr-tools` and `ws` packages must be installed (included in package.json)

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Post a note or announcement to Nostr | `post` — requires `--content`, optional `--tags` |
| Read recent notes from relays | `read-feed` — optional `--pubkey` filter, `--limit` |
| Search notes by hashtag | `search-tags` — requires `--tags` (NIP-12 `#t` filter, NOT NIP-50) |
| Look up a user's profile | `get-profile` — requires `--pubkey` (hex or npub) |
| Update agent's own Nostr profile | `set-profile` — options: `--name`, `--about`, `--picture`, `--nip05`, `--lud16` |
| Get agent's Nostr public key (npub) | `get-pubkey` — defaults to NIP-06; use `--key-source` to select path |
| List configured relay URLs | `relay-list` — no arguments needed |
| Broadcast a Signal-service take by ID | `amplify-signal` — requires `--signal-id`, optional `--beat`, `--relays` |
| Publish signal content directly to Nostr | `amplify-text` — requires `--content`, optional `--beat`, `--signal-id`, `--relays` |

### When to use each --key-source

| `--key-source` | Use when |
|----------------|----------|
| `nip06` (default) | New agent, general Nostr posting, human interop needed |
| `taproot` | Agent has known bc1p address; on-chain identity verification required |
| `stacks` | Agent already has existing Nostr posts from the original skill (pre-NIP-06) |

**Default to `nip06` unless there is a specific reason to use another path.**

## Safety Checks

- **Never log or expose the private key** — `deriveNostrKeys()` returns `sk` as `Uint8Array`; it is used internally and never printed
- **Post rate limit: max 2 posts per day** — avoid flooding relays; content should be authentic, not recycled
- **Key selection**: default NIP-06 key is separate from BTC/taproot keys — Nostr key compromise does not directly affect BTC funds. The `taproot` source shares the key with the bc1p address — only use if cross-protocol identity verification is needed.
- **Relay selection**: avoid `relay.nostr.band` in sandboxed environments — use `relay.damus.io` and `nos.lol`
- **kind:0 is a replaceable event** — `set-profile` fetches existing profile first to merge fields; partial updates will NOT delete unspecified fields
- **amplify-signal fetches from `1btc-news-api.p-d07.workers.dev`** — verify signal content is appropriate before posting
- **Consistent key source per identity** — always use the same `--key-source` for a given agent's Nostr identity. Switching sources produces a different npub and creates a different identity on the network.

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| `"Wallet is not unlocked. Run: bun run wallet/wallet.ts unlock"` | Write operation without unlocked wallet | Run `wallet unlock` first |
| `"NIP-06 Nostr private key not available in current session"` | Session was created by an older wallet version that didn't derive the nostr key | Re-unlock the wallet |
| `"Taproot private key not available in current session"` | Taproot key missing from session | Re-unlock the wallet |
| `"Signal has no content to amplify"` | Fetched signal has no `thesis` or `target_claim` | Check signal ID or use `amplify-text` with explicit content |
| `"Failed to fetch signal: 404"` | Take ID not found at the Signal service | Verify the signal ID exists |
| `"query timeout"` | Relay did not respond within 20 seconds | Retry or use `--relay` to override with a faster relay |
| `error: timeout` (in relay result) | Specific relay unreachable within 10 seconds | Normal — other relays may still succeed; check `relays` object in output |
| `"Profile not found"` | No kind:0 event found for that pubkey | Pubkey may be new or not indexed by default relays |

## Output Handling

- **post / amplify-signal / amplify-text**: extract `eventId` (the Nostr event ID) and `relays` map (per-relay publish status); `"ok"` means accepted
- **read-feed / search-tags**: returns an array of `{id, pubkey, content, created_at, tags}` sorted by `created_at` descending; use `content` for display
- **get-profile**: returns `{pubkey, name, about, picture, nip05, lud16, ...}` — all fields from kind:0 content
- **get-pubkey**: extract `npub` for human-readable identity and `hex` for protocol-level filtering; `keySource` confirms which derivation was used; `derivationPath` shows the exact BIP-32 path
- **relay-list**: informational only — `relays` array shows configured default URLs
- **set-profile**: extract `eventId` and `profile` (merged result); `relays` shows publish status per relay

## Example Invocations

```bash
# Post a note with hashtags (NIP-06 default)
bun run nostr/nostr.ts post --content "Hello from an AI agent #aibtcdev" --tags "Bitcoin,sBTC,aibtcdev"

# Get NIP-06 pubkey (default)
bun run nostr/nostr.ts get-pubkey

# Get taproot-derived pubkey (same as bc1p key)
bun run nostr/nostr.ts --key-source taproot get-pubkey

# Search for recent notes tagged with sBTC
bun run nostr/nostr.ts search-tags --tags "sBTC,Stacks" --limit 20

# Amplify signal content directly
bun run nostr/nostr.ts amplify-text --content "BTC holding above 200-week MA..." --beat "BTC Macro" --signal-id abc123

# Backward-compat: post with original BTC segwit derivation
bun run nostr/nostr.ts --key-source stacks post --content "Legacy identity post"
```
