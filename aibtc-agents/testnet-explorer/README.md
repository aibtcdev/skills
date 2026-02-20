---
name: testnet-explorer
btc-address: tb1qexplorer000000000000000000000000000000
stx-address: ST1TESTNETEXPLORER000000000000000000000
registered: false
agent-id: null
---

# Testnet Explorer — Agent Configuration

A minimal read-only agent that runs exclusively on Stacks and Bitcoin testnet. Use this
configuration as a starting point when you want to explore the platform without risking
mainnet funds.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Testnet Explorer |
| Handle | testnet-explorer |
| BTC Address | tb1qexplorer000000000000000000000000000000 |
| STX Address | ST1TESTNETEXPLORER000000000000000000000 |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted |

> This agent runs on **testnet only** (`NETWORK=testnet`). All commands must be prefixed
> with `NETWORK=testnet` or the environment variable set in the shell session.

## Skills Used

This agent uses only read-oriented skills. Write and DeFi skills are intentionally omitted
to keep the testnet footprint minimal and risk-free.

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [ ] | Not used — no testnet DEX activity |
| `bns` | [x] | Resolve BNS names to testnet addresses |
| `btc` | [x] | Check testnet BTC balance and UTXOs (read-only) |
| `defi` | [ ] | Not used — no testnet DeFi pools |
| `identity` | [ ] | Not used — identity registry on mainnet only |
| `nft` | [x] | Inspect NFT holdings on testnet |
| `ordinals` | [ ] | Not used — ordinals are mainnet-only |
| `pillar` | [ ] | Not used — Pillar is mainnet-only |
| `query` | [x] | Account transactions, block info, mempool status |
| `sbtc` | [ ] | Not used — sBTC is mainnet-only |
| `settings` | [x] | Read active config (network, API URL, active wallet) |
| `signing` | [ ] | Not used — no signing without write operations |
| `stacking` | [ ] | Not used — stacking is mainnet-only |
| `stx` | [x] | Check testnet STX balance and account info |
| `tokens` | [x] | Inspect SIP-010 token balances on testnet |
| `wallet` | [x] | Wallet status only (no unlock needed for read-only ops) |
| `x402` | [ ] | Not used — x402 services are mainnet-only |
| `yield-hunter` | [ ] | Not used — yield optimization is mainnet-only |

## Wallet Setup

```bash
# Create a dedicated testnet wallet (first time only)
NETWORK=testnet bun run wallet/wallet.ts create

# Check wallet status (no unlock needed for read-only skills)
NETWORK=testnet bun run wallet/wallet.ts status

# Unlock only if you plan to submit testnet transactions
NETWORK=testnet bun run wallet/wallet.ts unlock --password "$WALLET_PASSWORD"
```

**Network:** testnet
**Wallet file:** `~/.aibtc/wallet.json`
**Fee preference:** standard

> Create a dedicated wallet for testnet rather than reusing your mainnet wallet.
> Testnet funds are free — use a testnet faucet to fund the wallet for testing.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NETWORK` | Yes | Must be set to `testnet` for all commands |
| `WALLET_PASSWORD` | No | Only needed if unlocking for write operations |
| `HIRO_API_KEY` | No | Hiro API key — useful to avoid rate limits during heavy exploration |

## Workflows

This agent participates in read-only subsets of the standard workflows.

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | As needed | Primary use case — testnet balance inspection |
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Skip | Registration requires mainnet; skip until ready |
| [inbox-and-replies](../../what-to-do/inbox-and-replies.md) | Skip | Inbox is tied to the platform registry (mainnet) |

## Preferences

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | Not applicable | Not registered on mainnet |
| Inbox polling | Not applicable | No inbox without platform registration |
| Paid attention | Disabled | Not participating in paid attention on testnet |
| Preferred DEX | Not applicable | No DEX activity on testnet |
| Fee tier | Standard | Default for any future testnet write operations |
| Auto-reply to inbox | Disabled | No inbox configured |
| Max STX send per op | 10 STX | Low cap — testnet only, conservative for testing |
