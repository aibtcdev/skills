---
name: transfer
description: "STX, fungible token (SIP-010), and NFT (SIP-009) transfers on Stacks. All operations require an unlocked wallet."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "stx | token | nft"
  entry: "transfer/transfer.ts"
  mcp-tools: "transfer_stx, transfer_token, transfer_nft"
  requires: "wallet"
  tags: "l2, write, requires-funds"
---

# Transfer Skill

Unified asset transfer skill for the Stacks L2 — sends STX, SIP-010 fungible tokens, and SIP-009 NFTs to a recipient address. All three subcommands require an unlocked wallet.

## Usage

```
bun run transfer/transfer.ts <subcommand> [options]
```

## Subcommands

### stx

Transfer STX to a recipient address. Amount is specified in micro-STX (1 STX = 1,000,000 micro-STX).

```
bun run transfer/transfer.ts stx \
  --recipient <address> \
  --amount <microStx> \
  [--memo <text>] \
  [--fee low|medium|high|<microStx>]
```

Options:
- `--recipient` (required) — Stacks address of the recipient (starts with SP or ST)
- `--amount` (required) — Amount in micro-STX (e.g., `2000000` for 2 STX)
- `--memo` (optional) — Memo text to attach to the transfer (max 34 bytes)
- `--fee` (optional) — Fee preset (`low`, `medium`, `high`) or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "from": "SP2...",
  "recipient": "SP3...",
  "amount": "2 STX",
  "amountMicroStx": "2000000",
  "memo": null,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123..."
}
```

### token

Transfer any SIP-010 fungible token to a recipient. Accepts a well-known token symbol (`sBTC`, `USDCx`, `ALEX`, `DIKO`) or a full contract ID.

```
bun run transfer/transfer.ts token \
  --recipient <address> \
  --amount <uint> \
  --contract <token-symbol-or-contract-id> \
  [--memo <text>] \
  [--fee low|medium|high|<microStx>]
```

Options:
- `--recipient` (required) — Stacks address of the recipient
- `--amount` (required) — Amount in the token's smallest unit (check token decimals)
- `--contract` (required) — Token symbol (e.g., `sBTC`) or full contract ID (e.g., `SP2...my-token`)
- `--memo` (optional) — Memo text (max 34 bytes)
- `--fee` (optional) — Fee preset or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "from": "SP2...",
  "recipient": "SP3...",
  "contract": "SP2...my-token",
  "amount": "1000000",
  "memo": null,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123..."
}
```

### nft

Transfer a SIP-009 NFT to a recipient. Requires the NFT collection contract ID and the specific token ID.

```
bun run transfer/transfer.ts nft \
  --recipient <address> \
  --token-id <uint> \
  --contract <contract-id> \
  [--fee low|medium|high|<microStx>]
```

Options:
- `--recipient` (required) — Stacks address of the recipient
- `--token-id` (required) — Integer token ID of the NFT to transfer
- `--contract` (required) — NFT collection contract ID (e.g., `SP2...my-nft`)
- `--fee` (optional) — Fee preset or micro-STX amount; auto-estimated if omitted

Output:
```json
{
  "success": true,
  "txid": "abc123...",
  "from": "SP2...",
  "recipient": "SP3...",
  "contract": "SP2...my-nft",
  "tokenId": 42,
  "network": "mainnet",
  "explorerUrl": "https://explorer.hiro.so/txid/abc123..."
}
```

## Notes

- Wallet must be unlocked before any transfer. Use `bun run wallet/wallet.ts unlock` first.
- For STX, 1 STX = 1,000,000 micro-STX. For tokens, check decimals with the `tokens` skill's `get-info` subcommand.
- NFT token IDs are integers. Use the `nft` skill's `get-holdings` subcommand to list owned token IDs.
- Fee is paid in STX regardless of the asset being transferred. Ensure sufficient STX balance for the fee.
- The `--memo` option is available for STX and token transfers, but not NFT transfers (not part of the SIP-009 standard).
