---
name: vibewatch-sentiment
description: "Stacks ecosystem community sentiment from the Vibewatch Stacks Vibe Index — free public index plus x402 pay-per-query depth (per-project history, evidence receipts, deltas) settled in sBTC on Stacks."
metadata:
  author: "brandonjamesmarshall"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "index | terms | reports | project | evidence | delta"
  entry: "vibewatch-sentiment/vibewatch-sentiment.ts"
  requires: "wallet"
  tags: "l2, read-only, requires-funds"
---

# vibewatch-sentiment

Community sentiment for the Stacks ecosystem, from the [Vibewatch Stacks Vibe
Index](https://stacks.vibewatch.io) — a public sentiment index over an opted-in
panel of Stacks projects (Stacks, Zest Protocol, Bitflow, Stacking DAO, AIBTC,
Hermetica, and more), computed from each project's own community channels
(Discord, Telegram, X, forums, GitHub Discussions, governance votes) and
published with k-anonymity floors and marked suppression.

Two tiers:

- **Free** (`index`, `terms`, `reports`) — everything the public page shows:
  ecosystem composite (0–10), per-project current scores, 90-day history with
  Fear & Greed overlay, weekly message/author counts, rolling themes,
  governance votes, and the weekly-report archive. No wallet, no key.
- **Paid** (`project`, `evidence`, `delta`) — depth per query over x402,
  settled on Stacks: 100 sats sBTC or 300000 µSTX (0.3 STX) per query. The
  402 challenge lists both, sBTC first; this skill pays sBTC unless you pass
  `--asset STX` (see [Payment](#payment)). Answers "what changed, why, and
  where's the receipt": per-project daily series, the public posts backing
  each weekly theme, and changes-since deltas for polling loops.

## Subcommands

### `index` (free)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts index
```

The full live index payload (`schema_version`, `as_of`, `index`, `panel`,
`source_mix_7d`, `distribution_7d`, `history`, `projects[]`, `panel_joins`,
`panel_joins_truncated`, `governance`, `summary`, `suppressed[]`, plus the
skill's own `network` and `endpoint`). Each `projects[]` entry carries the
project's `slug` and `name`.

### `terms` (free)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts terms
```

The x402 discovery document (`/.well-known/x402.json`): current price,
accepted assets, `payTo`, and every paid resource. When the paid tier is
disabled the document truthfully serves empty `accepts` — check this before
the first paid call.

### `reports` (free)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts reports
```

The Stacks Vibe Weekly archive: one line per completed report with its
`week_start` (the `--week` value for `evidence`), title, week composite, and
week-over-week change.

### `project` (paid)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts project --project "Zest Protocol" --days 30
bun run vibewatch-sentiment/vibewatch-sentiment.ts project --project "Zest Protocol" --days 30 --asset STX
```

One panel project's daily composite series (≤90 days) plus its current score
and week-over-week change. `--project` accepts the project's name or slug;
the skill resolves it against the free index before paying (live slugs carry
a suffix, e.g. `zest-protocol-3672`, so you never have to know it). An
unknown or ambiguous project fails before any payment and lists the panel.
`latest` is null when the project's newest score is older than the index's
7-day recency floor — an old number is never presented as current.
A panel project whose free-index `score` is null (no scored days yet) is
served as a normal paid 200 with `series: []` and `latest.score: null` — the
query is charged. The skill refuses that call before payment; pass
`--allow-unscored` to pay anyway.

### `evidence` (paid)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts evidence --week 2026-08-24
bun run vibewatch-sentiment/vibewatch-sentiment.ts evidence --week 2026-08-24 --asset STX
```

Receipts behind one weekly report's themes: links to the public posts backing
each theme, with attributed excerpts for X posts. `--week` is a `week_start`
from `reports`; the skill checks it against the archive before paying, so a
week with no completed report fails free. Themes whose evidence is all in-server return `receipts: []`
marked `no_public_evidence` — private community content is never exposed.

### `delta` (paid)

```bash
bun run vibewatch-sentiment/vibewatch-sentiment.ts delta --since 2026-09-01T00:00:00Z
bun run vibewatch-sentiment/vibewatch-sentiment.ts delta --since 2026-09-01T00:00:00Z --asset STX
```

What changed since a timestamp (hour-bucketed): per-project score moves with
constant-panel baselines, ecosystem composite then/now, current themes, and
reports published since. Defaults to the last 24 hours; `--since` older than
90 days is clamped.

## Paid response shape

Every paid subcommand returns the index's paid envelope (`schema_version`,
`tier: "paid"`, `as_of`, `resource`, `payment`, `data`, `suppressed[]`) plus
the skill's own `endpoint`, `network`, and `payment_receipt`:

- `payment` — the settlement the index verified for this response: `txid`,
  `payer`, `amount`, `asset`, `network`, and `payment_identifier` (the id the
  operators match against their ledger). `payment.txid` is the receipt to
  cite.
- `payment_receipt` — the same settlement as the x402 `payment-response`
  header, decoded (`success`, `payer`, `transaction`, `network`).
  `payment_receipt.transaction` equals `payment.txid`.
- `data` — the resource payload:
  - `project`: `slug`, `name`, `latest { score, wow_change, as_of_date }`,
    `series[] { date, composite }` (scored days only, oldest first).
  - `evidence`: `week_start`, `themes[]` with `receipts[]`; a theme with only
    in-server evidence has `receipts: []` and `suppressed: true`,
    `reason: "no_public_evidence"`.
  - `delta`: `since_effective` (hour-bucketed), `index { composite_then,
    composite_now, change }`, `projects[]`, `reports_published[]`,
    `themes_current[]`.
- `suppressed[]` — slices withheld for privacy (`slice`, `reason`), e.g.
  `index_delta` / `below_min_orgs`. Report them as withheld, not zero.

## Payment

Standard x402 flow via the shared payment engine: the first request answers
402 with payment terms, the wallet signs, the retry carries the payment, and
the response includes a `payment_receipt` with the on-chain txid. One run,
one payment.

**Choosing the asset.** The index's 402 challenge advertises two Stacks
options, in this order: `100` sats of sBTC (`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`)
and `300000` µSTX (0.3 STX) — check `terms` for the current list. The shared
engine's default rule is *first Stacks option*, so a paid subcommand pays
sBTC unless told otherwise. `--asset STX` (on `project`, `evidence`, `delta`)
makes the engine select the STX option instead — a wallet holding STX but no
sBTC can pay the index without ever touching sBTC. `--asset sBTC` is the
default and can be passed explicitly. If the challenge does not offer the
asset you asked for, the run fails before anything is signed and names the
assets that were offered. The `payment.asset` and `payment.amount` fields in
the paid response confirm which option settled. Any other client should do
the same explicitly: select the `accepts[]` entry by `asset`, not by
position (Vibewatch-io/vibewatch-mcp#16). Running the same command again is a new query and a new
payment — there is no free re-read window across runs. (The server does hold
a 10-minute idempotency window keyed on the *signed payment itself*, which the
engine uses internally if the retry that carries a payment has to be resent;
that never costs a second payment.)

## Networks

`--network mainnet` (default) pays real sBTC on the live index; set `NETWORK=mainnet` too, since the wallet follows `NETWORK` (default testnet) and the payment engine refuses a network mismatch before signing. Payments are sponsored unless `X402_PAYMENT_MODE=direct` is set (see the `x402` skill), in which case the wallet also pays the STX fee. `--network testnet`
targets the staging index, which advertises the canonical testnet sBTC
(`SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`); the shared engine
currently pins a different testnet sBTC id (aibtcdev/skills#419), so paid
testnet calls fail at the asset check until that lands. Free subcommands work
on both.

## Reference

- Index: https://stacks.vibewatch.io
- Methodology: https://stacks.vibewatch.io/methodology
- Discovery: https://stacks.vibewatch.io/.well-known/x402.json
- Weekly reports: https://stacks.vibewatch.io/reports
- x402scan listing: https://scan.stacksx402.com/resources/6c71357a-b7f8-466e-a7e8-0e5babd8039d
- Report a problem: https://github.com/Vibewatch-io/vibewatch-mcp/issues
