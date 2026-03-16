---
name: relay-diagnostic
description: "Sponsor relay health checks and nonce recovery — diagnose stuck sponsored transactions, check nonce gaps, and attempt RBF or gap-fill recovery."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "check-health | recover"
  entry: "relay-diagnostic/relay-diagnostic.ts"
  mcp-tools: "check_relay_health, recover_sponsor_nonce"
  requires: "wallet"
  tags: "l2, diagnostic"
---

# Relay Diagnostic Skill

Diagnoses and recovers stuck sponsored transactions by inspecting the sponsor relay's nonce state and optionally triggering automated recovery.

- **check-health** — Read-only, no wallet required. Returns relay version, sponsor nonce status, detected gaps, and stuck transactions.
- **recover** — Requires an unlocked wallet (to source the sponsor API key). Attempts RBF, gap-fill, or both.

## Usage

```
bun run relay-diagnostic/relay-diagnostic.ts <subcommand> [options]
```

## Subcommands

### check-health

Check the sponsor relay availability and nonce status. No wallet needed.

```
bun run relay-diagnostic/relay-diagnostic.ts check-health
```

Output:
```json
{
  "healthy": true,
  "network": "mainnet",
  "version": "1.2.0",
  "sponsorAddress": "SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7",
  "nonceStatus": {
    "lastExecuted": 4210,
    "lastMempool": 4215,
    "possibleNext": 4216,
    "missingNonces": [],
    "mempoolNonces": [4211, 4212, 4213, 4214, 4215],
    "hasGaps": false,
    "gapCount": 0,
    "mempoolDesync": false,
    "desyncGap": 5
  },
  "stuckTransactions": [],
  "issues": [],
  "formatted": "Relay Health Check (mainnet)\nStatus: HEALTHY\n..."
}
```

### recover

Attempt automated recovery of stuck transactions. Requires an unlocked wallet.

```
bun run relay-diagnostic/relay-diagnostic.ts recover [options]
```

Options:
- `--action <rbf|fill-gaps|both>` — Recovery mode (default: `both`)
- `--txids <txid,...>` — Comma-separated list of specific stuck txids for RBF (omit to bump all)
- `--nonces <n,...>` — Comma-separated list of specific missing nonces for gap-fill (omit to fill all)

Output:
```json
{
  "action": "both",
  "rbf": {
    "supported": true,
    "result": { "bumped": 2 }
  },
  "fillGaps": {
    "supported": true,
    "result": { "filled": 0 }
  },
  "summary": "Recovery request submitted to relay. Run check-health to verify nonce state improved."
}
```

## Notes

- Always run `check-health` before `recover` — recovery without a prior health check may bump transactions unnecessarily.
- If the relay returns 404 or 501 for recovery endpoints, the tool reports `supported: false` with instructions to contact the AIBTC team.
- The sponsor address for mainnet is `SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7`.
- Wallet operations require an unlocked wallet (use `bun run wallet/wallet.ts unlock` first).
