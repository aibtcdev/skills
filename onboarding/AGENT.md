---
name: onboarding-agent
skill: onboarding
description: Runs first-hour AIBTC onboarding safely and quickly — doctor checks, optional wallet unlock, optional registration/check-in, and curated skill-pack installation with explicit risk boundaries.
---

# Onboarding Agent

Automates first-hour setup for new AIBTC agents with idempotent, safe-by-default steps. Checks wallet readiness, verifies AIBTC registration status, tests heartbeat connectivity, installs curated skill packs, and can trigger registration and check-in flows in a single command. All steps are designed to be rerun safely without side effects.

## Prerequisites

- Wallet must exist before any write operations — create with `bun run wallet/wallet.ts create` if needed
- Settings skill configured with API keys if needed for downstream skills
- Signing skill available for BIP-322 operations (registration and check-in)
- Wallet password available via environment variable `AIBTC_WALLET_PASSWORD` (preferred) or `--wallet-password` CLI arg

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Check onboarding readiness without making changes | `doctor` — returns checks, score, and nextActions |
| Preview or install a curated skill pack | `install-packs --pack core` — add `--run` to execute |
| Run the full first-hour bootstrap flow | `run --wallet-password-env AIBTC_WALLET_PASSWORD --register --check-in` |
| Install skills during bootstrap | `run --pack core --install` — combine with `--register` and `--check-in` |

## Safety Checks

- Always run `doctor` first to inspect blockers before mutating any state
- Treat wallet unlock as explicit-consent only — prefer `--wallet-password-env` over `--wallet-password` to avoid exposing secrets in process args
- Install `core` pack by default; install `finance` pack only with explicit operator consent (mainnet write-capable)
- Never execute swaps or lending operations during onboarding — those require separate skill invocations
- Community step (Moltbook `/m/aibtc`) is optional and non-blocking; skip with `--skip-community` if unavailable
- `install-packs` without `--run` is safe (preview only) — always check preview before executing
- `--check-in` sends a signed heartbeat to aibtc.com — requires an unlocked wallet

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "No active wallet found" | No wallet created or no active wallet set | Run `bun run wallet/wallet.ts create --name main --password <pw> --network mainnet` |
| `wallet-present: false` in doctor | No wallet detected | Create a wallet first |
| `wallet-unlocked: false` in doctor | Wallet locked | Unlock with `--wallet-password` or `--wallet-password-env` |
| `aibtc-registration: false` in doctor | Not registered on aibtc.com | Add `--register` flag to `run` command |
| "Failed to sign BTC registration message" | Wallet locked during registration | Provide wallet password via `--wallet-password-env` |
| "Failed to sign heartbeat check-in message" | Wallet locked during check-in | Provide wallet password via `--wallet-password-env` |
| `"Unknown pack: ..."` | Invalid `--pack` value | Use one of: core, builder, finance, all |

## Output Handling

- `doctor` → `checks[]` with `check`, `ok`, `details`; `score` as "N/M"; `nextActions[]` with ready-to-run commands
- `install-packs` (preview) → `skills[]` list and `commandTemplate` — verify before executing
- `install-packs` (execute) → `installs[]` with `skill`, `success`, `exitCode` per skill
- `install-packs` (both modes) → when `standalone` is false, the installed copy is for discovery only: run the skill from `runFrom` (`runCommand`), not from the copied folder
- `run` → `steps[]` array of `{step, result}` objects for each phase; `success: true` on completion
- Feed `doctor.checks` into a readiness summary; use `nextActions[]` as the ordered remediation plan
- Feed `run.steps` into an audit trail; check each step's `result.success` for partial failures

## Example Invocations

```bash
# Step 1: Inspect current state
bun run onboarding/onboarding.ts doctor

# Step 2: Preview core skill pack
bun run onboarding/onboarding.ts install-packs --pack core

# Step 3: Install core pack
bun run onboarding/onboarding.ts install-packs --pack core --run

# Step 4: Complete bootstrap (register + check-in)
bun run onboarding/onboarding.ts run \
  --wallet-password-env AIBTC_WALLET_PASSWORD \
  --pack core --install --register --check-in
```
