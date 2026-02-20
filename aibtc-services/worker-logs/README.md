# worker-logs

Centralized logging service for Cloudflare Workers. Each app gets isolated SQLite storage via Durable Objects. Dual access: RPC binding for internal workers, REST API with API key for external consumers.

- **GitHub:** https://github.com/aibtcdev/worker-logs (fork of whoabuddy/worker-logs)
- **Production:** https://logs.aibtc.com
- **Staging:** https://logs.aibtc.dev
- **Dashboard:** https://logs.aibtc.com/dashboard (admin login required)
- **Stack:** Cloudflare Workers, Hono.js, Durable Objects (SQLite), KV

## Purpose

Provides structured, queryable log storage for all AIBTC services. Workers log via RPC binding (no HTTP overhead). External tools access logs via REST API with API key authentication. The service is used internally by landing-page, x402-api, x402-sponsor-relay, and other AIBTC workers.

## Features

- Sharded storage — each app gets isolated SQLite via Durable Objects
- Dual access — RPC binding for internal workers, REST API for external
- Web dashboard — browse and search logs at `/dashboard`
- Health monitoring — periodic URL checks via DO alarms
- Daily stats — aggregated log counts by level (DEBUG, INFO, WARN, ERROR)

## Access Methods

### Method 1: RPC Binding (Internal Cloudflare Workers)

Add service binding to `wrangler.jsonc`:

```json
{
  "services": [
    {
      "binding": "LOGS",
      "service": "worker-logs-production",
      "entrypoint": "LogsRPC"
    }
  ]
}
```

Usage in worker code:

```typescript
await env.LOGS.info('my-app', 'User registered', { userId: '123' })
await env.LOGS.warn('my-app', 'Rate limit approaching', { count: 90 })
await env.LOGS.error('my-app', 'Transaction failed', { txid: '0x...' })
```

Log levels: `debug`, `info`, `warn`, `error`

### Method 2: REST API (External Access)

```bash
# Write a log entry
curl -X POST https://logs.aibtc.com/logs \
  -H "X-App-ID: my-app" \
  -H "X-Api-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"level": "INFO", "message": "Hello from external", "context": {}}'

# Query logs
curl "https://logs.aibtc.com/logs?level=ERROR&limit=10" \
  -H "X-App-ID: my-app" \
  -H "X-Api-Key: your-api-key"

# Get daily stats
curl "https://logs.aibtc.com/stats/my-app?days=7" \
  -H "X-App-ID: my-app" \
  -H "X-Api-Key: your-api-key"
```

## Authentication

| Endpoint | Auth Required |
|----------|---------------|
| `POST /logs`, `GET /logs` | API Key (`X-Api-Key` + `X-App-ID` headers) |
| `GET /apps/:id`, `GET /stats/:id` | API Key (own app) OR Admin Key |
| `POST /apps/:id/prune`, `POST /apps/:id/health-urls` | API Key (matching app) |
| `DELETE /apps/:id` | API Key (matching app) OR Admin Key |
| `GET /apps` | Admin Key (`X-Admin-Key` header) |
| `POST /apps` | Admin Key |
| `GET /health/:id` | Public (for monitoring) |
| `GET /` | Public (service info) |

**Headers:**
- `X-Admin-Key` — Admin authentication (app registration, full access)
- `X-Api-Key` + `X-App-ID` — Per-app authentication

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info |
| POST | `/logs` | Write a log entry |
| GET | `/logs` | Query logs (`?level`, `?limit`, `?offset`, `?search`) |
| GET | `/apps` | List all apps (admin only) |
| POST | `/apps` | Register new app (admin only) |
| GET | `/apps/:id` | Get app info |
| DELETE | `/apps/:id` | Delete app and all logs |
| POST | `/apps/:id/prune` | Delete logs older than N days |
| POST | `/apps/:id/health-urls` | Configure health check URLs |
| GET | `/stats/:id` | Daily log stats (`?days=7`) |
| GET | `/health/:id` | Public health check status |
| GET | `/dashboard` | Web dashboard (admin login required) |

## Data Model

### Log Entry

```
id TEXT PRIMARY KEY
timestamp TEXT NOT NULL
level TEXT NOT NULL    -- DEBUG | INFO | WARN | ERROR
message TEXT NOT NULL
context TEXT           -- JSON
request_id TEXT
```

### Daily Stats

```
date TEXT PRIMARY KEY  -- YYYY-MM-DD
debug INTEGER
info INTEGER
warn INTEGER
error INTEGER
```

## Related Skills

This is infrastructure — no skills directly wrap it. All AIBTC services use it internally.

## Common Workflows

### Reading Logs via REST

Useful for debugging agent actions or monitoring service health.

```bash
# Source env file for ADMIN_API_KEY
source ~/dev/aibtcdev/worker-logs/.env

# Get recent ERROR logs from a service
curl "https://logs.aibtc.com/logs?level=ERROR&limit=20" \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H "X-App-ID: landing-page-production"
```

### Integrating a New Service

1. Admin registers the app: `POST /apps` with `X-Admin-Key`
2. App receives its `app_id` and `api_key`
3. Add RPC service binding to `wrangler.jsonc`
4. Use `env.LOGS.info/warn/error` in worker code

## GitHub

https://github.com/aibtcdev/worker-logs
