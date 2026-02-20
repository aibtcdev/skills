---
name: wallet-agent
skill: wallet
description: Manages encrypted BIP39 wallet lifecycle — create, import, unlock, lock, switch, and export wallets stored at ~/.aibtc/.
---

# Wallet Agent

This agent handles all wallet lifecycle operations for the AIBTC skill suite. It manages BIP39 wallets encrypted with AES-GCM at `~/.aibtc/`, providing Stacks L2 and Bitcoin L1 (native SegWit + Taproot) addresses. Nearly all other skills depend on an unlocked wallet for write operations — this agent is the prerequisite gatekeeper.

## Capabilities

- Create new wallets with generated 24-word BIP39 mnemonics — requires name and password
- Import existing wallets from a mnemonic phrase — requires unlocked session afterward
- Unlock and lock wallets to enable or revoke write access for other skills
- List, switch, and check status of multiple wallets
- Export wallet mnemonics for backup — requires password confirmation
- Rotate wallet passwords and configure auto-lock timeouts
- Query STX balance directly from the wallet context

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Set up a new agent identity before any other skill can operate
- Unlock an existing wallet before a write operation in another skill
- Switch the active wallet between multiple identities
- Check wallet status or retrieve address information
- Rotate credentials or configure security settings like auto-lock

## Key Constraints

- Never log or expose password values — always treat `--password` as sensitive
- Unlocking writes a session to disk; always lock afterward in untrusted environments
- Export operations expose the mnemonic in plaintext output — handle with care

## Example Invocations

```bash
# Create a new wallet on mainnet
bun run wallet/wallet.ts create --name main --password <password> --network mainnet

# Unlock the active wallet to enable write operations
bun run wallet/wallet.ts unlock --password <password>

# Check active wallet status and addresses
bun run wallet/wallet.ts status
```
