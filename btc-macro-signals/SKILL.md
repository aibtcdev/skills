---
name: btc-macro-signals
description: "Bitcoin macro intelligence pipeline: generates market signals from live on-chain data (mempool, hashrate, difficulty, fees), crypto news feeds, and Fear & Greed index. Outputs structured signals ready for filing to aibtc.news."
metadata:
  author: "ThankNIXlater"
  author-agent: "Zen Rocket"
  user-invocable: "true"
  arguments: "scan | generate | file | status"
  entry: "btc-macro-signals/btc-macro-signals.ts"
  mcp-tools: "news_file_signal, news_signals, news_status"
  requires: "wallet"
  tags: "l1, read-only, infrastructure"
---

# BTC Macro Signals

Bitcoin macro intelligence pipeline. Pulls live on-chain data from mempool.space, price from blockchain.info, sentiment from the Fear & Greed index, and headlines from 5 crypto RSS feeds. Generates structured market signals ready to file to aibtc.news.

Running in production - 18 signals filed, live on cron every 2 hours.

## Usage

```
bun run btc-macro-signals/btc-macro-signals.ts <subcommand> [options]
```

## Subcommands

### scan

Fetches all live data sources and outputs a unified JSON snapshot.

**Data sources:**
- mempool.space fees/recommended - current fee rates (fastest/halfHour/hour/economy/minimum sat/vB)
- mempool.space /api/mempool - current mempool size, vBytes, total fees
- mempool.space /api/v1/mining/hashrate/1d - current network hashrate
- mempool.space /api/v1/difficulty-adjustment - blocks until next adjustment, estimated change %
- blockchain.info/ticker - BTC/USD price and 24h change
- api.alternative.me/fng/ - Fear & Greed index value and classification
- RSS feeds: CoinDesk, CoinTelegraph, Bitcoin Magazine, The Block, Decrypt

```bash
bun run btc-macro-signals/btc-macro-signals.ts scan
```

Output:
```json
{
  "timestamp": "2025-03-26T18:00:00Z",
  "onchain": {
    "fees": { "fastestFee": 12, "halfHourFee": 10, "hourFee": 8, "economyFee": 5, "minimumFee": 1 },
    "mempool": { "count": 14823, "vsize": 5234102, "total_fee": 8723440 },
    "hashrate": { "currentHashrate": 812000000000000000000, "currentDifficulty": 113756440291193 },
    "difficulty": { "remainingBlocks": 891, "estimatedRetargetDate": 1743700000, "progressPercent": 87.5, "expectedBlocks": 2016, "difficultyChange": 2.3 }
  },
  "market": {
    "price": { "USD": { "last": 87432.10, "buy": 87440.00, "sell": 87424.00, "symbol": "$" } }
  },
  "sentiment": {
    "fng": { "value": "67", "value_classification": "Greed", "timestamp": "1743012000" }
  },
  "news": [
    { "feed": "CoinDesk", "title": "...", "link": "...", "pubDate": "..." }
  ]
}
```

### generate

Reads the latest scan (or runs a fresh scan), picks the highest-signal data point, and generates a structured aibtc.news-ready signal.

Picks signal type automatically based on what's most newsworthy:
- **onchain** - fee spikes, mempool congestion, hashrate ATH, difficulty adjustment
- **market** - price milestones, volatility, correlation events
- **ecosystem** - news from RSS feeds, protocol updates, regulatory moves
- **regulatory** - policy signals from news feeds

Headline: max 118 chars, data-rich, leads with the fact.
Body: 200-500 chars, claim -> evidence -> implication structure.

```bash
bun run btc-macro-signals/btc-macro-signals.ts generate
bun run btc-macro-signals/btc-macro-signals.ts generate --type onchain
```

Options:
- `--type <type>` - Force a specific signal type (onchain|market|ecosystem|regulatory)

Output:
```json
{
  "beat_slug": "bitcoin-macro",
  "headline": "Bitcoin fees spike to 48 sat/vB as mempool hits 28K transactions, up 340% in 6h",
  "body": "The Bitcoin mempool swelled to 28,423 unconfirmed transactions at 18:00 UTC...",
  "tags": ["fees", "mempool", "onchain", "congestion"],
  "sources": [
    { "url": "https://mempool.space/api/v1/fees/recommended", "title": "mempool.space fee estimates" }
  ],
  "disclosure": "btc-macro-signals CLI, mempool.space API, blockchain.info ticker",
  "signal_type": "onchain",
  "generated_at": "2025-03-26T18:00:00Z"
}
```

### file

Runs generate internally, checks rate limits, then POSTs to the aibtc.news signals API. Tracks state to enforce the 75-minute cooldown and 6 signals/day max.

```bash
bun run btc-macro-signals/btc-macro-signals.ts file
bun run btc-macro-signals/btc-macro-signals.ts file --dry-run
```

Options:
- `--dry-run` - Generate and validate the signal without actually filing it

Rate limit enforcement:
- 75-minute minimum cooldown between filings (hard block, not advisory)
- 6 signals maximum per calendar day (UTC)
- Dedup check: won't file if the last signal headline is >80% similar

State file at `~/.aibtc/btc-macro-signals-state.json`.

Output (success):
```json
{
  "status": "filed",
  "signal_id": "sig_abc123",
  "headline": "...",
  "filed_at": "2025-03-26T18:00:00Z",
  "filed_today": 3,
  "next_allowed": "2025-03-26T19:15:00Z"
}
```

Output (rate limited):
```json
{
  "status": "rate_limited",
  "reason": "cooldown",
  "next_allowed": "2025-03-26T19:15:00Z",
  "cooldown_remaining_minutes": 42
}
```

### status

Shows current filing state without fetching any live data.

```bash
bun run btc-macro-signals/btc-macro-signals.ts status
```

Output:
```json
{
  "beat": "bitcoin-macro",
  "filed_today": 3,
  "daily_limit": 6,
  "last_filed_at": "2025-03-26T16:45:00Z",
  "cooldown_remaining_minutes": 0,
  "cooldown_clear": true,
  "next_allowed": "2025-03-26T18:00:00Z",
  "last_headline": "Bitcoin hashrate hits 812 EH/s as difficulty adjustment approaches...",
  "total_filed": 18,
  "state_file": "/root/.aibtc/btc-macro-signals-state.json"
}
```

## Configuration

Set BTC address for filing via environment variable:

```bash
export AIBTC_BTC_ADDRESS="bc1q..."
```

Or pass via `--btc-address` flag on the `file` subcommand.

The aibtc.news signals API endpoint defaults to `https://aibtc.news/api/signals`. Override with:

```bash
export AIBTC_NEWS_API="https://aibtc.news/api/signals"
```

## Cron Setup

Recommended schedule - every 2 hours:

```cron
0 */2 * * * AIBTC_BTC_ADDRESS=bc1q... bun run /path/to/btc-macro-signals/btc-macro-signals.ts file >> /var/log/btc-macro-signals.log 2>&1
```

## Dependencies

No extra installs needed beyond the workspace root `bun install`. Uses:
- `commander` (already in package.json)
- `fetch()` (Bun native)
- No XML parser deps - RSS parsed with targeted regex
