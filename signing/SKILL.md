---
name: signing
description: Message signing and verification — SIP-018 structured Clarity data signing (on-chain verifiable), Stacks plain-text message signing (SIWS-compatible), and Bitcoin BIP-137 message signing. All signing requires an unlocked wallet; hash and verify operations do not.
user-invocable: false
arguments: sip018-sign | sip018-verify | sip018-hash | stacks-sign | stacks-verify | btc-sign | btc-verify
---

# Signing Skill

Provides cryptographic message signing for the Stacks and Bitcoin ecosystems. Three signing standards are supported:

- **SIP-018** — Structured Clarity data signing. Signatures are verifiable both off-chain and by on-chain smart contracts via `secp256k1-recover?`.
- **Stacks messages** — SIWS-compatible plain-text signing. Used for wallet authentication and proving address ownership.
- **Bitcoin messages** — BIP-137 plain-text signing. Compatible with Electrum, Bitcoin Core, and most Bitcoin wallets.

## Usage

```
bun run signing/signing.ts <subcommand> [options]
```

## Subcommands

### sip018-sign

Sign structured Clarity data using the SIP-018 standard. The domain binding (name + version + chain-id) prevents cross-app and cross-chain replay attacks. Requires an unlocked wallet.

```
bun run signing/signing.ts sip018-sign \
  --message '{"amount":{"type":"uint","value":100}}' \
  --domain-name "My App" \
  --domain-version "1.0.0"
```

Options:
- `--message` (required) — Structured data as a JSON string. Use type hints for explicit Clarity types:
  - `{"type":"uint","value":100}` → `uint`
  - `{"type":"int","value":-50}` → `int`
  - `{"type":"principal","value":"SP..."}` → `principal`
  - `{"type":"ascii","value":"hello"}` → `string-ascii`
  - `{"type":"utf8","value":"hello"}` → `string-utf8`
  - `{"type":"buff","value":"0x1234"}` → `buff`
  - `{"type":"bool","value":true}` → `bool`
  - `{"type":"none"}` → `none`
  - `{"type":"some","value":...}` → `(some ...)`
  - `{"type":"list","value":[...]}` → `list`
  - `{"type":"tuple","value":{...}}` → `tuple`
  - Implicit: `string → string-utf8`, `number → int`, `boolean → bool`, `null → none`
- `--domain-name` (required) — Application name for domain binding
- `--domain-version` (required) — Application version for domain binding

Output:
```json
{
  "success": true,
  "signature": "abc123...",
  "signatureFormat": "RSV (65 bytes hex)",
  "signer": "SP...",
  "network": "testnet",
  "chainId": 2147483648,
  "hashes": {
    "message": "...",
    "domain": "...",
    "encoded": "...",
    "verification": "...",
    "prefix": "0x534950303138"
  },
  "domain": { "name": "My App", "version": "1.0.0", "chainId": 2147483648 },
  "verificationNote": "Use sip018-verify with the 'verification' hash..."
}
```

### sip018-verify

Verify a SIP-018 signature and recover the signer's Stacks address. Provide the `verification` hash from `sip018-sign` or `sip018-hash`.

```
bun run signing/signing.ts sip018-verify \
  --message-hash <verificationHash> \
  --signature <rsv65BytesHex> \
  [--expected-signer <address>]
```

Options:
- `--message-hash` (required) — The SIP-018 verification hash (from `sip018-sign`/`sip018-hash`)
- `--signature` (required) — Signature in RSV format (65 bytes hex)
- `--expected-signer` (optional) — Expected signer address to verify against

Output:
```json
{
  "success": true,
  "recoveredPublicKey": "03...",
  "recoveredAddress": "SP...",
  "network": "testnet",
  "verification": {
    "expectedSigner": "SP...",
    "isValid": true,
    "message": "Signature is valid for the expected signer"
  }
}
```

### sip018-hash

Compute the SIP-018 message hash without signing. Returns all hash components needed for off-chain or on-chain verification. Does not require an unlocked wallet.

```
bun run signing/signing.ts sip018-hash \
  --message '{"amount":{"type":"uint","value":100}}' \
  --domain-name "My App" \
  --domain-version "1.0.0" \
  [--chain-id <id>]
```

Options:
- `--message` (required) — Structured data as a JSON string (same format as sip018-sign)
- `--domain-name` (required) — Application name
- `--domain-version` (required) — Application version
- `--chain-id` (optional) — Chain ID (default: 1 for mainnet, 2147483648 for testnet)

Output:
```json
{
  "success": true,
  "hashes": {
    "message": "...",
    "domain": "...",
    "encoded": "...",
    "verification": "..."
  },
  "hashConstruction": {
    "prefix": "0x534950303138",
    "formula": "verification = sha256(prefix || domainHash || messageHash)"
  },
  "domain": { "name": "My App", "version": "1.0.0", "chainId": 2147483648 },
  "clarityVerification": {
    "example": "(secp256k1-recover? (sha256 encoded-data) signature)"
  }
}
```

### stacks-sign

Sign a plain text message using the Stacks message signing format. The message is prefixed with `\x17Stacks Signed Message:\n` before hashing (SIWS-compatible). Requires an unlocked wallet.

```
bun run signing/signing.ts stacks-sign --message "Hello, Stacks!"
```

Options:
- `--message` (required) — Plain text message to sign

Output:
```json
{
  "success": true,
  "signature": "abc123...",
  "signatureFormat": "RSV (65 bytes hex)",
  "signer": "SP...",
  "network": "testnet",
  "message": {
    "original": "Hello, Stacks!",
    "prefix": "\u0017Stacks Signed Message:\n",
    "prefixHex": "...",
    "hash": "..."
  },
  "verificationNote": "Use stacks-verify with the original message and signature to verify."
}
```

### stacks-verify

Verify a Stacks message signature and recover the signer's Stacks address. Compatible with SIWS authentication flows.

```
bun run signing/signing.ts stacks-verify \
  --message "Hello, Stacks!" \
  --signature <rsv65BytesHex> \
  [--expected-signer <address>]
```

Options:
- `--message` (required) — The original plain text message that was signed
- `--signature` (required) — Signature in RSV format (65 bytes hex)
- `--expected-signer` (optional) — Expected signer Stacks address

Output:
```json
{
  "success": true,
  "signatureValid": true,
  "recoveredPublicKey": "03...",
  "recoveredAddress": "SP...",
  "network": "testnet",
  "message": {
    "original": "Hello, Stacks!",
    "prefix": "\u0017Stacks Signed Message:\n",
    "hash": "..."
  },
  "verification": {
    "expectedSigner": "SP...",
    "signerMatches": true,
    "isFullyValid": true,
    "message": "Signature is valid and matches expected signer"
  }
}
```

### btc-sign

Sign a plain text message using Bitcoin message signing format (BIP-137). Produces a 65-byte signature in BIP-137 format, compatible with Electrum, Bitcoin Core, and most Bitcoin wallets. Requires an unlocked wallet with Bitcoin keys.

```
bun run signing/signing.ts btc-sign --message "Hello, Bitcoin!"
```

Options:
- `--message` (required) — Plain text message to sign

Output:
```json
{
  "success": true,
  "signature": "abc123...",
  "signatureBase64": "...",
  "signatureFormat": "BIP-137 (65 bytes: 1 header + 32 r + 32 s)",
  "signer": "bc1q...",
  "network": "mainnet",
  "addressType": "P2WPKH (native SegWit)",
  "message": {
    "original": "Hello, Bitcoin!",
    "prefix": "\u0018Bitcoin Signed Message:\n",
    "prefixHex": "...",
    "formattedHex": "...",
    "hash": "..."
  },
  "header": { "value": 39, "recoveryId": 0, "addressType": "P2WPKH (native SegWit)" },
  "verificationNote": "Use btc-verify with the original message and signature to verify."
}
```

### btc-verify

Verify a BIP-137 Bitcoin message signature and recover the signer's Bitcoin address. Accepts signatures in hex (130 chars) or base64 (88 chars) format.

```
bun run signing/signing.ts btc-verify \
  --message "Hello, Bitcoin!" \
  --signature <hexOrBase64Sig> \
  [--expected-signer <btcAddress>]
```

Options:
- `--message` (required) — The original plain text message that was signed
- `--signature` (required) — BIP-137 signature (65 bytes as hex [130 chars] or base64 [88 chars])
- `--expected-signer` (optional) — Expected signer Bitcoin address to verify against

Output:
```json
{
  "success": true,
  "signatureValid": true,
  "recoveredPublicKey": "03...",
  "recoveredAddress": "bc1q...",
  "network": "mainnet",
  "message": { "original": "Hello, Bitcoin!", "prefix": "...", "hash": "..." },
  "header": { "value": 39, "recoveryId": 0, "addressType": "P2WPKH (native SegWit)" },
  "verification": {
    "expectedSigner": "bc1q...",
    "signerMatches": true,
    "isFullyValid": true,
    "message": "Signature is valid and matches expected signer"
  }
}
```

## Signing Standards Reference

| Standard | Prefix | Use Case | On-Chain Verifiable? |
|----------|--------|----------|---------------------|
| SIP-018 | `SIP018` (hex) | Structured Clarity data | Yes (`secp256k1-recover?`) |
| Stacks | `\x17Stacks Signed Message:\n` | Auth, ownership proof | No (off-chain only) |
| BIP-137 | `\x18Bitcoin Signed Message:\n` | Bitcoin auth, ownership | No (off-chain only) |

## Notes

- SIP-018 signing and Stacks signing require an unlocked wallet (`bun run wallet/wallet.ts unlock`)
- BTC signing additionally requires Bitcoin keys (automatically present in managed wallets)
- `sip018-hash` and both `*-verify` subcommands do NOT require an unlocked wallet
- All signatures use the secp256k1 curve
- SIP-018 chain IDs: mainnet = 1, testnet = 2147483648 (0x80000000)
