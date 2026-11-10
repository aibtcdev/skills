---
name: lunarcrush
description: "Pay-per-call access to LunarCrush social and market intelligence (Galaxy Score, AltRank, market cap rank, price, 24h change) via x402 on Stacks. USD-pegged pricing recomputed hourly from live STX/USD. Mainnet endpoint live; testnet supported."
metadata:
  author: "joevezzani"
  author-agent: "Prime Spoke"
  user-invocable: "false"
  arguments: "oracle | score | health | meta"
  entry: "lunarcrush/lunarcrush.ts"
  requires: "wallet"
  tags: "l2, read-only, requires-funds"
---

# LunarCrush Skill

Provides paid access to LunarCrush social/market intelligence via the x402 protocol on Stacks. Each `score` call costs ~$0.005 USD worth of STX (the on-chain microSTX amount is recomputed at request time from live STX/USD, so you pay a stable dollar value regardless of STX volatility).

LunarCrush is the leading social intelligence platform for crypto and equities — Galaxy Score, AltRank, sentiment, social volume, and topic data are widely used by trading firms and quant strategies. This skill exposes a subset of that data on a per-call basis for autonomous agents that don't want to manage SaaS subscriptions or API keys.

## Endpoints

| Subcommand | Network | Approx cost | Description |
|---|---|---|---|
| `oracle` | mainnet (default) or testnet | $0.025 USD in STX | Premium combined: verdict + confidence + reasoning + vibe one-liner + structured signals. One paid call, both trading-model and chatbot audiences served. |
| `score` | mainnet (default) or testnet | $0.005 USD in STX | Galaxy Score, AltRank, market cap rank, price, 24h change |
| `health` | n/a | free | Liveness probe |
| `meta` | n/a | free | Live STX/USD price, full endpoint catalog with current microSTX amounts |

Endpoints planned (not yet live): `altrank` (dedicated), `topic`, `social-velocity`, `sentiment`, `top-movers`, `whale-flow`. The full catalog is documented at the meta endpoint.

## Usage

```
bun run lunarcrush/lunarcrush.ts <subcommand> [options]
```

### oracle

Premium combined call — returns verdict, confidence, reasoning, a vibe one-liner, AND the full structured signals in a single response. Costs ~$0.025 USD in STX (~5x a `score` call) but saves you 5+ separate paid calls if you'd otherwise compose this yourself.

```
bun run lunarcrush/lunarcrush.ts oracle --symbol BTC
bun run lunarcrush/lunarcrush.ts oracle --symbol ETH --network testnet
```

Options:
- `--symbol` (required) — Crypto ticker symbol (e.g. `BTC`, `ETH`, `STX`).
- `--network` (optional, default `mainnet`) — `mainnet` or `testnet`.

Output:
```json
{
  "symbol": "BTC",
  "name": "Bitcoin",
  "verdict": "BUY",
  "confidence": 0.691,
  "reasoning": "Galaxy Score 58.8, AltRank 85, 24h price +0.60%, top-10 market cap → composite 69/100 (Galaxy 45% / AltRank 35% / momentum 20%) → BUY.",
  "vibe": "BTC is feeling itself 💪 Galaxy 58.8 on the up, momentum constructive. Mid-confidence vote.",
  "signals": {
    "galaxy_score": 58.8,
    "alt_rank": 85,
    "market_cap_rank": 1,
    "price_usd": 76369.76,
    "percent_change_24h": 0.59
  },
  "source": "lunarcrush",
  "network": "mainnet",
  "endpoint": "https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev/oracle/btc",
  "payment_receipt": { "success": true, "payer": "SP...", "transaction": "...", "network": "stacks:1" }
}
```

Verdict tiers (deterministic synthesis from a weighted composite — Galaxy 45% / AltRank 35% / 24h momentum 20%):
- `STRONG-BUY` (composite ≥ 75)
- `BUY` (60-74)
- `NEUTRAL` (45-59)
- `WATCH` (30-44)
- `AVOID` (< 30)
- `UNKNOWN` (insufficient data)

The `vibe` field is a personality-laden one-liner usable directly in chatbots, Telegram bots, agent narrative output, or anywhere you'd prefer human-readable over structured. The `signals` block is for quant models that want raw inputs.

### score

Fetch Galaxy Score and other current metrics for a symbol. Pays via x402.

```
bun run lunarcrush/lunarcrush.ts score --symbol BTC
bun run lunarcrush/lunarcrush.ts score --symbol ETH --network testnet
```

Options:
- `--symbol` (required) — Crypto ticker symbol (e.g. `BTC`, `ETH`, `STX`).
- `--network` (optional, default `mainnet`) — `mainnet` or `testnet`. Mainnet uses real STX, testnet uses Hiro testnet faucet STX.

Output (fields surfaced by the worker; `payment_receipt` is decoded from the `payment-response` header when present):
```json
{
  "symbol": "BTC",
  "name": "Bitcoin",
  "galaxy_score": 59,
  "alt_rank": 63,
  "market_cap_rank": 1,
  "price_usd": 76244.42,
  "percent_change_24h": 1.40,
  "source": "lunarcrush",
  "network": "mainnet",
  "endpoint": "https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev/galaxy-score/btc",
  "payment_receipt": {
    "success": true,
    "payer": "SP...",
    "transaction": "...",
    "network": "stacks:1"
  }
}
```

### health

Liveness probe (free). Returns `{ ok: true, ts: ... }`.

```
bun run lunarcrush/lunarcrush.ts health
bun run lunarcrush/lunarcrush.ts health --network testnet
```

### meta

Returns the live endpoint catalog with current microSTX amounts (USD-pegged; recomputed hourly from STX/USD).

```
bun run lunarcrush/lunarcrush.ts meta
```

Output:
```json
{
  "name": "lunarcrush-x402-poc",
  "version": "0.0.2",
  "network": "mainnet",
  "server_address": "SP3TH5S631RYN7Z485TY0KPFVX24R7RW7P25HVZ73",
  "facilitator": "https://x402-relay.aibtc.com",
  "pricing": {
    "stx_price_usd": 0.2212,
    "stx_price_cache_ttl_seconds": 3600,
    "endpoints": [
      { "key": "galaxy-score", "price_usd": 0.005, "price_microSTX": "22605", "price_STX": 0.022605 }
    ]
  }
}
```

## Pricing strategy

- USD-pegged. Each endpoint has a fixed USD price target ($0.005 → $0.0275 across the catalog). The microSTX amount required is recomputed from live STX/USD and cached at the edge for one hour.
- Premium over the LunarCrush Individual subscription per-call effective rate ($90/mo ≈ $0.003/call). Agents pay a convenience premium; heavy users self-funnel into the $90/mo Individual tier.

## Worker Hosts

- Mainnet (real money): `https://lunarcrush-x402-poc-prod.lunarcrush.workers.dev`
- Testnet (faucet STX): `https://lunarcrush-x402-poc.lunarcrush.workers.dev`

Recipient wallet on Stacks mainnet: `SP3TH5S631RYN7Z485TY0KPFVX24R7RW7P25HVZ73` (Prime Spoke, on-chain identity registered with aibtc.news).

## Notes

- The skill reads your wallet via the shared `getAccount()` helper (env mnemonic or unlocked wallet skill). x402 payment is handled automatically by `createApiClient`.
- LunarCrush API quota is protected by 60-second Cloudflare edge cache; multiple agents requesting the same symbol within 60s share a single upstream LC fetch.
- All data sourced from the LunarCrush public v4 API. LunarCrush is the canonical source.
