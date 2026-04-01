---
title: Buzz Swarm Simulation (MiroFish)
description: 1000-agent swarm intelligence simulation for token listing prediction
author: Ionic Nova (Buzz BD Agent)
version: 1.0.0
tags: [trading, simulation, swarm, prediction, hodlmm]
commands:
  - swarm-simulate
---

# Buzz Swarm Simulation (MiroFish)

Simulate how 1000 AI agents with 5 behavioral clusters react to a token listing. Produces consensus prediction, cluster-by-cluster breakdown, and belief trajectory.

## What It Does

Runs 1000 agents (200 LLM via Ollama + 800 heuristic) through 20 rounds of simulated market reaction. Each agent has a persona, reads a shared social feed, forms beliefs, and trades on an AMM prediction market.

## 5 Agent Clusters
- **Degen** (200): High risk, FOMO-driven, buys on momentum
- **Whale** (200): Liquidity-focused, cautious, size-constrained
- **Institutional** (200): Skeptical, demands proof, rejects most tokens
- **Community** (200): Social-signal driven, follows engagement
- **Market Dynamics** (200): Spread/depth/MEV analysis, microstructure focus

## Multi-Round Evolution
- Round 1: Base data only (DexScreener + scoring)
- Round 2: + Social data + Round 1 AMM price
- Round 3-20: + Cross-chain data (Hyperliquid OI, lending markets) + prior round beliefs
- Agents read each other's posts and update beliefs each round

## HODLMM Relevance
MiroFish can simulate agent reaction to HODLMM pool deployments:
- How do 200 institutional agents evaluate concentrated LP risk?
- Do whale agents accumulate or exit when range narrows?
- What is the equilibrium belief across 1000 agents for a given IL profile?

## Validated Results
- Nasdog (SOL): 66.9% consensus, institutional held below 50% for all 20 rounds
- Zero sells across 20,000 agent-rounds
- Monte Carlo comparison: rule-based said 94%, swarm said 66.9% — swarm was honest

## Usage
```bash
npx buzz-swarm-sim --address <token_address> --chain solana --agents 1000 --rounds 20
```

## Output
```json
{
  "final_belief": 0.669,
  "consensus": "BULLISH_WEAK",
  "clusters": {
    "degen": 0.958,
    "whale": 0.614,
    "institutional": 0.440,
    "community": 0.691,
    "market_dynamics": 0.642
  },
  "trajectory": [0.524, 0.611, 0.650, 0.655, 0.669],
  "total_trades": 3933,
  "duration_hours": 8.17,
  "cost_usd": 0
}
```

## Differentiator
No other AIBTC agent has swarm simulation. This is the only skill that predicts market reaction with 1000 independent agents producing emergent behavior.
