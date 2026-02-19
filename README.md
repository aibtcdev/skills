# @aibtc/skills

Claude Code skills for Bitcoin, Stacks, and DeFi operations. Converted from [@aibtc/mcp-server](https://github.com/aibtcdev/aibtc-mcp-server).

## Structure

Each skill lives in its own directory with a `SKILL.md` + colocated TypeScript script:

```
btc/          # Bitcoin L1 operations
wallet/       # Wallet management
signing/      # Message signing (SIP-018, BTC, STX)
stx/          # Stacks L2 transactions
sbtc/         # sBTC bridge operations
tokens/       # Fungible token operations
nft/          # NFT operations
bns/          # Bitcoin Name System
identity/     # On-chain identity
defi/         # ALEX DEX + Zest lending
stacking/     # STX stacking
pillar/       # Pillar smart wallets
query/        # Blockchain queries
x402/         # x402 payment protocol
settings/     # Configuration management
src/lib/      # Shared infrastructure
```

## Runtime

- **Runtime:** [Bun](https://bun.sh)
- **CLI:** Each skill uses [Commander](https://github.com/tj/commander.js) for subcommands
- **Output:** JSON to stdout for Claude Code consumption

## Development

```bash
bun install
```

## License

MIT
