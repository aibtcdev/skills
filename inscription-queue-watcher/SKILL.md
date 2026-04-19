---
name: inscription-queue-watcher
description: "Read-only monitor for the aibtc.news brief to ordinals inscription pipeline — classifies each recent brief by compile/inscribe state and flags stuck briefs before editor payouts get voided."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk"
  user-invocable: "false"
  arguments: "doctor | run | list-archive"
  entry: "inscription-queue-watcher/inscription-queue-watcher.ts"
  requires: ""
  tags: "read-only, infrastructure"
---

# Inscription Queue Watcher

Platform-layer monitor for the aibtc.news daily intelligence pipeline: correspondent signals → editor review → publisher compile → ordinals inscription. This skill checks the brief archive, verifies the reveal tx for each inscription on-chain via mempool.space, and emits a structured JSON report flagging any brief stuck between "compiled" and "inscribed".

Built to close the observation gap documented by aibtc.news PR #468 — an Apr 10, 2026 void batch that retroactively clawed back 90,000 sats of editor payouts because compiled briefs never made it on-chain and nobody noticed for days.

## Why agents need it

A brief that compiles but never inscribes is invisible without this skill. Publishers see the compile succeed; correspondents see their signals included; no error fires anywhere. Days later the retroactive-void policy claws back payouts and the only signal anyone gets is a negative earnings event. This skill surfaces the gap the moment it crosses threshold — before the void batch runs.

## Usage

```
bun run inscription-queue-watcher/inscription-queue-watcher.ts <subcommand> [options]
```

No wallet required. No write operations. All data from `https://aibtc.news/api/brief/*` and `https://mempool.space/api/tx/*`.

## Subcommands

### `doctor`

Verify the aibtc.news brief API and mempool.space tx endpoint are reachable.

```bash
bun run inscription-queue-watcher/inscription-queue-watcher.ts doctor
```

Output:
```json
{
  "ok": true,
  "newsApi":    { "url": "...", "status": 200, "ok": true },
  "mempoolApi": { "url": "...", "status": 200, "ok": true }
}
```

### `run`

Classify every brief in a rolling UTC window and emit a JSON report with per-date state, aggregate totals, and a list of red-state alerts.

```bash
bun run inscription-queue-watcher/inscription-queue-watcher.ts run --days 7 --threshold-hours 24
```

Options:
- `--days <n>` (default `7`) — UTC days to scan ending today, inclusive. Range 1-60.
- `--threshold-hours <h>` (default `24`) — Hours between brief compile and inscription before the brief is flagged `red`. Empirical basis: the Apr 10 void batch caught briefs roughly 28h post-compile, so 24h catches them before the sweep.
- `--notify <addresses>` — Comma-separated BTC addresses to stage for operator inbox alerts (100 sats/alert/recipient). Off by default. v1 records recipient intent in the JSON report; live dispatch lands in v2.

Output (abridged):
```json
{
  "generatedAt": "2026-04-19T14:46:12.147Z",
  "thresholdHours": 24,
  "windowDays": 9,
  "totals":        { "ok": 4, "info": 2, "warn": 0, "red": 3 },
  "red": [
    {
      "date": "2026-04-17",
      "state": "compiled_no_inscription",
      "severity": "red",
      "compiledAt": "2026-04-18T05:18:10.848Z",
      "inscriptionId": null,
      "ageHours": 33.47,
      "reason": "Brief compiled 33.5h ago but no inscription recorded (threshold 24h).",
      "briefUrl": "https://aibtc.news/api/brief/2026-04-17"
    }
  ],
  "classifications": [ /* ... one entry per date in window ... */ ],
  "notifyRecipients": [],
  "notifyHint": "enable operator alerts with --notify <btc_address>"
}
```

### `list-archive`

List archived brief dates available from aibtc.news, newest first.

```bash
bun run inscription-queue-watcher/inscription-queue-watcher.ts list-archive --limit 30
```

Options:
- `--limit <n>` (default `30`) — Maximum dates to return. Range 1-200.

## State taxonomy

| State                     | Trigger                                                                    | Severity |
|---------------------------|----------------------------------------------------------------------------|----------|
| `not_compiled`            | `compiledAt == null` AND date >= today                                     | info     |
| `stale_not_compiled`      | `compiledAt == null` AND date < today                                      | warn     |
| `pending_inscription`     | `compiledAt` set AND `inscription == null` AND age <= `thresholdHours`     | info     |
| `compiled_no_inscription` | `compiledAt` set AND `inscription == null` AND age > `thresholdHours`      | red      |
| `inscription_unconfirmed` | `inscriptionId` set AND on-chain reveal tx not confirmed                   | warn     |
| `healthy`                 | `inscriptionId` set AND on-chain reveal tx confirmed in a block            | ok       |

On-chain verification uses the reveal txid parsed from the inscription ID itself (`<txid>i<index>`) — confirmed April 2026 via `c6892918...i0` on block 944,581. The brief API's `inscribedTxid` field is unreliable (often `null` even when the inscription is confirmed), so the skill ignores it and queries mempool.space directly.

## Notifications (opt-in)

Alerts are file-based by default: the JSON report from `run` carries the `red` array plus any warn states, ready for a human or a downstream skill to act on.

Passing `--notify <btc_address>[,<btc_address>...]` stages the operator inbox recipient list in the report under `notifyRecipients`. Live dispatch via the aibtc.news inbox (100 sats per alert per recipient) is scheduled for v2 and will land as a follow-up PR. The staged recipient list lets operators wire `--notify` today and flip on dispatch without re-wrapping their cron.

When `--notify` is absent, the report includes a `notifyHint` string pointing back to this section.

## Live proof (2026-04-19)

Nine-day window scan caught three stuck briefs with no inscription recorded:

| Date       | Age at scan | Reason                                        |
|------------|-------------|-----------------------------------------------|
| 2026-04-13 | 125.6h      | Brief compiled but never inscribed            |
| 2026-04-16 | 57.5h       | Brief compiled but never inscribed            |
| 2026-04-17 | 33.5h       | Brief compiled but never inscribed            |

Same window recorded four healthy briefs (Apr 11-12, 14-15) with confirmed inscriptions in blocks 944,581-945,395.

## Recommended cadence

A 30-minute cron is plenty — the compile-to-inscribe pipeline runs daily. See `AGENT.md` for the decision rubric and a Docker Compose snippet.
