# aibtc-mcp-server

Bitcoin-native MCP (Model Context Protocol) server for AI agents. Provides 120+ tools for Bitcoin L1 operations, Stacks L2 operations, DeFi protocols, and x402 payments. Agents get their own encrypted wallet stored locally.

- **GitHub:** https://github.com/aibtcdev/aibtc-mcp-server
- **npm:** https://www.npmjs.com/package/@aibtc/mcp-server
- **Package:** `@aibtc/mcp-server`

## Purpose

The MCP server is the primary tool integration layer for AI agents working with Bitcoin and Stacks. It exposes blockchain operations as MCP tools that compatible AI assistants (Claude Code, Claude Desktop, Cursor, etc.) can call. Each agent creates its own wallet with password-protected encrypted storage at `~/.aibtc/`.

## Installation

### Claude Code (Terminal) — Recommended

```bash
npx @aibtc/mcp-server@latest --install
```

Restart your terminal after installing.

### Claude Desktop (App)

```bash
npx @aibtc/mcp-server@latest --install --desktop
```

**Claude Desktop config paths by OS:**

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%/Claude/claude_desktop_config.json` |

Restart Claude Desktop after installing.

### Testnet Mode

Add `--testnet` to either install command:

```bash
npx @aibtc/mcp-server@latest --install --testnet
npx @aibtc/mcp-server@latest --install --desktop --testnet
```

### Other MCP-Compatible Environments

Add manually to your MCP server config:

```json
{
  "mcpServers": {
    "aibtc": {
      "command": "npx",
      "args": ["@aibtc/mcp-server@latest"],
      "env": {
        "NETWORK": "mainnet"
      }
    }
  }
}
```

Supported environments: Claude Code, Claude Desktop, Cursor, Codex, and any MCP-compatible AI assistant.

### Via Skills Repo

```bash
npx skills add aibtcdev/aibtc-mcp-server/skill
# or
npx skills add @aibtc/mcp-server/skill
```

## Tool Categories (120+ total)

### Wallet Management

| Tool | Description |
|------|-------------|
| `wallet_create` | Create a new wallet (BTC + STX addresses from same mnemonic) |
| `wallet_import` | Import existing wallet from mnemonic |
| `wallet_unlock` | Unlock wallet with password |
| `wallet_lock` | Lock wallet |
| `wallet_list` | List available wallets |
| `wallet_switch` | Switch active wallet |
| `wallet_delete` | Delete a wallet |
| `wallet_export` | Export wallet mnemonic |
| `wallet_status` | Check wallet status (addresses + lock state) |
| `wallet_set_timeout` | Set auto-lock timeout (default: 15 minutes) |

### Bitcoin L1

| Tool | Description |
|------|-------------|
| `get_btc_balance` | Get BTC balance (confirmed + unconfirmed) |
| `get_btc_fees` | Fee estimates (fast, medium, slow) in sat/vB |
| `get_btc_utxos` | List UTXOs for address |
| `transfer_btc` | Send BTC (uses cardinal UTXOs by default) |
| `get_cardinal_utxos` | Safe-to-spend UTXOs (no inscriptions) |
| `get_ordinal_utxos` | UTXOs containing inscriptions |

### Bitcoin Inscriptions

| Tool | Description |
|------|-------------|
| `get_taproot_address` | Get wallet Taproot (P2TR) address |
| `estimate_inscription_fee` | Calculate inscription cost |
| `inscribe` | Create inscription commit transaction |
| `inscribe_reveal` | Complete inscription reveal |
| `get_inscription` | Fetch inscription content |
| `get_inscriptions_by_address` | List inscriptions owned by address |

### Message Signing

| Tool | Description |
|------|-------------|
| `sip018_sign` | Sign structured Clarity data (SIP-018, for on-chain verification) |
| `sip018_verify` | Verify SIP-018 signature |
| `sip018_hash` | Compute SIP-018 hash without signing |
| `stacks_sign_message` | Sign plain text (SIWS-compatible) |
| `stacks_verify_message` | Verify Stacks message signature |
| `btc_sign_message` | Sign with Bitcoin key (BIP-137) |
| `btc_verify_message` | Verify BIP-137 signature |

### Stacks L2 Operations

| Tool | Description |
|------|-------------|
| `get_stx_balance` | Get STX balance for any address |
| `get_stx_fees` | Fee estimates (low, medium, high) |
| `get_wallet_info` | Get wallet addresses and status |
| `transfer_stx` | Send STX |
| `broadcast_transaction` | Broadcast pre-signed transaction |
| `call_contract` | Call a smart contract function |
| `deploy_contract` | Deploy a Clarity contract |
| `call_read_only_function` | Call read-only contract function |
| `get_transaction_status` | Check transaction status |

### sBTC Operations

| Tool | Description |
|------|-------------|
| `sbtc_get_balance` | Get sBTC balance |
| `sbtc_transfer` | Send sBTC |
| `sbtc_get_deposit_info` | Get BTC deposit instructions for sBTC peg |
| `sbtc_get_peg_info` | Get peg ratio and TVL |
| `sbtc_deposit` | Initiate BTC deposit to receive sBTC |
| `sbtc_deposit_status` | Check deposit status |

### Token Operations (SIP-010)

| Tool | Description |
|------|-------------|
| `get_token_balance` | Get balance of any SIP-010 token |
| `transfer_token` | Send any SIP-010 token |
| `get_token_info` | Get token metadata |
| `list_user_tokens` | List tokens owned by address |
| `get_token_holders` | Get top token holders |

### NFT Operations (SIP-009)

| Tool | Description |
|------|-------------|
| `get_nft_holdings` | List NFTs owned by address |
| `get_nft_metadata` | Get NFT metadata |
| `transfer_nft` | Send an NFT |
| `get_nft_owner` | Get NFT owner |
| `get_collection_info` | Get NFT collection details |
| `get_nft_history` | Get NFT transfer history |

### DeFi (Mainnet Only)

**ALEX DEX:**

| Tool | Description |
|------|-------------|
| `alex_list_pools` | Discover all trading pools |
| `alex_get_swap_quote` | Get expected output for token swap |
| `alex_swap` | Execute a token swap |
| `alex_get_pool_info` | Get liquidity pool reserves |

**Zest Protocol (lending/borrowing):**

| Tool | Description |
|------|-------------|
| `zest_list_assets` | List supported lending assets |
| `zest_get_position` | Get supply/borrow position |
| `zest_supply` | Supply assets to earn interest |
| `zest_withdraw` | Withdraw supplied assets |
| `zest_borrow` | Borrow against collateral |
| `zest_repay` | Repay borrowed assets |
| `zest_claim_rewards` | Claim protocol rewards |

**Bitflow DEX:**

| Tool | Description |
|------|-------------|
| `bitflow_get_ticker` | Get market data |
| `bitflow_get_quote` | Get swap quote |
| `bitflow_swap` | Execute token swap |

**Pillar Smart Wallet:**

| Tool | Description |
|------|-------------|
| `pillar_connect` | Connect to Pillar wallet |
| `pillar_send` | Send sBTC to BNS names or addresses |
| `pillar_boost` | Create leveraged sBTC position |
| `pillar_position` | View wallet and Zest position |
| `pillar_direct_*` | Direct tools for autonomous agents (no browser) |

### BNS Domains

| Tool | Description |
|------|-------------|
| `lookup_bns_name` | Resolve .btc domain to address |
| `reverse_bns_lookup` | Get .btc domain for address |
| `get_bns_info` | Get domain details |
| `check_bns_availability` | Check if domain is available |
| `get_bns_price` | Get registration price |
| `list_user_domains` | List domains owned by address |
| `preorder_bns_name` | Preorder a .btc domain (step 1) |
| `register_bns_name` | Register a .btc domain (step 2) |

### Blockchain Queries

| Tool | Description |
|------|-------------|
| `get_account_info` | Get account nonce and balance |
| `get_account_transactions` | List transaction history |
| `get_block_info` | Get block details |
| `get_mempool_info` | Get pending transactions |
| `get_contract_info` | Get contract ABI and source |
| `get_contract_events` | Get contract event history |
| `get_network_status` | Get network health |

### Stacking / PoX

| Tool | Description |
|------|-------------|
| `get_pox_info` | Current PoX cycle info |
| `get_stacking_status` | Check stacking status |
| `stack_stx` | Lock STX for stacking |
| `extend_stacking` | Extend stacking period |

### x402 API Endpoints

| Tool | Description |
|------|-------------|
| `list_x402_endpoints` | Discover x402 endpoints |
| `execute_x402_endpoint` | Execute x402 endpoint with auto-payment |
| `probe_x402_endpoint` | Check cost without paying |
| `scaffold_x402_endpoint` | Generate x402 Cloudflare Worker project |
| `scaffold_x402_ai_endpoint` | Generate x402 AI API with OpenRouter |

### Yield Hunter (Autonomous)

| Tool | Description |
|------|-------------|
| `yield_hunter_start` | Start autonomous sBTC→Zest deposits |
| `yield_hunter_stop` | Stop yield hunting |
| `yield_hunter_status` | Check status |
| `yield_hunter_configure` | Adjust threshold, reserve, interval |

### Identity (ERC-8004)

| Tool | Description |
|------|-------------|
| `register_identity` | Register on-chain identity (ERC-8004) |
| `get_identity` | Look up agent identity |
| `give_feedback` | Give reputation feedback to an agent |
| `get_reputation` | Get agent reputation summary |
| `request_validation` | Submit validation request |
| `get_validation_status` | Check validation request status |
| `get_validation_summary` | Get agent validation summary |

## Wallet Storage

Wallets stored locally at `~/.aibtc/`:

```
~/.aibtc/
├── wallets.json       # Wallet index (names, addresses, no secrets)
├── config.json        # Active wallet, settings
└── wallets/
    └── [wallet-id]/
        └── keystore.json  # AES-256-GCM encrypted mnemonic
```

Each wallet derives both a Stacks address and a Bitcoin address from the same 24-word BIP-39 mnemonic.

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `NETWORK` | `mainnet` or `testnet` | `mainnet` |
| `API_URL` | Default x402 API base URL | `https://x402.biwas.xyz` |
| `CLIENT_MNEMONIC` | Optional pre-configured mnemonic | — |
| `HIRO_API_KEY` | Hiro API key for higher rate limits | — |

`CLIENT_MNEMONIC` is optional. Recommended approach is to let the agent create its own wallet via `wallet_create`.

## Included Agent Skill

The package includes an Agent Skills-compatible skill at `skill/SKILL.md` with structured workflows:

```
skill/
├── SKILL.md                        # Bitcoin L1 core workflows
└── references/
    ├── genesis-lifecycle.md        # Agent registration and check-in
    ├── inscription-workflow.md     # Bitcoin inscription guide
    ├── pillar-wallet.md            # Pillar smart wallet guide
    ├── stacks-defi.md              # Stacks L2 / DeFi operations
    └── troubleshooting.md          # Common issues and solutions
```

Install the skill:

```bash
npx skills add @aibtc/mcp-server/skill
```

## Related Skills

`wallet`, `btc`, `stx`, `sbtc`, `tokens`, `nft`, `defi`, `identity`, `x402` — all available in the skills repo at https://github.com/aibtcdev/skills

## GitHub

https://github.com/aibtcdev/aibtc-mcp-server
