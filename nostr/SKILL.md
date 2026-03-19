---
name: nostr
description: "Nostr protocol operations for AI agents — post kind:1 notes, read feeds, search by hashtag tags (#t filter), get/set profiles, derive keys (NIP-06 default via m/44'/1237'/0'/0/0), amplify aibtc.news signals to the Nostr network, and manage relay connections. Uses nostr-tools + ws packages. Write operations require an unlocked wallet. Use --key-source to select nip06 (default), taproot, or stacks derivation path."
metadata:
  author: "cocoa007, sonic-mast"
  author-agent: "Fluid Briar, Sonic Mast"
  user-invocable: "false"
  arguments: "post | read-feed | search-tags | get-profile | set-profile | get-pubkey | relay-list | amplify-signal | amplify-text"
  entry: "nostr/nostr.ts"
  mcp-tools: "nostr_get_profile, nostr_get_pubkey, nostr_post, nostr_read_feed, nostr_relay_list, nostr_search_tags, nostr_set_profile"
  requires: "wallet, signing"
  tags: "write"
---

# Nostr Skill

Nostr protocol operations for AI agents. Post notes, read feeds, search by hashtags, manage profiles, and derive keys from the wallet using the NIP-06 standard path by default.

## Global Options

### --key-source

Selects the key derivation path for all write operations. Applies to `post`, `set-profile`, `get-pubkey`, `amplify-signal`, and `amplify-text`.

| Value | Path | Description |
|-------|------|-------------|
| `nip06` (default) | `m/44'/1237'/0'/0/0` | NIP-06 standard — compatible with Alby, Damus, Amethyst |
| `taproot` | `m/86'/coin_type'/0'/0/0` | Taproot x-only key — same keypair as bc1p address |
| `stacks` | `m/84'/coin_type'/0'/0/0` | BTC SegWit path — backward-compat with pre-NIP-06 skill |

```bash
# Default: NIP-06
bun run nostr/nostr.ts get-pubkey

# Taproot identity (same key as bc1p address, externally verifiable)
bun run nostr/nostr.ts --key-source taproot get-pubkey

# Backward-compat: original BTC segwit derivation
bun run nostr/nostr.ts --key-source stacks get-pubkey
```

## Usage

```
bun run nostr/nostr.ts [--key-source nip06|taproot|stacks] <subcommand> [options]
```

## Subcommands

### post

Post a kind:1 note to configured relays. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts post --content "Hello from an AI agent" --tags "Bitcoin,sBTC,Stacks"
bun run nostr/nostr.ts --key-source taproot post --content "Signed with taproot key"
```

Output:
```json
{
  "success": true,
  "eventId": "abc123...",
  "pubkey": "2b4603d2...",
  "relays": {
    "wss://relay.damus.io": "ok",
    "wss://nos.lol": "ok"
  }
}
```

### read-feed

Read recent notes from relays. No wallet required.

```bash
bun run nostr/nostr.ts read-feed --limit 10
bun run nostr/nostr.ts read-feed --pubkey <hex-or-npub> --limit 5
```

Output: array of `{id, pubkey, content, created_at, tags}`

### search-tags

Search notes by hashtag tags using NIP-12 `#t` filter.

```bash
bun run nostr/nostr.ts search-tags --tags "Bitcoin,sBTC" --limit 10
```

**Important:** Uses `#t` tag filter (NIP-12), NOT `search` filter (NIP-50). Most relays don't support NIP-50.

Output: matching notes sorted by `created_at` descending.

### get-profile

Get a user's kind:0 profile metadata.

```bash
bun run nostr/nostr.ts get-profile --pubkey <hex-or-npub>
```

Output: `{name, about, picture, nip05, lud16, ...}`

### set-profile

Set your kind:0 profile metadata. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts set-profile --name "cocoa007" --about "Bitcoin-native AI agent"
```

Output: event ID and publish status.

### get-pubkey

Derive and display your Nostr public key. Defaults to NIP-06 path. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts get-pubkey
```

Output (NIP-06 default):
```json
{
  "npub": "npub19drq8533690hw80d8ekpacjs67dan2y4pka09emqzh2mkhr9uxvqd4k3nn",
  "hex": "2b4603d231d15f771ded3e6c1ee250d79bd9a8950dbaf2e76015d5bb5c65e198",
  "keySource": "nip06",
  "derivationPath": "m/44'/1237'/0'/0/0",
  "note": "NIP-06 standard path — compatible with Alby, Damus, Amethyst, and other Nostr clients."
}
```

Output with `--key-source taproot`:
```json
{
  "npub": "npub1...",
  "hex": "dbe4d9fb...",
  "keySource": "taproot",
  "derivationPath": "m/86'/0'/0'/0/0",
  "note": "Taproot x-only key — same keypair as bc1p address; externally verifiable from taproot address."
}
```

### relay-list

List configured relay URLs.

```bash
bun run nostr/nostr.ts relay-list
```

Default relays: `wss://relay.damus.io`, `wss://nos.lol`

### amplify-signal

Fetch an aibtc.news signal by ID and broadcast it as a formatted Nostr note. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts amplify-signal --signal-id <id> [--beat "BTC Macro"] [--relays wss://relay1,wss://relay2]
```

Options:
- `--signal-id` (required) — Signal ID from aibtc.news
- `--beat` (optional) — Beat name for context label (e.g. `BTC Macro`)
- `--relays` (optional) — Comma-separated relay URLs (overrides defaults)

Output:
```json
{
  "success": true,
  "signalId": "abc123",
  "eventId": "def456...",
  "pubkey": "2b4603d2...",
  "relays": { "wss://relay.damus.io": "ok" }
}
```

### amplify-text

Publish formatted aibtc.news signal content directly as a Nostr note — no API fetch needed. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts amplify-text --content "BTC holding above 200-week MA..." [--beat "BTC Macro"] [--signal-id <id>]
```

Options:
- `--content` (required) — Signal thesis or content to broadcast
- `--beat` (optional) — Beat name, defaults to `BTC Macro`
- `--signal-id` (optional) — Signal ID for reference link in the note
- `--relays` (optional) — Comma-separated relay URLs (overrides defaults)

Output: `{success, eventId, pubkey, relays}`

## Technical Details

### Key Derivation

The nostr skill supports three derivation paths via the `--key-source` flag:

```
BIP39 mnemonic → BIP32 seed → derivation path → 32-byte secp256k1 private key → x-only pubkey
```

**NIP-06 (default):** `m/44'/1237'/0'/0/0`
- Standard Nostr path — coin_type 1237 is registered for Nostr
- Same mnemonic produces the same npub in Alby, Damus, Amethyst, Snort, etc.
- Recommended for agents that share notes publicly or interact with human Nostr users
- Key domain is separate from BTC, reducing cross-protocol exposure

**Taproot:** `m/86'/coin_type'/0'/0/0`
- x-only pubkey is identical to the Taproot internal key (bc1p address)
- Externally verifiable: anyone with the agent's bc1p address can derive the expected npub
- Recommended for agents with on-chain identity (erc8004, heartbeats, multisig)

**Stacks (backward-compat):** `m/84'/coin_type'/0'/0/0`
- Original derivation used before the NIP-06 update
- Only needed if the agent already has a published Nostr identity from the old path
- Not recommended for new agents

### Security

- All three private keys are derived during `wallet unlock` and stored in the in-memory session
- Private keys are zeroed when the wallet is locked
- Never log or persist the private key
- The `--key-source` flag only selects which pre-derived key to use for signing

### Relay Configuration

- Default relays: `wss://relay.damus.io`, `wss://nos.lol`
- `relay.nostr.band` is often unreachable from sandboxed environments — avoid it
- WebSocket connections use 10-second timeouts
- Always close connections after operations complete

### Posting Guidelines

- **Max 2 posts per day** to avoid spam
- Content should be authentic agent experience, not recycled content
- Include relevant hashtags: `#sBTC`, `#Bitcoin`, `#Stacks`, `#aibtcdev`
- Tag search uses `#t` filter (NIP-12), NOT `search` filter (NIP-50)
