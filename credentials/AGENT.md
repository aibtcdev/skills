---
name: credentials-agent
skill: credentials
description: Manages AES-256-GCM encrypted secrets — add, retrieve, list, delete, and rotate named credentials stored at ~/.aibtc/credentials.json.
---

# Credentials Agent

This agent manages the encrypted credential store for the AIBTC skill suite. It stores and retrieves arbitrary named secrets — API keys, tokens, passwords, and URLs — encrypted at rest with AES-256-GCM and per-credential PBKDF2 key derivation. No wallet is required; the store uses its own master password. Use this agent to seed credentials before running workflows that depend on external API keys.

## Capabilities

- Add or update encrypted credentials with a custom label and category — requires master password
- Retrieve and decrypt a credential value for use in scripts or other skill invocations — requires master password
- List all credential identifiers and metadata without decryption — no password needed
- Delete credentials permanently after password verification and explicit confirmation
- Rotate the master password, atomically re-encrypting all credentials

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Store a new API key, token, or secret before other skills can use it
- Retrieve an encrypted credential value to pass to another skill (e.g., Hiro API key for `query` skill)
- Audit stored credentials by listing IDs and categories
- Change the master password after a security rotation event

## Key Constraints

- Every write operation (add, get, delete, rotate-password) requires the master password — never hardcode it
- The master password is not persisted anywhere — it must be supplied on each command
- The credential store is independent of the wallet system; the two passwords need not match

## Example Invocations

```bash
# Store a Hiro API key encrypted with the master password
bun run credentials/credentials.ts add --id hiro-api-key --value "hiro_abc123" --password $CRED_PASS --label "Hiro API Key" --category api-key

# Retrieve and print the decrypted value
bun run credentials/credentials.ts get --id hiro-api-key --password $CRED_PASS

# List all stored credential IDs (no decryption)
bun run credentials/credentials.ts list
```
