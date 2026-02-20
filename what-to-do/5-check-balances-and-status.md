---
title: Check Balances and Status
description: Check all asset balances including BTC, STX, sBTC, fungible tokens, and NFTs, plus wallet and network status.
skills: [wallet, btc, stx, sbtc, tokens, nft, query]
estimated-steps: 7
---

# Check Balances and Status

A comprehensive balance check covers all asset types an agent may hold across Bitcoin L1 and Stacks L2. Run this workflow to get a full picture of available funds before executing payments, swaps, or deployments.

All balance queries are read-only and require no wallet unlock. The wallet `info` command can be run without unlocking.

## Prerequisites

- [ ] At least one wallet configured (`bun run wallet/wallet.ts list`)
- [ ] Network set appropriately (`NETWORK=mainnet` for mainnet, default is testnet)

## Steps

### 1. Check Wallet Status

Confirm which wallet is active and get addresses.

```bash
bun run wallet/wallet.ts status
```

Expected output: `wallet.btcAddress` (bc1q...) and `wallet.address` (SP...), plus `isUnlocked` status.

### 2. Check BTC Balance

```bash
bun run btc/btc.ts balance
```

Expected output: `balance.satoshis`, `confirmed.satoshis`, `unconfirmed.satoshis`, `utxoCount`.

### 3. Check STX Balance

```bash
bun run stx/stx.ts get-balance
```

Expected output: `balance.stx`, `balance.microStx`, `locked.stx` (STX locked in stacking, if any).

### 4. Check sBTC Balance

```bash
bun run sbtc/sbtc.ts get-balance
```

Expected output: `balance.sats`, `balance.btc` (sBTC denominated in satoshis).

### 5. Check Fungible Token Balances

List all SIP-010 fungible tokens held by the active address.

```bash
bun run tokens/tokens.ts list-user-tokens
```

Expected output: Array of token balances with `contractId`, `symbol`, `balance`, `decimals`.

### 6. Check NFT Holdings

List all SIP-009 NFTs held by the active address.

```bash
bun run nft/nft.ts get-holdings
```

Expected output: Array of NFT assets with `contractId`, `assetName`, `tokenId`, plus total `count`.

### 7. Check Stacks Network Status

Confirm the network is healthy before executing transactions.

```bash
bun run query/query.ts get-network-status
```

Expected output: `status: "ready"`, `chainTip.block_height` showing current block.

## Verification

At the end of this workflow, verify:
- [ ] BTC balance shows `confirmed.satoshis` for available spending
- [ ] STX balance shows enough for transaction fees (at least 0.01 STX)
- [ ] sBTC balance confirmed if inbox messaging is planned
- [ ] Network status is `"ready"`

## Related Skills

| Skill | Used For |
|-------|---------|
| `wallet` | Active wallet address lookup and unlock status |
| `btc` | Bitcoin L1 balance and UTXO data |
| `stx` | STX token balance on Stacks L2 |
| `sbtc` | sBTC (wrapped Bitcoin) balance on Stacks L2 |
| `tokens` | SIP-010 fungible token balances |
| `nft` | SIP-009 NFT holdings |
| `query` | Stacks network health status |

## See Also

- [4. Send BTC Payment](./4-send-btc-payment.md)
- [6. Swap Tokens](./6-swap-tokens.md)
