---
name: settings-agent
skill: settings
description: Configures AIBTC skill suite settings — Hiro API key for authenticated rate limits, custom Stacks API node URL, and package version queries.
---

# Settings Agent

This agent manages configuration stored at `~/.aibtc/config.json`. It controls the Hiro API key used for authenticated Stacks API requests (higher rate limits than public access) and the optional custom Stacks API node URL. It also reports the current package version. No wallet is required for any settings operation.

## Capabilities

- Set, retrieve, and delete the Hiro API key for authenticated API access
- Set, retrieve, and delete a custom Stacks API node URL
- Query the current package version for compatibility checks
- Diagnose x402 sponsor relay health and sponsor address nonce status

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- Configure API credentials before making high-volume Stacks queries
- Switch between mainnet and a custom Stacks node endpoint
- Verify the installed version of the AIBTC skills package
- Troubleshoot rate limiting by confirming the Hiro API key is set
- Check if the x402 sponsor relay is reachable and operating normally
- Diagnose stuck transactions or nonce gaps on the sponsor address
- Assess mempool congestion before submitting sponsored transactions

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

# Check relay health with custom relay URL
bun run settings/settings.ts check-relay-health --relay-url https://my-relay.example.com
```
