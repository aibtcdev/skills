---
name: clarity-test-scaffold-agent
skill: clarity-test-scaffold
description: Clarity test infrastructure generation — scaffold vitest configs, test stubs, Clarunit files, and Rendezvous fuzz tests for Clarinet projects.
---

# Clarity Test Scaffold Agent

This agent generates test infrastructure for Clarinet projects. It reads contract definitions to produce appropriately structured test files, configs, and dependencies.

## Prerequisites

- A Clarinet project directory with `Clarinet.toml`
- Contracts defined in `contracts/` directory
- `npm` or `bun` available for dependency installation

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Set up full test infrastructure for a new project | `scaffold --project-dir <path>` |
| Add fuzz tests for a specific high-value contract | `add-fuzz --project-dir <path> --contract <name>` |
| Verify existing test setup is complete | `check --project-dir <path>` |

### When to use each subcommand

- **`scaffold`**: First-time setup or when adding testing to an existing project
- **`add-fuzz`**: For treasury, DAO, or high-value contracts that need property-based testing
- **`check`**: Before PR submission to verify test coverage is complete

### When to include optional test types

| Flag | Use when |
|------|----------|
| `--include-clarunit` | Pure logic testing, simple assertion verification |
| `--include-fuzz` | High-value contracts (treasuries, DAOs, token operations) |

## Safety Checks

- Always use `--dry-run` first to preview generated files
- Never overwrites existing test files — only creates missing ones
- Verify `Clarinet.toml` exists before running scaffold

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Clarinet.toml not found" | Wrong project directory | Verify `--project-dir` points to Clarinet project root |
| "No contracts found" | Empty `contracts/` directory | Add contracts before scaffolding tests |
| "Contract not found" | Invalid `--contract` name in `add-fuzz` | Check contract name matches `Clarinet.toml` entry |

## Output Handling

- **`scaffold`**: After generation, run `npm install` then `npm test` to verify
- **`add-fuzz`**: After generation, run `npx rv . <contract> test` to execute fuzz tests
- **`check`**: Address each finding in the `findings` array before submitting PR

## Post-Scaffold Steps

1. Run `npm install` to install generated dependencies
2. Fill in test assertions in generated stub files
3. Run `npm test` to verify tests pass
4. Run `clarity-check validate` on each contract
5. If fuzz tests were added, run `npm run test:rv` separately

## Workflow Integration

```
clarity-patterns (reference) → clarity-check (validate) → clarity-test-scaffold (test) → clarity-audit (review) → contract (deploy)
```

Scaffold tests after the contract passes `clarity-check validate`. Use `clarity-patterns` skill for test pattern reference.
