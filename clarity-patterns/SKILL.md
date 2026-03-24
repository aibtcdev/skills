---
name: clarity-patterns
description: "Clarity smart contract pattern library — reusable code patterns, contract templates, and design references for building on Stacks."
metadata:
  author: "whoabuddy"
  author-agent: "Arc"
  user-invocable: "false"
  arguments: "list | get | template"
  entry: "clarity-patterns/SKILL.md"
  requires: ""
  tags: "read-only, l2, infrastructure"
---

# Clarity Patterns Skill

Bundled pattern library and contract template reference for Clarity smart contract development on Stacks. Provides reusable code patterns, design guidance, and complete contract templates that agents and developers can reference when building new contracts.

This skill is the canonical source for Clarity patterns in the aibtcdev ecosystem.

## Usage

This is a doc-only skill. Agents read this file to understand available patterns and invoke them through the skill framework. The CLI interface below documents the planned implementation.

```
bun run clarity-patterns/clarity-patterns.ts <subcommand> [options]
```

## Subcommands

### list

List all available patterns and templates with descriptions.

```
bun run clarity-patterns/clarity-patterns.ts list [--category <category>]
```

Options:
- `--category` (optional) — Filter by category: `patterns`, `templates`, `registry`, `testing`

Output:
```json
{
  "patterns": [
    {
      "name": "public-function-template",
      "category": "patterns",
      "description": "Standard structure for public functions with guards and error handling"
    }
  ]
}
```

### get

Return a specific pattern with code example and usage notes.

```
bun run clarity-patterns/clarity-patterns.ts get --name <pattern-name>
```

Options:
- `--name` (required) — Pattern identifier from the `list` output

Output:
```json
{
  "name": "public-function-template",
  "category": "patterns",
  "description": "Standard structure for public functions with guards and error handling",
  "code": "(define-public (transfer (amount uint) (to principal)) ...)",
  "notes": "Use try! for subcalls to propagate errors. Use asserts! for guards before state changes.",
  "references": ["https://github.com/aibtcdev/aibtcdev-daos/"]
}
```

### template

Return a complete contract template with full source code, tests, and deployment checklist.

```
bun run clarity-patterns/clarity-patterns.ts template --name <template-name>
```

Options:
- `--name` (required) — Template name: `heartbeat-registry`, `proof-of-existence`, `registry-minimal`

Output:
```json
{
  "name": "heartbeat-registry",
  "description": "Agent coordination primitive - on-chain heartbeat with full chain context",
  "contract": ";; heartbeat-registry.clar\n...",
  "test": "import { Cl } from '@stacks/transactions';\n...",
  "deploymentChecklist": ["Run clarinet check", "Run npm test", "Verify Clarity version compatibility"],
  "relatedPatterns": ["block-snapshot", "secondary-index", "global-stats"]
}
```

## Available Patterns

### Code Patterns

| Pattern | Description |
|---------|-------------|
| `public-function-template` | Standard public function with guards and error handling |
| `standardized-events` | Structured event emission for off-chain indexing |
| `error-handling-match` | Handle external call failures with match |
| `bit-flags` | Pack multiple booleans into a single uint |
| `multi-send` | Send to multiple recipients in one transaction using fold |
| `parent-child-maps` | Hierarchical data with pagination support |
| `whitelisting` | Control which contracts/assets can interact |
| `trait-whitelisting` | Only allow calls from trusted trait implementations |
| `delayed-activation` | Activate functionality after a Bitcoin block delay |
| `rate-limiting` | Prevent rapid repeated actions |
| `dao-historic-balances` | Snapshot voting with at-block |
| `fixed-point-arithmetic` | Decimal values with scale factor |
| `treasury-as-contract` | Contract-controlled funds with as-contract |
| `tx-sender-vs-contract-caller` | Decision framework for principal checks |
| `asset-restrictions` | Clarity 4 asset restriction syntax |
| `multi-party-coordination` | Coordinate actions requiring multiple signatures |

### Registry Patterns

| Pattern | Description |
|---------|-------------|
| `block-snapshot` | Capture comprehensive chain state at transaction time |
| `principal-keyed-registry` | Track state per address (heartbeats, profiles) |
| `hash-keyed-registry` | Track unique data (attestations, commitments) |
| `composite-keyed-registry` | Multi-dimensional tracking (votes per proposal) |
| `secondary-index` | Enable enumeration of entries by address |
| `global-stats` | Track aggregate metrics without iterating |
| `first-write-wins` | Immutable attestation semantics |
| `last-write-wins` | Heartbeat/status update semantics |
| `append-only` | History tracking with per-address indexing |
| `access-control-open` | Anyone can write |
| `access-control-self-only` | Only registered users can update own entries |
| `access-control-admin` | Admin-gated registration |

### Contract Templates

| Template | Description |
|----------|-------------|
| `heartbeat-registry` | Agent heartbeat with full chain context, address enumeration, liveness checks |
| `proof-of-existence` | Document timestamping with SIP-018 signatures, first-write-wins, attestor index |
| `registry-minimal` | Minimal registry combining snapshot + stats + events |

## Notes

- All patterns include code examples tested against Clarity 4 (Nakamoto)
- Templates include both contract source and Clarinet SDK test files
- Use `stacks-block-height` not `block-height` (deprecated)
- Use `tx-sender` for token operations, `contract-caller` only when immediate caller identity is needed
- Use `try!` for error propagation, `asserts!` for guards before state changes
