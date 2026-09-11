---
name: sbor
description: SBOR, the benchmark lending rate for Stacks — get the current borrow and supply rate per currency, judge whether a rate you have been offered is above or below the market, list the venues behind a rate with their utilisation, read the history, compare Stacks with lending markets off-chain, and check for cross-venue inversions.
metadata:
  user-invocable: "false"
  arguments: "rate | compare | markets | history | chains | inversions | method"
  entry: "sbor/sbor.ts"
  tags: "read-only, mainnet-only, defi, l2"
  author: "sborxyz"
---

# sbor

The benchmark lending rate for Stacks. Read from lending contract state,
published daily as a public good at [sbor.xyz](https://sbor.xyz).

**No wallet. No keys. No funds. No rate limit.** This skill only reads a public
endpoint, so it can be run freely and cannot lose anything.

## Why an agent wants this

Any agent that lends, borrows, loops or routes on Stacks is making a decision
about whether a rate is good. Without a benchmark there is nothing to judge it
against, so the agent either takes the first offer or compares venues by hand in
software.

SBOR is the market rate. Borrowing above it means paying more than the market.
Supplying below it means earning less.

## Commands

```bash
bun run sbor/sbor.ts rate
bun run sbor/sbor.ts rate --index SBOR-USD
bun run sbor/sbor.ts compare --rate 4.2 --side borrow --index SBOR-USD
bun run sbor/sbor.ts markets --index SBOR-USD
bun run sbor/sbor.ts history --index SBOR-USD --days 30
bun run sbor/sbor.ts chains
bun run sbor/sbor.ts inversions
bun run sbor/sbor.ts method
```

### rate

Current fixing. Every currency index unless one is named.

```bash
bun run sbor/sbor.ts rate --index SBOR-BTC
```

Returns borrow, supply, the all-in supply figure where protocol yield applies,
the venues covered and the weight of the largest one.

### compare

The one most agents want. Given a rate you have been offered, returns whether it
is above or below the market and by how many basis points, plus the best
constituent and its utilisation.

```bash
bun run sbor/sbor.ts compare --rate 4.2 --side borrow --index SBOR-USD
```

```json
{
  "index": "SBOR-USD",
  "side": "borrow",
  "offered": 4.2,
  "benchmark": 2.34,
  "differenceBps": 186,
  "verdict": "above market",
  "best": { "venue": "Granite", "asset": "USDCx", "rate": 1.46, "utilization": 23.64 }
}
```

### markets

Every venue and asset behind an index, with borrow, supply, utilisation, depth
and weight.

### history

Daily fixings. Withdrawn fixings are returned with their reason rather than
silently omitted.

### chains

The same asset classes on lending markets off Stacks, currently Ethereum and
Base. Context only, never part of an SBOR index.

### inversions

Cross-venue inversions: the same asset costing less to borrow at one venue than
it pays to supply at another. Checked hourly. Carries a `status` field; while it
reads `validating` the detection is still being proven.

### method

The full methodology and integration policy.

## Indices

| Index | Covers |
|---|---|
| `SBOR-USD` | dollar markets, USDCx and USDh |
| `SBOR-BTC` | sBTC markets |
| `SBOR-STX` | STX and stSTX markets |

Published beside them, never inside them: `poxReference`, the native bitcoin
yield paid to STX stackers.

## What to know before acting on it

**An index can be absent.** When a market cannot be read, SBOR omits the index
rather than publishing a figure that is not real. `rate` returns an explanation
rather than a zero. Treat absence as unknown, not as free.

**Check concentration.** Every index carries `venues` and
`largestConstituentWeight`. An index covering one venue is a reading of that
venue, not a market average.

**Utilisation explains the rate.** A cheap rate at 20% utilisation means unused
capacity. A cheap rate at 99% means you cannot actually draw. Both are returned.

**Protocol yield is not a lending rate.** stSTX carries staking yield from the
asset itself. `supply` is the lending rate; `allInSupply` includes the protocol
yield. Do not confuse them.

**`poxReference` is a staking yield**, not a lending rate, and is never blended
into an index.

## Independence

SBOR takes no payment from any venue it measures, is not affiliated with Stacks,
the Stacks Foundation or any protocol in the index, and does not trade on its
own rate. It publishes whatever the market does, including numbers unfavourable
to the ecosystem.

It is a statistic, not advice.
