# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@aibtc/skills` is the core instruction layer for AI agents interacting with Bitcoin and Stacks blockchain services. Each skill is a self-contained directory containing:

- **`SKILL.md`** — YAML frontmatter + documentation that Claude Code reads to understand available subcommands, arguments, and requirements
- **`AGENT.md`** — Autonomous operation rules: decision logic, prerequisites, safety checks, and error-handling patterns for subagent use
- **`<name>.ts`** — Commander CLI script that outputs a single JSON object to stdout

Skills are invoked directly by Claude Code or run manually via Bun. All output is JSON for reliable parsing.

### Repo Layout

```
skills/
  wallet/           # Skill directory (SKILL.md + AGENT.md + wallet.ts)
  btc/
  stx/
  sbtc/
  tokens/
  nft/
  bns/
  identity/
  signing/
  stacking/
  defi/
  bitflow/
  pillar/
  query/
  x402/
  yield-hunter/
  credentials/
  settings/
  what-to-do/       # Multi-step workflow guides (9 guides)
  aibtc-agents/     # Community agent configuration registry
  src/
    lib/                  # Shared infrastructure modules
      services/           # External API + wallet services
        wallet-manager.ts # Wallet load/unlock/persist
        hiro-api.ts       # Hiro Stacks API client
        mempool-api.ts    # mempool.space + Hiro Ordinals API client
      config/             # Network config, contract addresses, Pillar config, other config utilities
      utils/
        storage.ts        # Read/write ~/.aibtc/config.json and local storage
      transactions/       # Transaction builders and helpers
  scripts/
    generate-manifest.ts   # Generates skills.json from SKILL.md frontmatter
    validate-frontmatter.ts # Validates all SKILL.md frontmatter fields
  skills.json       # Auto-generated skill manifest (do not edit manually)
  package.json
  tsconfig.json
```

## Commands

```bash
# Type-check all TypeScript (must pass before committing)
bun run typecheck

# Validate all SKILL.md frontmatter fields
bun run validate

# Regenerate skills.json from SKILL.md files
bun run manifest

# Build shared library to dist/
bun run build
```

### Running Skills

Every skill is a standalone CLI. Invoke any skill directly:

```bash
# Wallet operations
bun run wallet/wallet.ts status
bun run wallet/wallet.ts unlock --password <password>

# Bitcoin L1
bun run btc/btc.ts balance
bun run btc/btc.ts fees
bun run btc/btc.ts transfer --recipient bc1q... --amount 100000 --fee-rate medium

# Stacks L2
bun run stx/stx.ts get-balance
bun run stx/stx.ts deploy-contract --contract-name foo --code-body '(define-public (hello) (ok true))'

# Network prefix for mainnet (default is testnet)
NETWORK=mainnet bun run btc/btc.ts balance
```

All scripts print a single JSON object to stdout. Errors are also JSON:

```json
{ "error": "Wallet is locked. Run: bun run wallet/wallet.ts unlock --password <password>" }
```

## Architecture

### How Skills Work

Claude Code reads `SKILL.md` to discover subcommands and options, then calls the script:

```
Claude Code
    ↓ reads SKILL.md for subcommands/args
    ↓ calls: bun run <skill>/<skill>.ts <subcommand> [--flags]
    ↓ parses JSON stdout
```

Each skill script uses [Commander.js](https://github.com/tj/commander.js) for argument parsing. Every subcommand handler must print exactly one JSON object and exit.

### Shared Infrastructure (`src/lib/`)

| Module | Purpose |
|--------|---------|
| `src/lib/services/wallet-manager.ts` | Load encrypted wallets, unlock with password, persist session to `~/.aibtc/` |
| `src/lib/utils/storage.ts`, `src/lib/config/` | Read and write `~/.aibtc/config.json` (API keys, active wallet, network) |
| `config/networks.ts` | Network URL selection, x402 API base URL, explorer helpers |
| `config/contracts.ts` | Stacks contract addresses for sBTC, identity, and other protocols |
| `src/lib/services/hiro-api.ts` | Hiro Stacks API client with optional API key and custom URL |
| `src/lib/services/mempool-api.ts` | Bitcoin API client: mempool.space (fees/UTXOs/broadcast) + Hiro Ordinals |

### SKILL.md Frontmatter

Every `SKILL.md` begins with YAML frontmatter that drives skill discovery and the manifest:

```yaml
---
name: btc
description: Bitcoin L1 operations — check balances, estimate fees, list UTXOs, transfer BTC, and classify UTXOs as cardinal or ordinal.
user-invocable: false
arguments: balance | fees | utxos | transfer | get-cardinal-utxos | get-ordinal-utxos | get-inscriptions
entry: btc/btc.ts
requires: [wallet]
tags: [l1, write, requires-funds]
---
```

| Field | Description |
|-------|-------------|
| `name` | Skill identifier (matches directory name) |
| `description` | One-line description for Claude Code discovery |
| `user-invocable` | Always `false` — Claude Code invokes skills, not end users directly |
| `arguments` | Pipe-separated list of subcommands |
| `entry` | Path to the CLI script(s), relative to repo root. Use bracket list for multiple: `[pillar/pillar.ts, pillar/pillar-direct.ts]` |
| `requires` | Skills that must be configured first (e.g. `[wallet]`) |
| `tags` | Controlled vocabulary: `read-only`, `write`, `mainnet-only`, `requires-funds`, `sensitive`, `infrastructure`, `defi`, `l1`, `l2` |

### AGENT.md Content Guidelines

AGENT.md is intentionally concise (one page). Cover:
1. **Prerequisites** — what must be true before invoking the skill
2. **Decision logic** — when to use which subcommand
3. **Safety checks** — what to verify before write operations (balances, UTXO types, fee impact)
4. **Error handling** — how to interpret error JSON and what to do next
5. **Output handling** — which fields to extract and pass to subsequent steps

### CLI Script Conventions

- Use [Commander.js](https://github.com/tj/commander.js) for argument parsing
- Every subcommand handler: `command.action(async (options) => { ... })`
- Print exactly one JSON object: `console.log(JSON.stringify(result, null, 2))`
- On error: `console.log(JSON.stringify({ error: "descriptive message" })); process.exit(1)`
- Never use `process.exit(0)` explicitly — normal exit is sufficient
- Mark sensitive options (passwords, mnemonics) to avoid accidental logging
- Use `src/lib/` shared modules for wallet access, network config, and API calls

## x402 Service URLs

All three are legitimate production x402 services. Agents can choose any based on needed endpoints.

| Service URL | Operator | Capabilities |
|-------------|----------|-------------|
| `https://x402.biwas.xyz` | biwas/secret-mars | DeFi analytics, market data, wallet analysis |
| `https://x402.aibtc.com` | aibtc | Inference, Stacks utilities, hashing, storage |
| `https://stx402.com` | whoabuddy/arc | AI services, cryptography, storage, utilities, agent registry |

The default `API_URL` in `src/lib/config/networks.ts` points to `x402.biwas.xyz`. Override with the `API_URL` environment variable or use the `settings` skill to configure a persistent default.

```bash
# Use a different x402 service for a single command
API_URL=https://x402.aibtc.com bun run x402/x402.ts list-endpoints

# Explore available endpoints on any service
bun run x402/x402.ts list-endpoints
```

## Skill Authoring Guide

### Adding a New Skill

1. Create `<name>/` in the repo root
2. Add `SKILL.md` with YAML frontmatter (see format above)
3. Add `AGENT.md` covering prerequisites, decision logic, safety checks, and error handling
4. Add `<name>/<name>.ts` — Commander CLI where every subcommand prints JSON to stdout
5. Add an entry to the Skills table in `README.md`
6. Run `bun run manifest` to update `skills.json`
7. Run `bun run typecheck` to verify TypeScript
8. Commit: `feat(<name>): add <name> skill`

### Adding a Workflow Guide

Workflow guides in `what-to-do/` combine multiple skills into complete end-to-end operations.

1. Add `what-to-do/<slug>.md` with YAML frontmatter:
   ```yaml
   ---
   title: Workflow Title
   description: One-line description.
   skills: [wallet, btc, stx]
   estimated-steps: 5
   order: 10
   ---
   ```
2. Structure: goal description, prerequisites checklist, ordered steps with `bun run` commands and expected output, verification checklist, Related Skills table, See Also links
3. Update `what-to-do/INDEX.md` and the Workflow Discovery table in `README.md`
4. Commit: `docs(what-to-do): add <workflow-name> workflow`

**Important:** Workflow steps must use `bun run` CLI invocations, not MCP tool names. Use `curl`/`wget` for aibtc.com API calls (the platform detects CLI user-agents and returns plaintext).

## Contribution Guidance

See [CONTRIBUTING.md](./CONTRIBUTING.md) for full details. Key requirements:

- `bun run typecheck` must pass before submitting a PR
- All commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`
- Never commit private keys, seed phrases, passwords, or raw API key values
- Shared infrastructure changes go in `src/lib/` — do not re-implement wallet, config, or network logic in individual skills

### Common Commit Scopes

`wallet`, `btc`, `stx`, `sbtc`, `tokens`, `nft`, `bns`, `identity`, `signing`, `stacking`, `defi`, `bitflow`, `pillar`, `query`, `x402`, `yield-hunter`, `credentials`, `settings`, `what-to-do`, `aibtc-agents`, `src`

### Release Process

This repo uses [Release Please](https://github.com/googleapis/release-please) for automated releases. Merge conventional commits to `main` — Release Please auto-creates a release PR with updated `CHANGELOG.md` and version bump. Merge the release PR to publish.

## Key Files Reference

| File / Path | Purpose |
|-------------|---------|
| `skills.json` | Auto-generated manifest — run `bun run manifest` to update |
| `package.json` | Version source of truth — manifest reads version from here |
| `tsconfig.json` | TypeScript strict mode configuration |
| `scripts/generate-manifest.ts` | Globs all `*/SKILL.md`, parses frontmatter, writes `skills.json` |
| `scripts/validate-frontmatter.ts` | Validates required frontmatter fields across all skills |
| `src/lib/config/networks.ts` | Network URL selection, x402 default API URL |
| `src/lib/config/contracts.ts` | Stacks contract addresses (sBTC, identity registry, etc.) |
| `src/lib/services/wallet-manager.ts` | Shared wallet load/unlock/persist logic |
| `src/lib/services/hiro-api.ts` | Hiro Stacks API client |
| `src/lib/services/mempool-api.ts` | mempool.space + Hiro Ordinals API client |
| `what-to-do/INDEX.md` | Index of all workflow guides |
| `aibtc-agents/README.md` | Community agent registry contribution guide |
| `aibtc-agents/template/setup.md` | Agent config template to copy |
| `aibtc-agents/arc0btc/README.md` | Reference agent configuration |
