# Contributing to @aibtc/skills

Contributions are welcome — whether you are adding a new skill, writing a workflow guide, registering your agent config, or reporting a bug.

## Prerequisites

- [Bun](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`)
- Run `bun install` in the repo root after cloning
- `bun run typecheck` must pass before submitting a PR

## What Can You Contribute?

### 1. New Skills

A skill is a self-contained directory with three files:

| File | Purpose |
|------|---------|
| `SKILL.md` | YAML frontmatter + documentation that Claude Code reads to understand available subcommands |
| `AGENT.md` | Autonomous operation rules: decision logic, safety checks, error handling for subagent use |
| `<name>.ts` | [Commander](https://github.com/tj/commander.js) CLI script — outputs a single JSON object to stdout |

Steps to add a new skill:

1. Create `<name>/` in the repo root
2. Add `SKILL.md` with YAML frontmatter:
   ```yaml
   ---
   name: <name>
   description: One-line description of what the skill does
   user-invocable: false
   arguments: subcommand1 | subcommand2 | subcommand3
   ---
   ```
3. Add `AGENT.md` covering prerequisites, safety checks, and error-handling patterns
4. Add `<name>/<name>.ts` — a Commander CLI where every subcommand prints a JSON object to stdout
5. Add an entry to the Skills table in `README.md`
6. Commit: `feat(<name>): add <name> skill`

Shared infrastructure lives in `src/lib/` — use it for wallet access, config, network selection, and API calls rather than re-implementing these.

### 2. Workflow Guides (`what-to-do/`)

Workflow guides combine multiple skills into a complete end-to-end operation with prerequisite checks, ordered steps, and expected outputs.

Steps to add a workflow:

1. Add `what-to-do/<N>-<slug>.md` following the existing numbered naming pattern (e.g. `10-my-workflow.md`)
2. Update `what-to-do/INDEX.md` with a new entry
3. Add a row to the Workflow Discovery table in `README.md`
4. Commit: `docs(what-to-do): add <workflow-name> workflow`

Look at existing guides in `what-to-do/` for the expected structure: goal, prerequisites, ordered steps, example outputs.

### 3. Agent Configurations (`aibtc-agents/`)

The `aibtc-agents/` directory is a community registry of agent setups. See [`aibtc-agents/README.md`](./aibtc-agents/README.md) for full instructions. Summary:

1. Fork the repo on GitHub
2. Copy the template: `cp aibtc-agents/template/setup.md aibtc-agents/<your-handle>/README.md`
3. Fill in your agent's identity, skills, wallet setup commands, env vars, and workflows
4. Review the [`arc0btc` example](./aibtc-agents/arc0btc/README.md) for reference
5. Open a PR: `feat(aibtc-agents): add <handle> agent config`

**Do not commit private keys, seed phrases, passwords, or raw API key values.** Environment variable names are fine; their values are not.

### 4. Bug Reports and Feature Requests

Open a [GitHub Issue](https://github.com/aibtcdev/skills/issues) on the `aibtcdev/skills` repo.

For **bug reports**, include:
- Skill name and subcommand (e.g. `wallet import`)
- Full command you ran (redact passwords/mnemonics)
- JSON error output
- Bun version (`bun --version`)
- OS / platform

For **feature requests**, describe:
- The use case (what you are trying to do)
- Which skill it would extend, or whether it needs a new skill
- Any relevant API or protocol links

## Commit Format

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) — the `CHANGELOG.md` is generated automatically from commit messages via Release Please.

```
type(scope): short description
```

| Type | When to use |
|------|------------|
| `feat` | New skill, subcommand, or workflow |
| `fix` | Bug fix in an existing skill or script |
| `refactor` | Internal restructure with no behavior change |
| `test` | Adding or updating tests |
| `docs` | README, SKILL.md, AGENT.md, workflow guides |
| `chore` | Dependency updates, config changes, tooling |

Common scopes: `wallet`, `btc`, `stx`, `sbtc`, `tokens`, `nft`, `bns`, `identity`, `signing`, `stacking`, `defi`, `bitflow`, `pillar`, `query`, `x402`, `yield-hunter`, `credentials`, `settings`, `what-to-do`, `aibtc-agents`, `src`

## Security

- **Never commit private keys, seed phrases, passwords, or raw API keys**
- Wallet mnemonics are AES-GCM encrypted by the wallet skill — do not bypass the encryption layer
- All `--password` and `--mnemonic` options are marked sensitive in CLI scripts and should not be logged
- If you discover a security vulnerability, please open a private GitHub security advisory rather than a public issue

## Code Style

- TypeScript with strict mode (`tsconfig.json`)
- Every CLI subcommand prints a **single JSON object** to stdout — no raw text output
- Errors output as `{ "error": "descriptive message" }` with a non-zero exit code
- Use the shared `src/lib/` modules for wallet loading, config access, network selection, and API calls
- Run `bun run typecheck` to verify TypeScript types before committing
