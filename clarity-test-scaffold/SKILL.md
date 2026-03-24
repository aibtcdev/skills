---
name: clarity-test-scaffold
description: "Clarity test infrastructure generation — scaffold vitest configs, test stubs, Clarunit files, and Rendezvous fuzz tests for Clarinet projects."
metadata:
  author: "whoabuddy"
  author-agent: "Arc"
  user-invocable: "false"
  arguments: "scaffold | add-fuzz | check"
  entry: "clarity-test-scaffold/SKILL.md"
  requires: ""
  tags: "read-only, l2, infrastructure"
---

# Clarity Test Scaffold Skill

Generates test infrastructure for Clarinet projects. Creates vitest configs, package.json dependencies, test file stubs with arrange-act-assert structure, and optionally Rendezvous fuzz test files with property and invariant tests.

## Usage

This is a doc-only skill. Agents read this file to understand available subcommands and invoke them through the skill framework. The CLI interface below documents the planned implementation.

```
bun run clarity-test-scaffold/clarity-test-scaffold.ts <subcommand> [options]
```

## Subcommands

### scaffold

Generate full test infrastructure for a Clarinet project. Creates or updates vitest config, package.json, tsconfig, and test stubs for all contracts.

```
bun run clarity-test-scaffold/clarity-test-scaffold.ts scaffold --project-dir <path> [--include-clarunit] [--include-fuzz] [--dry-run]
```

Options:
- `--project-dir` (required) — Path to the Clarinet project root (must contain `Clarinet.toml`)
- `--include-clarunit` (optional) — Also generate Clarunit test files (`.clar` test files)
- `--include-fuzz` (optional) — Also generate Rendezvous fuzz test files
- `--dry-run` (optional) — Show what would be generated without writing files

Output:
```json
{
  "projectDir": "/path/to/project",
  "contracts": ["my-contract", "helper-contract"],
  "filesGenerated": [
    {"path": "vitest.config.js", "action": "created"},
    {"path": "package.json", "action": "updated"},
    {"path": "tsconfig.json", "action": "created"},
    {"path": "tests/my-contract.test.ts", "action": "created"},
    {"path": "tests/helper-contract.test.ts", "action": "created"}
  ],
  "dependencies": {
    "@hirosystems/clarinet-sdk": "^2.0.0",
    "vitest": "^1.0.0",
    "vitest-environment-clarinet": "^2.0.0"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

### add-fuzz

Add Rendezvous property-based fuzz tests for a specific contract.

```
bun run clarity-test-scaffold/clarity-test-scaffold.ts add-fuzz --project-dir <path> --contract <contract-name> [--dry-run]
```

Options:
- `--project-dir` (required) — Path to the Clarinet project root
- `--contract` (required) — Contract name to generate fuzz tests for
- `--dry-run` (optional) — Show what would be generated without writing

Output:
```json
{
  "contract": "my-contract",
  "filesGenerated": [
    {"path": "contracts/my-contract.tests.clar", "action": "created"}
  ],
  "dependencies": {
    "@stacks/rendezvous": "^1.0.0"
  },
  "scripts": {
    "test:rv": "npx rv . my-contract test",
    "test:rv:invariant": "npx rv . my-contract invariant"
  },
  "publicFunctions": ["transfer", "set-value"],
  "propertyTests": ["test-transfer", "test-set-value"],
  "invariantTests": ["invariant-supply-capped"]
}
```

### check

Verify an existing test setup is complete and correct.

```
bun run clarity-test-scaffold/clarity-test-scaffold.ts check --project-dir <path>
```

Options:
- `--project-dir` (required) — Path to the Clarinet project root

Output:
```json
{
  "projectDir": "/path/to/project",
  "complete": false,
  "contracts": ["my-contract", "helper-contract"],
  "findings": [
    {"type": "missing", "description": "No test file for helper-contract"},
    {"type": "config", "description": "vitest.config.js missing singleThread: true"},
    {"type": "dependency", "description": "@hirosystems/clarinet-sdk not in package.json"}
  ],
  "coverage": {
    "contractsWithTests": 1,
    "contractsTotal": 2,
    "percentage": 50
  }
}
```

## Generated Test Structure

### Vitest Config

```javascript
import { defineConfig } from "vitest/config";
import { vitestSetupFilePath, getClarinetVitestsArgv } from "@hirosystems/clarinet-sdk/vitest";

export default defineConfig({
  test: {
    environment: "clarinet",
    singleThread: true,
    setupFiles: [vitestSetupFilePath],
    environmentOptions: {
      clarinet: getClarinetVitestsArgv(),
    },
  },
});
```

### Test File Template

Generated test files follow these conventions:
- **Arrange-Act-Assert** structure in every test
- **Functions over arrow functions** for test helpers
- **Constants** for reusable values (deployer, wallets, contract name)
- **NO `beforeAll`/`beforeEach`** — simnet resets each session
- **`singleThread: true`** — required for simnet isolation

### Testing Pyramid

```
Stxer (Historical Simulation)      — Pre-mainnet validation
RV (Property-Based Fuzzing)        — Invariants, edge cases
Vitest + Clarinet SDK              — Integration tests (default)
Clarunit                           — Unit tests in Clarity
```

## Notes

- Reads `Clarinet.toml` to discover contracts and generate appropriate test stubs
- Analyzes contract public functions to generate test method signatures
- Does not overwrite existing test files — only creates missing ones
- Use `--dry-run` first to preview what will be generated
- Generated tests are stubs — fill in assertions based on contract behavior
- For complete testing reference, see the `clarity-patterns` skill
