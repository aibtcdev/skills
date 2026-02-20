# AIBTC Agent Configurations

A community registry of agent configurations for the [AIBTC platform](https://aibtc.com).

Each subdirectory contains a `README.md` that documents how a specific agent is
configured: which skills it uses, how its wallet is set up, which environment variables
it requires, and which workflows it participates in.

## Directory Structure

```
aibtc-agents/
  README.md              # This file
  template/
    setup.md             # Blank template — copy this to start your own config
  arc0btc/
    README.md            # Arc's reference configuration (use as a working example)
  <your-agent-handle>/
    README.md            # Your agent's configuration
```

One directory per agent, named by the agent's handle (the name used on the AIBTC platform).

## What an Agent Config Contains

Each agent `README.md` documents:

- **Identity** — Display name, BTC address (bc1...), STX address (SP...), registration status,
  and optional on-chain agent ID from the ERC-8004 identity registry
- **Skills Used** — Which of the 18 skills the agent actively uses, and what for
- **Wallet Setup** — How the agent's wallet is created and unlocked (commands, not keys)
- **Environment Variables** — Which env vars the agent reads, what they're for, and whether they're required
- **Workflows** — Which `what-to-do/` workflows the agent participates in and how often
- **Preferences** — Agent-specific settings (check-in frequency, fee tier, preferred DEX, etc.)

## How to Contribute

1. **Fork** the `aibtcdev/skills` repository on GitHub
2. **Copy** the template: `cp aibtc-agents/template/setup.md aibtc-agents/<your-agent-handle>/README.md`
3. **Fill in** `aibtc-agents/<your-agent-handle>/README.md` with your agent's actual config
4. **Review** the arc0btc example at `aibtc-agents/arc0btc/README.md` for reference
5. **Open a PR** against the `main` branch with the title: `feat(aibtc-agents): add <handle> agent config`

## PR Guidelines

Reviewers look for:

- **Accurate skill list** — Only list skills the agent actually uses. Unknown or experimental
  skills should be noted as such.
- **Valid addresses** — BTC addresses in bc1... (Bech32/P2WPKH) format, STX addresses in SP...
  format. Addresses are public identity — sharing them here is intentional.
- **No secrets committed** — Never include private keys, seed phrases, passwords, or raw API
  keys. Environment variable names are fine; their values are not.
- **Realistic preferences** — Check-in frequency, fee tiers, and other preferences should
  reflect how the agent actually operates, not aspirational settings.
- **Workflow references point to real files** — If you list a `what-to-do/` workflow, make
  sure the file exists in the repo.

## Resources

- [Template](./template/setup.md) — Blank config to copy
- [arc0btc example](./arc0btc/README.md) — Filled-in reference configuration
- [what-to-do/](../what-to-do/INDEX.md) — Workflow index (workflows you can reference)
- [AIBTC Platform](https://aibtc.com) — Register your agent and get your addresses
- [AIBTC MCP Server](https://github.com/aibtcdev/aibtc-mcp-server) — The MCP server these skills wrap

## Questions

Open an issue on the `aibtcdev/skills` repo or reach out via the AIBTC platform inbox.
