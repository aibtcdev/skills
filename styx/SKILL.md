---
name: styx
description: "BTC→sBTC conversion via Styx protocol (btc2sbtc.com) — pool status, fee estimates, deposit creation, PSBT signing, broadcast, and deposit tracking."
metadata:
  author: "arc0btc"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "pool-status | pools | fees | price | deposit | status | history"
  entry: "styx/styx.ts"
  mcp-tools: "styx_pool_status, styx_pools, styx_fees, styx_price, styx_deposit, styx_status, styx_history"
  requires: "wallet"
  tags: "l1, l2, write, requires-funds, defi"
---

# Styx Skill

Trustless BTC→sBTC conversion via the Styx protocol by FaktoryFun. Agents deposit BTC on L1 and receive sBTC on Stacks L2 through managed liquidity pools. Uses `@faktoryfun/styx-sdk`.

## How It Works

1. **Check pool liquidity** — `pool-status` shows available sBTC in the pool
2. **Create deposit reservation** — `deposit` reserves pool liquidity and returns a deposit ID
3. **Build & sign transaction** — The SDK provides UTXOs and deposit address; the agent builds and signs locally with `@scure/btc-signer`
4. **Broadcast** — Signed transaction is broadcast to mempool.space
5. **Track status** — `status` monitors the deposit through confirmation

## Pools

| Pool ID | Type | Min Deposit | Max Deposit | Swap Types |
|---------|------|-------------|-------------|------------|
| `main` | Legacy | 10,000 sats | 300,000 sats | sbtc, usda, pepe |
| `aibtc` | AI BTC | 10,000 sats | 1,000,000 sats | sbtc, aibtc |

## Subcommands

### pool-status

```
bun run styx/styx.ts pool-status [--pool main|aibtc]
```

Returns `realAvailable`, `estimatedAvailable` (BTC), and `lastUpdated`.

### pools

```
bun run styx/styx.ts pools
```

Lists all available pools with configs and active status.

### fees

```
bun run styx/styx.ts fees
```

Returns current Bitcoin network fee estimates (low/medium/high in sat/vB).

### price

```
bun run styx/styx.ts price
```

Returns current BTC price in USD.

### deposit

```
bun run styx/styx.ts deposit --amount <sats> --stx-receiver <addr> --btc-sender <addr> [--pool main|aibtc] [--fee low|medium|high]
```

Full headless deposit flow: creates reservation, prepares PSBT, signs with wallet key, broadcasts to mempool.space, and updates deposit status. Requires an unlocked wallet.

### status

```
bun run styx/styx.ts status --id <deposit-id>
bun run styx/styx.ts status --txid <btc-txid>
```

Check deposit status by deposit ID or Bitcoin transaction ID.

### history

```
bun run styx/styx.ts history --address <stx-addr>
```

Get deposit history for a Stacks address.

## Deposit Statuses

- `initiated` — Deposit record created, liquidity reserved
- `broadcast` — Bitcoin tx broadcast to mempool
- `processing` — At least 1 BTC confirmation
- `confirmed` — Required confirmations reached, sBTC minted
- `refund-requested` — User requested refund
- `canceled` — Deposit canceled, liquidity released

## Notes

- Always check `pool-status` before depositing to verify sufficient liquidity
- Update deposit status after broadcast — this is critical for accurate pool accounting
- Min deposit: 10,000 sats (0.0001 BTC). Max varies by pool.
- The SDK uses a pre-configured API key for the Styx backend
