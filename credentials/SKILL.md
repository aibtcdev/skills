---
name: credentials
description: Encrypted credential store — add, retrieve, list, and delete named secrets (API keys, tokens, passwords) stored AES-256-GCM encrypted at ~/.aibtc/credentials.json. Each write operation requires the master password; listing metadata does not.
user-invocable: false
arguments: add | get | list | delete | rotate-password
category: wallet-keys
requires: []
tags: [has-read-ops, has-write-ops]
entry-point: cli.ts
---

# Credentials Skill

Manages arbitrary named secrets — API keys, tokens, passwords, URLs — encrypted at rest using AES-256-GCM with per-credential PBKDF2 key derivation. Values are stored as encrypted blobs in `~/.aibtc/credentials.json`; only identifiers, labels, categories, and timestamps are stored in plaintext. No wallet is required — the credential store uses its own master password independent of the wallet system.

## Usage

```
bun run credentials/cli.ts <subcommand> [options]
```

## Subcommands

### add

Add a new credential or update an existing one. The value is encrypted with AES-256-GCM using a key derived from the master password via PBKDF2 (100,000 iterations, per-credential salt).

```
bun run credentials/cli.ts add --id <id> --value <value> --password <pass> [--label <text>] [--category <cat>]
```

Options:
- `--id` (required) — Normalized credential identifier (e.g. `hiro-api-key`, `openrouter-token`)
- `--value` (required) — Plaintext secret value (sensitive — not stored)
- `--password` (required) — Master password for encryption (sensitive)
- `--label` (optional) — Human-readable label (default: same as id)
- `--category` (optional) — Category tag such as `api-key`, `token`, `url`, or `secret` (default: `secret`)

Output:
```json
{
  "success": true,
  "id": "hiro-api-key",
  "label": "Hiro API Key",
  "category": "api-key",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

### get

Decrypt and return a credential value. The plaintext value appears in the output — handle with care.

```
bun run credentials/cli.ts get --id <id> --password <pass>
```

Options:
- `--id` (required) — Credential identifier
- `--password` (required) — Master password for decryption (sensitive)

Output:
```json
{
  "id": "hiro-api-key",
  "label": "Hiro API Key",
  "category": "api-key",
  "value": "hiro_api_key_xxxxxxxxxxxxxxxx",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

> Tip: Extract the value in scripts with `$(bun run credentials/cli.ts get --id hiro-api-key --password $CRED_PASS | jq -r .value)`

### list

List all credential identifiers and metadata. No decryption is performed and no secret values are returned.

```
bun run credentials/cli.ts list
```

Output:
```json
{
  "count": 2,
  "credentials": [
    {
      "id": "hiro-api-key",
      "label": "Hiro API Key",
      "category": "api-key",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### delete

Permanently delete a credential. Requires the master password (to verify ownership) and an explicit confirmation string.

```
bun run credentials/cli.ts delete --id <id> --password <pass> --confirm DELETE
```

Options:
- `--id` (required) — Credential identifier to delete
- `--password` (required) — Master password for verification (sensitive)
- `--confirm` (required) — Must be exactly `DELETE`

Output:
```json
{
  "success": true,
  "deleted": "hiro-api-key",
  "message": "Credential \"hiro-api-key\" has been permanently deleted."
}
```

### rotate-password

Change the master password by atomically re-encrypting all credentials. Decrypts every credential with the old password and re-encrypts with the new one. If any credential fails to decrypt, the operation is aborted before any changes are written.

```
bun run credentials/cli.ts rotate-password --old-password <pass> --new-password <pass>
```

Options:
- `--old-password` (required) — Current master password (sensitive)
- `--new-password` (required, min 8 chars) — New master password (sensitive)

Output:
```json
{
  "success": true,
  "message": "Password rotated. 3 credentials re-encrypted.",
  "count": 3
}
```

## Security Notes

- Credentials are AES-256-GCM encrypted with a unique salt and IV per credential — a compromised credential does not weaken others
- PBKDF2-SHA256 with 100,000 iterations makes brute-force attacks expensive
- The master password is never written to disk — pass it via `--password` flag or environment variable substitution
- `~/.aibtc/credentials.json` is written with mode 0o600 (owner read/write only)
- The credential store is independent of the wallet system — a separate master password is recommended
- `delete` and `rotate-password` verify the password by decrypting before mutating the store
