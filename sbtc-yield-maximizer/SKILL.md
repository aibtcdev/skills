---
name: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest safe live yield path and executes either capped Zest supply or a HODLMM rebalance when the winning route is safely executable."
metadata:
  author: "Ololadestephen"
  author-agent: "Wide Eden"
  user-invocable: "false"
  arguments: "doctor | install-packs | status | run"
  entry: "sbtc-yield-maximizer/sbtc-yield-maximizer.ts"
  requires: "wallet, signing, settings, hodlmm-move-liquidity, bitflow"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# sBTC Yield Maximizer

## What it does

Compares live Zest sBTC yield against current Bitflow sBTC HODLMM opportunity and routes idle sBTC to the highest safe path. This version executes a real Zest sBTC supply transaction when Zest is the winning route and executes the HODLMM leg by orchestrating `hodlmm-move-liquidity` via CLI when HODLMM is the winning safe executable route.

## Why agents need it

Agents should not deploy sBTC based on static assumptions. They need a real decision layer that checks current yield, stale pricing risk, HODLMM liquidity quality, and wallet reserves before capital moves. This skill turns that decision into a repeatable, guardrailed write flow.

## Safety notes

- Writes to chain. `run` signs and broadcasts a real Zest sBTC supply transaction when Zest is the winning route, or a real HODLMM rebalance when HODLMM wins.
- Mainnet only. Routing data and write execution target live mainnet protocols.
- Wallet password required. The skill unlocks the local AIBTC wallet at execution time using `AIBTC_WALLET_PASSWORD`.
- Reserve enforced. The wallet retains at least `--reserve-sats` after the write path.
- Deploy cap enforced. The routed amount is capped by `--max-deploy-sats`.
- Gas reserve enforced. The wallet must keep at least `--min-gas-reserve-ustx`.
- Post-conditions enforced. The Zest service-layer write path uses `PostConditionMode.Deny`.
- HODLMM stale-price gate enforced. HODLMM reads older than `--max-data-age-seconds` or pools with price divergence above `--max-price-divergence-pct` are disqualified.
- HODLMM liquidity gates enforced. Pools below the configured TVL or 24h volume floors are disqualified.
- APY edge gate enforced. The route only rotates when the winning venue leads by at least `--min-apy-diff-bps`.
- Meta-cooldown enforced. Repeated route execution is blocked until `--cooldown-hours` has elapsed.
- Mempool-depth guard enforced. Execution is blocked when pending sender depth exceeds `--mempool-depth-limit`.
- HODLMM execution delegates to `hodlmm-move-liquidity` via CLI, keeps the wallet password in environment scope rather than subprocess CLI args, and respects the upstream per-pool cooldown/state.
- Explicit confirmation required. `run` refuses to execute unless `--confirm=MAXIMIZE` is provided.
- Wallet is re-locked after the attempted write path.

## Commands

### doctor
Checks wallet resolution, STX and sBTC balances, Zest vault reads, Bitflow pool reads, mempool depth, and whether the current configuration can execute the winning route safely.

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
Unlocks the wallet, re-checks the route decision, and executes the winning safe route:
- Zest sBTC supply when Zest wins
- HODLMM rebalance via `hodlmm-move-liquidity` when HODLMM wins and the current position is out of range

```bash
AIBTC_WALLET_PASSWORD='your-password' bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts run --confirm=MAXIMIZE
```

Example tuned run:

```bash
AIBTC_WALLET_PASSWORD='your-password' HODLMM_MOVE_LIQUIDITY_CMD='bun run /path/to/hodlmm-move-liquidity.ts' bun run sbtc-yield-maximizer/sbtc-yield-maximizer.ts run --wallet-id=b4d575f8-0865-4d6f-b1d6-5627b645a03c --max-deploy-sats=10000 --reserve-sats=100 --min-gas-reserve-ustx=100000 --min-hodlmm-volume-usd=1000 --min-hodlmm-tvl-usd=1000 --max-price-divergence-pct=0.5 --min-apy-diff-bps=50 --max-data-age-seconds=30 --mempool-depth-limit=0 --confirm=MAXIMIZE
```

## Output contract

All outputs are JSON to stdout.

**Success:**

```json
{
  "status": "success",
  "action": "Executed the highest safe yield route",
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

- This version composes with `hodlmm-move-liquidity` by CLI rather than source imports. That upstream primitive remains the source of truth for the HODLMM write path.
- The HODLMM preflight path uses `hodlmm-move-liquidity scan`, which is a no-broadcast command. Actual HODLMM execution only happens on the delegated `run --confirm` path.
- Zest sBTC yield is derived from live on-chain Zest vault reads and interpreted as a basis-points-style supply signal. This was verified against the live `v0-vault-sbtc` source, which defines `BPS u10000` and applies rate math in basis points.
- HODLMM opportunity is derived from live Bitflow app and quote APIs using APR, fee run-rate, volume, TVL, stale-price checks, and whether the wallet already has an out-of-range LP position that can be rebalanced.
- Requires enough sBTC to exceed reserve and enough STX to preserve gas reserve.
- Wallet-scoped state now lives under `~/.aibtc/`. This intentionally starts fresh on upgrade rather than migrating the previous shared `~/.sbtc-yield-maximizer-state.json` cooldown file.
