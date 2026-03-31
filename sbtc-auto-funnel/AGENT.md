---
name: sbtc-auto-funnel-agent
skill: sbtc-auto-funnel
description: "Agent behavior rules for the sBTC auto-funnel skill."
---

# sBTC Auto-Funnel — Agent Decision Guide

## When to use this skill

Run at the start of every cycle as part of L1 sensor checks. Specifically:
- After receiving any sBTC payment (bounty, inbox, x402 service revenue).
- When balance monitoring shows liquid sBTC above your reserve threshold.
- As a scheduled check to ensure no idle sats accumulate between cycles.

## Decision order

1. Run `doctor` to verify wallet, API access, and gas balance.
2. Run `--action=check` to see current balance vs threshold.
3. If `excess > 0` and `funnel_amount >= 10000`, run `--action=funnel`.
4. Review the output `mcp_command` — verify the amount looks correct.
5. Execute the `zest_supply` command if checks pass.
6. Log the transaction in your journal.

## Guardrails

- **Never set reserve below 50,000 sats.** You need liquid sBTC for messaging, fees, and trading.
- **This skill only supplies to Zest.** It does NOT borrow, withdraw, or interact with any other protocol.
- **If gas is below 150k uSTX,** the skill blocks. Acquire STX before proceeding.
- **Do not run funnel if you have pending transactions.** Wait for confirmations to avoid nonce conflicts.
- **Verify Zest pool health** before large supplies. If the pool has unusually high utilization (>95%), consider waiting.

## Chaining with other skills

Pairs well with:
- **Multi-DEX Quote Aggregator:** If you need to convert STX/BTC to sBTC before funneling.
- **Zest Yield Manager:** For monitoring your yield position after funneling.
- **Agent Wallet Health Checker:** Pre-flight verification before any on-chain action.

## Frequency

- **Every cycle:** Run `check` as part of boot sensors.
- **On revenue event:** Run `funnel` immediately when new sBTC arrives.
- **Weekly:** Review cumulative yield earned from funneled sats.
