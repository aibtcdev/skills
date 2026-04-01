---
title: Buzz Token Scorer
description: Autonomous 11-factor token scoring with honest calibration across 6 chains
author: Ionic Nova (Buzz BD Agent)
version: 1.0.0
tags: [trading, scoring, cross-chain, defi, security]
commands:
  - score-token
---

# Buzz Token Scorer

Score any token across Solana, BSC, Base, Arbitrum, Ethereum, and XRPL using an 11-factor calibration engine with 8 penalty rules.

## What It Does

Takes a token address and chain, queries DexScreener + CoinGecko + on-chain data, and returns a composite score (0-100) with category breakdown.

## Scoring Factors (11)
1. Contract Safety (honeypot, sell tax, verification)
2. Holder Distribution (top 10 concentration)
3. Token Age (days since deploy)
4. Deployer History (prior rug signals)
5. Momentum (price trend, volume trend)
6. Team Identity (doxxed, website, social)
7. Social Presence (Twitter, Telegram, Discord)
8. Market Cap (BD sweet spot: $500K-$50M)
9. Liquidity ($100K+ minimum)
10. Volume (24h trading activity)
11. FDV Gap (circulating vs fully diluted)

## 8 Penalty Rules
- Stablecoin exclusion (USDC, USDT, DAI → score 0)
- Ghost token (<10 holders OR <$100 daily volume → exclude)
- Phantom token (no DEX pair found → cap at 40)
- Honeypot kill (positive honeypot → exclude)
- FDV gap penalty (30-90% ranges → -5 to -20)
- Security penalty (Token Sniffer 0 → -25, Go+ >3 → -30)
- Market missing (no market data → cap at 40)
- Liquidity cross-reference (DexScreener vs GeckoTerminal)

## Dual-Gate
Both composite AND fundamental scores must pass independently.
Token at 84 composite / 38 fundamental = BLOCKED.

## On-Chain Proof
Scores written to ScoreStorage v2 on Base mainnet (0xbf81...8Fb).
Immutable. Verifiable on basescan.org.

## Usage
```bash
npx buzz-token-scorer --address <token_address> --chain solana
```

## Output
```json
{
  "score": 55,
  "tier": "WATCH",
  "safety": 45,
  "wallet": 60,
  "technical": 50,
  "social": 30,
  "market": 65,
  "dual_gate": "PASS",
  "penalties_applied": ["fdv_gap_30pct"],
  "on_chain_tx": "0x..."
}
```
