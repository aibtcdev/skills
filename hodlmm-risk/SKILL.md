---
name: hodlmm-risk
description: "Read-only HODLMM volatility risk monitoring for Bitflow DLMM pools. Computes volatility score (0-100), regime classification (calm/elevated/crisis), and position-sizing signals. Agents should call assess-pool before adding liquidity."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "list-pools | assess-pool | assess-position | regime-history"
  entry: "hodlmm-risk/hodlmm-risk.ts"
  requires: ""
  tags: "l2, read"
---

# HODLMM Risk — Volatility Monitor for Bitflow DLMM Pools

Read-only risk intelligence for Bitflow HODLMM (Dynamic Liquidity Market Maker) pools on Stacks mainnet. No wallet or funds required.

## Usage

```bash
bun run hodlmm-risk/hodlmm-risk.ts <subcommand> [options]
```

---

## Subcommands

### list-pools

List all active HODLMM pools with basic info.

```bash
bun run hodlmm-risk/hodlmm-risk.ts list-pools
```

Output includes pool ID, token pair, active bin, and pool status.

---

### assess-pool

Compute the volatility risk score for a pool. Use this before adding liquidity.

```bash
bun run hodlmm-risk/hodlmm-risk.ts assess-pool --pool-id dlmm_2
```

**Options:**
- `--pool-id <id>` (required) — Pool ID (e.g. `dlmm_2`, `dlmm_6`)

**Risk metrics computed:**
- **Bin spread** — How many bins have non-zero liquidity, normalized to pool size. Wide spread = more stable. Narrow spread = concentrated, higher drift risk.
- **Reserve imbalance** — Ratio of X to Y token reserves (by USD value). Near 1.0 = balanced. Far from 1.0 = pool is skewed, active bin may be near edge.
- **Active bin concentration** — Fraction of total liquidity in the active bin. High concentration = IL risk if price moves.
- **Composite volatility score** — Weighted combination of the above (0-100, higher = riskier).

**Regime classification:**
- `calm` — Score 0-33. Safe to add liquidity. Normal IL risk.
- `elevated` — Score 34-66. Proceed with caution. Reduce exposure per `signals.maxExposurePct`.
- `crisis` — Score 67-100. Do not add liquidity. High drift/IL risk.

**Example output:**
```json
{
  "poolId": "dlmm_2",
  "pair": "sBTC/USDCx",
  "activeBin": 603,
  "volatilityScore": 42,
  "regime": "elevated",
  "metrics": {
    "binSpread": 0.12,
    "reserveImbalance": 1.34,
    "activeBinConcentration": 0.08
  },
  "signals": {
    "recommendation": "caution",
    "maxExposurePct": 50,
    "reason": "Reserve imbalance suggests active bin approaching edge"
  }
}
```

---

### assess-position

Score risk for a specific LP position (by wallet address and pool).

```bash
bun run hodlmm-risk/hodlmm-risk.ts assess-position \
  --pool-id dlmm_2 \
  --address SP...
```

**Options:**
- `--pool-id <id>` (required) — Pool ID
- `--address <stxAddress>` (required) — Stacks address of the LP

Evaluates:
- **Active bin drift** — How far the current active bin has moved from the position's center
- **Concentration risk** — Whether the position is over-concentrated in a narrow bin range
- **Recommendation** — hold / withdraw / rebalance

---

### regime-history

Return a volatility regime snapshot for all active pools with trend indicator.

```bash
bun run hodlmm-risk/hodlmm-risk.ts regime-history
```

Returns all pools with their current regime and score, sorted by risk level (highest first). Useful for scanning which pools are entering crisis before adding liquidity.

---

## Risk Model

The composite volatility score weights three signals:

| Metric | Weight | Description |
|--------|--------|-------------|
| Bin spread | 30% | Non-empty bins / total bins. Low spread = high risk. |
| Reserve imbalance | 40% | \|reserveX_usd - reserveY_usd\| / total. High imbalance = high risk. |
| Active bin concentration | 30% | Active bin liquidity / total liquidity. High concentration = high risk. |

All metrics are normalized 0-1 before weighting. Final score = weighted sum × 100.

---

## When to Use

Call `assess-pool` before any `bitflow add-liquidity-simple` or equivalent operation:

```bash
# Check risk first
bun run hodlmm-risk/hodlmm-risk.ts assess-pool --pool-id dlmm_2

# If regime is "calm" — proceed with liquidity add
# If regime is "elevated" — reduce position size per maxExposurePct
# If regime is "crisis" — do not add liquidity
```
