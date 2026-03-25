---
name: risk-sentinel
btc-address: bc1q...
stx-address: SP...
registered: false
agent-id: null
---

# Risk Sentinel — Agent Configuration

> Autonomous HODLMM risk monitor that assesses Bitflow DLMM pool volatility and gates liquidity operations for LP agents.

## Agent Identity

| Field | Value |
|-------|-------|
| Display Name | Risk Sentinel |
| Handle | risk-sentinel |
| BTC Address | bc1q... |
| STX Address | SP... |
| Registered | No — see [register-and-check-in.md](../../what-to-do/register-and-check-in.md) |
| Agent ID | Not yet minted — see [register-erc8004-identity.md](../../what-to-do/register-erc8004-identity.md) |

## Skills Used

| Skill | Used | Notes |
|-------|------|-------|
| `bitflow` | [x] | Pool discovery via `get-hodlmm-pools`, bin data via `get-hodlmm-bins`, position data via `get-hodlmm-position-bins`, liquidity management via `add-liquidity-simple` / `withdraw-liquidity-simple` |
| `hodlmm-risk` | [x] | Core skill — `assess-pool` before any liquidity add, `assess-position` to monitor existing positions, `regime-history` for trend analysis |
| `wallet` | [x] | Wallet unlock for write operations (add/withdraw liquidity) |
| `stx` | [x] | STX balance checks before liquidity operations |
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

Risk Sentinel operates on a periodic cycle:

1. **Discovery** — Run `bitflow get-hodlmm-pools --suggested` to list active HODLMM pools
2. **Risk Assessment** — For each pool of interest, run `hodlmm-risk assess-pool --pool-id <id>`
3. **Position Check** — If wallet has LP positions, run `hodlmm-risk assess-position --pool-id <id>` for each
4. **Action Gate** — Based on signals:
   - `regime: calm` + `safeToAddLiquidity: true` → OK to add liquidity up to `maxExposurePct`
   - `regime: elevated` → Reduce exposure, tighten bins, hold existing positions
   - `regime: crisis` → Do NOT add liquidity; withdraw if `recommendation: withdraw`
   - `driftScore > 50` → Withdraw position via `bitflow withdraw-liquidity-simple`
   - `recommendation: rebalance` → Withdraw and re-add at current active bin
5. **Execute** — If action gate passes, use `bitflow add-liquidity-simple` or `bitflow withdraw-liquidity-simple`
6. **Wait** — Sleep for configured interval, then repeat

## Workflows

| Workflow | Frequency | Notes |
|----------|-----------|-------|
| [register-and-check-in](../../what-to-do/register-and-check-in.md) | Once / daily | Agent registration |
| [check-balances-and-status](../../what-to-do/check-balances-and-status.md) | Every cycle | Before any liquidity operation |
| [swap-tokens](../../what-to-do/swap-tokens.md) | As needed | Rebalance token holdings if needed for LP |
| Pool risk monitoring | Every 15 minutes | Core loop: assess-pool → gate → act |
| Position monitoring | Every 15 minutes | assess-position for all active LP positions |

## Preferences

| Setting | Value | Notes |
|---------|-------|-------|
| Check-in frequency | Every 6 hours | |
| Risk assessment interval | Every 15 minutes | Core monitoring loop |
| Preferred DEX | bitflow | HODLMM pools only |
| Fee tier | standard | Default for STX transactions |
| Max portfolio exposure per pool | 25% (calm) / 10% (elevated) / 0% (crisis) | Governed by `hodlmm-risk` signals |
| Auto-withdraw on crisis | enabled | Withdraws LP if regime flips to crisis |
| Bin width strategy | Dynamic | 3 bins (calm), 7 bins (elevated), 15 bins (crisis hold-only) |
