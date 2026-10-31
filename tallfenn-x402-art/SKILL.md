---
name: tallfenn-x402-art
description: "Deterministic generative-art seed packs, 512x512 SVG previews, and keyframed motion timelines via x402 v2 on Stacks — free teaser/samples plus sBTC pay-per-call generation."
metadata:
  author: "Luis-Cwk"
  author-agent: "Tall Fenn"
  user-invocable: "false"
  arguments: "meta | health | teaser | samples | seed-pack | svg-preview | motion-timeline | full-bundle"
  entry: "tallfenn-x402-art/tallfenn-x402-art.ts"
  requires: "wallet"
  tags: "l2, read-only, requires-funds"
---

# tallfenn-x402-art

Deterministic generative-art seed packs, 512x512 SVG previews, and keyframed
motion timelines for autonomous agents, served by
[Tall Fenn x402 Art](https://tallfenn-x402-art.petrasynthetic.workers.dev) and
settled in sBTC over **x402 v2** on Stacks (`stacks:1`).

No API keys or accounts: the x402 payment is the authentication. Every output
derives deterministically from `SHA-256(prompt + "|v" + version + "|tallfenn")`,
so the same prompt and version always produce the exact same hash, HSL palette,
motion grammar, videodanza pipeline parameters, keyframe timeline, and SVG.

Two tiers:

- **Free** (`meta`, `health`, `teaser`, `samples`) — inspect service metadata,
  liveness, and complete sample seed packs before spending a satoshi. No wallet
  needed.
- **Paid** (`seed-pack`, `svg-preview`, `motion-timeline`, `full-bundle`) —
  100 sats sBTC per single artifact (`seed-pack`, `svg-preview`,
  `motion-timeline`) or 150 sats sBTC for `full-bundle` (all three artifacts in
  one call, saving 150 sats compared to three separate calls). Re-running a
  command after a timeout signs a new payment; check the payment first (the
  CLI does not reuse a signed transaction across runs).

## Subcommands

### `meta` (free)

```bash
bun run tallfenn-x402-art/tallfenn-x402-art.ts meta
```

Returns service info, discovery URLs (`/llms.txt`, `/skill.md`,
`/.well-known/agent.json`), free and paid endpoint catalog, and supported x402
headers.

### `health` (free)

```bash
bun run tallfenn-x402-art/tallfenn-x402-art.ts health
```

Liveness check (`{ status: "ok", timestamp, network }`).

### `teaser` (free)

```bash
bun run tallfenn-x402-art/tallfenn-x402-art.ts teaser
```

Returns one fixed seed pack (`prompt: "bodies that dance alone"`) so agents can
inspect the exact output schema (`hash`, `palette`, `noiseSeed`, `motion`,
`motionGrammar`, `series`, `pipeline`, `traits`, `artBlocks`) at zero cost.

### `samples` (free)

```bash
bun run tallfenn-x402-art/tallfenn-x402-art.ts samples
```

Returns three fixed seed packs from the Tall Fenn series (`cuerpos que caen juntos`,
`fase rem de una ia`, `atractor: la caida repetida`).

### `seed-pack` (paid — 100 sats sBTC)

```bash
NETWORK=mainnet bun run tallfenn-x402-art/tallfenn-x402-art.ts seed-pack --prompt "bodies that dance alone" --piece-version 1
```

Generates a deterministic seed pack from `--prompt` (1–500 chars) and optional
`--piece-version` (positive integer, default `1`). Validated locally before any
wallet access.

### `svg-preview` (paid — 100 sats sBTC)

```bash
NETWORK=mainnet bun run tallfenn-x402-art/tallfenn-x402-art.ts svg-preview --hash 5c42e8f7715308d47b0c8922f98d0d65c8791df3727c8297b217f8d3877b433b
```

Renders a deterministic 512x512 SVG preview (`image/svg+xml` string inside JSON)
from a seed hash (`--hash`, 16-64 hex chars) and optional pipe-separated HSL/hex
`--palette` (e.g. 'hsl(120, 72%, 58%)|hsl(240, 72%, 58%)').

### `motion-timeline` (paid — 100 sats sBTC)

```bash
NETWORK=mainnet bun run tallfenn-x402-art/tallfenn-x402-art.ts motion-timeline --prompt "bodies that dance alone"
```

Generates a deterministic 24 fps keyframed motion timeline (`hash`, `fps`,
`durationSec`, `keyframes[] { t, x, y, phase }`, `notation`) for agents driving
video, p5.js sketches, or on-chain animation.

### `full-bundle` (paid — 150 sats sBTC)

```bash
NETWORK=mainnet bun run tallfenn-x402-art/tallfenn-x402-art.ts full-bundle --prompt "bodies that dance alone"
```

Returns `seedPack`, `svg`, and `motionTimeline` for the same prompt in a single
150-sat call.

## Paid response shape

Every paid subcommand returns:

- `success: true`
- `data` — the generated artifact (`SeedPack`, `{ hash, svg, contentType }`,
  `MotionTimeline`, or `FullArtBundle`)
- `payment` — `{ txId, sender }` reported by the worker after facilitator
  settlement
- `payment_receipt` — decoded `payment-response` header (`{ success, payer, transaction, network }`)
- `endpoint` and `network`

## Payment & Network

Set `NETWORK=mainnet` when running paid subcommands so the wallet matches the
live worker (`stacks:1`). Payments settle in sBTC via the AIBTC x402 v2
facilitator (`https://x402-relay.aibtc.com`) to recipient
`SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC` (Tall Fenn).

The CLI caps payments itself before signing: it verifies the worker's 402 quote
against the route's known price (100 or 150 sats) and payTo, so a quote that
differs from the published price is refused before signing. This does not
protect against a host that changes its answer between this check and the
payment. `X402_MAX_SATS_PER_PAYMENT` is only effective in direct mode
(`X402_PAYMENT_MODE=direct`) and does not protect the default sponsored path.

## Reference

- Worker: https://tallfenn-x402-art.petrasynthetic.workers.dev
- Quick start: https://tallfenn-x402-art.petrasynthetic.workers.dev/llms.txt
- Agent card: https://tallfenn-x402-art.petrasynthetic.workers.dev/.well-known/agent.json
- Mainnet payment demo gist: https://gist.github.com/Luis-Cwk/77e0193c110b2239729ccb044e238c2a
