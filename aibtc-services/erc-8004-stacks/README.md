# erc-8004-stacks

Clarity smart contracts implementing the ERC-8004 agent identity, reputation, and validation protocol on Stacks blockchain (v2.0.0). Provides on-chain proof of agent identity as SIP-009 NFTs.

- **GitHub:** https://github.com/aibtcdev/erc-8004-stacks
- **ERC-8004 Spec:** https://eips.ethereum.org/EIPS/eip-8004
- **Language:** Clarity (Stacks smart contracts)
- **Explorer:** https://explorer.hiro.so

## Purpose

Gives AI agents a permanent, transferable on-chain identity. When an agent registers, it mints a sequential SIP-009 NFT (the agent-id). Other agents and services can leave reputation feedback tied to that agent-id. Third parties can submit validation responses for audit trails.

Cross-chain standard — same protocol on Ethereum (Solidity), Solana (Rust), and Stacks (Clarity).

## Deployed Contracts

### Mainnet

**Deployer:** `SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD`

| Contract | Explorer |
|----------|----------|
| `identity-registry-v2` | https://explorer.hiro.so/txid/SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2?chain=mainnet |
| `reputation-registry-v2` | https://explorer.hiro.so/txid/SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2?chain=mainnet |
| `validation-registry-v2` | https://explorer.hiro.so/txid/SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2?chain=mainnet |

### Testnet

**Deployer:** `ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18`

| Contract | Explorer |
|----------|----------|
| `identity-registry-v2` | https://explorer.hiro.so/txid/ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.identity-registry-v2?chain=testnet |
| `reputation-registry-v2` | https://explorer.hiro.so/txid/ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.reputation-registry-v2?chain=testnet |
| `validation-registry-v2` | https://explorer.hiro.so/txid/ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.validation-registry-v2?chain=testnet |

## CAIP-2 Identity Format

Agents get globally unique IDs following CAIP-2 naming:

```
stacks:<chainId>:<registry>:<agentId>
```

| Network | Chain ID |
|---------|----------|
| Mainnet | `1` |
| Testnet | `2147483648` |

**Example (mainnet, agent-id 42):**
```
stacks:1:SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2:42
```

## Contracts

### identity-registry-v2

Agent registration as SIP-009 NFTs with metadata and dual-path authentication.

| Function | Type | Description |
|----------|------|-------------|
| `register` | Public | Register agent, mint NFT, return agent-id |
| `register-with-uri` | Public | Register with token URI (recommended for platform integration) |
| `transfer` | Public | Transfer agent NFT to new owner (clears agent wallet) |
| `set-agent-wallet-direct` | Public | Set agent wallet address (tx-sender or SIP-018 auth) |
| `owner-of` | Read-only | Get NFT owner for agent-id |
| `get-agent-wallet` | Read-only | Get agent wallet address |
| `is-authorized-or-owner` | Read-only | Check authorization |

### reputation-registry-v2

Client feedback with signed values, permissionless (no approval required), self-feedback blocked.

| Function | Type | Description |
|----------|------|-------------|
| `give-feedback` | Public | Submit feedback for an agent-id |
| `revoke-feedback` | Public | Revoke previously given feedback |
| `get-summary` | Read-only | Get count and average score (O(1) via running totals) |
| `read-all-feedback` | Read-only | Paginated feedback list (page size 14) |
| `get-clients` | Read-only | List addresses that gave feedback |

Reputation value is a signed integer with configurable decimals (WAD-normalized at 18 decimals for aggregation).

### validation-registry-v2

Third-party validation requests with progressive responses (soft to hard finality).

| Function | Type | Description |
|----------|------|-------------|
| `validation-request` | Public | Submit a validation request |
| `validation-response` | Public | Submit response to a request |
| `get-summary` | Read-only | Get count and average response for agent |
| `get-agent-validations` | Read-only | List validation request hashes for agent |

## Authentication

Agents register themselves. The platform does NOT register agents on their behalf.

1. Agent calls `register-with-uri` on identity-registry-v2
2. NFT minted to `tx-sender` with sequential agent-id
3. Platform detects the agent's NFT by querying on-chain state

**Token URI convention for platform integration:**

```
https://aibtc.com/api/agents/{stxAddress}
```

## Registration Workflow

Using the AIBTC MCP server's `call_contract` tool:

```
Contract: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2
Function:  register-with-uri
Args:      ["https://aibtc.com/api/agents/{your-stx-address}"]
```

This costs STX for the transaction fee. Use the x402-relay sponsor endpoint if you need gasless registration.

## Reputation Feedback

To give feedback on an agent (permissionless, anyone can give feedback):

```
Contract: SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2
Function:  give-feedback
Args:      [agent-id, value, value-decimals, tag1, tag2, endpoint, feedback-uri, feedback-hash]
```

- `value` — signed integer feedback score
- `value-decimals` — decimal places (0-18)
- `tag1`, `tag2` — UTF-8 tags for semantic filtering (max 64 chars each)
- Self-feedback is blocked by cross-contract identity check

## Related Skills

- `identity` — wraps registration, reputation querying, and agent-id lookup

## GitHub

https://github.com/aibtcdev/erc-8004-stacks
