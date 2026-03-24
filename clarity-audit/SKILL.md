---
name: clarity-audit
description: "Clarity smart contract security audit — structured review covering correctness, security vulnerabilities, design concerns, and deployment readiness."
metadata:
  author: "whoabuddy"
  author-agent: "Arc"
  user-invocable: "false"
  arguments: "audit | quick-check | function-review"
  entry: "clarity-audit/SKILL.md"
  requires: ""
  tags: "read-only, l2, infrastructure, sensitive"
---

# Clarity Audit Skill

Structured security audit for Clarity smart contracts. Produces a comprehensive review covering correctness, security vulnerabilities, design concerns, and deployment readiness. Designed to work both as a standalone skill (structured JSON output) and as the foundation for the `clarity-expert` agent (open-ended reasoning).

## Usage

This is a doc-only skill. Agents read this file to understand the audit framework and invoke it through the skill framework or `clarity-expert` agent. The CLI interface below documents the planned implementation.

```
bun run clarity-audit/clarity-audit.ts <subcommand> [options]
```

## Subcommands

### audit

Run a full structured audit on a Clarity contract.

```
bun run clarity-audit/clarity-audit.ts audit --source <path-to-file.clar> [--contract-id <deployed-contract-id>] [--severity-threshold <level>]
```

Options:
- `--source` (required) — Path to the `.clar` source file to audit
- `--contract-id` (optional) — Deployed contract ID for on-chain verification; enables cross-referencing deployed vs source
- `--severity-threshold` (optional) — Minimum severity to report: `critical`, `high`, `medium`, `low` (default: `low`)

Output:
```json
{
  "file": "contracts/my-contract.clar",
  "summary": "Token transfer contract with admin controls and minting capability",
  "verdict": "CONDITIONAL_PASS",
  "riskLevel": "MEDIUM",
  "stats": {
    "publicFunctions": 5,
    "readOnlyFunctions": 3,
    "privateFunctions": 2,
    "maps": 2,
    "dataVars": 1,
    "constants": 8
  },
  "whatWorksCorrectly": [
    "Transfer function uses try! for error propagation",
    "Admin functions check tx-sender against owner constant",
    "Events follow structured notification/payload format"
  ],
  "bugs": [
    {
      "severity": "high",
      "title": "Unbounded mint allows infinite token supply",
      "location": {"function": "mint", "line": 45},
      "description": "The mint function has no supply cap check. Any admin can mint unlimited tokens.",
      "recommendation": "Add MAX_SUPPLY constant and check (< (+ current-supply amount) MAX_SUPPLY) before minting",
      "category": "logic"
    }
  ],
  "designConcerns": [
    {
      "severity": "medium",
      "title": "Single admin with no succession plan",
      "description": "CONTRACT_OWNER is set at deploy time with no transfer mechanism",
      "recommendation": "Add set-admin function with two-step transfer (propose + accept)"
    }
  ],
  "gasAnalysis": {
    "mostExpensiveFunction": "batch-transfer",
    "concern": "fold over list of 200 recipients may approach block limits"
  }
}
```

### quick-check

Run a lightweight scan focused on critical and high severity issues only.

```
bun run clarity-audit/clarity-audit.ts quick-check --source <path-to-file.clar>
```

Options:
- `--source` (required) — Path to the `.clar` source file

Output:
```json
{
  "file": "contracts/my-contract.clar",
  "criticalIssues": 0,
  "highIssues": 1,
  "quickVerdict": "REVIEW_NEEDED",
  "findings": [
    {
      "severity": "high",
      "title": "Unbounded mint allows infinite token supply",
      "line": 45,
      "fix": "Add MAX_SUPPLY cap"
    }
  ]
}
```

### function-review

Audit a single function in detail with color-coded risk assessment.

```
bun run clarity-audit/clarity-audit.ts function-review --source <path-to-file.clar> --function <function-name>
```

Options:
- `--source` (required) — Path to the `.clar` source file
- `--function` (required) — Function name to review

Output:
```json
{
  "function": "transfer",
  "visibility": "public",
  "riskColor": "ORANGE",
  "riskReason": "Token transfer with external call",
  "parameters": [
    {"name": "amount", "type": "uint", "validated": true},
    {"name": "to", "type": "principal", "validated": false}
  ],
  "checks": [
    {"check": "Input validation", "status": "partial", "detail": "amount checked but recipient not validated"},
    {"check": "Proper sender check", "status": "pass", "detail": "Uses tx-sender correctly"},
    {"check": "Error propagation", "status": "pass", "detail": "Uses try! for ft-transfer?"},
    {"check": "Post-condition safe", "status": "warn", "detail": "No post-condition hints in contract"},
    {"check": "Reentrancy safe", "status": "pass", "detail": "State changes before external calls"}
  ],
  "recommendation": "Add recipient validation (not contract principal) if transfers should be restricted to standard principals"
}
```

## Risk Color Framework

| Color | Meaning | Examples |
|-------|---------|---------|
| GREEN | Harmless read-only | `get-balance`, `get-stats` |
| YELLOW | State changes with proper guards | `check-in` with auth, `vote` with snapshot |
| ORANGE | Token transfers, external calls | `transfer`, `swap`, any `contract-call?` |
| RED | Critical — admin functions, treasury access | `withdraw`, `mint`, `set-admin`, `upgrade` |

## Audit Categories

| Category | What it covers |
|----------|---------------|
| `logic` | Incorrect behavior, missing checks, wrong conditions |
| `security` | Reentrancy, overflow, access control bypass, locked funds |
| `design` | Architecture issues, missing features, upgrade concerns |
| `gas` | Functions that may exceed block cost limits |
| `standards` | SIP compliance, event format, naming conventions |

## Severity Levels

| Level | Criteria |
|-------|---------|
| `critical` | Funds at risk, contract can be bricked, exploitable by anyone |
| `high` | Significant logic errors, access control issues, economic attacks |
| `medium` | Non-critical issues that affect functionality or user experience |
| `low` | Best practice violations, code quality, documentation gaps |

## Notes

- This skill produces structured output for automated processing
- For open-ended security reasoning and multi-contract analysis, use the `clarity-expert` agent
- The audit is static analysis only — it does not execute the contract
- Always combine with `clarity-check` for pre-deployment validation
- For production-critical contracts, supplement with RV fuzz testing via `clarity-test-scaffold`
- Reference: [pbtc21/publisher-succession#1](https://github.com/pbtc21/publisher-succession/issues/1) for example audit output
