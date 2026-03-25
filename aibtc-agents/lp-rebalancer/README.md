---
name: lp-rebalancer
btc-address: bc1q...
stx-address: SP...
registered: false
agent-id: null
---

# LP Rebalancer — Agent Configuration

> Autonomous HODLMM liquidity position rebalancer that monitors pool conditions, assesses risk, and manages bin allocations for Bitflow DLMM pools.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | LP Rebalancer |
| Handle | lp-rebalancer |
| BTC Address | bc1q... |
| STX Address | SP... |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted — see [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |

## Skills Used

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [x] | Pool discovery via `get-hodlmm-pools`, bin data via `get-hodlmm-bins`, position data via `get-hodlmm-position-bins`, liquidity via `add-liquidity-simple` / `withdraw-liquidity-simple` |
| `hodlmm-risk` | [x] | `assess-pool` for volatility regime and risk gating before any liquidity operation |
| `hodlmm-rebalancer` | [x] | Core skill — `run` executes the full rebalance cycle, `configure` adjusts parameters, `history` reviews past actions |
| `wallet` | [x] | Wallet unlock for write operations (add/withdraw liquidity) |
| `stx` | [x] | STX balance checks and gas reserve management |
| `tokens` | [x] | Token balance checks (sBTC, STX, USDCx) |
| `settings` | [x] | Network and config management |
| `bns` | [ ] | |
| `btc` | [ ] | |
| `credentials` | [ ] | |
| `defi` | [ ] | |
| `identity` | [ ] | |
| `nft` | [ ] | |
| `ordinals` | [ ] | |
| `pillar` | [ ] | |
| `query` | [ ] | |
| `sbtc` | [ ] | |
| `signing` | [ ] | |
| `stacking` | [ ] | |
| `x402` | [ ] | |
| `yield-hunter` | [ ] | |

## Wallet Setup

```bash
# Create wallet (first time only)
bun run wallet/wallet.ts create

# Unlock wallet before write operations
bun run wallet/wallet.ts unlock --password YOUR_WALLET_PASSWORD

# Check wallet status
bun run wallet/wallet.ts status
```

**Network:** mainnet
**Wallet file:** `~/.aibtc/wallet.json`
**Fee preference:** standard

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NETWORK` | Yes | Must be `mainnet` — Bitflow HODLMM is mainnet-only |
| `HIRO_API_KEY` | No | Hiro API key for higher rate limits on Stacks queries |
| `BITFLOW_API_KEY` | No | Bitflow API key for higher rate limits (public endpoints work without) |

## Agent Decision Loop

LP Rebalancer operates on a periodic cycle:

1. **Risk Check** — Run `hodlmm-risk assess-pool --pool-id <id>` to get current volatility regime
2. **Decide** — The `hodlmm-rebalancer run` command evaluates regime + position drift and decides: `add`, `reduce`, `withdraw`, `rebalance`, `hold`, `skip`, or `emergency-withdraw`
3. **Execute** — Based on the decision:
   - `add` → Build bins and call `bitflow add-liquidity-simple`
   - `reduce` / `withdraw` / `emergency-withdraw` → Call `bitflow withdraw-liquidity-simple`
   - `rebalance` → Withdraw existing position and re-add at current active bin
   - `hold` / `skip` → No action taken
4. **Record** — Each cycle is logged to local state with timestamp, action, and txid
5. **Wait** — Sleep for configured interval, then repeat

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| Max exposure per pool | 80% | Percentage of deployable STX |
| Bin width | 10 | Number of bins per side of active bin |
| Rebalance threshold | 5 | Bin drift before triggering rebalance |
| Crisis action | emergency-withdraw | Action when regime is crisis |
| Gas reserve | 1 STX | Reserved for transaction fees |
| Dry run | false | When true, logs decisions without executing |

## Workflows

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Once / daily | Agent registration |
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | Every cycle | Before any liquidity operation |
| Pool rebalance cycle | Every 15 minutes | Core loop: assess → decide → execute |
| Position monitoring | Every 15 minutes | Track drift and concentration |

## Preferences

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | Every 6 hours | |
| Rebalance interval | Every 15 minutes | Core monitoring loop |
| Preferred DEX | bitflow | HODLMM pools only |
| Fee tier | standard | Default for STX transactions |
| Max portfolio exposure per pool | 80% (calm) / 50% (elevated) / 0% (crisis) | Governed by `hodlmm-risk` signals |
| Auto-withdraw on crisis | enabled | Emergency withdraw if regime flips to crisis |
| Bin allocation strategy | Dynamic | Width adjusts based on volatility regime |
