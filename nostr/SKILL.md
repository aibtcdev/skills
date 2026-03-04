---
name: nostr
description: Nostr protocol operations for AI agents — post kind:1 notes, read feeds, search by hashtag tags (#t filter), get/set profiles, derive keys (BTC-shared path) from BIP84 wallet path, and manage relay connections. Uses nostr-tools + ws packages. Write operations require an unlocked wallet.
user-invocable: false
arguments: post | read-feed | search-tags | get-profile | set-profile | get-pubkey | relay-list
entry: nostr/nostr.ts
requires: [wallet, signing]
tags: [l1, write]
---

# Nostr Skill

Nostr protocol operations for AI agents. Post notes, read feeds, search by hashtags, manage profiles, and derive keys (BTC-shared path) from the BTC wallet.

## Usage

```
bun run nostr/nostr.ts <subcommand> [options]
```

## Subcommands

### post

Post a kind:1 note to configured relays. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts post --content "Hello from an AI agent" --tags "Bitcoin,sBTC,Stacks"
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

Derive and display your Nostr public key from BIP84 wallet. Requires unlocked wallet.

```bash
bun run nostr/nostr.ts get-pubkey
```

Output:
```json
{
  "npub": "npub19drq8533690hw80d8ekpacjs67dan2y4pka09emqzh2mkhr9uxvqd4k3nn",
  "hex": "2b4603d231d15f771ded3e6c1ee250d79bd9a8950dbaf2e76015d5bb5c65e198",
  "derivationPath": "m/84'/0'/0'/0/0"
}
```

### relay-list

List configured relay URLs.

```bash
bun run nostr/nostr.ts relay-list
```

Default relays: `wss://relay.damus.io`, `wss://nos.lol`

## Technical Details

### Key Derivation (BTC-shared)

The Nostr private key is derived from the same BIP-84 HD wallet path used for BTC:

```
BIP39 mnemonic → BIP32 seed → m/84'/0'/0'/0/0 → secp256k1 private key
```

- The 32-byte private key is used directly as the Nostr secret key
- The corresponding x-only public key (32 bytes) becomes the Nostr pubkey
- This means the agent's npub and BTC taproot address share the same underlying keypair
- Event signing uses `finalizeEvent` from `nostr-tools/pure`

### Security

- **Always delete mnemonic from temp files after key derivation**
- Mnemonic is written to `/tmp/.mnemonic_tmp`, used, then immediately removed
- Never log or persist the private key

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
