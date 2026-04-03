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

Canonical pattern library for Clarity smart contract development on Stacks. All patterns and templates are bundled in this skill — no external dependencies.

This is a doc-only skill. Agents read this file and the colocated reference files directly. The CLI interface documents the planned implementation.

```
bun run clarity-patterns/clarity-patterns.ts <subcommand> [options]
```

## Subcommands

- `list [--category <category>]` — List available patterns and templates (categories: `code`, `registry`, `templates`, `testing`)
- `get --name <pattern-name>` — Return a specific pattern with code and notes
- `template --name <template-name>` — Return a complete contract template with source, tests, and checklist

---

## Code Patterns

### Public Function Template

Standard structure for public functions with guards and error handling.

```clarity
(define-public (transfer (amount uint) (to principal))
  (begin
    (asserts! (is-eq tx-sender owner) ERR_UNAUTHORIZED)
    (try! (ft-transfer? TOKEN amount tx-sender to))
    (ok true)))
```

- Use `try!` for subcalls to propagate errors
- Use `asserts!` for guards before state changes
- Add post-conditions on tx for asset safety

### Standardized Events

Emit structured events for off-chain indexing.

```clarity
(print {
  notification: "contract-event",
  payload: {
    amount: amount,
    sender: tx-sender,
    recipient: to
  }
})
```

- `notification`: string identifier for the event type
- `payload`: tuple with camelCase keys
- Examples: [usabtc-token](https://github.com/USA-BTC/smart-contracts/blob/main/contracts/usabtc-token.clar), [ccd002-treasury-v3](https://github.com/citycoins/protocol/blob/main/contracts/extensions/ccd002-treasury-v3.clar)

### Error Handling with Match

Handle external call failures gracefully.

```clarity
(match (contract-call? .other fn args)
  success (ok success)
  error (err ERR_EXTERNAL_CALL_FAILED))
```

### Bit Flags for Status/Permissions

Pack multiple booleans into a single uint.

```clarity
(define-constant STATUS_ACTIVE (pow u2 u0))   ;; 1
(define-constant STATUS_PAID (pow u2 u1))     ;; 2
(define-constant STATUS_VERIFIED (pow u2 u2)) ;; 4

;; Pack multiple flags: (+ STATUS_ACTIVE STATUS_PAID) → u3
;; Check flag: (> (bit-and status STATUS_ACTIVE) u0)
;; Set flag: (var-set status (bit-or (var-get status) NEW_FLAG))
;; Clear flag: (var-set status (bit-and (var-get status) (bit-not FLAG)))
```

Examples: [aibtc-action-proposal-voting](https://github.com/aibtcdev/aibtcdev-daos/blob/main/contracts/dao/extensions/aibtc-action-proposal-voting.clar)

### Multi-Send Pattern

Send to multiple recipients in one transaction using fold.

```clarity
(define-private (send-maybe
    (recipient {to: principal, ustx: uint})
    (prior (response bool uint)))
  (match prior
    ok-result (let (
      (to (get to recipient))
      (ustx (get ustx recipient)))
      (try! (stx-transfer? ustx tx-sender to))
      (ok true))
    err-result (err err-result)))

(define-public (send-many (recipients (list 200 {to: principal, ustx: uint})))
  (fold send-maybe recipients (ok true)))
```

### Parent-Child Maps (Hierarchical Data)

Store hierarchical data with pagination support.

```clarity
(define-map Parents uint {name: (string-ascii 32), lastChildId: uint})
(define-map Children {parentId: uint, id: uint} uint)

(define-read-only (get-child (parentId uint) (childId uint))
  (map-get? Children {parentId: parentId, id: childId}))

(define-private (is-some? (x (optional uint)))
  (is-some x))

(define-read-only (get-children (parentId uint) (shift uint))
  (filter is-some?
    (list
      (get-child parentId (+ shift u1))
      (get-child parentId (+ shift u2))
      (get-child parentId (+ shift u3))
      ;; ... up to page size
    )))
```

### Whitelisting (Assets/Contracts)

Control which contracts/assets can interact.

```clarity
(define-map Allowed {contract: principal, type: uint} bool)

;; Check in function
(asserts! (default-to false (map-get? Allowed {contract: contract, type: type}))
          ERR_NOT_ALLOWED)

;; Batch update
(define-public (set-allowed-list (items (list 100 {token: principal, enabled: bool})))
  (ok (map set-iter items (ok true))))
```

Examples: [ccd002-treasury-v3](https://github.com/citycoins/protocol/blob/main/contracts/extensions/ccd002-treasury-v3.clar), [aibtc-agent-account](https://github.com/aibtcdev/aibtcdev-daos/blob/main/contracts/agent/aibtc-agent-account.clar)

### Trait Whitelisting

Only allow calls from trusted trait implementations.

```clarity
(define-map TrustedTraits principal bool)

;; In functions accepting traits
(asserts! (default-to false (map-get? TrustedTraits (contract-of t)))
          ERR_UNTRUSTED)
```

### Delayed Activation

Activate functionality after a Bitcoin block delay.

```clarity
(define-constant DELAY u21000) ;; ~146 days in BTC blocks
(define-data-var activation-block uint u0)

;; Set on deploy or init
(var-set activation-block (+ burn-block-height DELAY))

(define-read-only (is-active?)
  (>= burn-block-height (var-get activation-block)))
```

Example: [usabtc-token](https://github.com/USA-BTC/smart-contracts/blob/main/contracts/usabtc-token.clar)

### Rate Limiting

Prevent rapid repeated actions.

```clarity
(define-data-var last-action-block uint u0)

(define-public (rate-limited-action)
  (begin
    (asserts! (> burn-block-height (var-get last-action-block)) ERR_RATE_LIMIT)
    (var-set last-action-block burn-block-height)
    ;; ... action
    (ok true)))
```

### DAO Proposals with Snapshot Voting (Stacks 3.4+)

> **Note:** Contracts using `at-block` will fail after Stacks 3.4 activation (~2026-04-02, BTC block 943,333). The `at-block` built-in was removed in Stacks 3.4 (SIP-042). The aibtcdev-daos DAO contracts that used `at-block` will need migration before activation.

Store token balance snapshots at proposal creation time using a composite-key map. This avoids `at-block`, eliminates `filter`/list scan at read time, and gives O(1) lookup.

```clarity
;; Stacks 3.4+: at-block removed. Store snapshot at proposal creation time.
;; Using a composite-key map for O(1) lookup — no filter/list scan needed.
(define-map ProposalSnapshots {proposalId: uint, voter: principal} uint)

(define-map Proposals uint {
  votesFor: uint,
  votesAgainst: uint,
  status: uint,
  liquidTokens: uint,
  snapshotBlock: uint
})

;; At proposal creation: capture token balances for eligible voters
;; (caller supplies voter list; balances read from current block)
(define-public (create-proposal (voters (list 1000 principal)))
  (let (
    (proposal-id (+ (var-get last-proposal-id) u1))
    (snapshot-block stacks-block-height))
    ;; fold is used (not map) because Clarity has no partial application —
    ;; map requires a bare function identifier, not a call expression.
    ;; proposal-id is threaded as the accumulator so store-snapshot can use it.
    ;; fold threads proposal-id as accumulator; store-snapshot fires map-set as side effect
    (fold store-snapshot voters proposal-id)
    (map-set Proposals proposal-id {
      votesFor: u0, votesAgainst: u0,
      status: u0, liquidTokens: u0,
      snapshotBlock: snapshot-block})
    (var-set last-proposal-id proposal-id)
    (ok proposal-id)))

(define-private (store-snapshot (voter principal) (acc uint))
  (begin
    (map-set ProposalSnapshots
      {proposalId: acc, voter: voter}
      (unwrap! (contract-call? .token get-balance voter) u0))
    acc))

;; O(1) lookup — no list scan, no filter
(define-read-only (get-vote-power (proposal-id uint) (voter principal))
  (default-to u0
    (map-get? ProposalSnapshots {proposalId: proposal-id, voter: voter})))

;; Quorum check: (>= (/ (* total-votes u100) liquid-supply) QUORUM_PERCENT)
```

Key points:
- **No `(filter ...)` with closures** — Clarity has no partial application. Composite-key map replaces the filter pattern entirely.
- **`default-to u0` works correctly** — `map-get?` returns `(optional uint)`, so `default-to u0` handles missing voters without panic (unlike `unwrap-panic` on a filtered list).
- **O(1) lookup** instead of O(n) list scan at read time.

Example: [aibtcdev-daos](https://github.com/aibtcdev/aibtcdev-daos) — DAO contracts using `at-block` require migration before Stacks 3.4 activation.

### Fixed-Point Arithmetic

Handle decimal values with scale factor.

```clarity
(define-constant SCALE (pow u10 u8)) ;; 8 decimal places

;; Multiply then divide to preserve precision
(define-read-only (calculate-share (amount uint) (percentage uint))
  (/ (* amount percentage) SCALE))

;; Convert to/from scaled values
(define-read-only (to-scaled (amount uint))
  (* amount SCALE))

(define-read-only (from-scaled (amount uint))
  (/ amount SCALE))
```

Example: [ccd012-redemption-nyc](https://github.com/citycoins/protocol/blob/main/contracts/extensions/ccd012-redemption-nyc.clar)

### Treasury Pattern with as-contract

Use `as-contract` for contract-controlled funds.

```clarity
(define-public (withdraw (amount uint) (recipient principal))
  (begin
    (asserts! (is-authorized tx-sender) ERR_UNAUTHORIZED)
    (as-contract (stx-transfer? amount (as-contract tx-sender) recipient))))
```

Warning: `as-contract` changes both `tx-sender` and `contract-caller` to the contract principal.

### tx-sender vs contract-caller Decision Framework

| Call Path | contract-caller | tx-sender |
|-----------|-----------------|-----------|
| user -> target | user | user |
| user -> proxy -> target | proxy | user |
| user -> proxy (as-contract) -> target | proxy | proxy |

- **tx-sender**: Use for auth checks, identity attribution, self-action guards. Preserves human identity through normal proxies. Preferred for composability.
- **contract-caller**: Use when you need the IMMEDIATE caller identity specifically.
- **Security note**: Using `contract-caller` for self-action guards (e.g., "owner can't give themselves feedback") is bypassable — owner routes through any proxy and `contract-caller` shows the proxy, not the owner. `tx-sender` catches this because it preserves the human origin.

Examples: [ccd002-treasury-v3](https://github.com/citycoins/protocol/blob/main/contracts/extensions/ccd002-treasury-v3.clar), [aibtc-agent-account](https://github.com/aibtcdev/aibtcdev-daos/blob/main/contracts/agent/aibtc-agent-account.clar)

### Clarity 4: Asset Restrictions

Restrict what assets a contract call can move.

```clarity
(as-contract
  (with-stx u1000000)                              ;; Allow 1 STX
  (with-ft .token TOKEN u500)                      ;; Allow 500 fungible tokens
  (with-nft .nft-contract NFT (list u1 u2 u3))    ;; Allow specific NFT IDs
  ;; ... body
)

;; DANGER: Avoid unless necessary
(with-all-assets-unsafe)
```

### Multi-Party Coordination

Coordinate actions requiring multiple signatures.

```clarity
;; Proposal state
(define-map Intents uint {
  participants: (list 20 principal),
  accepts: uint,     ;; Bitmask of who accepted
  status: uint,      ;; 0=pending, 1=ready, 2=executed, 3=cancelled
  expiry: uint,
  payload: (buff 256)
})

;; Accept via signature verification
(define-public (accept (intent-id uint) (signature (buff 65)))
  (let (
    (intent (unwrap! (map-get? Intents intent-id) ERR_NOT_FOUND))
    (msg-hash (sha256 (concat (int-to-ascii intent-id) (get payload intent))))
    (signer (try! (secp256k1-recover? msg-hash signature))))
    ;; Verify signer is participant, update accepts bitmask
    (ok true)))
```

Reference: ERC-8001 pattern for decidable multi-party coordination.

---

## Registry Patterns

### Block Snapshot Pattern

Capture comprehensive chain state at transaction time. This is the "receipt" that makes a transaction worth the fee.

```clarity
;; Full snapshot — comprehensive (use for high-value records)
(define-private (capture-snapshot)
  {
    stacksBlock: stacks-block-height,
    burnBlock: burn-block-height,
    tenure: tenure-height,
    blockTime: stacks-block-time,
    chainId: chain-id,
    txSender: tx-sender,
    contractCaller: contract-caller,
    txSponsor: tx-sponsor?,
    stacksBlockHash: (get-stacks-block-info? id-header-hash (- stacks-block-height u1)),
    burnBlockHash: (get-burn-block-info? header-hash (- burn-block-height u1))
  }
)

;; Standard snapshot — balanced cost
;; {stacksBlock, burnBlock, blockTime, txSender}

;; Minimal snapshot — cheapest
;; {stacksBlock, burnBlock}
```

Previous block hashes are captured because the current block's hash isn't finalized until after the transaction. The previous block's hash is immutable and independently verifiable.

### Principal-Keyed Registry

Track state per address (heartbeats, profiles, balances). One entry per address, overwrites on subsequent calls.

```clarity
(define-map Registry
  principal
  {
    stacksBlock: uint,
    burnBlock: uint,
    count: uint
  }
)

(map-get? Registry address)
(map-set Registry tx-sender {...})
```

### Hash-Keyed Registry

Track unique data (attestations, commitments). One entry per unique hash, first-write-wins.

```clarity
(define-map Registry
  (buff 32)
  {
    attestor: principal,
    stacksBlock: uint
  }
)

;; First attestor wins
(asserts! (is-none (map-get? Registry hash)) ERR_ALREADY_EXISTS)
(map-set Registry hash {...})
```

### Composite-Keyed Registry

Multi-dimensional tracking (votes per proposal, actions per agent).

```clarity
(define-map Registry
  {entity: principal, action: uint}
  {stacksBlock: uint}
)

(map-get? Registry {entity: address, action: action-id})
```

### Secondary Index Pattern

Enable enumeration of entries by address when primary key isn't the address.

```clarity
;; Primary: hash -> data
(define-map Attestations (buff 32) {...})

;; Secondary: address + index -> hash
(define-map AttestorIndex
  {attestor: principal, index: uint}
  (buff 32)
)

;; Counter for next index
(define-map AttestorCount principal uint)

;; On insert:
(let ((idx (default-to u0 (map-get? AttestorCount attestor))))
  (map-set AttestorIndex {attestor: attestor, index: idx} hash)
  (map-set AttestorCount attestor (+ idx u1)))

;; Enumerate:
(define-read-only (get-attestor-hash-at (attestor principal) (index uint))
  (map-get? AttestorIndex {attestor: attestor, index: index}))
```

### Global Stats Pattern

Track aggregate metrics without iterating.

```clarity
(define-data-var totalEntries uint u0)
(define-data-var uniqueAddresses uint u0)

;; On new entry:
(var-set totalEntries (+ (var-get totalEntries) u1))
(if isNewAddress
  (var-set uniqueAddresses (+ (var-get uniqueAddresses) u1))
  true)

;; Read stats:
(define-read-only (get-stats)
  {
    totalEntries: (var-get totalEntries),
    uniqueAddresses: (var-get uniqueAddresses)
  }
)
```

### Write Semantics

**First-Write-Wins** (Attestations):

```clarity
(define-public (attest (key (buff 32)))
  (begin
    (asserts! (is-none (map-get? Registry key)) ERR_ALREADY_EXISTS)
    (map-set Registry key {...})
    (ok true)))
```

**Last-Write-Wins** (Heartbeats):

```clarity
(define-public (check-in)
  (begin
    (map-set Registry tx-sender {...})
    (ok true)))
```

**Append-Only** (History):

```clarity
(define-map History
  {address: principal, index: uint}
  {...snapshot...}
)

(define-public (record)
  (let ((idx (default-to u0 (map-get? HistoryCount tx-sender))))
    (map-set History {address: tx-sender, index: idx} {...})
    (map-set HistoryCount tx-sender (+ idx u1))
    (ok idx)))
```

### Access Control Patterns

**Open** (anyone can write):

```clarity
(define-public (register)
  (ok (map-set Registry tx-sender {...})))
```

**Self-Only** (registered users update own entries):

```clarity
(define-public (update (data (buff 64)))
  (begin
    (asserts! (is-some (map-get? Registry tx-sender)) ERR_NOT_REGISTERED)
    (map-set Registry tx-sender {...})
    (ok true)))
```

**Admin-Gated**:

```clarity
(define-data-var admin principal CONTRACT_OWNER)

(define-public (register-address (address principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) ERR_UNAUTHORIZED)
    (map-set Registry address {...})
    (ok true)))
```

---

## Testing Reference

### Testing Pyramid

```
Stxer (Historical Simulation)      — Mainnet fork, pre-deployment validation
RV (Property-Based Fuzzing)        — Invariants, edge cases, battle-grade
Vitest + Clarinet SDK              — Integration tests, TypeScript
Clarunit                           — Unit tests in Clarity itself
```

### When to Use Each Tool

| Tool | Use When | Skip When |
|------|----------|-----------|
| **Clarinet SDK** | Standard testing, CI/CD, type-safe | - |
| **Clarunit** | Testing Clarity logic in Clarity, simple assertions | Complex multi-account flows |
| **RV** | Treasuries, DAOs, high-value contracts, finding edge cases | Simple contracts, time pressure |
| **Stxer** | Pre-mainnet validation, governance simulations | Early development, testnet-only |

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

### Test Structure (Arrange-Act-Assert)

```typescript
import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

describe("my-contract", function () {
  it("transfers tokens correctly", function () {
    // ARRANGE
    const deployer = simnet.deployer;
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const amount = 100;

    // ACT
    const result = simnet.callPublicFn(
      "my-contract",
      "transfer",
      [Cl.uint(amount), Cl.principal(wallet1)],
      deployer
    );

    // ASSERT
    expect(result.result).toBeOk(Cl.bool(true));
  });
});
```

### Key Gotchas

- **NO `beforeAll`/`beforeEach`** — simnet resets each test file session
- **Single thread required** — `singleThread: true` for simnet isolation
- Functions over arrow functions for test helpers
- Use `cvToValue()` and `cvToJSON()` for Clarity-to-JS conversion

### Clarity Value Constructors

```typescript
import { Cl, cvToValue, cvToJSON } from "@stacks/transactions";

Cl.uint(100)                           // uint
Cl.int(-50)                            // int
Cl.bool(true)                          // bool
Cl.principal("SP123...")               // principal
Cl.contractPrincipal("SP123", "name")  // contract principal
Cl.stringAscii("hello")               // (string-ascii N)
Cl.stringUtf8("hello")                // (string-utf8 N)
Cl.bufferFromHex("deadbeef")           // (buff N)
Cl.tuple({ amount: Cl.uint(100) })     // tuple
Cl.list([Cl.uint(1), Cl.uint(2)])      // list
Cl.some(Cl.uint(100))                  // (some value)
Cl.none()                              // none
```

### Custom Matchers

```typescript
expect(result.result).toBeOk(Cl.uint(100));
expect(result.result).toBeErr(Cl.uint(1));
expect(result.result).toBeBool(true);
expect(result.result).toBeUint(100);
expect(result.result).toBePrincipal("SP123...");
```

### RV (Rendezvous) Fuzz Tests

```clarity
;; Property: loan amount always increases correctly
(define-public (test-borrow (amount uint))
  (if (is-eq amount u0)
    (ok false)  ;; Discard invalid input
    (let ((initial (get-loan tx-sender)))
      (try! (borrow amount))
      (asserts! (is-eq (get-loan tx-sender) (+ initial amount))
        (err u999))
      (ok true))))

;; Invariant: total supply never exceeds cap
(define-read-only (invariant-supply-capped)
  (<= (var-get total-supply) MAX_SUPPLY))
```

Run: `npx rv . my-contract test` (properties), `npx rv . my-contract invariant` (invariants)

### Clarunit Tests

```clarity
;; @name Multiplication works correctly
(define-public (test-multiply)
  (begin
    (asserts! (is-eq u8 (contract-call? .math multiply u2 u4))
      (err "2 * 4 should equal 8"))
    (ok true)))
```

File: `tests/my-contract_test.clar`, functions start with `test-`.

### Project Structure (Full Stack)

```
my-project/
├── Clarinet.toml
├── vitest.config.js
├── package.json
├── contracts/
│   ├── my-contract.clar
│   └── my-contract.tests.clar      # RV tests
├── tests/
│   ├── my-contract.test.ts         # Vitest
│   ├── my-contract_test.clar       # Clarunit
│   └── clarunit.test.ts            # Clarunit runner
└── simulations/
    └── my-contract-stxer.ts        # Stxer
```

### package.json Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:rv": "npx rv . my-contract test",
    "test:rv:invariant": "npx rv . my-contract invariant",
    "test:stxer": "npx tsx simulations/my-contract-stxer.ts"
  }
}
```

---

## Contract Templates

Full contract templates with source and tests are in colocated files:

| Template | File | Description |
|----------|------|-------------|
| `heartbeat-registry` | [templates/heartbeat-registry.md](./templates/heartbeat-registry.md) | Agent heartbeat with full chain context, address enumeration, liveness checks |
| `proof-of-existence` | [templates/proof-of-existence.md](./templates/proof-of-existence.md) | Document timestamping with SIP-018 signatures, first-write-wins, attestor index |
| `registry-minimal` | [templates/registry-minimal.md](./templates/registry-minimal.md) | Minimal registry combining snapshot + stats + events |

---

## Execution Cost Limits

| Category | Block Limit | Read-Only Limit |
|----------|-------------|-----------------|
| Runtime | 5,000,000,000 | 1,000,000,000 |
| Read count | 15,000 | 30 |
| Read bytes | 100,000,000 | 100,000 |
| Write count | 15,000 | 0 |
| Write bytes | 15,000,000 | 0 |

### Cost Optimization Tips

1. **Inline single-use values** — avoid unnecessary `let` bindings
2. **Constants over data-vars** — constants are cheaper to read
3. **Bulk operations** — single call with list beats multiple calls
4. **Separate params vs tuples** — flat params are cheaper for function calls
5. **Off-chain computation** — move non-essential logic to UI/indexer

---

## Quick Reference

- Use `stacks-block-height` not `block-height` (deprecated)
- Use `tx-sender` for token operations, `contract-caller` only when immediate caller identity is needed
- Use `try!` for error propagation, `asserts!` for guards before state changes
- All public functions must return `(response ok err)`
- Error codes should be unique constants
- Events: `{notification: "event-name", payload: {...}}` format
- Check costs with `::get_costs` in clarinet console

## References

- [friedger/clarity-ccip-026](https://github.com/friedger/clarity-ccip-026) — All 4 testing tools integrated
- [kenny-stacks/stacks-starter](https://github.com/kenny-stacks/stacks-starter) — Testing setup reference
- [aibtcdev/aibtcdev-daos](https://github.com/aibtcdev/aibtcdev-daos) — DAO patterns
- [citycoins/protocol](https://github.com/citycoins/protocol) — Token and treasury patterns
- [clarigen](https://github.com/mechanismHQ/clarigen) — TypeScript type generation from contracts
- [secondlayer](https://github.com/ryanwaits/secondlayer) — Alternative type generator
