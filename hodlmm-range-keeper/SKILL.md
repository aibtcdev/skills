---
name: hodlmm-range-keeper
description: "Active HODLMM position manager that monitors bin drift, estimates accrued fees, and re-centers liquidity around the active bin when profitable."
metadata:
  author: "tearful-saw"
  author-agent: "Elegant Orb"
  user-invocable: "false"
  arguments: "doctor | status | plan | recenter | run | history | install-packs"
  entry: "hodlmm-range-keeper/hodlmm-range-keeper.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Range Keeper

## What it does
Actively manages HODLMM concentrated-liquidity positions by monitoring active-bin drift, estimating fee accrual, and re-centering LP ranges when the market moves away. Unlike signal-only analytics skills, this closes the full management loop: detect drift, plan the re-center, simulate the outcome, execute via MCP tools, and verify. Supports autonomous `run` mode that scans all pools and re-centers any drifted position in a single cycle.

## Why agents need it
HODLMM concentrated liquidity earns fees only when the active bin is within your position range. When price moves, the active bin drifts away and your liquidity sits idle — earning nothing while exposed to impermanent loss. Manual monitoring is impractical across multiple pools. This skill turns passive LP deposits into actively managed positions: it tracks where your bins are, where the market is, and moves your liquidity to stay in range and keep earning.

## Safety notes
- **Writes to chain**: Withdraws liquidity and re-deposits into new bins. Real funds move.
- **Drift threshold**: Will not re-center unless the active bin drifts >= 3 bins from your position center (configurable).
- **Cooldown**: 30-minute cooldown between recenters on the same pool to prevent churn.
- **Gas cap**: 50 STX maximum per cycle. Will not execute if gas estimate exceeds cap.
- **Dust filter**: Ignores positions < 5,000 sats to avoid unprofitable micro-recenters.
- **--confirm gate**: The `recenter` command requires explicit `--confirm` flag. Without it, nothing executes.
- **Fee preservation**: Tracks deposit baselines per bin. On re-center, fees above baseline are harvested (kept); only principal is re-deployed.
- **Mainnet only**: HODLMM is not available on testnet.
- **MCP execution**: Actual on-chain transactions are emitted as MCP tool calls (`bitflow_hodlmm_remove_liquidity`, `bitflow_hodlmm_add_liquidity`). The agent runtime executes them.

## Commands

### doctor
Check wallet, HODLMM API access, pool availability, existing positions, and MCP tool requirements. Read-only, safe to run anytime.
```bash
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts doctor
```

### status
Analyze all LP positions: drift magnitude, range efficiency (% of bins in active range), estimated fees, and whether re-centering is needed. Records fee baselines locally on first observation; otherwise read-only.
```bash
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts status
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts status --pool dlmm_1
```

### plan
Dry-run a re-center: simulate withdraw and re-deposit, show expected bin layout, fees harvested, gas cost. No funds move.
```bash
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts plan --pool dlmm_1
```

### recenter
Execute the re-center: withdraw from drifted bins, harvest fees, re-deposit principal around active bin. Requires --confirm.
```bash
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts recenter --pool dlmm_1 --confirm
```

### run
Full autonomous cycle: scan all pools, assess drift, plan and execute recenters where needed. Use --confirm for live execution, omit for dry-run.
```bash
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts run
STX_ADDRESS=SP... bun run hodlmm-range-keeper/hodlmm-range-keeper.ts run --confirm
```

### history
Show past re-center events from local ledger. Useful for auditing position management.
```bash
bun run hodlmm-range-keeper/hodlmm-range-keeper.ts history
bun run hodlmm-range-keeper/hodlmm-range-keeper.ts history --pool dlmm_1 --limit 10
```

## Output contract

All outputs are JSON to stdout. Logs go to stderr.

**Success:**
```json
{ "status": "success", "action": "status", "data": { "positionsAnalyzed": 2, "needsRecenter": 1, "positions": [...] }, "error": null }
```

**Recenter ready:**
```json
{ "status": "success", "action": "execute_mcp", "data": { "step1_withdraw": { "tool": "bitflow_hodlmm_remove_liquidity", "params": {...} }, "step2_deposit": { "tool": "bitflow_hodlmm_add_liquidity", "params": {...} }, "summary": {...} }, "error": null }
```

**Blocked:**
```json
{ "status": "blocked", "action": "recenter", "data": { "cooldownRemainingMinutes": 15 }, "error": "Cooldown active." }
```

**Error:**
```json
{ "status": "error", "action": "recenter", "data": null, "error": "Pool dlmm_99 not found." }
```

### install-packs
No external packs required. Returns success immediately.
```bash
bun run hodlmm-range-keeper/hodlmm-range-keeper.ts install-packs --pack all
```

## Known constraints
- Mainnet only — HODLMM has no testnet deployment
- Fee estimation requires a baseline — first `status` after fresh install records current state as baseline (zero estimated fees until next check)
- Position re-centering executes as two sequential MCP calls (withdraw then deposit) — partial failure is possible if the deposit tx fails after a successful withdraw. In that case, funds are in the wallet, not lost. State is recorded optimistically before MCP execution; on partial failure, baselines reset and the next `status` call re-establishes them from current on-chain state.
- Active bin can move between the plan and recenter steps. The skill uses the latest active bin at execution time.
- HODLMM API (`bff.bitflowapis.finance`) may lag 1-2 blocks behind chain state
- Gas estimation is conservative (4 STX for 2 txs). Actual gas is typically lower.
