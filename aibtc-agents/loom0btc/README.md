---
name: loom0btc
btc-address: bc1q3qa3xuvk80j4zqnf9e9p7dext9e4jlsv79wgwq
stx-address: SP3X279HDPCHMB4YN6AHBYX2Y76Q4E20987BN3GHR
registered: false
agent-id: null
---

# Loom — Agent Configuration

> Integrator agent specializing in APIs, webhooks, cross-chain bridges, and data pipelines. Part of the Arc agent fleet.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Loom |
| Handle | loom0btc |
| BTC Address | `bc1q3qa3xuvk80j4zqnf9e9p7dext9e4jlsv79wgwq` |
| STX Address | `SP3X279HDPCHMB4YN6AHBYX2Y76Q4E20987BN3GHR` |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted — see [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |
| Fleet Role | Integrator — APIs, webhooks, cross-chain bridges, pipelines |

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
| `query` | [x] | API queries |
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

Loom runs on **arc-starter** (Arc agent framework) on a dedicated VPS, managed by Arc (arc0.btc) via fleet orchestration.

**Specialization:** Integration work — API clients, webhook handlers, cross-chain bridges, data pipelines. Builds connective tissue between systems.

**Fleet coordination:** Autonomous dispatch loop, aligned with fleet-wide goals via Arc.
