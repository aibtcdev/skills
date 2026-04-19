---
name: inscription-queue-watcher-agent
skill: inscription-queue-watcher
description: "Read-only pipeline observability for aibtc.news brief inscription. Operate as a background cron; surface red-state alerts to the operator without taking autonomous remediation."
---

# Inscription Queue Watcher — Agent Decision Guide

## When to use this skill

- Before an operator shift on the aibtc.news pipeline — run `run --days 7` as a situation check.
- On a recurring cron (30 min) inside an agent's Docker stack, appending reports to a state file.
- After a brief compile you are personally responsible for, to confirm the inscription landed within the threshold.
- When investigating a retroactive editor-payout void — scan the days before the void batch to see which briefs slipped.

Do NOT use this skill to:
- Broadcast or retry an inscription. This is operator territory.
- Hold editorial opinions about signal content. Use `aibtc-news-editor` or `aibtc-news-publisher` for that.
- Replace the aibtc.news publisher workflow. This observes the pipeline; it does not compile briefs.

## Decision order

1. Run `doctor` once per agent session to verify both upstream APIs are reachable.
2. Run `run --days 7 --threshold-hours 24` to get a rolling report.
3. Inspect `totals.red`. If `> 0`:
   - Read each entry in `red[]`.
   - Cross-check `briefUrl` manually against aibtc.news to confirm the gap is real and not an API lag.
   - Surface the findings to the operator or downstream skill — do not attempt to inscribe autonomously.
4. Inspect `totals.warn`. Warn states are usually in-flight or transient:
   - `inscription_unconfirmed` — normal for the first ~30 min after reveal broadcast.
   - `stale_not_compiled` — the publisher missed a day; flag but do not escalate until 12h past midnight.
5. Expect `info` on today's date (brief usually compiles around 04-05 UTC; today reads `not_compiled` until then).

## Guardrails

- **Never broadcast anything based on this skill's output.** It is strictly observational.
- **Rate-limit politely.** Default window is 7 days = 7 aibtc.news requests + up to 7 mempool.space requests. Do not loop faster than 1× / 5 min.
- **Do not enable `--notify` without the operator's consent.** v1 only stages recipients; v2 dispatch will bill 100 sats per alert per recipient from the agent's sBTC balance.
- **Re-run `doctor` on any `ok: false` result** before interpreting `run` output as a failure — the upstream API may simply be briefly offline.
- **Trust `onChain.confirmed` over `inscribedTxid`.** The brief API's `inscribedTxid` field returns `null` even when the inscription is confirmed; the skill avoids it by parsing the reveal txid from the inscription ID and asking mempool.space directly.

## Error handling

| Error message                                             | Cause                                             | Fix                                                                                 |
|-----------------------------------------------------------|---------------------------------------------------|-------------------------------------------------------------------------------------|
| `aibtc.news brief fetch failed for YYYY-MM-DD: 404`       | Date before the archive (> 2 months old) or 404 returned for non-today past dates | Narrow `--days` window or accept the entry being classified as `stale_not_compiled` |
| `aibtc.news brief fetch failed: 5xx`                      | Upstream transient error                          | Re-run in 60s; open a signal on the `infrastructure` beat if 5xx persists > 10 min  |
| `mempool.space /tx/... failed: 5xx`                       | mempool.space transient error                     | Re-run; on persistent failure fall back to block explorer via `briefUrl`            |
| `--days must be an integer between 1 and 60`              | Bad CLI input                                     | Pass an integer in range                                                            |
| `--threshold-hours must be a positive number`             | Bad CLI input                                     | Pass a positive number                                                              |

## Output handling

- **Primary field:** `totals.red` — if non-zero, attention required.
- **`red[].ageHours`** grades urgency: 24-48h means operator should look today; > 72h means a retroactive void is close.
- **`classifications[]`** is the full window; use it to plot trends (e.g. "inscribed Apr 11-12 but not Apr 13 — what changed on the 13th?").
- **`notifyHint`** reminds the caller how to enable operator alerts; it is only present when `notifyRecipients` is empty.

## Chaining with other skills

Pairs well with:
- **`aibtc-news`** — use `compile-brief` or `list-signals` to confirm the brief actually has enough signals to justify compilation.
- **`mempool-watch`** — deeper inspection of an individual reveal tx (`tx-status`) when `inscription_unconfirmed` persists.
- **`paperboy`** — when notification dispatch (v2) lands, paid alerts can be routed through paperboy's delivery mechanism.

## Docker cron snippet (operator reference)

```yaml
inscription-watcher:
  image: oven/bun:1
  working_dir: /app
  volumes:
    - .:/app
  command: >
    sh -c "while true; do
      bun run inscription-queue-watcher/inscription-queue-watcher.ts run --days 7 --threshold-hours 24 > /app/state/inscription-alerts.json 2>> /app/state/inscription-watcher.log;
      sleep 1800;
    done"
  restart: unless-stopped
```

Keep the `bun run ... 2>> ... .log;` on a single unbroken line. YAML's folded scalar preserves newlines between lines that are indented deeper than the base, so splitting the redirect across lines will break stdout capture — the redirect becomes a no-op and the JSON ends up in `docker logs` instead of the state file.

## Frequency

- **Interactive:** before any action that depends on a brief being on-chain.
- **Autonomous:** every 30 min is plenty. Faster than 5 min wastes API budget with no gain.
- **On incident:** re-run immediately after a publisher reports a compile, to confirm the inscription started.
