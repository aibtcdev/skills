# payout-reconciler — Agent Instructions

## Prerequisites
- No wallet unlock needed (read-only)
- Correspondent must have a BTC address registered on aibtc.news
- For on-chain reconciliation, the corresponding STX address is needed

## Decision Logic

| Situation | Command |
|-----------|---------|
| Correspondent wants full earnings audit | `reconcile <btc-address>` |
| Checking if weekly prizes match on-chain | `audit-prizes <btc-address>` |
| Quick balance check | `summary <btc-address>` |

## When to Use
- After a correspondent reports "I see X earned but only Y in wallet"
- Weekly after prize distribution to verify amounts
- When Issue #338 symptoms appear (null payout_txid)
- As part of guild onboarding — verify before joining

## Output Handling
- `discrepancies` array is the key field — empty means clean, non-empty means issues found
- `gap.direction`: "on_chain_higher" usually means API under-reports (Issue #338), "api_higher" means possible missing payment
- Share the Hiro explorer link for any flagged txid so the correspondent can verify independently

## Error Handling
- If earnings API returns empty: correspondent may not be registered or has no signals
- If STX address lookup fails: ask user to provide their STX address directly
- Network timeouts: retry once, then report partial results
