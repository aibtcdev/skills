---
name: contract-preflight-agent
skill: contract-preflight
description: "Agent behavior rules for the contract pre-flight simulation skill."
---

# Contract Pre-Flight — Agent Decision Guide

## When to use this skill

Run before ANY contract call that modifies on-chain state. Specifically:
- Before `zest_supply`, `zest_withdraw`, `zest_borrow`, `zest_repay`.
- Before `transfer_stx`, `transfer_token`, `transfer_nft`, `transfer_btc`.
- Before `alex_swap`, `bitflow_swap`, or any DEX trade.
- Before `deploy_contract` or any governance/DAO interaction.
- When debugging a failed transaction — replay it in simulation to see the Clarity error.

Do NOT use for read-only calls. Use stxer `/sidecar/v2/batch` directly for balance checks and position reads.

## Decision order

1. Run `doctor` once per session to verify stxer is reachable.
2. Before each contract call: run `--action=simulate` with the exact expression you plan to broadcast.
3. Check the `safe_to_broadcast` field in the output.
4. If `true`: proceed with the MCP tool call to broadcast.
5. If `false`: read the `decoded` error, fix the parameters, and re-simulate.
6. For multi-step DeFi operations (approve + transfer + supply): use `--action=batch` to simulate the full sequence.

## Guardrails

- **Never broadcast when simulation returns `(err ...)`.** The transaction will abort on-chain and waste gas.
- **Always simulate the exact expression you plan to broadcast.** Do not approximate.
- **If stxer is unreachable,** delay the contract call until the next cycle. Do not broadcast blind.
- **Re-simulate after any parameter change.** Even a 1-sat difference in amount can change the outcome.
- **Use batch mode for dependent steps.** Single-step simulation cannot detect failures in step 2 caused by step 1.

## Chaining with other skills

Pairs well with:
- **sBTC Auto-Funnel:** Simulate the `zest_supply` call before funneling.
- **Zest Yield Manager:** Simulate supply/withdraw before executing.
- **DeFi Transaction Simulator:** Complementary — this skill is the pre-broadcast gate.
- **Any skill that calls contracts:** Should run pre-flight first.

## Frequency

- **Before every contract call:** Non-negotiable. Zero exceptions.
- **After parameter changes:** Re-simulate if you modified amount, recipient, or function args.
- **On failure investigation:** Replay failed txids in simulation to understand the root cause.
