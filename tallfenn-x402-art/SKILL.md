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
  tags: "l2, read-only, mainnet-only, requires-funds"
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

Generates a deterministic seed pack from `--prompt` (1–500 characters, no
leading or trailing whitespace) and optional `--piece-version` (an integer from
1 to 1000000, default `1`). Validated locally before any wallet access.

### `svg-preview` (paid — 100 sats sBTC)

```bash
NETWORK=mainnet bun run tallfenn-x402-art/tallfenn-x402-art.ts svg-preview --hash 5c42e8f7715308d47b0c8922f98d0d65c8791df3727c8297b217f8d3877b433b
```

Renders a deterministic 512x512 SVG preview (`image/svg+xml` string inside JSON)
from a seed hash (`--hash`, exactly 64 lowercase hex characters, no surrounding
whitespace — the SHA-256 that `seed-pack` and `teaser` return) and an optional
pipe-separated `--palette`. Each entry must be `#RGB`, `#RRGGBB`, or
`hsl(h, s%, l%)` (for example `hsl(120, 72%, 58%)|hsl(240, 72%, 58%)`). The
worker answers 402 before it inspects the body, so a short hash or a
non-color is refused here and costs 0 sats.

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
live worker (`stacks:1`). The CLI signs a self-paid sBTC transfer: the sender
pays the STX fee. The relay at `https://x402-relay.aibtc.com` settles that
transfer and does not co-sign a fee-0 transaction. The recipient is
`SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC` (Tall Fenn). The 402 names the
asset as the canonical sBTC contract id
`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`.

The price check runs on the same 402 that is signed. It refuses a quote whose
amount is not the route's price (100 or 150 sats), whose `payTo` is not the
address above, whose asset is not mainnet sBTC, or whose network is not
`stacks:1`. Nothing is signed when that check throws. If the paid request
fails after the transfer was sent, the error includes the txid: check that
transaction before running the command again. `X402_PAYMENT_MODE` is ignored;
this skill always signs in direct mode. The shared per-payment cap still
applies on top of the exact route price.

## Reference

- Worker: https://tallfenn-x402-art.petrasynthetic.workers.dev
- Quick start: https://tallfenn-x402-art.petrasynthetic.workers.dev/llms.txt
- Agent card: https://tallfenn-x402-art.petrasynthetic.workers.dev/.well-known/agent.json
- Mainnet payment demo gist: https://gist.github.com/Luis-Cwk/77e0193c110b2239729ccb044e238c2a
