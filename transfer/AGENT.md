---
name: transfer-agent
skill: transfer
description: STX, SIP-010 fungible token, and SIP-009 NFT transfers on Stacks — unified send operations for all Stacks L2 asset types.
---

# Transfer Agent

This agent handles unified asset transfers on the Stacks L2. Use it to send STX, fungible tokens (SIP-010), or NFTs (SIP-009) to any Stacks address. All three subcommands sign and broadcast a transaction and require an unlocked wallet with enough STX for fees.

## Prerequisites

- Wallet unlocked via `bun run wallet/wallet.ts unlock`
- Sufficient STX balance for transaction fees (check with `bun run stx/stx.ts get-balance`)
- For `stx`: sufficient STX balance to cover `--amount` plus fees
- For `token`: sufficient token balance (check with `bun run tokens/tokens.ts get-balance --token <contract>`)
- For `nft`: ownership of the NFT being transferred (check with `bun run nft/nft.ts get-holdings`)

## Decision Logic

| Asset type | Subcommand | Key options |
|-----------|-----------|-------------|
| Native STX | `stx` | `--recipient`, `--amount` (micro-STX), optional `--memo` |
| SIP-010 fungible token | `token` | `--recipient`, `--amount` (smallest unit), `--contract` (symbol or contract ID) |
| SIP-009 NFT | `nft` | `--recipient`, `--token-id`, `--contract` (collection contract ID) |

Use `stx` for native Stacks token transfers. Use `token` for any SIP-010 compliant fungible token (sBTC, USDCx, ALEX, DIKO, or custom). Use `nft` for SIP-009 NFT ownership transfers.

## Safety Checks

- Before `stx`: verify recipient address starts with `SP` (mainnet) or `ST` (testnet) and the sender has enough balance (`stx get-balance`)
- Before `stx`: 1 STX = 1,000,000 micro-STX — double-check unit conversion before sending large amounts
- Before `token`: confirm token decimals with `bun run tokens/tokens.ts get-info --token <contract>` to avoid unit errors
- Before `token`: verify sender balance with `bun run tokens/tokens.ts get-balance --token <contract>`
- Before `nft`: confirm ownership with `bun run nft/nft.ts get-holdings` and verify `--token-id` matches an owned token
- Never reuse a memo containing sensitive information — memos are stored on-chain permanently
- Fees are paid in STX for all three asset types — always maintain a small STX reserve for fees (~0.01 STX minimum)

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "No active wallet found." | Wallet not unlocked or session expired | Run `bun run wallet/wallet.ts unlock` |
| "--token-id must be a non-negative integer" | Non-numeric or negative token ID | Pass a valid positive integer for `--token-id` |
| "--amount must be a positive integer" | Zero or non-numeric amount | Pass a valid positive integer for `--amount` |
| "Insufficient balance" | Not enough STX or token balance | Check balance with `stx/stx.ts get-balance` or `tokens/tokens.ts get-balance` |
| "Token not found" | Unknown token symbol or wrong contract ID | Verify contract ID with `bun run tokens/tokens.ts get-info --token <contract>` |
| "NFT not owned by sender" | Sending an NFT you do not own | Confirm ownership with `bun run nft/nft.ts get-holdings` |

## Output Handling

All three subcommands return a JSON object on success:
- `txid` — use this to track the transaction with `bun run stx/stx.ts get-transaction-status --txid <txid>`
- `explorerUrl` — direct link to the transaction in the Hiro Explorer
- `success: true` confirms the transaction was broadcast (not confirmed — poll status separately if needed)

## Example Invocations

```bash
# Send 5 STX to another address
bun run transfer/transfer.ts stx \
  --recipient SP3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NZ159 \
  --amount 5000000

# Send 100 USDCx tokens
bun run transfer/transfer.ts token \
  --recipient SP3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NZ159 \
  --amount 100000000 \
  --contract USDCx

# Transfer an NFT (token #42 from a collection)
bun run transfer/transfer.ts nft \
  --recipient SP3FGQ8Z7JY9BWYZ5WM53E0M9NK7WHJF0691NZ159 \
  --token-id 42 \
  --contract SP2...my-nft-collection
```
