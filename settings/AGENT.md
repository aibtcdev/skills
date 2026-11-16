---
name: settings-agent
skill: settings
description: Configures AIBTC skill suite settings — Hiro API key for authenticated rate limits, custom Stacks API node URL, and package version queries.
---

# Settings Agent

Manages configuration stored at `~/.aibtc/config.json`. Controls the Hiro API key used for authenticated Stacks API requests (higher rate limits than public access) and the optional custom Stacks API node URL. Reports the current package version and diagnoses x402 sponsor relay health. No wallet is required for any settings operation.

## Prerequisites

- No wallet required — settings are independent of the wallet system
- For `set-hiro-api-key`: a valid Hiro API key from https://platform.hiro.so/
- For `set-stacks-api-url`: a running Stacks API node serving `/v2/` and `/extended/v1/` endpoints

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Configure Hiro API key | `set-hiro-api-key` — enables authenticated rate limits |
| Check if API key is set | `get-hiro-api-key` — shows source and masked preview |
| Remove stored API key | `delete-hiro-api-key` — reverts to public rate limits |
| Point to a custom node | `set-stacks-api-url` — overrides the default Hiro API |
| Check active API URL | `get-stacks-api-url` — shows active URL and source |
| Revert to default node | `delete-stacks-api-url` — restores the Hiro API endpoint |
| Check package version | `get-server-version` — compares installed vs latest GitHub release |
| Diagnose relay issues | `check-relay-health` — verifies relay reachability and sponsor nonce status |

## Safety Checks

- Treat the Hiro API key as sensitive — avoid logging it; `get-hiro-api-key` shows only a masked preview
- When setting a custom Stacks API URL, verify the node is reachable before running write operations
- `check-relay-health` makes external HTTP requests to the relay and Hiro API — requires network access
- The `HIRO_API_KEY` environment variable takes effect as a fallback even after `delete-hiro-api-key`

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| Network error on `get-server-version` | GitHub API unreachable or rate-limited | Non-fatal — `latestVersion` will be `"unknown"` |
| `"reachable": false` on `check-relay-health` | Relay URL unreachable or timed out | Check the relay URL; try again or use `--relay-url` to specify an alternative |
| Hiro API HTTP error on `check-relay-health` | Hiro API unavailable or rate limited | Set a Hiro API key via `set-hiro-api-key` and retry |

## Output Handling

- `get-hiro-api-key`: check `configured` (boolean) — if `false`, run `set-hiro-api-key` before high-volume queries
- `get-stacks-api-url`: check `isCustom` to determine if a custom node is active; use `activeUrl` for display
- `get-server-version`: check `updateAvailable` — if `true`, update (`git pull` in a checkout, or re-run `npx skills add` + `bun install`) before new workflows
- `check-relay-health`: check `healthy` (boolean) first; if `false`, read `issues` array for specific problems; check `sponsor.missingNonces` for stuck transaction diagnosis

## Example Invocations

```bash
# Store a Hiro API key for authenticated requests
bun run settings/settings.ts set-hiro-api-key --api-key <key>

# Check the currently configured Stacks API URL
bun run settings/settings.ts get-stacks-api-url

# Get the current package version
bun run settings/settings.ts get-server-version

# Check relay health with defaults
bun run settings/settings.ts check-relay-health
```
