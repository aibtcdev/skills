---
name: clarity-audit-agent
skill: clarity-audit
description: Clarity smart contract security audit — structured review covering correctness, security vulnerabilities, design concerns, and deployment readiness.
---

# Clarity Audit Agent

This agent performs security audits on Clarity smart contracts. It combines structured analysis (via the skill) with open-ended reasoning for complex security concerns. The skill produces JSON output; the agent can also be invoked for deeper, multi-contract analysis.

## Prerequisites

- A `.clar` source file to audit
- For deployed contract verification: the on-chain contract ID
- Recommended: run `clarity-check validate` first to fix basic issues

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Full structured audit report | `audit --source <path>` |
| Quick scan for critical/high issues | `quick-check --source <path>` |
| Deep dive on a specific function | `function-review --source <path> --function <name>` |

### When to use each subcommand

- **`audit`**: Pre-deployment review, code review for PRs, third-party contract evaluation
- **`quick-check`**: Fast triage — is this contract safe to interact with?
- **`function-review`**: Investigating a specific concern or reviewing a function that handles funds

### When to use the agent vs the skill

| Scenario | Use |
|----------|-----|
| Automated CI check | Skill (`audit` or `quick-check`) |
| Pre-deployment gate | Skill (`audit`) |
| Multi-contract system review | Agent (open-ended reasoning across contracts) |
| Investigating a suspected vulnerability | Agent (can trace call paths, reason about economic attacks) |
| Code review feedback | Skill (`function-review` per function) |

## Safety Checks

- This skill is read-only — it does not modify contracts or interact with the blockchain
- Audit results are advisory — a passing audit does not guarantee security
- Critical findings should be verified manually before taking action
- For high-value contracts (treasury, DAO), always supplement with RV fuzz testing

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Source file not found" | Invalid `--source` path | Check the file path exists |
| "Function not found" | Invalid `--function` name | Check function exists in the contract |
| "Contract ID mismatch" | Deployed code differs from source | Verify you're auditing the correct version |

## Output Handling

### From `audit`
1. Check `verdict` — `PASS`, `CONDITIONAL_PASS`, `FAIL`, `CRITICAL_FAIL`
2. Review `bugs` sorted by severity — fix all critical and high issues
3. Consider `designConcerns` for long-term maintainability
4. Use `gasAnalysis` to identify functions near cost limits

### From `quick-check`
1. Check `quickVerdict` — `PASS` or `REVIEW_NEEDED`
2. If `REVIEW_NEEDED`, run full `audit` for details

### From `function-review`
1. Check `riskColor` — GREEN/YELLOW are low concern, ORANGE/RED need careful review
2. Address any `fail` or `warn` status in `checks`
3. Follow `recommendation` for improvement

## Audit Checklist Reference

### Per-Function
- Input validation with `asserts!`
- Proper principal checks (`tx-sender` vs `contract-caller`)
- Error codes for all failure paths
- No unbounded iteration
- Token operations use `try!`
- Post-conditions for asset protection

### Contract-Wide
- All public functions return `(response ok err)`
- Error codes are unique and documented
- Traits are whitelisted before use
- `as-contract` has explicit asset allowances (Clarity 4)
- Rate limiting on sensitive operations
- Admin functions have proper access control

## Workflow Integration

```
clarity-patterns (reference) → clarity-check (validate) → clarity-test-scaffold (test) → clarity-audit (review) → contract (deploy)
```

Audit is the final gate before deployment. Run after tests pass and `clarity-check` shows no failures.
