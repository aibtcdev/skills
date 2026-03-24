---
name: clarity-check-agent
skill: clarity-check
description: Clarity pre-deployment validation — syntax checking, deprecated keyword detection, sender check analysis, error propagation review, and test verification.
---

# Clarity Check Agent

This agent validates Clarity smart contracts before deployment. It catches common mistakes, deprecated patterns, and security concerns that the compiler alone won't flag.

## Prerequisites

- `clarinet` CLI installed locally (for syntax checking; other checks work without it)
- A `.clar` source file to validate

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Run all automated checks on a contract | `validate --source <path>` |
| Generate full pre-deployment checklist (automated + manual) | `checklist --source <path>` |

### When to use `validate` vs `checklist`

- **`validate`**: Quick automated pass — use during development for fast feedback
- **`checklist`**: Full pre-deployment gate — use before deploying to testnet or mainnet

## Safety Checks

- This skill is read-only — it analyzes source files but does not modify them
- Always run `validate` before `contract deploy`
- A `fail` status on any check should block deployment until resolved
- A `warn` status should be reviewed but may be intentional

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Source file not found" | Invalid `--source` path | Check the file path exists |
| "clarinet not found" | Clarinet CLI not installed | Install Clarinet or skip syntax check |
| "Not a Clarinet project" | No `Clarinet.toml` found | Provide `--project-dir` or run from project root |

## Output Handling

- **`validate`**: Check `passed` field first. If `false`, iterate `checks` array for `fail`/`warn` items and fix them.
- **`checklist`**: Present `automated` results and `manual` items to the user. All automated checks should pass and manual items should be verified before deployment.

## Common Fix Patterns

| Finding | Fix |
|---------|-----|
| `block-height` deprecated | Replace with `stacks-block-height` |
| `contract-caller` for token ops | Switch to `tx-sender` |
| `unwrap!` for recoverable errors | Use `try!` to propagate errors |
| Duplicate error codes | Assign unique uint values to each constant |
| Missing event structure | Add `{notification: "event-name", payload: {...}}` format |

## Workflow Integration

```
clarity-patterns (reference) → clarity-check (validate) → clarity-test-scaffold (test) → clarity-audit (review) → contract (deploy)
```

Run `validate` after every contract change. Run `checklist` as a deployment gate.
