---
name: tallfenn-x402-art-agent
skill: tallfenn-x402-art
description: Deterministic generative-art seed packs, 512x512 SVG previews, and keyframed motion timelines via x402 v2 on Stacks — free teaser/samples reads plus sBTC pay-per-call generation.
---

# tallfenn-x402-art agent guide

## Prerequisites

- Free subcommands (`meta`, `health`, `teaser`, `samples`): none. No wallet, no
  funds, no API keys.
- Paid subcommands (`seed-pack`, `svg-preview`, `motion-timeline`,
  `full-bundle`): an unlocked wallet (`wallet` skill) holding at least 100 sats
  sBTC (150 sats for `full-bundle`) with `NETWORK=mainnet` set. Default
  sponsored mode (`X402_PAYMENT_MODE=sponsored`) settles gaslessly through
  `https://x402-relay.aibtc.com`.

## When to invoke

- When an agent needs deterministic generative-art parameters (HSL palette,
  noise seed, symmetry/density/grain traits, Art Blocks-style metadata) from a
  text prompt (`seed-pack`).
- When an agent needs a shareable 512x512 SVG artwork preview for an ordinal,
  NFT prototype, or bounty deliverable (`svg-preview`).
- When an agent needs keyframed 24 fps movement coordinates (`t`, `x`, `y`,
  `phase`) to drive generative video or canvas animations (`motion-timeline`).
- When an agent needs two or more of the above for the same prompt — use
  `full-bundle` (150 sats) instead of separate 100-sat calls.

## Decision logic

1. **Inspect free first:** Run `teaser` or `samples` if you only need to inspect
   the JSON structure or test a downstream parser. Never pay 100 sats just to
   see the schema.
2. **Pick the right paid endpoint:**
   - Need only parameters/palette? → `seed-pack` (100 sats)
   - Already have a `hash` and need the SVG? → `svg-preview --hash <hash>` (100 sats)
   - Need only keyframe coordinates? → `motion-timeline` (100 sats)
   - Need parameters + SVG (or all three)? → `full-bundle` (150 sats, saves
     50–150 sats).
3. **Cache by `(prompt, pieceVersion)`:** Output is strictly deterministic.
   Never pay twice for the same prompt and version; store the JSON output and
   reuse it locally.

## Cost guardrails

- Validate inputs locally before calling: `--prompt` must be 1–500 characters,
  `--piece-version` a positive integer, and `--hash` 16–64 hex characters. The
  CLI enforces these checks before touching the wallet so bad flags cost 0 sats.
- Confirm sBTC balance before running a batch of prompts.
- Before signing, the CLI verifies the worker's 402 quote locally: `payTo` must be
  `SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC`, the asset must be `sBTC`, the
  network must be `stacks:1`, and the amount must equal the route's known price
  (100 sats for `seed-pack`, `svg-preview`, `motion-timeline`; 150 sats for
  `full-bundle`). A quote that differs from the published price is refused before
  the wallet spends anything. It does not protect against a host that changes its
  answer between this check and the payment (that guarantee belongs to the shared
  x402 client, not this PR).
- Note: `X402_MAX_SATS_PER_PAYMENT` is only effective in direct mode
  (`X402_PAYMENT_MODE=direct`). The default sponsored path does not honour it,
  so do not rely on that env var as the guard for this skill.
- Do not loop paid calls on identical prompts.
- Each CLI run signs a new transaction. Re-running a command after a timeout is
  therefore a new payment, not an idempotent retry: check whether the previous
  transaction settled (via its txid or the Hiro explorer) before re-running. (The
  worker does cache settled responses by `(signedTx, resourceUrl)`, but the CLI
  never reuses a signed transaction across runs.)

## Error handling

| Error | Meaning | Action |
| --- | --- | --- |
| `--prompt is required` / `--hash must be 16-64 hex characters` | Local input validation failed before wallet access | Fix CLI arguments; nothing was signed or spent |
| `Network mismatch: endpoint requires mainnet...` | Wallet is on testnet (`NETWORK` not set to `mainnet`) | Re-run with `NETWORK=mainnet` |
| `Insufficient sBTC...` | Wallet has < 100 sats (or < 150 sats for `full-bundle`) | Check balance via `sbtc/sbtc.ts get-balance` and fund wallet before retrying |
| `402 AMOUNT_TOO_LOW` | Payment amount below endpoint requirement | Let `createApiClient` read the advertised amount from the 402 header |
| `400 PAYMENT_INVALID` (`recipient_mismatch`, `invalid_payload`, `transaction_failed`) | Facilitator rejected the signed transaction | Check wallet nonce/network status; do not replay the rejected tx |
| `409 payment_identifier_conflict` | Duplicate payment identifier on facilitator | Rebuild with a fresh transaction if the prior one was not settled |
| `502 NETWORK_ERROR` / `503 RELAY_UNAVAILABLE` | Transient facilitator or broadcast failure | Wait `retryAfter` seconds (5–30s), verify whether prior tx settled on Hiro before re-running |

## Output handling

- Extract `data.hash` from `seed-pack` or `full-bundle` as the canonical seed
  identifier.
- Extract `data.svg` (or `data.seedPack`, `data.motionTimeline` in
  `full-bundle`) for rendering or inscription.
- Cite `payment.txId` or `payment_receipt.transaction` as the on-chain sBTC
  settlement receipt on Stacks mainnet.

## Safety checks

- Read-only generation: the worker performs no on-chain writes beyond settling
  the x402 payment transfer via the facilitator.
- The CLI verifies `payTo` in the 402 challenge against
  `SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC` before signing; a mismatch fails
  the command before any sats are spent. Cross-check `meta` manually only when
  auditing an endpoint off-band.
