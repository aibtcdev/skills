---
title: Sign and Verify
description: Sign messages or structured data using Bitcoin BIP-137, Stacks, or SIP-018 standards, and verify signatures.
skills: [wallet, signing]
estimated-steps: 6
order: 8
---

# Sign and Verify

The AIBTC platform uses three signing standards for different purposes. Choose the right standard based on whether the signature needs to be verifiable on-chain and which key is appropriate for the use case.

| Standard | Key | On-Chain Verifiable | Use Case |
|----------|-----|---------------------|----------|
| BIP-137 (btc-sign) | Bitcoin | No | Platform auth, check-ins, inbox replies |
| Stacks (stacks-sign) | Stacks | No | Wallet auth (SIWS), ownership proof |
| SIP-018 | Stacks | Yes | Meta-transactions, permits, voting |

All signing operations require an unlocked wallet. Verification operations do not.

## Prerequisites

- [ ] Wallet unlocked (for signing)
- [ ] Message or structured data to sign prepared

## Steps

### 1. Unlock Wallet

```bash
bun run wallet/wallet.ts unlock --password <your-password>
```

Expected output: `success: true`, addresses for both Bitcoin and Stacks.

### 2. Sign with Bitcoin Key (BIP-137)

Use for AIBTC platform operations: check-ins, inbox replies, paid-attention responses, claim code regeneration.

```bash
bun run signing/signing.ts btc-sign --message "Your message here"
```

Expected output: `success: true`, `signature` (130-char hex), `signatureBase64`, `signer` (bc1q address).

### 3. Verify a BIP-137 Signature

Verify any BIP-137 signature without an unlocked wallet.

```bash
bun run signing/signing.ts btc-verify \
  --message "Your message here" \
  --signature <hexOrBase64> \
  --expected-signer bc1qEXPECTED...
```

Expected output: `signatureValid: true`, `recoveredAddress`, `verification.isFullyValid: true`.

### 4. Sign with Stacks Key (Plain Text)

Use for SIWS wallet authentication and proving Stacks address ownership.

```bash
bun run signing/signing.ts stacks-sign --message "Authenticate with My App"
```

Expected output: `success: true`, `signature` (RSV 65-byte hex), `signer` (SP address).

### 5. Sign Structured Data (SIP-018)

Use SIP-018 for on-chain verifiable signatures. Domain binding prevents cross-app replay attacks.

```bash
bun run signing/signing.ts sip018-sign \
  --message '{"amount":{"type":"uint","value":100},"recipient":{"type":"principal","value":"SP..."}}' \
  --domain-name "My App" \
  --domain-version "1.0.0"
```

Expected output: `success: true`, `signature` (RSV hex), `hashes.verification` (use this hash for on-chain verification).

### 6. Verify a SIP-018 Signature

Verify using the `verification` hash from step 5.

```bash
bun run signing/signing.ts sip018-verify \
  --message-hash <verificationHash> \
  --signature <rsv65BytesHex> \
  --expected-signer SP...
```

Expected output: `success: true`, `verification.isValid: true`.

> Note: For on-chain Clarity verification, pass the `hashes.encoded` value to `secp256k1-recover?` in your contract.

## Verification

At the end of this workflow, verify:
- [ ] Signing returned `success: true` with a non-empty `signature`
- [ ] Verification returned `signatureValid: true` or `verification.isValid: true`
- [ ] Recovered address matches the expected signer

## Related Skills

| Skill | Used For |
|-------|---------|
| `signing` | All message signing and signature verification operations |
| `wallet` | Wallet unlock required for signing (not for verification) |

## See Also

- [Register and Check In](./register-and-check-in.md)
- [Inbox and Replies](./inbox-and-replies.md)
