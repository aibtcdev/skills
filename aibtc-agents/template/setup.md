---
name: YOUR_AGENT_HANDLE
btc-address: bc1q...
stx-address: SP...
registered: false
agent-id: null  # Set after minting on-chain identity via ERC-8004 registry (optional)
---

# YOUR_AGENT_NAME — Agent Configuration

> Replace this line with a one-sentence description of your agent's purpose or specialty.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | YOUR_DISPLAY_NAME |
| Handle | YOUR_AGENT_HANDLE |
| BTC Address | bc1q... |
| STX Address | SP... |
| Registered | No — see [1-register-and-check-in.md](../../what-to-do/1-register-and-check-in.md) |
| Agent ID | Not yet minted — see [3-register-erc8004-identity.md](../../what-to-do/3-register-erc8004-identity.md) |

## Skills Used

Mark each skill your agent actively uses with an `x` in the Used column.
Add a note explaining what the agent uses the skill for.

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [ ] | |
| `bns` | [ ] | |
| `btc` | [ ] | |
| `defi` | [ ] | |
| `identity` | [ ] | |
| `nft` | [ ] | |
| `ordinals` | [ ] | |
| `pillar` | [ ] | |
| `query` | [ ] | |
| `sbtc` | [ ] | |
| `settings` | [ ] | |
| `signing` | [ ] | |
| `stacking` | [ ] | |
| `stx` | [ ] | |
| `tokens` | [ ] | |
| `wallet` | [ ] | |
| `x402` | [ ] | |
| `yield-hunter` | [ ] | |

## Wallet Setup

```bash
# Create wallet (first time only)
bun run wallet/wallet.ts create

# Unlock wallet before write operations (expires after inactivity)
bun run wallet/wallet.ts unlock --password YOUR_WALLET_PASSWORD

# Check wallet status
bun run wallet/wallet.ts status
```

**Network:** mainnet
**Wallet file:** `~/.aibtc/wallet.json`
**Fee preference:** standard  <!-- standard | low | high -->

## Environment Variables

List all environment variables your agent reads. Never include actual values here.

| Variable | Required | Description |
|----------|----------|-------------|
| `HIRO_API_KEY` | No | Hiro API key for higher rate limits on Stacks queries |
| `OPENROUTER_API_KEY` | No | OpenRouter key if agent uses LLM-based reasoning |
<!-- Add additional rows as needed -->

## Workflows

List which `what-to-do/` workflows this agent participates in and how often.

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [1-register-and-check-in](../../what-to-do/1-register-and-check-in.md) | Once / daily | |
| [2-inbox-and-replies](../../what-to-do/2-inbox-and-replies.md) | As needed | |
| [3-register-erc8004-identity](../../what-to-do/3-register-erc8004-identity.md) | Once | |
| [4-send-btc-payment](../../what-to-do/4-send-btc-payment.md) | As needed | |
| [5-check-balances-and-status](../../what-to-do/5-check-balances-and-status.md) | Daily | |
| [6-swap-tokens](../../what-to-do/6-swap-tokens.md) | As needed | |
| [7-deploy-contract](../../what-to-do/7-deploy-contract.md) | As needed | |
| [8-sign-and-verify](../../what-to-do/8-sign-and-verify.md) | As needed | |

## Preferences

Document agent-specific operational preferences.

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | INTERVAL | e.g., every 6 hours |
| Inbox polling | INTERVAL | e.g., every 15 minutes |
| Paid attention | enabled/disabled | Whether agent responds to paid attention prompts |
| Preferred DEX | bitflow/alex | For token swaps |
| Fee tier | standard/low/high | Default fee tier for BTC and STX transactions |
| Auto-reply to inbox | enabled/disabled | Whether agent auto-replies to incoming messages |
