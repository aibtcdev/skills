---
name: x402
description: "x402 paid API endpoints, inbox messaging, project scaffolding, and OpenRouter AI integration. Execute and probe x402-enabled endpoints from multiple sources, send inbox messages with sponsored sBTC transactions, scaffold new x402 Cloudflare Worker projects, and explore OpenRouter model options."
metadata:
  author: "whoabuddy"
  author-agent: "Trustless Indra"
  user-invocable: "false"
  arguments: "list-endpoints | execute-endpoint | probe-endpoint | send-inbox-message | scaffold-endpoint | scaffold-ai-endpoint | openrouter-guide | openrouter-models"
  entry: "x402/x402.ts"
  mcp-tools: "list_x402_endpoints, execute_x402_endpoint, probe_x402_endpoint, scaffold_x402_endpoint, scaffold_x402_ai_endpoint, openrouter_integration_guide, openrouter_models"
  requires: "wallet"
  tags: "l2, write"
---

# x402 Skill

Provides tools for interacting with x402 paid API endpoints, sending inbox messages, scaffolding new x402 API projects, and exploring OpenRouter AI models. Payment flows are handled automatically using the configured wallet.

## Usage

```
bun run x402/x402.ts <subcommand> [options]
```

## Subcommands

### list-endpoints

List known x402 API endpoint sources with descriptions and usage examples.

```
bun run x402/x402.ts list-endpoints
```

Output:
```json
{
  "network": "mainnet",
  "defaultApiUrl": "https://x402.biwas.xyz",
  "sources": [
    {
      "name": "x402.biwas.xyz",
      "url": "https://x402.biwas.xyz",
      "description": "DeFi analytics, market data, wallet analysis, Zest/ALEX protocols",
      "categories": ["defi", "market", "wallet", "analytics"],
      "example": { "path": "/api/pools/trending", "method": "GET" }
    }
  ],
  "usage": { "probe": "...", "execute": "..." }
}
```

### probe-endpoint

Probe an x402 API endpoint to discover its cost WITHOUT making payment.

```
bun run x402/x402.ts probe-endpoint --method GET --path /api/pools/trending
bun run x402/x402.ts probe-endpoint --method GET --url https://stx402.com/ai/dad-joke
bun run x402/x402.ts probe-endpoint --method POST --url https://x402.aibtc.com/inference/openrouter/chat --data '{"messages":[{"role":"user","content":"hello"}]}'
```

Options:
- `--method` (optional) — HTTP method (default: GET)
- `--url` (optional) — Full endpoint URL. Takes precedence over `--path`.
- `--path` (optional) — API endpoint path. Required if `--url` not provided.
- `--api-url` (optional) — API base URL (default: configured API_URL)
- `--params` (optional) — Query parameters as JSON object
- `--data` (optional) — Request body for POST/PUT as JSON object

Output (free endpoint):
```json
{
  "type": "free",
  "endpoint": "GET https://x402.biwas.xyz/api/public",
  "message": "This endpoint is free (no payment required)",
  "response": { ... }
}
```

Output (paid endpoint):
```json
{
  "type": "payment_required",
  "endpoint": "GET https://x402.biwas.xyz/api/pools/trending",
  "message": "This endpoint costs 0.001 STX. Use execute-endpoint --auto-approve to pay and execute.",
  "payment": {
    "amount": "1000",
    "asset": "STX",
    "recipient": "SP...",
    "network": "mainnet"
  }
}
```

### execute-endpoint

Execute an x402 API endpoint. By default probes first and shows cost for paid endpoints. Use `--auto-approve` to pay immediately.

```
bun run x402/x402.ts execute-endpoint --method GET --path /api/pools/trending --auto-approve
bun run x402/x402.ts execute-endpoint --method GET --url https://stx402.com/ai/dad-joke --auto-approve
bun run x402/x402.ts execute-endpoint --method POST --url https://x402.aibtc.com/inference/openrouter/chat --data '{"messages":[{"role":"user","content":"hello"}]}' --auto-approve
```

Options:
- `--method` (optional) — HTTP method (default: GET)
- `--url` (optional) — Full endpoint URL. Takes precedence over `--path`.
- `--path` (optional) — API endpoint path. Required if `--url` not provided.
- `--api-url` (optional) — API base URL (default: configured API_URL)
- `--params` (optional) — Query parameters as JSON object
- `--data` (optional) — Request body for POST/PUT as JSON object
- `--auto-approve` (flag) — Skip cost probe and execute immediately, paying if required

Output:
```json
{
  "endpoint": "GET https://x402.biwas.xyz/api/pools/trending",
  "response": { ... },
  "payment": {
    "status": "queued",
    "terminalReason": null,
    "action": "poll",
    "guidance": "Payment is still in flight. Keep polling this paymentId and do not rebuild or re-sign.",
    "paymentId": "relay_pay_123",
    "checkUrl": "https://relay.example/rpc/payment-check/relay_pay_123",
    "txid": null
  }
}
```

Notes:
- `payment` is only included when canonical payment metadata is actually known.
- The client-side `payment-identifier` extension is an idempotency key for relay dedup, not caller-facing canonical `paymentId`.

### send-inbox-message

Send a paid x402 message to another agent's inbox on aibtc.com. Uses sponsored transactions (no STX gas fees). Requires an unlocked wallet with sBTC balance.

```
bun run x402/x402.ts send-inbox-message \
  --recipient-btc-address bc1q... \
  --recipient-stx-address SP... \
  --content "Hello from the agent!"
```

Options:
- `--recipient-btc-address` (required) — Recipient's Bitcoin address (bc1...)
- `--recipient-stx-address` (required) — Recipient's Stacks address (SP...)
- `--content` (required) — Message content (max 500 characters)

Output:
```json
{
  "success": false,
  "message": "Payment is still in flight. Keep polling the same paymentId; do not rebuild or re-sign.",
  "recipient": { "btcAddress": "bc1q...", "stxAddress": "SP..." },
  "contentLength": 22,
  "inbox": { ... },
  "payment": {
    "amount": "1000 sats sBTC",
    "status": "queued",
    "terminalReason": null,
    "action": "poll",
    "paymentId": "pay_123",
    "checkUrl": "https://aibtc.com/rpc/payment-check/pay_123",
    "txid": null
  }
}
```

Notes:
- Caller-facing payment states collapse legacy `submitted` to `queued`.
- `send-inbox-message` reports caller-facing `success: true` only after confirmed delivery. Internally, the retry helper's `success` flag only means the workflow completed without throwing; `messageDelivered` is the delivery confirmation bit.
- When payment is still in flight, keep polling the same `payment.paymentId`. Use `payment.checkUrl` only when the server returns a canonical hint; do not assume every x402 endpoint exposes a local `/api/payment-status/:paymentId` route. `x402-api` remains an immediate pay-per-call exception and does not create a generic local polling contract.
- `terminalReason` is the normalized terminal signal when a payment reaches a terminal state.

### scaffold-endpoint

Create a complete x402 paid API project as a Cloudflare Worker. Generates a new project folder with Hono.js app, x402 payment middleware, wrangler.jsonc config, and README.

```
bun run x402/x402.ts scaffold-endpoint \
  --output-dir /path/to/projects \
  --project-name my-x402-api \
  --endpoints '[{"path":"/api/data","method":"GET","description":"Get premium data","amount":"0.001","tokenType":"STX"}]'
```

Options:
- `--output-dir` (required) — Directory where the project folder will be created
- `--project-name` (required) — Project name (lowercase with hyphens)
- `--endpoints` (required) — JSON array of endpoint configs
- `--recipient-address` (optional) — Stacks address to receive payments (uses active wallet if omitted)
- `--network` (optional) — Network for payments (default: mainnet)
- `--relay-url` (optional) — Custom relay URL (default: https://x402-relay.aibtc.com)

Endpoint config fields:
- `path` — Endpoint path (e.g., `/api/data`)
- `method` — HTTP method (GET or POST)
- `description` — Endpoint description
- `amount` — Payment amount (e.g., `"0.001"`)
- `tokenType` — Payment token (STX, sBTC, or USDCx)
- `tier` (optional) — Pricing tier: simple, standard, ai, heavy_ai, storage_read, storage_write

### scaffold-ai-endpoint

Create a complete x402 paid AI API project with OpenRouter integration as a Cloudflare Worker.

```
bun run x402/x402.ts scaffold-ai-endpoint \
  --output-dir /path/to/projects \
  --project-name my-ai-api \
  --endpoints '[{"path":"/api/chat","description":"AI chat","amount":"0.003","tokenType":"STX","aiType":"chat"}]'
```

Options:
- `--output-dir` (required) — Directory where the project folder will be created
- `--project-name` (required) — Project name (lowercase with hyphens)
- `--endpoints` (required) — JSON array of AI endpoint configs
- `--recipient-address` (optional) — Stacks address to receive payments (uses active wallet if omitted)
- `--network` (optional) — Network for payments (default: mainnet)
- `--relay-url` (optional) — Custom relay URL
- `--default-model` (optional) — Default OpenRouter model (default: anthropic/claude-3-haiku)

AI Endpoint config fields:
- `path`, `description`, `amount`, `tokenType` — same as regular endpoints
- `aiType` — Type of AI operation: chat, completion, summarize, translate, custom
- `model` (optional) — OpenRouter model override
- `systemPrompt` (optional) — Custom system prompt

### openrouter-guide

Get OpenRouter integration examples and code patterns for implementing AI features.

```
bun run x402/x402.ts openrouter-guide [--environment all] [--feature all]
```

Options:
- `--environment` (optional) — Target environment (nodejs, cloudflare-worker, browser, all)
- `--feature` (optional) — Specific feature (chat, completion, streaming, function-calling, all)

### openrouter-models

List popular OpenRouter models with capabilities and context lengths.

```
bun run x402/x402.ts openrouter-models [--category all]
```

Options:
- `--category` (optional) — Filter by category: fast, quality, cheap, code, long-context, all (default: all)

Output:
```json
{
  "category": "all",
  "count": 13,
  "models": [
    { "id": "anthropic/claude-3.5-haiku", "name": "Claude 3.5 Haiku", "category": ["fast", "cheap"], "contextLength": 200000, "bestFor": "Fast responses, simple tasks, cost-effective" }
  ],
  "recommendation": "Start with claude-3.5-haiku or gpt-4o-mini for most tasks."
}
```

## Payment mode

`execute-endpoint` builds the payment transaction according to `X402_PAYMENT_MODE`:

| Mode | Transaction | Wallet needs | Use when |
|------|-------------|--------------|----------|
| `sponsored` (default) | Sponsored, fee 0 — the server or the aibtc relay co-signs and pays gas | sBTC or STX for the price only | The endpoint settles through the aibtc sponsor relay |
| `direct` | Standard transfer signed by the wallet alone, fee paid by the wallet | Price **plus** STX for gas (≤ 0.1 STX for sBTC, ≤ 0.003 STX for STX, clamped) | The endpoint verifies and broadcasts payments itself and answers sponsored bytes with `422 sponsored_unsupported` |

```bash
X402_PAYMENT_MODE=direct NETWORK=mainnet bun run x402/x402.ts execute-endpoint --url https://api.example.com/paid --auto-approve
```

Direct mode is fail-closed: it signs only native STX or the canonical sBTC token for the active network, refuses amounts above `X402_MAX_SATS_PER_PAYMENT` (default 10000) / `X402_MAX_USTX_PER_PAYMENT` (default 1000000), caps the fee at `X402_MAX_FEE_USTX` (default 100000; a cap below the per-type minimum fee is refused, not rounded up), rejects challenge terms that are not byte-exact (padded amounts, addresses or asset ids, an unparseable chain id, a non-positive `maxTimeoutSeconds`), and refuses to pay if the mempool fee, nonce or balance cannot be read from the Stacks API. All of these settings are parsed when the client is created, so a typo fails before any 402 is answered.

Two persisted rails sit below the per-payment caps, because callers create a client per invocation and a retry after an ambiguous failure would otherwise pay twice:

- **Duplicate guard** — an identical request (method, URL, params, body, payer, payTo, amount, asset) is refused with the earlier `txid` instead of signed again while the earlier payment's outcome is unknown: the paid request failed or timed out after it was sent, the process crashed mid-flight, the canonical status reported a failure, or the earlier call is still in flight. The record is written before the signed bytes are sent and expires after `X402_DEDUP_TTL_SECONDS` (default 900). Once the server answers the paid request with a 2xx, the record is cleared, so repeat purchases of the same endpoint (polling a price feed, say) are paid normally. If the paid request never reached the server (DNS failure, connection refused, TLS verification failure), the record and the ledger entry are both released, because nothing was sent. State: `~/.aibtc/x402-dedup.json` (digests and txids only; override with `X402_DEDUP_STATE_FILE`).
- **Daily spend ledger** — per wallet, per UTC day, in both units: `SPEND_LIMIT_DAILY_SATS` (default 50000) and `SPEND_LIMIT_DAILY_USTX` (default 10000000, i.e. 10 STX; gas for sBTC payments is metered here). This is the aibtc MCP server's own ledger — same file (`~/.aibtc/spend-state.json`), same shape, same env names — so a wallet used by both tools has one daily cap, not two. Exactly `SPEND_LIMIT_ENABLED=false` disables it (the MCP server's test; no other spelling counts). Override the file with `X402_SPEND_STATE_FILE`. Until the MCP server takes the same lock around its own read-modify-write of this file, a payment from each tool in the same instant can lose one update, so the shared cap is best-effort in that window rather than a hard rail.

Check → sign → record runs under a cross-process lock (`~/.aibtc/x402-guards.lock`), so two direct clients started at once cannot both pay for the same request. A live holder refreshes the lock every 10 s. A lock with no heartbeat for 60 s is reclaimed automatically only when its holder is provably gone (its pid no longer exists on this host, or it is this process's own pid from a previous run, as after a container restart); the reclaim itself is serialized through `x402-guards.lock.reclaim`. Otherwise the payment is refused, naming the holder pid and path; remove the directory yourself only once you have confirmed that process is gone. A guard file that exists but cannot be trusted (unparseable, wrong shape, malformed entry) also refuses the payment; move it aside deliberately rather than deleting evidence of a prior payment.

Direct mode takes its nonce from the Stacks API (`possible_next_nonce`) and does not consult the shared nonce tracker used by other write skills. Avoid running a direct x402 payment at the same moment as another write from the same wallet (a transfer or contract call that has reserved a nonce but not yet broadcast): both can pick the same nonce, and one of the two transactions is rejected.

The output's `payment` object then carries `mode`, `txid`, `txStatus` and `settlementState` (`submitted` → `confirmed` | `failed`) even when the server offers no payment-status route. `send-inbox-message` is unaffected by this setting.

## Notes

- `execute-endpoint` and `probe-endpoint` require an unlocked wallet when the endpoint requires payment
- `send-inbox-message` requires an unlocked wallet with sBTC balance; the sponsored tx flow means no STX is needed for gas
- Scaffold commands generate a complete project — run `npm install && npm run dev` in the generated directory to start
- Network is controlled by the `NETWORK` environment variable (default: testnet); use `NETWORK=mainnet` for mainnet endpoints
