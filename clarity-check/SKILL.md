---
name: clarity-check
description: "Clarity pre-deployment validation — syntax checking, deprecated keyword detection, sender check analysis, error propagation review, and test verification."
metadata:
  author: "whoabuddy"
  author-agent: "Arc"
  user-invocable: "false"
  arguments: "validate | checklist"
  entry: "clarity-check/SKILL.md"
  requires: ""
  tags: "read-only, l2, infrastructure"
---

# Clarity Check Skill

Pre-deployment validation gate for Clarity smart contracts. Runs automated checks for syntax errors, deprecated keywords, incorrect sender checks, error propagation issues, and missing tests. Pairs with the existing `contract` skill for deploy operations.

## Usage

This is a doc-only skill. Agents read this file to understand available checks and invoke them through the skill framework. The CLI interface below documents the planned implementation.

```
bun run clarity-check/clarity-check.ts <subcommand> [options]
```

## Subcommands

### validate

Run all automated checks against a Clarity contract file.

```
bun run clarity-check/clarity-check.ts validate --source <path-to-file.clar> [--project-dir <clarinet-project-dir>]
```

Options:
- `--source` (required) — Path to the `.clar` source file to validate
- `--project-dir` (optional) — Clarinet project directory for `clarinet check` integration; auto-detected from source path if omitted

Output:
```json
{
  "file": "contracts/my-contract.clar",
  "passed": false,
  "checks": [
    {
      "name": "syntax",
      "status": "pass",
      "description": "clarinet check passes"
    },
    {
      "name": "deprecated-keywords",
      "status": "fail",
      "description": "Deprecated keywords found",
      "findings": [
        {
          "line": 15,
          "keyword": "block-height",
          "replacement": "stacks-block-height",
          "severity": "warning"
        }
      ]
    },
    {
      "name": "sender-checks",
      "status": "warn",
      "description": "Sender check analysis",
      "findings": [
        {
          "line": 22,
          "issue": "Token transfer uses contract-caller instead of tx-sender",
          "recommendation": "Use tx-sender for token operations to preserve human identity through proxies",
          "severity": "warning"
        }
      ]
    }
  ],
  "summary": {
    "total": 7,
    "pass": 5,
    "fail": 1,
    "warn": 1
  }
}
```

### checklist

Generate a human-readable pre-deployment checklist for a contract, combining automated checks with manual verification items.

```
bun run clarity-check/clarity-check.ts checklist --source <path-to-file.clar> [--project-dir <clarinet-project-dir>]
```

Options:
- `--source` (required) — Path to the `.clar` source file
- `--project-dir` (optional) — Clarinet project directory

Output:
```json
{
  "file": "contracts/my-contract.clar",
  "automated": [
    {"check": "clarinet check passes", "status": "pass"},
    {"check": "No deprecated keywords", "status": "fail", "details": "Found: block-height on line 15"},
    {"check": "Correct sender checks", "status": "warn", "details": "1 finding"},
    {"check": "Error propagation uses try!", "status": "pass"},
    {"check": "No dead code or unused features", "status": "pass"},
    {"check": "Events follow structured format", "status": "pass"},
    {"check": "Error codes are unique", "status": "pass"}
  ],
  "manual": [
    "Verify tests exist and pass (npm test)",
    "Check execution costs in clarinet console (::get_costs)",
    "Review post-conditions for all token operations",
    "Verify trait whitelisting if external contracts are called",
    "Test on testnet before mainnet deployment",
    "Document contract address after deployment"
  ]
}
```

## Checks Performed

### Automated

| Check | What it detects |
|-------|----------------|
| Syntax | `clarinet check` errors and warnings |
| Deprecated keywords | `block-height` (use `stacks-block-height`), other legacy keywords |
| Sender checks | `tx-sender` vs `contract-caller` misuse in token operations |
| Error propagation | `unwrap!` used where `try!` is more appropriate for recoverable errors |
| Dead code | Unused private functions, unreachable branches |
| Event format | Events missing `notification`/`payload` structure |
| Error code uniqueness | Duplicate error code constants |
| Public function returns | Functions missing `(response ok err)` return type |

### Manual (Checklist Only)

| Check | Why it matters |
|-------|---------------|
| Tests exist and pass | Ensures behavior is verified |
| Execution costs | Prevents exceeding block limits |
| Post-conditions | Protects users from unexpected token transfers |
| Trait whitelisting | Prevents unauthorized contract interactions |
| Testnet deployment | Catches issues before mainnet |

## Notes

- Requires `clarinet` CLI installed locally for syntax checking
- If `clarinet` is not found, syntax check is skipped with a warning
- Static analysis only — does not execute the contract or run tests
- Use `clarity-test-scaffold` to generate tests, then `clarity-audit` for deep review
- Complements `clarinet check` by adding Clarity-specific best practice checks that the compiler doesn't enforce
