---
name: signing-agent
skill: signing
description: Cryptographic message signing and verification across four standards — SIP-018 structured Clarity data, Stacks plain-text (SIWS), Bitcoin BIP-137, and BIP-340 Schnorr for Taproot multisig.
---

# Signing Agent

This agent handles all cryptographic signing and verification for the AIBTC platform. It supports four signing standards: SIP-018 (on-chain verifiable structured data), Stacks plain-text (SIWS wallet authentication), Bitcoin BIP-137 (plain-text, Electrum/Bitcoin Core compatible), and BIP-340 Schnorr (Taproot script-path and multisig). Signing operations require an unlocked wallet; hash and verify operations do not.

## Capabilities

- Sign and verify SIP-018 structured Clarity data — produces signatures verifiable on-chain via `secp256k1-recover?`
- Hash SIP-018 structured data without signing — for multi-party coordination
- Sign and verify Stacks plain-text messages — SIWS-compatible wallet authentication
- Sign and verify Bitcoin messages (BIP-137) — compatible with Electrum, Bitcoin Core, and AIBTC check-in
- Sign and verify Schnorr digests (BIP-340) — for Taproot script-path spending and multisig witness assembly

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Sign the AIBTC registration or check-in message with the Bitcoin key (BIP-137 `btc-sign`)
- Produce an on-chain-verifiable signature for a smart contract operation (SIP-018 `sip018-sign`)
- Authenticate a user's Stacks wallet via SIWS (`stacks-sign`)
- Coordinate Taproot multisig by signing raw 32-byte digests (`schnorr-sign-digest`)
- Verify a received signature before trusting a message

## Key Constraints

- All signing subcommands require an unlocked wallet (`wallet unlock` first)
- Use `btc-sign` for AIBTC platform operations (check-in, registration, paid attention)
- Use `sip018-sign` when the signature must be verifiable by a Clarity smart contract
- Use `stacks-sign` for wallet authentication flows only

## Example Invocations

```bash
# Sign the AIBTC check-in message with Bitcoin key
bun run signing/signing.ts btc-sign --message "AIBTC Check-In | 2026-02-19T12:00:00.000Z"

# Sign structured Clarity data for on-chain verification
bun run signing/signing.ts sip018-sign --message '{"amount":{"type":"uint","value":100}}' --domain-name "My App" --domain-version "1.0.0"

# Verify a BIP-137 Bitcoin signature
bun run signing/signing.ts btc-verify --message "hello" --signature <sig> --address bc1q...
```
