---
name: pillar-agent
skill: pillar
description: Pillar smart wallet operations in two modes — browser-handoff (pillar.ts) for user-signed operations via the Pillar frontend, and agent-signed direct (pillar-direct.ts) for fully autonomous gas-sponsored operations with a local secp256k1 keypair.
---

# Pillar Agent

This agent manages Pillar smart wallet operations across two distinct modes. Browser-handoff mode (`pillar.ts`) opens the Pillar frontend for the user to sign — requires the user to be logged in at pillarbtc.com. Direct mode (`pillar-direct.ts`) generates and manages a local secp256k1 signing keypair, signs SIP-018 structured data locally, and submits directly to the Pillar backend API with gas sponsored — no browser required. All financial operations are Stacks mainnet only.

## Prerequisites

- For browser-handoff mode: user must be logged into pillarbtc.com; run `pillar.ts connect` before any operation
- For direct mode: a signing key must exist; run `pillar-direct.ts direct-create-wallet` or `key-generate` first
- For direct mode: signing keys auto-unlock on first use. The password is derived from `PILLAR_API_KEY` when set, otherwise from a random per-machine secret in `~/.aibtc/pillar-signing-secret` (created on first use; keep it with `~/.aibtc/signing-keys` — without it those keys can't be unlocked). Keys from older releases, encrypted under a public default, are re-encrypted under the current password the first time they unlock.
- Session file stored at `~/.aibtc/pillar-session.json`; signing keys at `~/.aibtc/signing-keys/`
- All direct-mode financial operations require mainnet (`NETWORK=mainnet`)

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Connect browser session | `pillar.ts connect` — opens browser, saves wallet address |
| Check connection status | `pillar.ts status` — returns connected wallet address |
| Send sBTC (browser-signed) | `pillar.ts send --to <recipient> --amount <sats>` |
| View balances (browser mode) | `pillar.ts position` — opens browser and returns balance data |
| Set up DCA schedule (browser) | `pillar.ts boost --amount <sats>` — amounts >100k sats enter DCA mode |
| Create a new direct-mode wallet | `pillar-direct.ts direct-create-wallet --wallet-name <name>` |
| Generate a signing key | `pillar-direct.ts key-generate` |
| Check signing key status | `pillar-direct.ts key-info` |
| View balances (direct mode) | `pillar-direct.ts direct-position` |
| Supply sBTC to Zest (direct) | `pillar-direct.ts direct-supply --sbtc-amount <sats>` |
| Create leveraged sBTC position | `pillar-direct.ts direct-boost --sbtc-amount <sats> --aeusdc-to-borrow <amount> --min-sbtc-from-swap <sats>` |
| Close leveraged position | `pillar-direct.ts direct-unwind --sbtc-to-swap <sats> --sbtc-to-withdraw <sats> --min-aeusdc-from-swap <amount>` |
| Get boost quote before boosting | `pillar-direct.ts direct-quote --sbtc-amount <sats>` |
| Stack STX via fast pool | `pillar-direct.ts direct-stack-stx --stx-amount <microStx> --pool fast-pool` |
| Check stacking status | `pillar-direct.ts direct-stacking-status` |
| Send sBTC (direct mode) | `pillar-direct.ts direct-send --to <recipient> --amount <sats>` |

## Safety Checks

- For `direct-boost`: always run `direct-quote` first to get `aeUsdcToBorrow` and `minSbtcFromSwap` values
- For `direct-boost`/`direct-unwind`: set `--min-sbtc-from-swap`/`--min-aeusdc-from-swap` for slippage protection
- For `direct-unwind`: check `direct-position` first — `zestPosition.borrowedAeUsdc` determines repayment amount
- For `direct-send`: resolve recipient first with `direct-resolve-recipient` to confirm address before sending
- Leveraged positions have liquidation risk — monitor collateral ratio via `direct-position`
- For `direct-stack-stx`: STX stays locked until the current PoX cycle ends after `direct-revoke-fast-pool`
- Browser operations time out after 5 minutes (override with `PILLAR_POLL_TIMEOUT_MS` env var)

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Not connected to Pillar. Please use 'connect' first." | No session file found | Run `pillar.ts connect` and complete browser flow |
| "No signing key found. Use 'direct-create-wallet' to create one." | No key at `~/.aibtc/signing-keys/` | Run `direct-create-wallet` or `key-generate` |
| "Signing key locked and auto-unlock failed." | The key was stored under a different secret (another `PILLAR_API_KEY`, or a missing `~/.aibtc/pillar-signing-secret`) | Set the `PILLAR_API_KEY` the key was created with, or restore `~/.aibtc/pillar-signing-secret` |
| "Pillar Direct tools are only available on mainnet" | Running on testnet | Set `NETWORK=mainnet` env var |
| "Wallet name ... is not available." | Name already taken or invalid format | Choose a unique name (3-20 chars, lowercase, numbers, hyphens) |
| "Timed out waiting for ..." | Browser flow not completed within timeout | Retry or extend timeout with `PILLAR_POLL_TIMEOUT_MS` |

## Output Handling

- `pillar.ts connect`: `walletAddress` is saved to session; feed into subsequent browser operations automatically
- `pillar-direct.ts direct-position`: `balances.sbtcSats` and `zestPosition.collateralSats` are key fields for deciding boost/unwind
- `pillar-direct.ts direct-quote`: use `quote.aeUsdcToBorrow` and `quote.minSbtcFromSwap` directly in `direct-boost`
- `pillar-direct.ts direct-create-wallet`: `contractAddress` is the smart wallet address for all direct operations
- All write operations return `txId` and `explorerUrl` — the backend sponsors gas so no STX fee is needed

## Example Invocations

```bash
# Check current Pillar position (browser-handoff mode)
bun run pillar/pillar.ts status

# Get boost quote before creating a leveraged position
bun run pillar/pillar-direct.ts direct-quote --sbtc-amount 100000

# Supply sBTC directly via agent-signed mode (no browser needed)
bun run pillar/pillar-direct.ts direct-supply --sbtc-amount 100000
```
