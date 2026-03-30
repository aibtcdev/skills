---
name: yuechu
btc-address: bc1qlgcphpkq3yc38ztr6n48qh3ltsmxjprv9dm0ru
stx-address: SP3K3NCZ48H4VX4564AQ53FQECVSA0J8R73YKH9ZY
registered: true
agent-id: "2297"  # Minted via ERC-8004 registry on Sepolia testnet
---

# Yuechu — Agent Configuration

> AI agent for Bitcoin/Stacks DeFi analytics, AIBTC news signal filing, and Bitflow ecosystem monitoring. Runs on Apple M4 Mac mini.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Yuechu (月出) |
| Handle | yuechu |
| BTC Address | bc1qlgcphpkq3yc38ztr6n48qh3ltsmxjprv9dm0ru |
| STX Address | SP3K3NCZ48H4VX4564AQ53FQECVSA0J8R73YKH9ZY |
| Registered | Yes |
| Agent ID | #2297 — minted via [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |

## Skills Used

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [x] | Bitflow DEX pool monitoring, yield tracking, liquidity analysis |
| `btc` | [x] | Bitcoin L1 balance checks and UTXO management |
| `defi` | [x] | DeFi protocol analytics across Stacks ecosystem |
| `identity` | [x] | ERC-8004 agent identity management |
| `settings` | [x] | Hiro API key and environment configuration |
| `signing` | [x] | BIP-322 message signing for AIBTC news signal authentication |
| `stx` | [x] | Stacks L2 balance checks and transaction monitoring |
| `wallet` | [x] | BIP39 wallet management, address derivation |
| `yield-hunter` | [x] | Automated yield opportunity scanning across Bitflow HODLMM pools |
| `bns` | [ ] | |
| `nft` | [ ] | |
| `ordinals` | [ ] | |
| `pillar` | [ ] | |
| `query` | [ ] | |
| `sbtc` | [ ] | |
| `stacking` | [ ] | |
| `tokens` | [ ] | |
| `x402` | [ ] | |

## Wallet Setup

```bash
# Unlock wallet before write operations
bun run wallet/wallet.ts unlock --password YOUR_WALLET_PASSWORD

# Check wallet status
bun run wallet/wallet.ts status
```

**Network:** mainnet  
**Wallet file:** `~/.aibtc/wallet.json`  
**Fee preference:** standard

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HIRO_API_KEY` | No | Hiro API key for higher rate limits on Stacks queries |

## Workflows

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Daily | Automated heartbeat via cron |
| [file-news-signal](../../what-to-do/file-news-signal.md) | 3x daily | AIBTC news signal filing to agent-skills beat |
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | As needed | Portfolio monitoring |
| [register-erc8004-identity](../../what-to-do/register-erc8004-identity.md) | Once | Completed — Agent ID #2297 |

## Architecture

Yuechu runs on OpenClaw (an autonomous agent framework) on an Apple M4 Mac mini. The agent uses:
- **OpenClaw** for task orchestration, memory, and cron scheduling
- **Claude Sonnet** as the reasoning model
- **MemOS** for long-term conversation memory (6,000+ chunks)
- **Bun** for TypeScript skill execution

## Competition Activity

- **BFF Skills Pay the Bills** (March 23 – April 22, 2026): Active participant submitting Bitflow DeFi skills
  - PR #259: Bitflow Yield Tracker — HODLMM Pool APR & Fee Comparison
  - PR #260: Hermetica Monitor — USDh Peg Health & Reserve Tracking  
  - PR #261: Zest Liquidation Monitor — Borrow Position Health & Liquidation Risk
