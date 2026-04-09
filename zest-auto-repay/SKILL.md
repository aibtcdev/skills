---
name: zest-auto-repay
description: "Autonomous Zest Protocol LTV guardian — monitors borrowing positions, detects liquidation risk, and executes safe repayments with enforced spend limits to protect collateral on Stacks mainnet."
metadata:
  author: "azagh72-creator"
  author-agent: "Flying Whale"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=monitor | run --action=repay | run --action=emergency-repay"
  entry: "zest-auto-repay/zest-auto-repay.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

## What it does

Autonomous LTV guardian for Zest Protocol v2 borrowing positions on Stacks. Continuously monitors loan-to-value ratios across all supported assets (sBTC, wSTX, stSTX, USDC, USDH, stSTXbtc), detects when positions approach liquidation thresholds, and executes safe partial repayments to restore healthy LTV. This is a **WRITE skill** — the first autonomous liquidation protection system for Zest Protocol.

## Why agents need it

Zest Protocol liquidates borrowers when LTV exceeds ~85% (partial) or ~95% (full). Liquidation penalties destroy collateral value. Manual monitoring is unreliable — a 10% price move during off-hours can trigger liquidation before the borrower reacts. This skill gives agents the ability to:

1. **Detect risk** — continuously monitor LTV across all Zest positions
2. **Classify urgency** — score positions as healthy, warning, critical, or emergency
3. **Compute safe repayments** — calculate minimum repayment to restore target LTV
4. **Execute protection** — repay debt automatically with enforced spend caps
5. **Preserve reserves** — never repay below minimum wallet reserve threshold

Without this, leveraged Zest positions are exposed to unmonitored liquidation risk 24/7.

## Zest Protocol integration

Direct integration with Zest Protocol v2 on Stacks mainnet:
- Reads position data from `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market`
- Monitors all 6 supported assets: sBTC, wSTX, stSTX, USDC, USDH, stSTXbtc
- Executes repayments via `zest_repay` MCP tool
- Fetches live interest rates from on-chain vault contracts
- Supports both self-repay and on-behalf-of repayment

## Commands

### `doctor`
Check environment readiness: wallet, balances, Zest API connectivity, active positions, current LTV.

```bash
bun run zest-auto-repay/zest-auto-repay.ts doctor
```

### `run --action=status`
Full position analysis with LTV scoring, liquidation distance, and risk classification.

```bash
bun run zest-auto-repay/zest-auto-repay.ts run --action=status
```

### `run --action=monitor`
Continuous monitoring mode. Polls position every interval, logs LTV changes, alerts on threshold crossings. Read-only — does not execute repayments.

```bash
bun run zest-auto-repay/zest-auto-repay.ts run --action=monitor --interval=300
```

### `run --action=repay`
Compute and execute a safe repayment to restore target LTV. Enforces all safety limits.

```bash
bun run zest-auto-repay/zest-auto-repay.ts run --action=repay --asset=sBTC --target-ltv=60 --max-repay=50000
```

### `run --action=emergency-repay`
Immediate maximum repayment when LTV is critical (>85%). Skips drift checks, uses higher spend cap, prioritizes speed.

```bash
bun run zest-auto-repay/zest-auto-repay.ts run --action=emergency-repay --asset=sBTC
```

## Safety notes

All limits are **implemented and enforced** in the TypeScript file, not just documented:

| Control | Default | Enforced |
|---------|---------|----------|
| Max repay per operation | 50,000 sats (0.0005 BTC) | `--max-repay` flag, hard cap 500,000 sats |
| Target LTV after repay | 60% | `--target-ltv` flag, range 30-75% |
| Warning LTV threshold | 70% | Triggers alert, no auto-action |
| Critical LTV threshold | 80% | Triggers auto-repay if enabled |
| Emergency LTV threshold | 85% | Triggers emergency-repay |
| Minimum wallet reserve | 5,000 sats | **Always enforced**, never repays below this |
| Cooldown between repays | 600 seconds | Tracked per-session |
| Absolute hard cap per repay | 500,000 sats (0.005 BTC) | Cannot be overridden by any flag |
| Absolute hard cap per day | 1,000,000 sats (0.01 BTC) | Cannot be overridden by any flag |

## Output contract

All commands output structured JSON:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": { },
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

### Error codes

| Code | Meaning |
|------|---------|
| `no_wallet` | Wallet not unlocked or STACKS_ADDRESS not set |
| `insufficient_balance` | Not enough tokens to repay (after reserve) |
| `no_position` | No active Zest borrowing position found |
| `healthy_ltv` | LTV is below warning threshold — no action needed |
| `exceeds_hard_cap` | Requested repayment exceeds absolute safety cap |
| `exceeds_daily_cap` | Daily repayment limit already reached |
| `cooldown_active` | Must wait before next repayment operation |
| `api_unreachable` | Zest Protocol API not responding |
| `repay_failed` | On-chain repayment transaction failed |

## On-chain proof

| Evidence | Detail |
|----------|--------|
| Wallet | `SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW` |
| BTC Address | `bc1qdfm56pmmq40me84aau2fts3725ghzqlwf6ys7p` |
| sBTC Balance | 28,306 sats active on Zest-eligible wallet |
| DLMM NFTs | 387 NFTs across Bitflow pools (cross-protocol DeFi activity) |
| Stableswap LP | 771M tokens in USDH-USDCx pool |
| Agent | Flying Whale — Genesis L2, ERC-8004 #54 on aibtc.com |
| Explorer | [View on Hiro](https://explorer.hiro.so/address/SP322ZK4VXT3KGDT9YQANN9R28SCT02MZ97Y24BRW?chain=mainnet) |

## Architecture

```
Agent invokes skill
  -> doctor: pre-flight checks (wallet, gas, API, position, LTV)
  -> status: fetch all Zest positions -> LTV scoring -> risk classification
  -> monitor: continuous polling -> LTV tracking -> alert on threshold crossing
  -> repay: pre-flight -> LTV check -> compute safe amount -> enforce caps -> emit repay tx
  -> emergency-repay: minimal checks -> max safe repayment -> immediate execution
```

The skill does NOT broadcast transactions directly. It computes parameters and emits structured MCP command objects that the agent framework executes. This separation ensures the agent always has final approval before any on-chain write.

## Known constraints

- Zest Protocol v2 mainnet only — no testnet support
- Repayment amount is denominated in the borrowed asset's smallest unit
- zToken shares appreciate over time — withdrawal amounts may differ from supply amounts
- Interest accrues continuously — LTV can increase between checks
- Liquidation can occur between monitoring intervals during extreme volatility
- Requires STX for transaction fees (separate from repayment amount)
- On-behalf-of repayment requires the borrower's address
