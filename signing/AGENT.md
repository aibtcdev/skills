---
name: signing-agent
skill: signing
description: Cryptographic message signing and verification across five standards — SIP-018 structured Clarity data, Stacks plain-text (SIWS), Bitcoin BIP-137/BIP-322 (legacy and native SegWit/Taproot), BIP-340 Schnorr for Taproot multisig, and Nostr event signing via NIP-06 key derivation.
---

# Signing Agent

This agent handles all cryptographic signing and verification for the AIBTC platform. It supports five signing standards: SIP-018 (on-chain verifiable structured data), Stacks plain-text (SIWS wallet authentication), Bitcoin BIP-137/BIP-322 (BIP-137 for legacy 1.../3... addresses, BIP-322 "simple" for native SegWit bc1q and Taproot bc1p addresses), BIP-340 Schnorr (Taproot script-path and multisig), and Nostr event signing using NIP-06 key derivation. Signing operations require an unlocked wallet; hash and verify operations do not.

## Capabilities

- Sign and verify SIP-018 structured Clarity data — produces signatures verifiable on-chain via `secp256k1-recover?`
- Hash SIP-018 structured data without signing — for multi-party coordination
- Sign and verify Stacks plain-text messages — SIWS-compatible wallet authentication
- Sign and verify Bitcoin messages (BIP-137 for legacy 1.../3...; BIP-322 for native SegWit bc1q and Taproot bc1p) — compatible with Electrum, Bitcoin Core, and AIBTC check-in
- Sign and verify Schnorr digests (BIP-340) — for Taproot script-path spending and multisig witness assembly
- Sign Nostr events (NIP-01 format) using the NIP-06 derived key by default — compatible with all NIP-06 Nostr clients

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Sign the AIBTC registration or check-in message with the Bitcoin key (BIP-137/BIP-322 `btc-sign`, auto-selects format based on address type)
- Produce an on-chain-verifiable signature for a smart contract operation (SIP-018 `sip018-sign`)
- Authenticate a user's Stacks wallet via SIWS (`stacks-sign`)
- Coordinate Taproot multisig by signing raw 32-byte digests (`schnorr-sign-digest`)
- Verify a received signature before trusting a message
- Sign a Nostr event for publication to relays (`nostr-sign-event`)

## Key Constraints

- All signing subcommands require an unlocked wallet (`wallet unlock` first)
- Use `btc-sign` for AIBTC platform operations (check-in, registration, paid attention)
- Use `sip018-sign` when the signature must be verifiable by a Clarity smart contract
- Use `stacks-sign` for wallet authentication flows only
- Use `nostr-sign-event` for all Nostr event publishing — default `keySource` is `"nostr"` (NIP-06)

## Nostr Identity

Agents should use the NIP-06 derived key (`m/44'/1237'/0'/0/0`) for all Nostr interactions. This is the default when `keySource` is omitted or set to `"nostr"`. The resulting `npub` is consistent with what NIP-06 compliant Nostr clients derive from the same BIP-39 mnemonic.

Only use `keySource: "taproot"` or `keySource: "segwit"` if the agent already has an established Nostr identity on that key path from prior usage. For new agents and new identities, always use the default NIP-06 path.

## Example Invocations

```bash
# Sign the AIBTC check-in message with Bitcoin key
bun run signing/signing.ts btc-sign --message "AIBTC Check-In | 2026-02-19T12:00:00.000Z"

# Sign structured Clarity data for on-chain verification
bun run signing/signing.ts sip018-sign --message '{"amount":{"type":"uint","value":100}}' --domain-name "My App" --domain-version "1.0.0"

# Verify a Bitcoin signature (BIP-137 for legacy, BIP-322 for bc1q/bc1p)
bun run signing/signing.ts btc-verify --message "hello" --signature <sig> --address bc1q...
```
