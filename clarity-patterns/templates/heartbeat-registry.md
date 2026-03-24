# Heartbeat Registry Template

Agent coordination primitive — on-chain heartbeat with full chain context.

## Use Cases

- **Agent heartbeat**: Autonomous agents prove they're alive and operational
- **Activity tracking**: Record when addresses interact with a system
- **Coordination checkpoint**: Agents record state at known points
- **Chain anchor**: Capture block hashes for cryptographic proofs

## Contract Source

```clarity
;; heartbeat-registry.clar
;; Agent coordination primitive - on-chain heartbeat with full chain context

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------

(define-constant CONTRACT_OWNER tx-sender)

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

(define-map Registry
  principal
  {
    ;; Block context
    stacksBlock: uint,
    burnBlock: uint,
    tenure: uint,
    blockTime: uint,
    chainId: uint,
    ;; Transaction context
    contractCaller: principal,
    txSponsor: (optional principal),
    ;; Block hashes (cryptographic anchors)
    stacksBlockHash: (optional (buff 32)),
    burnBlockHash: (optional (buff 32)),
    ;; Counter
    count: uint
  }
)

;; Global stats
(define-data-var totalAddresses uint u0)
(define-data-var totalCheckIns uint u0)

;; Secondary index: index -> address (for enumeration)
(define-map AddressIndex uint principal)

;; ---------------------------------------------------------
;; Private Functions
;; ---------------------------------------------------------

;; Capture full chain snapshot at transaction time
(define-private (capture-snapshot (existingCount uint))
  {
    stacksBlock: stacks-block-height,
    burnBlock: burn-block-height,
    tenure: tenure-height,
    blockTime: stacks-block-time,
    chainId: chain-id,
    contractCaller: contract-caller,
    txSponsor: tx-sponsor?,
    stacksBlockHash: (get-stacks-block-info? id-header-hash (- stacks-block-height u1)),
    burnBlockHash: (get-burn-block-info? header-hash (- burn-block-height u1)),
    count: (+ existingCount u1)
  }
)

;; ---------------------------------------------------------
;; Public Functions
;; ---------------------------------------------------------

;; Check in - records full chain snapshot for tx-sender
(define-public (check-in)
  (let
    (
      (caller tx-sender)
      (existing (map-get? Registry caller))
      (existingCount (default-to u0 (get count existing)))
      (isNew (is-none existing))
      (snapshot (capture-snapshot existingCount))
    )
    ;; Update registry
    (map-set Registry caller snapshot)

    ;; Update counters and index
    (var-set totalCheckIns (+ (var-get totalCheckIns) u1))
    (if isNew
      (begin
        (map-set AddressIndex (var-get totalAddresses) caller)
        (var-set totalAddresses (+ (var-get totalAddresses) u1))
      )
      true
    )

    ;; Emit event for indexers
    (print {
      notification: "check-in",
      payload: {
        address: caller,
        stacksBlock: (get stacksBlock snapshot),
        burnBlock: (get burnBlock snapshot),
        blockTime: (get blockTime snapshot),
        stacksBlockHash: (get stacksBlockHash snapshot),
        burnBlockHash: (get burnBlockHash snapshot),
        count: (get count snapshot)
      }
    })

    (ok snapshot)
  )
)

;; ---------------------------------------------------------
;; Read-Only Functions
;; ---------------------------------------------------------

(define-read-only (get-registration (address principal))
  (map-get? Registry address))

(define-read-only (is-registered (address principal))
  (is-some (map-get? Registry address)))

(define-read-only (get-check-in-count (address principal))
  (default-to u0 (get count (map-get? Registry address))))

(define-read-only (get-last-block (address principal))
  (default-to u0 (get stacksBlock (map-get? Registry address))))

(define-read-only (get-stats)
  {
    totalAddresses: (var-get totalAddresses),
    totalCheckIns: (var-get totalCheckIns)
  })

(define-read-only (get-address-at (index uint))
  (map-get? AddressIndex index))

(define-read-only (get-current-block-info)
  {
    stacksBlock: stacks-block-height,
    burnBlock: burn-block-height,
    tenure: tenure-height,
    blockTime: stacks-block-time,
    chainId: chain-id,
    stacksBlockHash: (get-stacks-block-info? id-header-hash (- stacks-block-height u1)),
    burnBlockHash: (get-burn-block-info? header-hash (- burn-block-height u1))
  })

(define-read-only (is-alive (address principal) (maxBlocks uint))
  (match (map-get? Registry address)
    entry (<= (- stacks-block-height (get stacksBlock entry)) maxBlocks)
    false))

(define-read-only (filter-alive (addresses (list 20 principal)) (maxBlocks uint))
  (filter is-alive-check addresses))

(define-private (is-alive-check (address principal))
  (is-alive address u144))  ;; ~1 day of blocks
```

## Test (Clarinet SDK / Vitest)

```typescript
import { Cl, cvToValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const CONTRACT = "heartbeat-registry";

describe("heartbeat-registry", function () {
  it("captures full chain snapshot on check-in", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const result = simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    expect(result.result).toBeOk(expect.anything());
    const value = cvToValue(result.result);
    expect(value.value.count).toBe(1n);
  });

  it("increments count on subsequent check-ins", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    const result = simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    const value = cvToValue(result.result);
    expect(value.value.count).toBe(3n);
  });

  it("tracks unique addresses in stats", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const wallet2 = simnet.getAccounts().get("wallet_2")!;
    const wallet3 = simnet.getAccounts().get("wallet_3")!;

    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet2);
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1); // repeat
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet3);

    const stats = simnet.callReadOnlyFn(CONTRACT, "get-stats", [], wallet1);
    expect(stats.result).toStrictEqual(Cl.tuple({
      totalAddresses: Cl.uint(3),
      totalCheckIns: Cl.uint(4),
    }));
  });

  it("enumerates registered addresses via index", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const wallet2 = simnet.getAccounts().get("wallet_2")!;

    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet2);

    const addr0 = simnet.callReadOnlyFn(CONTRACT, "get-address-at", [Cl.uint(0)], wallet1);
    const addr1 = simnet.callReadOnlyFn(CONTRACT, "get-address-at", [Cl.uint(1)], wallet1);
    const addr2 = simnet.callReadOnlyFn(CONTRACT, "get-address-at", [Cl.uint(2)], wallet1);

    expect(addr0.result).toBeSome(Cl.principal(wallet1));
    expect(addr1.result).toBeSome(Cl.principal(wallet2));
    expect(addr2.result).toBeNone();
  });

  it("detects alive vs stale addresses", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    simnet.callPublicFn(CONTRACT, "check-in", [], wallet1);

    let alive = simnet.callReadOnlyFn(
      CONTRACT, "is-alive",
      [Cl.principal(wallet1), Cl.uint(10)], wallet1
    );
    expect(alive.result).toBeBool(true);

    simnet.mineEmptyBlocks(15);

    alive = simnet.callReadOnlyFn(
      CONTRACT, "is-alive",
      [Cl.principal(wallet1), Cl.uint(10)], wallet1
    );
    expect(alive.result).toBeBool(false);
  });
});
```

## Deployment Checklist

- [ ] Run `clarinet check` — no errors
- [ ] Run `npm test` — all tests pass
- [ ] Verify Clarity version compatibility (needs Clarity 4 for `stacks-block-time`)
- [ ] Check execution costs with `::get_costs` in console
- [ ] Deploy to testnet, verify all read-only functions
- [ ] Document contract address after mainnet deployment

## Related Patterns

- Block snapshot pattern
- Secondary index pattern
- Global stats pattern
- Rate limiting pattern (for throttled check-ins)
