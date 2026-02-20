---
name: wallet
description: Manage encrypted BIP39 wallets stored at ~/.aibtc/. Create, import, unlock, lock, list, switch, delete, export, rotate passwords, set auto-lock timeouts, and check status or info for Stacks and Bitcoin addresses.
user-invocable: false
arguments: create | import | unlock | lock | list | switch | delete | export | rotate-password | set-timeout | status | info | stx-balance
entry: wallet/wallet.ts
requires: []
tags: [infrastructure, sensitive]
---

# Wallet Skill

Manages encrypted BIP39 wallets stored locally at `~/.aibtc/`. Provides full lifecycle operations for Stacks L2 and Bitcoin L1 (native SegWit + Taproot) addresses. Wallets are AES-GCM encrypted with a password and never stored in plaintext.

## Usage

```
bun run wallet/wallet.ts <subcommand> [options]
```

## Subcommands

### create

Create a new wallet with a generated 24-word BIP39 mnemonic.

```
bun run wallet/wallet.ts create --name <name> --password <password> [--network mainnet|testnet]
```

Options:
- `--name` (required) — Label for the wallet (e.g. "main", "trading")
- `--password` (required, min 8 chars) — Encryption password (sensitive)
- `--network` (optional) — `mainnet` or `testnet` (default: `testnet`)

Output:
```json
{
  "success": true,
  "walletId": "...",
  "Bitcoin (L1)": { "Native SegWit": "bc1q...", "Taproot": "bc1p..." },
  "Stacks (L2)": { "Address": "SP..." },
  "network": "testnet",
  "mnemonic": "word1 word2 ... word24",
  "warning": "CRITICAL: Save this mnemonic..."
}
```

### import

Import an existing wallet from a BIP39 mnemonic phrase.

```
bun run wallet/wallet.ts import --name <name> --mnemonic "<24 words>" --password <password> [--network mainnet|testnet]
```

Options:
- `--name` (required) — Label for the wallet
- `--mnemonic` (required) — 24-word BIP39 mnemonic (sensitive)
- `--password` (required, min 8 chars) — Encryption password (sensitive)
- `--network` (optional) — `mainnet` or `testnet` (default: `testnet`)

Output:
```json
{
  "success": true,
  "walletId": "...",
  "Bitcoin (L1)": { "Native SegWit": "bc1q...", "Taproot": "bc1p..." },
  "Stacks (L2)": { "Address": "SP..." },
  "network": "testnet"
}
```

### unlock

Unlock a wallet to enable transactions. Session persists in-process memory until locked or timeout.

```
bun run wallet/wallet.ts unlock --password <password> [--wallet-id <id>]
```

Options:
- `--password` (required) — Wallet password (sensitive)
- `--wallet-id` (optional) — Wallet ID to unlock (uses active wallet if omitted)

Output:
```json
{
  "success": true,
  "walletId": "...",
  "Bitcoin (L1)": { "Native SegWit": "bc1q...", "Taproot": "bc1p..." },
  "Stacks (L2)": { "Address": "SP..." },
  "network": "testnet"
}
```

### lock

Lock the wallet, clearing sensitive key material from memory.

```
bun run wallet/wallet.ts lock
```

Output:
```json
{ "success": true, "message": "Wallet is now locked." }
```

### list

List all available wallets with metadata (no sensitive data).

```
bun run wallet/wallet.ts list
```

Output:
```json
{
  "wallets": [
    {
      "id": "...",
      "name": "main",
      "btcAddress": "bc1q...",
      "address": "SP...",
      "network": "testnet",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "isActive": true,
      "isUnlocked": false
    }
  ],
  "totalCount": 1
}
```

### switch

Switch the active wallet (requires unlock after switching).

```
bun run wallet/wallet.ts switch --wallet-id <id>
```

Options:
- `--wallet-id` (required) — Wallet ID to activate

Output:
```json
{
  "success": true,
  "activeWalletId": "...",
  "address": "SP...",
  "network": "testnet"
}
```

### delete

Permanently delete a wallet (requires password + confirmation).

```
bun run wallet/wallet.ts delete --wallet-id <id> --password <password> --confirm DELETE
```

Options:
- `--wallet-id` (required) — Wallet ID to delete
- `--password` (required) — Wallet password for verification (sensitive)
- `--confirm` (required) — Must be exactly `DELETE`

Output:
```json
{
  "success": true,
  "deletedWalletId": "...",
  "message": "Wallet deleted permanently."
}
```

### export

Export the mnemonic phrase for a wallet (requires password + safety acknowledgment).

```
bun run wallet/wallet.ts export --password <password> --confirm I_UNDERSTAND_THE_RISKS [--wallet-id <id>]
```

Options:
- `--password` (required) — Wallet password (sensitive)
- `--confirm` (required) — Must be exactly `I_UNDERSTAND_THE_RISKS`
- `--wallet-id` (optional) — Wallet ID (uses active wallet if omitted)

Output:
```json
{
  "walletId": "...",
  "mnemonic": "word1 word2 ... word24",
  "warning": "SECURITY WARNING: ..."
}
```

### rotate-password

Change the wallet encryption password (atomic with backup/verify/rollback).

```
bun run wallet/wallet.ts rotate-password --old-password <pass> --new-password <pass> [--wallet-id <id>]
```

Options:
- `--old-password` (required) — Current password (sensitive)
- `--new-password` (required, min 8 chars) — New password (sensitive)
- `--wallet-id` (optional) — Wallet ID (uses active wallet if omitted)

Output:
```json
{
  "success": true,
  "walletId": "...",
  "message": "Password rotated. Use unlock with the new password."
}
```

### set-timeout

Set the auto-lock timeout in minutes (0 = never auto-lock).

```
bun run wallet/wallet.ts set-timeout --minutes <n>
```

Options:
- `--minutes` (required) — Minutes until auto-lock (0 = disabled)

Output:
```json
{
  "success": true,
  "autoLockMinutes": 15,
  "message": "Auto-lock set to 15 minutes."
}
```

### status

Get wallet readiness status: whether a wallet exists, is active, and is unlocked.

```
bun run wallet/wallet.ts status
```

Output:
```json
{
  "message": "Wallet is locked. Unlock to perform transactions.",
  "readyForTransactions": false,
  "isUnlocked": false,
  "currentNetwork": "testnet",
  "wallet": { "id": "...", "address": "SP...", "btcAddress": "bc1q..." }
}
```

### info

Get the active wallet's address and session info.

```
bun run wallet/wallet.ts info
```

Output:
```json
{
  "status": "ready",
  "network": "testnet",
  "Stacks (L2)": { "Address": "SP..." },
  "Bitcoin (L1)": { "Native SegWit": "bc1q...", "Taproot": "bc1p..." }
}
```

### stx-balance

Get the STX balance for a wallet address.

```
bun run wallet/wallet.ts stx-balance [--address <addr>]
```

Options:
- `--address` (optional) — Stacks address to check (uses active wallet if omitted)

Output:
```json
{
  "address": "SP...",
  "network": "testnet",
  "balance": { "stx": "100 STX", "microStx": "100000000" },
  "locked": { "stx": "0 STX", "microStx": "0" }
}
```

## Security Notes

- Mnemonics are AES-GCM encrypted before being written to disk
- Passwords never appear in stored files
- Use `lock` after sensitive operations to clear keys from memory
- `export` and `delete` require explicit confirmation strings to prevent accidents
- `rotate-password` is atomic: original keystore is backed up and restored on failure
