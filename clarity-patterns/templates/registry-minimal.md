# Registry Minimal Template

Minimal registry contract combining snapshot, stats, and events. Use as a starting point and extend with patterns from the main SKILL.md.

## Contract Source

```clarity
;; registry-template.clar

;; Constants
(define-constant CONTRACT_OWNER tx-sender)
(define-constant ERR_UNAUTHORIZED (err u1000))
(define-constant ERR_NOT_FOUND (err u1001))

;; Data
(define-map Registry
  principal
  {
    stacksBlock: uint,
    burnBlock: uint,
    blockTime: uint,
    chainId: uint,
    count: uint
  }
)

(define-data-var totalEntries uint u0)
(define-data-var uniqueAddresses uint u0)

;; Public
(define-public (register)
  (let
    (
      (existing (map-get? Registry tx-sender))
      (isNew (is-none existing))
      (newCount (+ (default-to u0 (get count existing)) u1))
    )
    (map-set Registry tx-sender {
      stacksBlock: stacks-block-height,
      burnBlock: burn-block-height,
      blockTime: stacks-block-time,
      chainId: chain-id,
      count: newCount
    })
    (var-set totalEntries (+ (var-get totalEntries) u1))
    (if isNew
      (var-set uniqueAddresses (+ (var-get uniqueAddresses) u1))
      true)
    (print {notification: "register", payload: {address: tx-sender, count: newCount}})
    (ok newCount)
  )
)

;; Read-only
(define-read-only (get-entry (address principal))
  (map-get? Registry address))

(define-read-only (get-stats)
  {totalEntries: (var-get totalEntries), uniqueAddresses: (var-get uniqueAddresses)})
```

## Test (Clarinet SDK / Vitest)

```typescript
import { Cl, cvToValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const CONTRACT = "registry-template";

describe("registry-template", function () {
  it("registers with count 1 on first call", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const result = simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    expect(result.result).toBeOk(Cl.uint(1));
  });

  it("increments count on subsequent calls", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    const result = simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    expect(result.result).toBeOk(Cl.uint(3));
  });

  it("tracks unique addresses separately from total entries", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const wallet2 = simnet.getAccounts().get("wallet_2")!;

    simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    simnet.callPublicFn(CONTRACT, "register", [], wallet1);
    simnet.callPublicFn(CONTRACT, "register", [], wallet2);

    const stats = simnet.callReadOnlyFn(CONTRACT, "get-stats", [], wallet1);
    expect(stats.result).toStrictEqual(Cl.tuple({
      totalEntries: Cl.uint(3),
      uniqueAddresses: Cl.uint(2),
    }));
  });

  it("returns none for unregistered addresses", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const wallet2 = simnet.getAccounts().get("wallet_2")!;
    const entry = simnet.callReadOnlyFn(
      CONTRACT, "get-entry", [Cl.principal(wallet2)], wallet1
    );
    expect(entry.result).toBeNone();
  });
});
```

## Deployment Checklist

- [ ] Run `clarinet check` — no errors
- [ ] Run `npm test` — all tests pass
- [ ] Check execution costs with `::get_costs`
- [ ] Deploy to testnet first

## Extending This Template

Add from the patterns in SKILL.md:

- **Address enumeration**: Add `AddressIndex` map + secondary index pattern
- **Liveness checks**: Add `is-alive` read-only function
- **Rate limiting**: Add minimum block interval between calls
- **Admin controls**: Add admin-gated registration
- **Block hashes**: Add `stacksBlockHash`/`burnBlockHash` for cryptographic anchors
- **History**: Switch from last-write-wins to append-only pattern
