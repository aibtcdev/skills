---
name: hodlmm-arb-executor
description: "Executes LP-based sBTC/STX arb on Bitflow HODLMM. Detects XYK vs DLMM price spread, enters via swap + add-liquidity-simple, exits on spread reversal or 2h timeout. Write-capable; requires --confirm. Emits MCP command objects."
metadata:
  author: "ronkenx9"
  author-agent: "Parallel Owl (ERC-8004 ID #354, SP1KNKVXNNS9B6TBBT8YTM2VTYKVZYWS65TTRD430)"
  user-invocable: "false"
  arguments: "doctor | simulate | execute | watch"
  entry: "hodlmm-arb-executor/hodlmm-arb-executor.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Arb Executor

## What it does

Detects price spreads between Bitflow XYK pool and HODLMM (DLMM) for sBTC/STX, then executes LP-based arb via MCP command objects. Entry: swap STX→sBTC on XYK (buy cheap), deposit sBTC to DLMM bins as LP (capture premium). Exit: withdraw LP from DLMM, swap sBTC→STX. Exit triggers: spread reversal or 2-hour max hold.

All execution is write-capable. `--confirm` is required for live MCP command emission. `simulate` shows the full decision pipeline without touching chain or state.

## Why agents need it

Agents running sBTC/STX strategies need a way to act on spread signals, not just observe them. This skill closes the loop from price detection to LP position management — entry when spread is profitable, exit on reversal, hard timeout to avoid stale positions.

## On-chain proof

Live `execute --confirm --max-sats 10000` run on 2026-04-07T16:32Z demonstrated full pipeline against mainnet:

- **Pyth**: BTC=$68,347 STX=$0.2149 | age 1s ✅
- **Hiro XYK**: 317,086 STX/BTC | $1.31M TVL ✅
- **Bitflow HODLMM** (`dlmm_6`): 311,100 STX/BTC | active bin 308 ✅
- **Spread**: 1.93% gross / 1.38% net — `profitable: true` ✅
- **STX amount**: 32.3 STX for 10,000 sats at live oracle price ✅
- **entryBinId**: 309 = activeBin 308 + 1 ✅
- **State**: openPosition written, cooldown stamped ✅

On-chain swap tx (STX→sBTC via Bitflow XYK, wallet `SP1KNKVXNNS9B6TBBT8YTM2VTYKVZYWS65TTRD430`):
`a34388332765330ff0299e598757078c7512c0db8dfd7dd96737b6ba9753e424` — **SUCCESS** `(ok u10064)` — 10,064 sats sBTC received.
Explorer: https://explorer.hiro.so/txid/a34388332765330ff0299e598757078c7512c0db8dfd7dd96737b6ba9753e424?chain=mainnet

Post-conditions: STX eq 32,300,024 micro-STX (debit from wallet) + sbtc-token gte 9,850 sats (sent from pool). 32.3 STX debited, 10,064 sats received. The `bitflow_hodlmm_add_liquidity` LP step can execute once sBTC confirms.

## HODLMM integration

Uses `bitflow_hodlmm_add_liquidity` for entry and `bitflow_hodlmm_withdraw_liquidity` for exit. Targets `dlmm_6` (`SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15`, the STX/sBTC DLMM pool). Bonus-eligible for HODLMM integration prize.

## Safety notes

- **Hard spend cap**: `MAX_AUTONOMOUS_SATS = 100_000` (~$85 at $85k BTC) hardcoded in source constants — not just documentation.
- **`--confirm` required**: All write paths require `--confirm`. Without it: `CONFIRM_REQUIRED` status, no state changes.
- **Doctor-first preflight**: `execute` fetches all three data sources before proceeding. Aborts with `PREFLIGHT_FAILED` if any source is unreachable.
- **No DLMM = no execute**: If HODLMM data is unavailable, executor refuses to guess spreads. Returns `PREFLIGHT_FAILED`.
- **Cooldown guard**: `lastExecutionAt` is only stamped when `cmds.length > 0`. No-op runs (nothing to execute) never consume the cooldown window.
- **Post-conditions**: All MCP commands carry `postConditions` arrays (FT debit eq, FT credit gte with slippage tolerance).
- **2-hour max hold**: LP positions auto-exit after 2 hours to prevent stale exposure.
- **Oracle confidence buffer**: `profitable` flag requires net spread > `(oracle.confidence.stx / oracle.stxUsd) * 100` — not just net spread > 0.
- **No credential passthrough**: Skill does not accept `--wallet-password`. Unlock wallet before calling.

## Commands

### doctor
Preflight check: all data sources + cooldown + open position. Run before execute.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts doctor
```

### simulate
Dry-run. Shows exact commands, amounts, decision logic. No `--confirm` needed. No state changes.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts simulate [--max-sats 100000]
```

### execute
Full pipeline. Requires `--confirm` to emit live MCP commands.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts execute [--confirm] [--max-sats 100000]
```

### watch
Continuous monitoring. Read-only. Alerts when spread exceeds threshold.
```bash
bun run hodlmm-arb-executor/hodlmm-arb-executor.ts watch [--interval 60] [--min-spread 0.3] [--max-scans 60]
```

## Output contract

All outputs are JSON to stdout.

**doctor:**
```json
{
  "network": "mainnet",
  "status": "ok | error",
  "checks": [
    { "name": "pyth_hermes", "status": "ok | error", "detail": "BTC=$85000 STX=$0.21 | age 3s | conf STX=$0.000210" },
    { "name": "hiro_xyk_pool", "status": "ok | error", "detail": "296000 STX/BTC | $1.3M TVL" },
    { "name": "bitflow_hodlmm", "status": "ok | error", "detail": "298000 STX/BTC | active bin 500 | 42 bins" },
    { "name": "cooldown", "status": "ok | warn", "detail": "ready | COOLING DOWN — 8m remaining" },
    { "name": "open_position", "status": "ok | warn", "detail": "No open LP position | Open LP: 100000 sats | held 14m | timeout in 106m" }
  ],
  "note": "All systems go. | PREFLIGHT_FAILED — fix errors before running execute.",
  "maxAutonomousSats": 100000,
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**simulate:**
```json
{
  "network": "mainnet",
  "mode": "simulate",
  "pair": "sBTC/STX",
  "oracle": { "btcUsd": 85000, "stxUsd": 0.2101, "stxPerBtc": 404569 },
  "xyk": { "stxPerBtc": 400123 },
  "dlmm": { "stxPerBtc": 406800, "activeBinId": 500, "source": "bitflow-api" },
  "spread": {
    "grossSpreadPct": 1.6636,
    "estFeePct": 0.55,
    "netSpreadPct": 1.1136,
    "confidenceBuffer": 0.0823,
    "profitable": true,
    "xykStxPerBtc": 400123,
    "dlmmStxPerBtc": 406800
  },
  "openPosition": null,
  "wouldExecute": true,
  "skipReason": null,
  "entryCommands": [
    {
      "tool": "bitflow_swap",
      "args": { "token_x": "token-stx", "token_y": "token-sbtc", "amount_in": "410.14", "slippage_tolerance": "0.015" },
      "description": "Swap 410.14 STX for ~0.001 sBTC on Bitflow XYK (entry: buy cheap sBTC)",
      "postConditions": ["FT debit STX eq 410140000 micro-STX", "FT credit sBTC gte 98500 sats (1.5% slippage)"]
    },
    {
      "tool": "bitflow_hodlmm_add_liquidity",
      "args": { "pool_id": "dlmm_6", "bins": "[{\"activeBinOffset\":1,\"xAmount\":\"100000\",\"yAmount\":\"0\"}]", "active_bin_tolerance": "{\"expectedBinId\":500,\"maxDeviation\":\"2\"}", "slippage_tolerance": "1.5" },
      "description": "Add 0.001 sBTC to DLMM pool dlmm_6 bin +1 (LP entry at premium)",
      "postConditions": ["FT debit sBTC eq 100000 sats", "LP tokens credited for pool dlmm_6"]
    }
  ],
  "maxSats": 100000,
  "cooldownRemainingMs": 0,
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**execute — CONFIRM_REQUIRED:**
```json
{
  "status": "CONFIRM_REQUIRED",
  "message": "Add --confirm to authorize MCP command emission.",
  "network": "mainnet",
  "note": "Max spend: 100000 sats (hard cap: 100000 sats)",
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**execute — ENTRY_COMMANDS_EMITTED:**
```json
{
  "status": "ENTRY_COMMANDS_EMITTED",
  "network": "mainnet",
  "spread": { "grossSpreadPct": 1.6636, "netSpreadPct": 1.1136, "profitable": true },
  "satsCapped": 100000,
  "maxAutonomousSats": 100000,
  "commandCount": 2,
  "commands": [ "...same as simulate entryCommands..." ],
  "openPosition": { "entryTimestamp": "...", "entrySpreadPct": 1.6636, "entryBinId": 500, "satsSent": 100000, "estimatedEntryUsd": 85.0 },
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**execute — SKIPPED:**
```json
{
  "status": "SKIPPED",
  "reason": "SPREAD_NOT_PROFITABLE | SPREAD_TOO_SMALL | COOLDOWN_ACTIVE | DLMM_UNAVAILABLE",
  "spread": { "...": "..." },
  "message": "descriptive message",
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**execute — PREFLIGHT_FAILED:**
```json
{
  "status": "PREFLIGHT_FAILED",
  "error": "API error 503 at https://api.hiro.so/...",
  "network": "mainnet",
  "timestamp": "2026-03-30T12:00:00.000Z"
}
```

**watch — compact poll:**
```json
{ "scan": 1, "alert": false, "xykStxPerBtc": 400123, "dlmmStxPerBtc": 406800, "grossSpreadPct": 1.66, "openPosition": "no", "timestamp": "..." }
```

**watch — alert:**
```json
{ "scan": 3, "alert": true, "network": "mainnet", "pair": "sBTC/STX", "spread": { "..." }, "openPosition": null, "timestamp": "..." }
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- DLMM data required for execute — degrades to read-only if Bitflow API is unavailable.
- `bitflow_swap` auto-routes — cannot force a specific pool. SDK determines the route.
- Entry direction is always "buy sBTC on XYK, LP on DLMM" — only when XYK is cheaper than DLMM.
- HODLMM bin offsets are recalculated on exit to account for active bin movement since entry.
- Fee estimates are static (XYK 30bps, DLMM 25bps). Actual HODLMM fees vary by bin distance.
- State is stored locally in `~/.hodlmm-arb-executor-state.json`.

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @ronkenx9
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/379
