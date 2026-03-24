---
name: clarity-patterns-agent
skill: clarity-patterns
description: Clarity smart contract pattern library — reusable code patterns, contract templates, and design references for building on Stacks.
---

# Clarity Patterns Agent

This agent provides reusable Clarity code patterns, contract templates, and design references. It is read-only and requires no wallet.

## Prerequisites

- None — this skill is purely informational and read-only

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Browse available patterns and templates | `list` — optionally filter by category |
| Get a specific code pattern with example | `get --name <pattern-name>` |
| Get a complete contract template with source, tests, and checklist | `template --name <template-name>` |

## When to Use This Skill

- **Starting a new contract**: Use `list` to browse patterns, then `template` for a starting point
- **Adding a feature**: Use `get` to find the right pattern (e.g., rate limiting, access control)
- **Code review**: Reference patterns to verify a contract follows best practices
- **Before clarity-audit**: Patterns provide the baseline expectations for the audit

## Safety Checks

- This skill is read-only — no safety checks required
- Patterns are reference material; always adapt to your specific contract requirements
- Templates target Clarity 4 (Nakamoto) — verify compatibility if deploying to older networks

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Pattern not found" | Invalid pattern name | Run `list` to see available patterns |
| "Template not found" | Invalid template name | Run `list --category templates` to see options |

## Output Handling

- `list`: Scan results for relevant patterns, then use `get` or `template` to retrieve details
- `get`: Extract `code` field for inline use; read `notes` for usage guidance
- `template`: Extract `contract` for the Clarity source, `test` for the test file, and follow `deploymentChecklist` before deploying

## Relationship to Other Skills

```
clarity-patterns (reference) → clarity-check (validate) → clarity-test-scaffold (test) → clarity-audit (review) → contract (deploy)
```

This skill is the foundation — other Clarity skills reference its patterns for validation and audit criteria.
