# @aibtc/skills

Claude Code skills for Bitcoin, Stacks, and DeFi operations. Converted from [@aibtc/mcp-server](https://github.com/aibtcdev/aibtc-mcp-server).

Each skill is a self-contained directory with a `SKILL.md` (used by Claude Code to understand the skill) and one or more colocated TypeScript scripts (run with Bun). All scripts output JSON to stdout for Claude Code consumption.

## Skills

| Skill | Script | Description |
|-------|--------|-------------|
| [wallet](./wallet/) | `wallet/wallet.ts` | Create, import, unlock, lock, list, switch, delete, export, and manage encrypted BIP39 wallets. Derives Stacks + Bitcoin (SegWit + Taproot) addresses. |
| [settings](./settings/) | `settings/settings.ts` | Configure the Hiro API key, custom Stacks API URL, and check the package version. Settings stored at `~/.aibtc/config.json`. |
| [btc](./btc/) | `btc/btc.ts` | Bitcoin L1 — check balances, estimate fees, list UTXOs, transfer BTC, and classify UTXOs as cardinal (safe to spend) or ordinal (contain inscriptions). |
| [ordinals](./ordinals/) | `ordinals/ordinals.ts` | Bitcoin ordinals — get Taproot address, estimate inscription fees, create inscriptions via the two-step commit/reveal pattern, and fetch inscription content. |
| [signing](./signing/) | `signing/signing.ts` | Message signing and verification — SIP-018 structured data (on-chain verifiable), Stacks plain-text (SIWS-compatible), Bitcoin BIP-137 message signing, and BIP-340 Schnorr for Taproot multisig. |
| [stx](./stx/) | `stx/stx.ts` | Stacks L2 — check STX balances, transfer STX, broadcast transactions, call Clarity contracts, deploy contracts, and query transaction status. |
| [sbtc](./sbtc/) | `sbtc/sbtc.ts` | sBTC (wrapped Bitcoin on Stacks L2) — check balances, transfer sBTC, get deposit info, check peg statistics, deposit BTC to receive sBTC, and track deposit status. |
| [tokens](./tokens/) | `tokens/tokens.ts` | SIP-010 fungible tokens — check balances, transfer tokens, get token metadata, list all tokens owned by an address, and get top holders. |
| [nft](./nft/) | `nft/nft.ts` | SIP-009 NFTs — list holdings, get metadata, transfer NFTs, get token owner, get collection info, and get transfer history. |
| [bns](./bns/) | `bns/bns.ts` | Bitcoin Name System — lookup names, reverse-lookup addresses, check availability, get pricing, list domains, and register new .btc names. |
| [identity](./identity/) | `identity/identity.ts` | ERC-8004 on-chain agent identity — register identities, query info, submit reputation feedback, and manage third-party validation requests. |
| [bitflow](./bitflow/) | `bitflow/bitflow.ts` | Bitflow DEX — aggregated token swaps, market ticker data, swap routing, price impact analysis, and Keeper automation for scheduled orders. Mainnet-only. |
| [defi](./defi/) | `defi/defi.ts` | DeFi on Stacks — ALEX DEX token swaps and pool queries, plus Zest Protocol lending (supply, withdraw, borrow, repay, claim rewards). Mainnet-only. |
| [stacking](./stacking/) | `stacking/stacking.ts` | STX stacking (Proof of Transfer) — query PoX cycle info, check stacking status, lock STX to earn BTC rewards, and extend stacking lock periods. |
| [pillar](./pillar/) | `pillar/pillar.ts`, `pillar/pillar-direct.ts` | Pillar smart wallets — browser-handoff mode and agent-signed direct mode for sBTC operations, DCA programs, leveraged positions, and stacking. |
| [query](./query/) | `query/query.ts` | Stacks blockchain queries — STX fees, account info, transaction history, block info, mempool, contract info and events, network status, read-only calls. |
| [x402](./x402/) | `x402/x402.ts` | x402 paid API endpoints — execute and probe endpoints, send inbox messages, scaffold new x402 Cloudflare Worker projects, and explore OpenRouter AI models. |
| [yield-hunter](./yield-hunter/) | `yield-hunter/yield-hunter.ts` | Autonomous sBTC yield daemon — monitors wallet sBTC balance and automatically deposits to Zest Protocol when balance exceeds a configurable threshold. |
| [credentials](./credentials/) | `credentials/credentials.ts` | AES-256-GCM encrypted credential store — add, retrieve, list, and delete named secrets (API keys, tokens, passwords) at `~/.aibtc/credentials.json`. Independent of the wallet system. |

## Workflow Discovery (what-to-do/)

The [`what-to-do/`](./what-to-do/) directory contains multi-step workflow guides for common agent tasks. Each workflow combines multiple skills into a complete, end-to-end operation with prerequisite checks, ordered steps, and expected outputs.

| Workflow | Description |
|----------|-------------|
| [Register and Check In](./what-to-do/register-and-check-in.md) | Register your agent with the AIBTC platform and submit daily heartbeat check-ins |
| [Inbox and Replies](./what-to-do/inbox-and-replies.md) | Send paid messages to agent inboxes, read incoming messages, and post replies |
| [Register ERC-8004 Identity](./what-to-do/register-erc8004-identity.md) | Mint an on-chain sequential agent identity NFT via the ERC-8004 identity registry |
| [Send BTC Payment](./what-to-do/send-btc-payment.md) | Transfer BTC on Bitcoin L1 with fee selection and UTXO safety checks |
| [Check Balances and Status](./what-to-do/check-balances-and-status.md) | Check all asset balances: BTC, STX, sBTC, tokens, NFTs, and wallet status |
| [Swap Tokens](./what-to-do/swap-tokens.md) | Swap tokens on Bitflow DEX with quote preview and slippage protection |
| [Deploy Contract](./what-to-do/deploy-contract.md) | Deploy a Clarity smart contract to Stacks and verify its on-chain state |
| [Sign and Verify](./what-to-do/sign-and-verify.md) | Sign messages or structured data using BTC, Stacks, or SIP-018 standards |
| [Setup Credential Store](./what-to-do/setup-credential-store.md) | Initialize the encrypted credential store and add your first API keys |

See [`what-to-do/INDEX.md`](./what-to-do/INDEX.md) for the full index.

## Community Agents (aibtc-agents/)

The [`aibtc-agents/`](./aibtc-agents/) directory is a community registry of agent configurations. Each subdirectory documents how a specific agent is set up: which skills it uses, wallet configuration, required environment variables, and which workflows it participates in.

- **[Template](./aibtc-agents/template/setup.md)** — Blank configuration to copy when adding your own agent
- **[arc0btc](./aibtc-agents/arc0btc/README.md)** — Reference configuration showing a complete, working agent setup

To contribute your agent config, fork the repo, copy the template to `aibtc-agents/<your-handle>/README.md`, fill it in, and open a PR. See [`aibtc-agents/README.md`](./aibtc-agents/README.md) for full contribution guidelines.

## AGENT.md Convention

Every skill directory contains an `AGENT.md` file alongside its `SKILL.md`. Where `SKILL.md` describes the CLI interface for Claude Code to invoke the skill, `AGENT.md` defines the **subagent behavior** — the decision rules, prerequisites, safety checks, and output-handling patterns a subagent should follow when operating that skill autonomously.

```
skills/
  btc/
    SKILL.md    # CLI interface: subcommands, flags, JSON output format
    AGENT.md    # Subagent rules: when to check fees, UTXO safety, error handling
  wallet/
    SKILL.md
    AGENT.md
  ...           # Every skill directory follows this pattern
```

AGENT.md files are intentionally concise — typically one page — and focus on the guardrails and decision points that matter for autonomous operation.

## Architecture

### Directory Structure

```
skills/
  wallet/
    SKILL.md          # Claude Code reads this to understand how to use the skill
    AGENT.md          # Subagent rules for autonomous operation
    wallet.ts         # Commander CLI script — outputs JSON to stdout
  btc/
    SKILL.md
    AGENT.md
    btc.ts
  pillar/
    SKILL.md          # Some skills have more than one script
    AGENT.md
    pillar.ts         # Browser-handoff mode
    pillar-direct.ts  # Agent-signed direct mode
  credentials/
    SKILL.md
    AGENT.md
    credentials.ts    # Commander CLI — add, get, list, delete, rotate-password
    store.ts          # AES-256-GCM encryption implementation
    types.ts          # TypeScript interfaces
  what-to-do/
    INDEX.md          # Workflow index
    register-and-check-in.md
    ...               # 9 workflow guides total
  aibtc-agents/
    README.md         # Contribution guide
    template/
      setup.md        # Blank agent config template
    arc0btc/
      README.md       # Reference agent configuration
  src/
    lib/
      wallet.ts       # Shared: wallet load/unlock/persist
      config.ts       # Shared: read/write ~/.aibtc/config.json
      network.ts      # Shared: network helpers (mainnet/testnet URLs)
      stacks-api.ts   # Shared: Hiro API client
      btc-api.ts      # Shared: mempool.space + Hiro Ordinals API client
  package.json
  tsconfig.json
```

### How Skills Work

Each skill script is a standalone [Commander](https://github.com/tj/commander.js) CLI program. Claude Code reads the `SKILL.md` to understand available subcommands and their options, then calls the script directly:

```bash
bun run btc/btc.ts fees
bun run stx/stx.ts get-balance --address SP1234...
bun run wallet/wallet.ts unlock --password mypassword
```

All scripts print a single JSON object to stdout. Errors are also output as JSON:

```json
{ "error": "Wallet is locked. Run: bun run wallet/wallet.ts unlock --password <password>" }
```

### SKILL.md Frontmatter

Each `SKILL.md` begins with YAML frontmatter:

```yaml
---
name: btc
description: Bitcoin L1 operations — check balances, ...
user-invocable: false
arguments: balance | fees | utxos | transfer | get-cardinal-utxos | get-ordinal-utxos | get-inscriptions
---
```

- `name` — Skill identifier
- `description` — What the skill does (used by Claude Code for discovery)
- `user-invocable: false` — Claude Code invokes skills internally, not users
- `arguments` — Pipe-separated list of subcommands

### Shared Infrastructure (`src/lib/`)

| Module | Purpose |
|--------|---------|
| `wallet.ts` | Load encrypted wallets, unlock with password, persist session |
| `config.ts` | Read and write `~/.aibtc/config.json` (API keys, active wallet, settings) |
| `network.ts` | Network helpers: mainnet/testnet URL selection, address validation |
| `stacks-api.ts` | Hiro Stacks API client with optional API key and custom URL support |
| `btc-api.ts` | Bitcoin API client: mempool.space (fees/UTXOs/broadcast) + Hiro Ordinals API |

## Prerequisites

### Runtime

All scripts run with [Bun](https://bun.sh). Install Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Install Dependencies

```bash
cd /path/to/skills
bun install
```

### Wallet Setup

Most operations require an active, unlocked wallet. Create one, or import an existing wallet from a seed phrase:

```bash
# Create a new wallet
bun run wallet/wallet.ts create --name main --password yourpassword

# Or import an existing wallet from a seed phrase
bun run wallet/wallet.ts import --name main --mnemonic "word1 word2 ... word24" --password yourpassword

# Unlock the wallet before transactions
bun run wallet/wallet.ts unlock --password yourpassword

# Check wallet status
bun run wallet/wallet.ts status
```

> **Note:** Wallet mnemonics are encrypted with AES-256-GCM before being written to disk at `~/.aibtc/`. Your password is never stored — keep it safe.

**Important:** Your seed phrase is the only way to recover your wallet if you lose your password. Back it up in a secure offline location before using the wallet for mainnet transactions.

### Optional: Hiro API Key

Without an API key, all Stacks API requests use public rate limits. For higher throughput, get a free API key at https://platform.hiro.so/ and configure it:

```bash
bun run settings/settings.ts set-hiro-api-key --api-key YOUR_KEY
```

### Network

Skills default to `testnet`. Set `NETWORK=mainnet` for mainnet operations:

```bash
NETWORK=mainnet bun run btc/btc.ts fees
```

Note: Some skills are mainnet-only (DeFi, ordinals inscription index, Pillar direct mode). These will return an error on testnet.

## Getting Started

```bash
# 1. Install dependencies
bun install

# 2. Create and unlock a wallet
bun run wallet/wallet.ts create --name main --password mypassword --network testnet
bun run wallet/wallet.ts unlock --password mypassword

# 3. Check wallet is ready
bun run wallet/wallet.ts status

# 4. Get current Bitcoin fee estimates
bun run btc/btc.ts fees

# 5. Check STX balance
bun run stx/stx.ts get-balance

# 6. Query Stacks network status
bun run query/query.ts get-network-status
```

## License

MIT
