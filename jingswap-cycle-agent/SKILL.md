---
name: jingswap-cycle-agent
description: "JingSwap STX↔sBTC cycle monitor and participation agent. Reads live cycle state and prices directly from the Stacks contract via Hiro API and Pyth oracle — no API key required. Outputs PARTICIPATE / MONITOR / WAIT_FOR_DEPOSIT_PHASE / NO_SBTC_AVAILABLE with oracle-vs-DEX discount analysis."
metadata:
  author: "teflonmusk"
  author-agent: "Dual Cougar"
  user-invocable: "false"
  arguments: "doctor | status | analyze | participate"
  entry: "jingswap-cycle-agent/jingswap-cycle-agent.ts"
  requires: "wallet, jingswap"
  tags: "defi, write, mainnet-only, l2"
---

# jingswap-cycle-agent

## What it does

Monitors the active JingSwap cycle and evaluates whether the Pyth oracle settlement rate offers a favourable sBTC acquisition opportunity relative to live DEX prices.

| Data source | What it reads | Why it matters |
|---|---|---|
| `sbtc-stx-jing-v2` contract (Hiro read-only API) | Cycle ID, phase, blocks elapsed, deposits, minimums | Is the cycle in deposit phase? Is sBTC available? |
| Pyth Hermes oracle | BTC/USD and STX/USD live prices | Computes oracle STX/sBTC settlement rate |
| `get-dlmm-price` (contract) | DLMM pool price (1e10 / raw) | Best DEX rate for comparison |
| `get-xyk-price` (contract) | XYK pool price (raw / 1e8) | Secondary DEX rate cross-check |

JingSwap settles at the Pyth oracle rate, not the DEX rate. When oracle < DEX, depositing STX acquires sBTC cheaper than buying on-market — the arbitrage window. This skill quantifies that spread in real time.

## Why agents need it

JingSwap's API (`faktory-dao-backend.vercel.app`) requires an `x-api-key`. This skill bypasses it entirely by reading the Stacks contract directly via the public Hiro read-only endpoint. No credentials needed.

The `analyze` command distils the cycle state + two price sources into a single `action` field — agents don't need to know the contract encoding or Pyth feed IDs.

## Safety notes

- Read-only for `doctor`, `status`, `analyze` — no wallet required.
- `participate` (without `--dry-run`) outputs a `DEPOSIT_READY` JSON payload — **parent agent must confirm** before calling `jingswap_deposit_stx`.
- Mainnet only — JingSwap v2 contract is mainnet-only.
- Always uses live contract reads — never caches cycle state.

## Commands

### doctor
Checks Hiro contract API and Pyth Hermes connectivity.
```bash
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts doctor
```

Output:
```json
{
  "result": "ready",
  "checks": {
    "hiro_contract_api": "ok",
    "pyth_hermes_api": "ok"
  },
  "contract": "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2"
}
```

### status
Fetches full cycle state + price snapshot.
```bash
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts status
```

Output:
```json
{
  "skill": "jingswap-cycle-agent",
  "timestamp": "2026-03-29T15:22:18.792Z",
  "contract": "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2",
  "cycle": {
    "id": 9,
    "phase": "deposit",
    "blocks_elapsed": 191,
    "sbtc_deposited": "0.01929494 sBTC",
    "stx_deposited": "0.00 STX",
    "min_stx_deposit": "1.00 STX",
    "min_sbtc_deposit": "0.00001000 sBTC"
  },
  "prices": {
    "btc_usd": "66488.42",
    "stx_usd": "0.216440",
    "oracle_stx_per_sbtc": "307191.64",
    "dex_stx_per_sbtc_dlmm": "305922.66",
    "dex_stx_per_sbtc_xyk": "305306.01",
    "oracle_vs_dex_discount_pct": "-0.394"
  },
  "summary": "Cycle 9 in deposit phase. Oracle 0.39% MORE EXPENSIVE than DEX."
}
```

### analyze
Evaluates whether the current cycle offers a favourable entry.
```bash
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts analyze
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts analyze --min-discount 2.0
```

Options:
- `--min-discount <pct>` (default: `1.0`) — minimum oracle discount vs DEX to trigger PARTICIPATE

Output:
```json
{
  "skill": "jingswap-cycle-agent",
  "timestamp": "2026-03-29T15:22:27.573Z",
  "contract": "SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2",
  "input": { "min_discount_pct": 1 },
  "cycle": {
    "id": 9,
    "phase": "deposit",
    "sbtc_available": "0.01929494 sBTC",
    "stx_deposited": "0.00 STX"
  },
  "pricing": {
    "oracle_stx_per_sbtc": "307148.46",
    "dex_stx_per_sbtc": "305922.66",
    "discount_pct": "-0.401"
  },
  "action": "MONITOR",
  "confidence": "high",
  "is_favourable": false,
  "rationale": "Oracle rate (307148 STX/sBTC) is 0.40% MORE expensive than DEX (305923 STX/sBTC). Spread does not meet minimum discount threshold of 1%.",
  "summary": "MONITOR (high confidence) — cycle 9 (deposit), oracle 0.40% premium vs DEX."
}
```

### participate
Evaluates opportunity and (if favourable) prepares deposit parameters for parent agent execution.
```bash
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts participate --amount-stx 100
bun run jingswap-cycle-agent/jingswap-cycle-agent.ts participate --amount-stx 100 --min-discount 2.0 --dry-run
```

Options:
- `--amount-stx <amount>` (required) — STX amount to deposit
- `--min-discount <pct>` (default: `1.0`) — minimum discount required to proceed
- `--dry-run` — analyse only, do not output execution payload

When favourable, outputs:
```json
{
  "skill": "jingswap-cycle-agent",
  "action": "DEPOSIT_READY",
  "deposit_params": {
    "amount_stx": 100,
    "amount_micro_stx": 100000000,
    "market": "sbtc-stx",
    "cycle": 9
  },
  "instruction": "Parent agent: call jingswap_deposit_stx with amount=100000000 and market=sbtc-stx to execute this deposit. Confirm before proceeding."
}
```

## Action values

| Action | Meaning |
|---|---|
| `PARTICIPATE` | Oracle < DEX by ≥ min-discount — deposit STX to acquire sBTC below market |
| `MONITOR` | Spread present but below threshold — watch and retry |
| `WAIT_FOR_DEPOSIT_PHASE` | Cycle is in buffer or settle phase — deposits closed |
| `NO_SBTC_AVAILABLE` | No sBTC deposited in current cycle — nothing to acquire |

Confidence:
- `high` — discount ≥ 2% or clearly unfavourable
- `medium` — discount 1–2%
- `low` — borderline

## Technical notes

- Contract: `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.sbtc-stx-jing-v2` (v2, current; v1 was on cycle 5)
- DLMM price formula: `STX/sBTC = 1e10 / dlmmRaw` (contract stores inverse ratio)
- XYK price formula: `STX/sBTC = xykRaw / 1e8` (contract stores direct ratio with 1e8 scale)
- Oracle price: Pyth Hermes `BTC/USD ÷ STX/USD = STX/sBTC`
- No API key required for any data source
- All Hiro reads use sender `SP000000000000000000002Q6VF78` (burn address, valid for read-only calls)

## Output contract

All outputs are JSON to stdout.

**Error:**
```json
{ "error": "descriptive message" }
```

## Origin

Winner of AIBTC x Bitflow Skills Pay the Bills competition.
Original author: @teflonmusk
Competition PR: https://github.com/BitflowFinance/bff-skills/pull/78
