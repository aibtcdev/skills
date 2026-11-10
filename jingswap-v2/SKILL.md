---
name: jingswap-v2
description: "Jingswap V2 limit-price auction — sbtc-stx markets with mandatory limit prices, 2-phase (no buffer), bundled close+settle. Markets: sbtc-stx-market (0% premium) and sbtc-stx-20bp-stx-premium (0.20% STX bonus)."
metadata:
  author: "Rapha-btc"
  author-agent: "Claude Code"
  user-invocable: "false"
  arguments: "cycle-state | user-deposit | clearing-preview | prices | deposit-stx | deposit-sbtc | set-stx-limit | set-sbtc-limit | cancel-stx | cancel-sbtc | close-and-settle | cancel-cycle"
  entry: "jingswap-v2/jingswap-v2.ts"
  mcp-tools: "jingswap_v2_get_cycle_state, jingswap_v2_get_user_deposit, jingswap_v2_get_clearing_preview, jingswap_v2_get_prices, jingswap_v2_deposit_stx, jingswap_v2_deposit_sbtc, jingswap_v2_set_stx_limit, jingswap_v2_set_sbtc_limit, jingswap_v2_cancel_stx, jingswap_v2_cancel_sbtc, jingswap_v2_close_and_settle_with_refresh, jingswap_v2_cancel_cycle"
  requires: "wallet"
  tags: "l2, write, requires-funds, defi"
---

# Jingswap V2 Skill

Limit-price auction for swapping sBTC against STX on Stacks. Two markets:

| Market | Contract | Premium |
|--------|----------|---------|
| `sbtc-stx-market` (default) | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-0-jing-v2` | 0% (oracle price) |
| `sbtc-stx-20bp-stx-premium` | `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-20-jing-v2` | 0.20% STX bonus |

## Key Differences from V1

- **Limit prices required** on all deposits (in sats/STX)
- **2 phases only**: deposit (10 blocks ~20s) then settle (no buffer)
- **Bundled settlement**: `close-and-settle` in a single atomic tx (reverts entirely if fails)
- **No separate close-deposits** — avoids stuck cycles
- **Limit updates** without re-depositing via `set-stx-limit` / `set-sbtc-limit`

## Usage

```
bun run jingswap-v2/jingswap-v2.ts <subcommand> [--market <pair>] [options]
```

Default market is `sbtc-stx-market`. All limit prices are in **sats/STX**.

## Subcommands

### cycle-state

Get current V2 cycle state (phase, blocks, totals).

```
bun run jingswap-v2/jingswap-v2.ts cycle-state --market sbtc-stx-20bp-stx-premium
```

### user-deposit

Get deposit amounts and limit prices for a user.

```
bun run jingswap-v2/jingswap-v2.ts user-deposit --cycle 0 --address SP...
```

### clearing-preview

Simulate settlement at current oracle — shows what will clear vs roll.

```
bun run jingswap-v2/jingswap-v2.ts clearing-preview
```

### prices

Get oracle prices with default limit suggestions.

```
bun run jingswap-v2/jingswap-v2.ts prices
```

### deposit-stx

Deposit STX with limit price (sats/STX floor). Omit `--limit` for 20% in-the-money default.

```
bun run jingswap-v2/jingswap-v2.ts deposit-stx --amount 10 --limit 240
```

### deposit-sbtc

Deposit sBTC (satoshis) with limit price (sats/STX ceiling). Omit `--limit` for 20% in-the-money default.

```
bun run jingswap-v2/jingswap-v2.ts deposit-sbtc --amount 10000 --limit 360
```

### set-stx-limit

Update STX-side limit price without re-depositing. Deposit phase only.

```
bun run jingswap-v2/jingswap-v2.ts set-stx-limit --limit 250
```

### set-sbtc-limit

Update sBTC-side limit price without re-depositing. Deposit phase only.

```
bun run jingswap-v2/jingswap-v2.ts set-sbtc-limit --limit 350
```

### cancel-stx

Cancel STX deposit for full refund. Deposit phase only.

```
bun run jingswap-v2/jingswap-v2.ts cancel-stx
```

### cancel-sbtc

Cancel sBTC deposit for full refund. Deposit phase only.

```
bun run jingswap-v2/jingswap-v2.ts cancel-sbtc
```

### close-and-settle

Close deposits and settle atomically with fresh Pyth prices. Single tx, reverts entirely if settlement fails.

```
bun run jingswap-v2/jingswap-v2.ts close-and-settle --market sbtc-stx-20bp-stx-premium
```

### cancel-cycle

Cancel cycle if settlement failed. Callable 42 blocks (~84s) after close. Rolls all deposits forward.

```
bun run jingswap-v2/jingswap-v2.ts cancel-cycle
```

## Notes

- Limit prices in sats/STX: STX depositors set a floor (min sats/STX they'll accept), sBTC depositors set a ceiling (max sats/STX they'll pay)
- Default limits are 20% in-the-money vs oracle (virtually guaranteed fill)
- Stacks blocks average ~2 seconds (Nakamoto)
- Deposit phase: 10 blocks (~20s) before close-and-settle is callable
- Cancel threshold: 42 blocks (~84s) after close
- If limits wipe a side below minimum, bundled tx reverts — no stuck cycle
- Post conditions: deposits use Deny mode; cancel/settle/cancel-cycle use Allow mode
