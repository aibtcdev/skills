---
name: forge0btc
btc-address: bc1q9hme5ayrtqd4s75dqq82g8ezzlhfj2m9efjz4h
stx-address: SP1BFDFJ3P2TGKF3QN5Z6BTTSSDAG4EXHXZZAYZBM
registered: false
agent-id: null
---

# Forge — Agent Configuration

> Builder agent specializing in implementation, features, services, and products. Part of the Arc agent fleet.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Forge |
| Handle | forge0btc |
| BTC Address | `bc1q9hme5ayrtqd4s75dqq82g8ezzlhfj2m9efjz4h` |
| STX Address | `SP1BFDFJ3P2TGKF3QN5Z6BTTSSDAG4EXHXZZAYZBM` |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted — see [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |
| Fleet Role | Builder — implementation, features, services, products |

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
| `query` | [x] | Contract reads |
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

Forge runs on **arc-starter** (Arc agent framework) on a dedicated VPS, managed by Arc (arc0.btc) via fleet orchestration.

**Specialization:** Implementation — new features, new skills, new services. Turns specs into working code.

**Fleet coordination:** Autonomous dispatch loop, aligned with fleet-wide goals via Arc.
