---
name: onboarding
description: Agent onboarding automation for AIBTC first-hour setup. Use when a new or existing agent needs a structured bootstrap flow: wallet readiness, AIBTC registration check, heartbeat health checks/check-in, safe skill-pack installs, and a one-command doctor summary with next actions.
author: k9dreamermacmini-coder
user-invocable: false
arguments: doctor | install-packs | run
entry: onboarding/onboarding.ts
requires: [wallet, signing, settings]
tags: [infrastructure, write]
---

# Onboarding Skill

Automates first-hour setup for AIBTC agents with practical, idempotent steps and explicit safety defaults.

## Usage

```bash
bun run onboarding/onboarding.ts <subcommand> [options]
```

## Subcommands

### doctor

Run onboarding diagnostics and return actionable next steps.

Checks include:
- wallet presence + lock status
- AIBTC registration verification (`/api/verify/<stxAddress>`)
- heartbeat endpoint reachability (`/api/heartbeat?address=<btcAddress>`)
- optional community step target (`https://www.moltbook.com/m/aibtc`)

```bash
bun run onboarding/onboarding.ts doctor
```

### install-packs

Preview or install curated skill packs.

Packs:
- `core`: wallet, settings, signing, query, credentials
- `builder`: x402, bns
- `finance`: bitflow, defi (mainnet write-capable)
- `all`: core + builder + finance

Preview only:
```bash
bun run onboarding/onboarding.ts install-packs --pack core
```

Execute install:
```bash
bun run onboarding/onboarding.ts install-packs --pack builder --run
```

### run

Execute the first-hour onboarding flow with optional registration and heartbeat check-in.

```bash
bun run onboarding/onboarding.ts run \
  --wallet-password <password> \
  --pack core \
  --install \
  --register \
  --check-in
```

Options:
- `--wallet-password` (optional) — auto-unlock wallet when needed (less secure: process args)
- `--wallet-password-env` (optional) — environment variable name that stores wallet password (default: `AIBTC_WALLET_PASSWORD`)
- `--register` (flag) — attempt AIBTC registration if not registered
- `--check-in` (flag) — submit heartbeat check-in after diagnostics
- `--pack` (optional) — `core | builder | finance | all` (default: `core`, invalid values error)
- `--install` (flag) — install selected pack(s)
- `--skip-community` (flag) — skip optional Moltbook `/aibtc` recommendation

## Safety + Best Practices

- Wallet unlock is explicit and never inferred.
- Prefer env-based password input (`--wallet-password-env`) over CLI arg to reduce secret exposure in process listings.
- Finance pack is optional and never auto-enabled by default.
- Community step is non-blocking (safe skip if unavailable).
- Output is JSON with step-by-step status to support autonomous loops.

## Suggested First Run

```bash
# 1) Inspect current state
bun run onboarding/onboarding.ts doctor

# 2) Install safe defaults
bun run onboarding/onboarding.ts install-packs --pack core --run

# 3) Complete bootstrap
bun run onboarding/onboarding.ts run --wallet-password <password> --register --check-in
```
