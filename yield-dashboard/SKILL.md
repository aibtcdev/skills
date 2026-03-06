---
name: yield-dashboard
description: Single view of DeFi positions across Zest, Bitflow, Pillar, and stacking — plus YieldAgent x402 yields for opportunity discovery. Integrates defi/bitflow/pillar/stacking skills as data sources. Mainnet-only. Optional x402 payment for YieldAgent.
user-invocable: false
arguments: dashboard | positions | opportunities | rebalance-suggestions
entry: yield-dashboard/yield-dashboard.ts
requires: [wallet, defi, bitflow, pillar, stacking, x402]
tags: [l2, defi, mainnet-only, stacks-v1, x402]
---

# Yield Dashboard Skill

Aggregates DeFi positions from Zest, Bitflow, Pillar, and stacking into a single dashboard view. Optionally fetches yield opportunities from YieldAgent x402 API. Produces rebalance suggestions when YieldAgent is included.

## Data Sources

- **Zest Protocol** — Lending positions (supply/borrow) via defi zest-get-position
- **Pillar** — Smart wallet balances and Zest positions via **pillar-direct.ts** `direct-position` (requires pillar-direct, not pillar.ts; uses Pillar signing key, not --address; may differ from other sources)
- **Bitflow** — Keeper orders and DEX positions via bitflow get-keeper-user
- **Stacking** — STX stacking status via stacking get-stacking-status
- **YieldAgent** — x402 API at api.yieldagentx402.app/api/yields (optional, requires sBTC payment via x402 execute-endpoint)

## Usage

```
bun run yield-dashboard/yield-dashboard.ts <subcommand> [options]
```

## Subcommands

### dashboard

Full dashboard: positions from all protocols, YieldAgent opportunities (if --include-yieldagent), rebalance suggestions.

```
bun run yield-dashboard/yield-dashboard.ts dashboard [--include-yieldagent] [--address <addr>] [--max-assets <n>]
```

Options:
- `--include-yieldagent` — Fetch yield opportunities from api.yieldagentx402.app (x402 payment required, ~100 sats sBTC)
- `--address` — Stacks address (uses active wallet if omitted)
- `--max-assets` — Max Zest assets to query (default 10; 0 = no limit)

Output: `network`, `address`, `positions` (zest, pillar, bitflow, stacking), `opportunities` (null or object; null when not using --include-yieldagent), `rebalanceSuggestions` (always array), optional `note` when YieldAgent not included.

### positions

Positions only — no YieldAgent fetch, no rebalance logic.

```
bun run yield-dashboard/yield-dashboard.ts positions [--address <addr>] [--max-assets <n>]
```

Options: `--address`, `--max-assets` (default 10, 0 = no limit).

### opportunities

Yield opportunities from YieldAgent x402 (requires payment). Use when you want to compare portfolio APY to best available rates.

```
bun run yield-dashboard/yield-dashboard.ts opportunities [--limit <n>]
```

### rebalance-suggestions

Fetches YieldAgent x402 yields and returns top rebalance suggestions (protocol, chain, APY, action). Always fetches fresh — no cache. Requires sBTC for x402 payment.

```
bun run yield-dashboard/yield-dashboard.ts rebalance-suggestions
```

## Notes

- **Stacks v1 + x402** — AIBTC dashboard ecosystem; all addresses and APIs are Stacks v1 mainnet.
- **Pillar path** — Requires `pillar-direct.ts` (agent-signed mode). If the MCP server ships only `pillar.ts` (browser-handoff), direct-position will fail.
- Mainnet-only. Requires unlocked wallet for position queries.
- YieldAgent integration uses x402 execute-endpoint with --auto-approve; requires sBTC (~100 sats per call). No cost confirmation — ensure sufficient balance.
- Rebalance suggestions are heuristic: compares current APY to top opportunities.
- Integrates with existing defi, bitflow, pillar, stacking skills — no duplicate protocol logic.
