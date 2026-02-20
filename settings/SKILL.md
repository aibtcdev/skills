---
name: settings
description: Manage AIBTC skill settings stored at ~/.aibtc/config.json. Configure the Hiro API key for authenticated rate limits, set a custom Stacks API node URL, and check the current package version.
user-invocable: false
arguments: set-hiro-api-key | get-hiro-api-key | delete-hiro-api-key | set-stacks-api-url | get-stacks-api-url | delete-stacks-api-url | get-server-version
entry: settings/settings.ts
requires: []
tags: [infrastructure]
---

# Settings Skill

Manages configuration stored at `~/.aibtc/config.json`. Controls the Hiro API key used for authenticated Stacks API requests, the custom Stacks API node URL, and provides version information.

## Usage

```
bun run settings/settings.ts <subcommand> [options]
```

## Subcommands

### set-hiro-api-key

Save a Hiro API key to `~/.aibtc/config.json`. Authenticated requests receive higher rate limits than public (unauthenticated) requests.

Get a free API key at https://platform.hiro.so/

```
bun run settings/settings.ts set-hiro-api-key --api-key <key>
```

Options:
- `--api-key` (required) — Your Hiro API key (sensitive value)

Output:
```json
{
  "success": true,
  "message": "Hiro API key saved. All subsequent Hiro API requests will use this key.",
  "maskedKey": "abcd...wxyz",
  "storedIn": "~/.aibtc/config.json"
}
```

### get-hiro-api-key

Check whether a Hiro API key is configured. Shows the key source and a masked preview.

```
bun run settings/settings.ts get-hiro-api-key
```

Output (key configured):
```json
{
  "configured": true,
  "source": "~/.aibtc/config.json",
  "maskedKey": "abcd...wxyz",
  "hint": "API key is active. Hiro API requests use authenticated rate limits."
}
```

Output (no key):
```json
{
  "configured": false,
  "source": "none",
  "maskedKey": "(not set)",
  "hint": "No API key configured. Using public rate limits. Get a key at https://platform.hiro.so/"
}
```

### delete-hiro-api-key

Remove the stored Hiro API key from `~/.aibtc/config.json`. If `HIRO_API_KEY` is set in the environment, that will still be used as a fallback.

```
bun run settings/settings.ts delete-hiro-api-key
```

Output:
```json
{
  "success": true,
  "message": "Hiro API key removed from ~/.aibtc/config.json.",
  "envFallbackActive": false,
  "hint": "No API key configured. Requests will use public rate limits."
}
```

### set-stacks-api-url

Point all Stacks API requests at a custom node instead of the default Hiro API. The URL must serve the same `/v2/` and `/extended/v1/` endpoints as `api.hiro.so`.

```
bun run settings/settings.ts set-stacks-api-url --url <url>
```

Options:
- `--url` (required) — Base URL of your Stacks API node (e.g. `http://localhost:3999`)

Output:
```json
{
  "success": true,
  "message": "Custom Stacks API URL saved. All subsequent Stacks API requests will use this node.",
  "url": "http://localhost:3999",
  "storedIn": "~/.aibtc/config.json",
  "tip": "Use get-stacks-api-url to verify, or delete-stacks-api-url to revert to the default."
}
```

### get-stacks-api-url

Show the current Stacks API URL being used. Indicates whether it is a custom node or the default Hiro API.

```
bun run settings/settings.ts get-stacks-api-url
```

Output (custom URL):
```json
{
  "activeUrl": "http://localhost:3999",
  "isCustom": true,
  "source": "~/.aibtc/config.json",
  "defaultUrl": "https://api.testnet.hiro.so",
  "network": "testnet",
  "hint": "Using custom Stacks API node."
}
```

Output (default):
```json
{
  "activeUrl": "https://api.testnet.hiro.so",
  "isCustom": false,
  "source": "default (Hiro API)",
  "defaultUrl": "https://api.testnet.hiro.so",
  "network": "testnet",
  "hint": "Using default Hiro API. Use set-stacks-api-url to point to your own node."
}
```

### delete-stacks-api-url

Remove the custom Stacks API URL and revert to the default Hiro API (`api.mainnet.hiro.so` or `api.testnet.hiro.so`).

```
bun run settings/settings.ts delete-stacks-api-url
```

Output:
```json
{
  "success": true,
  "message": "Custom Stacks API URL removed. Reverted to default: https://api.testnet.hiro.so",
  "activeUrl": "https://api.testnet.hiro.so",
  "network": "testnet"
}
```

### get-server-version

Check the currently installed package version and compare with the latest published version on npm.

```
bun run settings/settings.ts get-server-version
```

Output:
```json
{
  "currentVersion": "0.1.0",
  "latestVersion": "0.1.0",
  "isLatest": true,
  "updateAvailable": false,
  "package": "@aibtc/skills"
}
```

## Configuration File

All settings are stored in `~/.aibtc/config.json`. This file is created automatically on first use by any wallet or settings subcommand.

```json
{
  "version": 1,
  "activeWalletId": null,
  "autoLockTimeout": 15,
  "hiroApiKey": "your-key-here",
  "stacksApiUrl": "http://localhost:3999"
}
```

## Environment Variable Fallbacks

- `HIRO_API_KEY` — Used if no stored key is set in config
- `NETWORK` — Set to `mainnet` or `testnet` (default: `testnet`)
- `API_URL` — Custom x402 relay URL
