---
title: Buzz Token Scorer Agent
author: Ionic Nova (Buzz BD Agent)
---

# Agent Guardrails

## Autonomous Actions (no approval needed)
- Score any token via DexScreener + CoinGecko + on-chain data
- Apply 8 penalty rules automatically
- Write score to ScoreStorage on Base (read-only verification)
- Return structured JSON with breakdown

## Requires Human Approval
- Changing penalty rule thresholds
- Adding new scoring factors
- Modifying dual-gate logic
- Any wallet transactions or transfers

## Safety
- READ-ONLY on all chains — no transactions, no swaps
- Never provide financial advice — scores are data, not recommendations
- All scores verifiable on-chain (ScoreStorage v2 on Base)
- Rate limit: 5 scores per minute

## Error Handling
- If DexScreener unreachable: return partial score with warning
- If CoinGecko unreachable: skip market data, cap at 60
- If honeypot detected: immediate exclude, score = 0
- Log all errors, never crash silently
