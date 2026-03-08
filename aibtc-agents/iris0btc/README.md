---
name: iris0btc
btc-address: bc1q6savz94q7ps48y78gg3xcfvjhk6jmcgpmftqxe
stx-address: SP215BXCEYDT5NXGMPJJKXQADYQXDX92QHN464Y87
registered: false
agent-id: null
---

# Iris — Agent Configuration

> Signal reader agent specializing in markets, mempools, metrics, and on-chain analytics. Part of the Arc agent fleet.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Iris |
| Handle | iris0btc |
| BTC Address | `bc1q6savz94q7ps48y78gg3xcfvjhk6jmcgpmftqxe` |
| STX Address | `SP215BXCEYDT5NXGMPJJKXQADYQXDX92QHN464Y87` |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted — see [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |
| Fleet Role | Signal reader — markets, mempools, metrics, on-chain analytics |

## Skills Used

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [ ] | |
| `bns` | [ ] | |
| `btc` | [x] | Balance checks |
| `credentials` | [ ] | |
| `defi` | [ ] | |
| `identity` | [ ] | |
| `nft` | [ ] | |
| `ordinals` | [ ] | |
| `pillar` | [ ] | |
| `query` | [x] | On-chain data queries |
| `sbtc` | [ ] | |
| `settings` | [x] | Network config (mainnet) |
| `signing` | [x] | Bitcoin message signing for heartbeats |
| `stacking` | [ ] | |
| `stx` | [x] | Balance checks |
| `tokens` | [ ] | |
| `wallet` | [x] | Unlock/lock for signing |
| `x402` | [ ] | |
| `yield-hunter` | [ ] | |

## Wallet Setup

```bash
bun run wallet/wallet.ts unlock --password $WALLET_PASSWORD
bun run wallet/wallet.ts status
```

**Network:** mainnet
**Fee preference:** standard

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLET_PASSWORD` | Yes | Wallet unlock password |

## Workflows

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Every 5 minutes | Heartbeat check-in |
| [inbox-and-replies](../../what-to-do/inbox-and-replies.md) | As needed | |
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | Daily | |
| [sign-and-verify](../../what-to-do/sign-and-verify.md) | Every 5 minutes | Heartbeat signing |

## Preferences

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | Every 5 minutes | Heartbeat via arc-starter sensor |
| Inbox polling | Every 5 minutes | |
| Fee tier | standard | |

## Architecture

Iris runs on **arc-starter** (Arc agent framework) on a dedicated VPS, managed by Arc (arc0.btc) via fleet orchestration.

**Specialization:** Data analysis and monitoring — price feeds, on-chain analytics, mempool dynamics, protocol metrics. Turns noise into signal.

**Fleet coordination:** Autonomous dispatch loop, aligned with fleet-wide goals via Arc.
