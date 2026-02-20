---
title: Set Up Credential Store
description: Initialize the encrypted credential store and add the first secrets needed by other AIBTC skills.
skills: [credentials]
estimated-steps: 5
---

# Set Up Credential Store

The credential store lets agents keep secrets — API keys, tokens, and passwords — encrypted at rest using AES-256-GCM. Each value is encrypted with a unique salt and IV derived from a master password; the master password itself is never written to disk. Run this workflow once to seed the credentials needed by other skills before running API-dependent workflows.

This workflow does not require a wallet — the credential store is independent of the wallet system.

## Prerequisites

- [ ] Bun installed and skills repo available (`bun --version`)
- [ ] Master password decided (min 8 characters, not reused from wallet)

## Steps

### 1. Verify the Store is Empty

Check that no credentials exist yet (or review what is already stored).

```bash
bun run credentials/cli.ts list
```

Expected output: `count: 0, credentials: []` on a fresh install. If credentials already exist, review before adding duplicates.

### 2. Add the Hiro API Key

Store the Hiro API key for use by the `query`, `stx`, and other network skills.

```bash
bun run credentials/cli.ts add \
  --id hiro-api-key \
  --value "your_hiro_api_key_here" \
  --password $CRED_PASS \
  --label "Hiro API Key" \
  --category api-key
```

Expected output: `success: true`, `id: "hiro-api-key"`, `category: "api-key"`.

> Note: Obtain a Hiro API key at https://platform.hiro.so. Set `CRED_PASS` in your shell environment rather than typing the password inline.

### 3. Verify the Credential Was Stored

Confirm the credential is retrievable by decrypting it.

```bash
bun run credentials/cli.ts get --id hiro-api-key --password $CRED_PASS
```

Expected output: JSON with `value` equal to the API key you stored. If decryption fails, the password was wrong or the value was not stored.

### 4. List All Stored Credentials

Review the credential inventory (metadata only — no decrypted values shown).

```bash
bun run credentials/cli.ts list
```

Expected output: `count: 1` (or more if you added additional credentials), with each entry showing `id`, `label`, `category`, and timestamps.

### 5. Optional: Add Additional Credentials

Repeat the `add` command for each additional secret your workflows need.

```bash
# Example: store an OpenRouter token
bun run credentials/cli.ts add \
  --id openrouter-token \
  --value "sk-or-..." \
  --password $CRED_PASS \
  --label "OpenRouter API Token" \
  --category token
```

Expected output: `success: true` for each credential added.

> Note: To rotate the master password later, use `bun run credentials/cli.ts rotate-password --old-password $OLD_PASS --new-password $NEW_PASS`.

## Verification

At the end of this workflow, verify:
- [ ] `list` returns at least one credential with correct `id` and `category`
- [ ] `get` successfully decrypts and returns the stored value
- [ ] `~/.aibtc/credentials.json` exists and contains no plaintext secret values (only encrypted blobs)

## Related Skills

| Skill | Used For |
|-------|---------|
| `credentials` | Storing and retrieving encrypted secrets |

## See Also

- [1. Register and Check In](./1-register-and-check-in.md)
- [5. Check Balances and Status](./5-check-balances-and-status.md)
