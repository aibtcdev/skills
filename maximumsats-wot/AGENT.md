---
name: maximumsats-wot-agent
skill: maximumsats-wot
description: MaximumSats Web of Trust — query Nostr WoT trust scores for counterparty risk assessment before on-chain interactions.
---

# MaximumSats WoT — Agent Instructions

## Purpose

Use this skill to assess counterparty trust before on-chain interactions (payments, DeFi, contract calls). Check a Nostr pubkey's WoT rank to detect sybil accounts, new accounts with no history, or low-trust actors.

## Prerequisites

- No wallet required for `check` (pubkey/npub lookup)
- Unlocked wallet required for `check-agent` (self-lookup via BTC-shared derivation)
- L402 Lightning payment capability required for live API calls (100 sats per request)
- Without L402, the API returns HTTP 402 and the skill surfaces a clear error

## Decision Logic

```
Before transacting with a counterparty:
  1. Obtain their Nostr pubkey (npub or hex)
  2. Run: bun run maximumsats-wot/maximumsats-wot.ts check --npub <npub>
  3. If trusted: true → proceed
  4. If trusted: false → investigate reason before proceeding
     - reason: "Not in top 100" → high bar; consider --require-top100 config
     - reason: "Rank exceeds minRank" → adjust threshold or decline
  5. If L402 error → cache miss; requires Lightning payment; note and proceed with caution
```

## Safety Checks

- **Never bypass L402 errors silently** — surface them to the caller
- **Cache is 1 hour TTL** — trust scores are relatively stable; re-check on long-lived engagements
- **WoT is Nostr-specific** — a pubkey with no Nostr activity may be trustworthy off-Nostr; use as one signal among many
- **Config thresholds are tuneable** — defaults (minRank=10000, requireTop100=false) are conservative for general use

## Error Handling

| Error | Action |
|-------|--------|
| `L402 payment required` | Log, note payment needed, surface to caller |
| `Invalid npub` | Validate input format before calling |
| `API error 5xx` | Retry once; if fails, surface error |
| `Wallet not unlocked` | Run `bun run wallet/wallet.ts unlock` first |

## Integration Pattern

```typescript
// Before a payment or trade, check counterparty trust
const result = JSON.parse(
  await $`bun run maximumsats-wot/maximumsats-wot.ts check --npub ${counterpartyNpub}`
);

if (!result.success) {
  // Handle L402 or API error — proceed with caution
  console.warn("WoT check failed:", result.error);
} else if (!result.trusted) {
  // Low-trust counterparty
  console.warn(`Low trust: ${result.reason} (rank: ${result.rank})`);
  // Decision: decline, require escrow, or proceed with reduced exposure
} else {
  // Trusted — proceed
  console.log(`Trusted counterparty (rank: ${result.rank})`);
}
```

## Cache Management

Results are cached at `~/.aibtc/maximumsats-cache.json` with a 1-hour TTL. Use `cache-status` to inspect. Expired entries are pruned on each write. No manual cache clearing is needed.
