---
name: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest safe live yield path and executes capped Zest supply when Zest is the best current route."
metadata:
  author: "Ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | install-packs | status | run"
  entry: "sbtc-yield-maximizer/sbtc-yield-maximizer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# sBTC Yield Maximizer

## What it does

Compares live Zest sBTC yield against current Bitflow sBTC HODLMM opportunity and routes idle sBTC to the highest safe path. This version executes a real Zest sBTC supply transaction when Zest is the winning route and blocks when HODLMM is better but not safely executable by this standalone skill version.

## Why agents need it

Agents should not deploy sBTC based on static assumptions. They need a real decision layer that checks current yield, stale pricing risk, HODLMM liquidity quality, and wallet reserves before capital moves. This skill turns that decision into a repeatable, guardrailed write flow.

## Safety notes

- Writes to chain. `run` signs and broadcasts a real Zest sBTC supply transaction when Zest is the winning route.
- Mainnet only. Routing data and write execution target live mainnet protocols.
- Wallet password required. The skill unlocks the local AIBTC wallet at execution time using `AIBTC_WALLET_PASSWORD`.
- Reserve enforced. The wallet retains at least `--reserve-sats` after the write path.
- Deploy cap enforced. The routed amount is capped by `--max-deploy-sats`.
- Gas reserve enforced. The wallet must keep at least `--min-gas-reserve-ustx`.
- Post-conditions enforced. The Zest service-layer write path uses `PostConditionMode.Deny`.
- HODLMM stale-price gate enforced. Pools with price divergence above `--max-price-divergence-pct` are disqualified from winning.
- HODLMM liquidity gates enforced. Pools below the configured TVL or 24h volume floors are disqualified.
- Cooldown enforced. Repeated route execution is blocked until `--cooldown-hours` has elapsed.
- Explicit confirmation required. `run` refuses to execute unless `--confirm=MAXIMIZE` is provided.
- Wallet is re-locked after the attempted write path.

## Commands

### doctor
Checks wallet resolution, STX and sBTC balances, Zest vault reads, Bitflow pool reads, and whether the current configuration can execute the winning route safely.

```bash
bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts doctor
```

### install-packs
Lists the required runtime packages used by this skill.

```bash
bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts install-packs
```

### status
Shows live balances, route candidates, route scores, Zest rate reads, the top HODLMM candidate, and the current winning route.

```bash
bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts status
```

### run
Unlocks the wallet, re-checks the route decision, and executes a real Zest sBTC supply when Zest is the winning safe route.

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts run --confirm=MAXIMIZE
```

Example tuned run:

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts run --wallet-id=b4d575f8-0865-4d6f-b1d6-5627b645a03c --max-deploy-sats=100 --reserve-sats=100 --min-gas-reserve-ustx=100000 --min-hodlmm-volume-usd=1000 --min-hodlmm-tvl-usd=1000 --max-price-divergence-pct=0.5 --confirm=MAXIMIZE
```

## Output contract

All outputs are JSON to stdout.

**Success:**

```json
{
  "status": "success",
  "action": "Supplied sBTC to Zest because it was the highest safe executable yield route",
  "data": {
    "operation": "maximize-yield",
    "txid": "0x...",
    "explorerUrl": "https://explorer.hiro.so/txid/0x...?chain=mainnet"
  },
  "error": null
}
```

**Blocked:**

```json
{
  "status": "blocked",
  "action": "Hold idle sBTC until a safe executable route is available",
  "data": {},
  "error": {
    "code": "PREFLIGHT_BLOCKED",
    "message": "No executable route passed the configured safety gates",
    "next": "Re-run later or adjust thresholds with explicit operator approval"
  }
}
```

**Error:**

```json
{ "error": "descriptive message" }
```

## Known constraints

- This version executes the Zest route when Zest is the winning route. When HODLMM wins, the skill reports that outcome but does not attempt a direct HODLMM LP deposit.
- Zest sBTC yield is derived from live on-chain Zest vault reads and interpreted as a basis-points-style supply signal. This was verified against the live `v0-vault-sbtc` source, which defines `BPS u10000` and applies rate math in basis points.
- HODLMM opportunity is derived from live Bitflow app and quote APIs using APR, fee run-rate, volume, TVL, and stale-price checks.
- Requires enough sBTC to exceed reserve and enough STX to preserve gas reserve.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @Ololadestephen
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/243
