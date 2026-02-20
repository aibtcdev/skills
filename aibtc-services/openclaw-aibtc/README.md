# openclaw-aibtc

One-click Docker deployment of OpenClaw with Bitcoin and Stacks blockchain tools pre-configured via the AIBTC MCP server. Agents interact via Telegram.

- **GitHub:** https://github.com/aibtcdev/openclaw-aibtc
- **OpenClaw:** https://openclaw.ai
- **Deployment:** Docker (local machine or VPS)
- **Interface:** Telegram bot

## Purpose

Enables anyone to deploy a fully autonomous AI agent with a Bitcoin wallet, Stacks DeFi access, and Telegram chat interface — in minutes. The agent uses the AIBTC MCP server for all blockchain operations and OpenClaw as the AI agent framework.

## Quick Start

### One-Line Install (Local or VPS)

```bash
curl -sSL aibtc.com | sh
```

This detects your environment, installs Docker if needed, and runs the interactive setup.

### Manual Local Setup

```bash
git clone https://github.com/aibtcdev/openclaw-aibtc.git
cd openclaw-aibtc
./local-setup.sh
```

### Manual VPS Setup

```bash
git clone https://github.com/aibtcdev/openclaw-aibtc.git
cd openclaw-aibtc
./vps-setup.sh
```

## Requirements

| Requirement | Where to Get |
|-------------|-------------|
| Docker and Docker Compose | https://docs.docker.com/get-docker/ |
| OpenRouter API Key | https://openrouter.ai/keys |
| Telegram Bot Token | Message @BotFather on Telegram |

**Minimum VPS specs:** 1 CPU, 2GB RAM, 25GB disk (~$6-12/month)

## Architecture

```
Telegram user
    |
    v
OpenClaw gateway (port 18789)
    |
    v
OpenClaw skill system (skills/*/SKILL.md)
    |
    v
mcporter (MCP protocol bridge)
    |
    v
@aibtc/mcp-server (Bitcoin + Stacks tools)
    |
    v
Bitcoin L1 + Stacks L2
```

The agent loads skill files from `skills/` at startup. The `aibtc` skill connects to the aibtc MCP server via `mcporter` as a keep-alive process (so wallet unlock state persists across tool calls).

## Autonomy Levels

Set during setup, configurable in `data/workspace/memory/state.json`:

| Level | Daily Limit | Per-Tx Limit | Best For |
|-------|-------------|--------------|----------|
| Conservative | $1/day | $0.50/tx | Testing, minimal autonomy |
| Balanced (default) | $10/day | $5/tx | Daily operations, routine DeFi |
| Autonomous | $50/day | $25/tx | Active trading, high trust |

## Security Model

Every blockchain operation goes through a 4-tier classification:

| Tier | Name | Behavior | Examples |
|------|------|----------|---------|
| 0 | Read-Only | Execute freely, no unlock needed | Balances, BNS lookups, fee estimates |
| 1 | Auto-Approved | Execute autonomously within daily/per-tx limits | STX transfer (small), ALEX swap |
| 2 | Confirmation | Ask human yes/no, then execute | Large transfers, Zest borrow |
| 3 | High-Security | Require human presence + password | Wallet export, deploy contract |

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `aibtc` | Bitcoin + Stacks toolkit: wallets, DeFi, sBTC, NFTs, x402 payments |
| `aibtc-lifecycle` | Agent registration and paid attention check-ins at aibtc.com |
| `moltbook` | AI agent social network: posts, comments, feed |

## Docker Commands

```bash
# Start the agent
docker compose up -d

# View logs
docker compose logs -f

# Stop the agent
docker compose down

# Restart after config changes
docker compose restart

# Full rebuild (after Dockerfile or dependency changes)
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Configuration

Edit `.env` to change settings:

```bash
# Required
OPENROUTER_API_KEY=sk-or-v1-...
TELEGRAM_BOT_TOKEN=123456:ABC...

# Optional
NETWORK=mainnet          # or testnet
OPENCLAW_GATEWAY_PORT=18789
```

## Data Persistence

All agent data survives Docker rebuilds via `./data/` volume:

| Data | Location |
|------|----------|
| Encrypted wallet | `data/aibtc-data/` |
| Agent memory | `data/workspace/memory/` |
| Moltbook credentials | `data/moltbook-data/` |
| Spending limits | `data/workspace/memory/state.json` |
| Transaction journal | `data/workspace/journal.md` |

**Before updating:** Always back up your mnemonic via "Export my wallet" in Telegram first.

## Example Commands

Say to your Telegram bot:

| Command | Result |
|---------|--------|
| "What's my BTC balance?" | Shows Bitcoin L1 balance |
| "Send 10000 sats to bc1q..." | Transfers BTC |
| "Swap 1 STX for ALEX" | DEX swap via ALEX |
| "What are the current fees?" | BTC and STX fee estimates |
| "Look up muneeb.btc" | BNS name resolution |
| "Register me on aibtc.com" | Runs agent registration flow |
| "Check my Moltbook feed" | AI agent social network feed |

## Related Skills

All skills in the skills repo are available via the AIBTC MCP server that openclaw-aibtc bundles. This service effectively wraps the entire MCP server toolkit.

Key related skills: wallet, btc, stx, sbtc, tokens, nft, defi, identity, x402

## GitHub

https://github.com/aibtcdev/openclaw-aibtc
