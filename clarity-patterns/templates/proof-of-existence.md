# Proof of Existence Template

On-chain attestation for recording that data existed at a specific moment. Supports SIP-018 signature verification for delegated submissions.

## Use Cases

- **Document timestamping**: Prove a document existed before a certain date
- **Commit-reveal schemes**: Commit to data before revealing it
- **Audit trails**: Immutable record of file hashes with Bitcoin anchor
- **Signed attestations**: Prove who attested to what and when (SIP-018)
- **Agent coordination**: Record decisions with cryptographic proof

## Contract Source

```clarity
;; proof-of-existence.clar
;; On-chain attestation with full chain context and SIP-018 signature support

;; ---------------------------------------------------------
;; Constants
;; ---------------------------------------------------------

(define-constant CONTRACT_OWNER tx-sender)

;; Errors
(define-constant ERR_ALREADY_ATTESTED (err u1001))
(define-constant ERR_NOT_FOUND (err u1002))
(define-constant ERR_INVALID_SIGNATURE (err u1003))

;; SIP-018 Structured Data Domain
(define-constant ATTESTATION_DOMAIN {
  name: "ProofOfExistence",
  version: "1",
  chain-id: chain-id
})

;; ---------------------------------------------------------
;; Data
;; ---------------------------------------------------------

(define-map Attestations
  (buff 32)
  {
    attestor: principal,
    stacksBlock: uint,
    burnBlock: uint,
    tenure: uint,
    blockTime: uint,
    chainId: uint,
    contractCaller: principal,
    txSponsor: (optional principal),
    stacksBlockHash: (optional (buff 32)),
    burnBlockHash: (optional (buff 32)),
    memo: (optional (string-ascii 64))
  }
)

;; Secondary index: attestor -> hashes
(define-map AttestorCount principal uint)
(define-map AttestorIndex
  {attestor: principal, index: uint}
  (buff 32)
)

;; Global stats
(define-data-var totalAttestations uint u0)

;; ---------------------------------------------------------
;; Private Functions
;; ---------------------------------------------------------

(define-private (capture-snapshot (attestor principal) (memo (optional (string-ascii 64))))
  {
    attestor: attestor,
    stacksBlock: stacks-block-height,
    burnBlock: burn-block-height,
    tenure: tenure-height,
    blockTime: stacks-block-time,
    chainId: chain-id,
    contractCaller: contract-caller,
    txSponsor: tx-sponsor?,
    stacksBlockHash: (get-stacks-block-info? id-header-hash (- stacks-block-height u1)),
    burnBlockHash: (get-burn-block-info? header-hash (- burn-block-height u1)),
    memo: memo
  }
)

(define-private (update-attestor-index (attestor principal) (hash (buff 32)))
  (let ((idx (default-to u0 (map-get? AttestorCount attestor))))
    (map-set AttestorIndex {attestor: attestor, index: idx} hash)
    (map-set AttestorCount attestor (+ idx u1))
  )
)

;; ---------------------------------------------------------
;; Public Functions
;; ---------------------------------------------------------

;; Attest to a hash - first attestor wins
(define-public (attest (hash (buff 32)) (memo (optional (string-ascii 64))))
  (let
    (
      (attestor tx-sender)
      (existing (map-get? Attestations hash))
      (snapshot (capture-snapshot attestor memo))
    )
    (asserts! (is-none existing) ERR_ALREADY_ATTESTED)
    (map-set Attestations hash snapshot)
    (update-attestor-index attestor hash)
    (var-set totalAttestations (+ (var-get totalAttestations) u1))
    (print {
      notification: "attestation",
      payload: {
        hash: hash,
        attestor: attestor,
        stacksBlock: (get stacksBlock snapshot),
        burnBlock: (get burnBlock snapshot),
        blockTime: (get blockTime snapshot),
        memo: memo
      }
    })
    (ok {
      hash: hash,
      stacksBlock: stacks-block-height,
      burnBlock: burn-block-height,
      blockTime: stacks-block-time,
      stacksBlockHash: (get stacksBlockHash snapshot),
      burnBlockHash: (get burnBlockHash snapshot)
    })
  )
)

;; Attest with SIP-018 signature verification
(define-public (attest-with-signature
    (hash (buff 32))
    (memo (optional (string-ascii 64)))
    (signature (buff 65))
    (signer principal))
  (let
    (
      (existing (map-get? Attestations hash))
      (messageHash (sha256 (concat
        (unwrap-panic (to-consensus-buff? ATTESTATION_DOMAIN))
        (unwrap-panic (to-consensus-buff? {hash: hash, memo: memo}))
      )))
      (recoveredKey (try! (secp256k1-recover? messageHash signature)))
      (recoveredPrincipal (principal-of? recoveredKey))
      (snapshot (capture-snapshot signer memo))
    )
    (asserts! (is-eq (ok signer) recoveredPrincipal) ERR_INVALID_SIGNATURE)
    (asserts! (is-none existing) ERR_ALREADY_ATTESTED)
    (map-set Attestations hash snapshot)
    (update-attestor-index signer hash)
    (var-set totalAttestations (+ (var-get totalAttestations) u1))
    (print {
      notification: "attestation-signed",
      payload: {
        hash: hash,
        attestor: signer,
        submitter: tx-sender,
        stacksBlock: (get stacksBlock snapshot),
        burnBlock: (get burnBlock snapshot),
        blockTime: (get blockTime snapshot),
        memo: memo
      }
    })
    (ok {
      hash: hash,
      attestor: signer,
      stacksBlock: stacks-block-height,
      burnBlock: burn-block-height,
      blockTime: stacks-block-time,
      stacksBlockHash: (get stacksBlockHash snapshot),
      burnBlockHash: (get burnBlockHash snapshot)
    })
  )
)

;; ---------------------------------------------------------
;; Read-Only Functions
;; ---------------------------------------------------------

(define-read-only (get-attestation (hash (buff 32)))
  (map-get? Attestations hash))

(define-read-only (is-attested (hash (buff 32)))
  (is-some (map-get? Attestations hash)))

(define-read-only (get-attestor (hash (buff 32)))
  (get attestor (map-get? Attestations hash)))

(define-read-only (get-attestation-block (hash (buff 32)))
  (get stacksBlock (map-get? Attestations hash)))

(define-read-only (get-attestor-count (attestor principal))
  (default-to u0 (map-get? AttestorCount attestor)))

(define-read-only (get-attestor-hash-at (attestor principal) (index uint))
  (map-get? AttestorIndex {attestor: attestor, index: index}))

(define-read-only (get-stats)
  { totalAttestations: (var-get totalAttestations) })

(define-read-only (verify-hash (data (buff 1024)) (expectedHash (buff 32)))
  (is-eq (sha256 data) expectedHash))

(define-read-only (get-signing-message (hash (buff 32)) (memo (optional (string-ascii 64))))
  (sha256 (concat
    (unwrap-panic (to-consensus-buff? ATTESTATION_DOMAIN))
    (unwrap-panic (to-consensus-buff? {hash: hash, memo: memo}))
  )))

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
```

## Test (Clarinet SDK / Vitest)

```typescript
import { Cl, cvToValue } from "@stacks/transactions";
import { sha256 } from "@stacks/encryption";
import { describe, expect, it } from "vitest";

const CONTRACT = "proof-of-existence";

describe("proof-of-existence", function () {
  it("records attestation with full snapshot", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const hash = sha256(Buffer.from("Important document"));

    const result = simnet.callPublicFn(
      CONTRACT, "attest",
      [Cl.buffer(hash), Cl.some(Cl.stringAscii("Contract v1"))],
      wallet1
    );
    expect(result.result).toBeOk(expect.anything());
  });

  it("prevents duplicate attestations (first-write-wins)", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const wallet2 = simnet.getAccounts().get("wallet_2")!;
    const hash = sha256(Buffer.from("Unique data"));

    const first = simnet.callPublicFn(
      CONTRACT, "attest", [Cl.buffer(hash), Cl.none()], wallet1
    );
    expect(first.result).toBeOk(expect.anything());

    const second = simnet.callPublicFn(
      CONTRACT, "attest", [Cl.buffer(hash), Cl.none()], wallet2
    );
    expect(second.result).toBeErr(Cl.uint(1001));
  });

  it("stores and retrieves attestation data by hash", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const hash = sha256(Buffer.from("Document with memo"));

    simnet.callPublicFn(
      CONTRACT, "attest",
      [Cl.buffer(hash), Cl.some(Cl.stringAscii("Legal Agreement"))],
      wallet1
    );

    const attestation = simnet.callReadOnlyFn(
      CONTRACT, "get-attestation", [Cl.buffer(hash)], wallet1
    );
    const value = cvToValue(attestation.result, true);
    expect(value.value.attestor).toBe(wallet1);
    expect(value.value.memo.value).toBe("Legal Agreement");
  });

  it("tracks attestor history via secondary index", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const hash1 = sha256(Buffer.from("Doc 1"));
    const hash2 = sha256(Buffer.from("Doc 2"));
    const hash3 = sha256(Buffer.from("Doc 3"));

    simnet.callPublicFn(CONTRACT, "attest", [Cl.buffer(hash1), Cl.none()], wallet1);
    simnet.callPublicFn(CONTRACT, "attest", [Cl.buffer(hash2), Cl.none()], wallet1);
    simnet.callPublicFn(CONTRACT, "attest", [Cl.buffer(hash3), Cl.none()], wallet1);

    const count = simnet.callReadOnlyFn(
      CONTRACT, "get-attestor-count", [Cl.principal(wallet1)], wallet1
    );
    expect(count.result).toBeUint(3);

    const secondHash = simnet.callReadOnlyFn(
      CONTRACT, "get-attestor-hash-at",
      [Cl.principal(wallet1), Cl.uint(1)], wallet1
    );
    expect(secondHash.result).toBeSome(Cl.buffer(hash2));
  });

  it("verifies hash matches data", function () {
    const wallet1 = simnet.getAccounts().get("wallet_1")!;
    const testData = "Verify this content";
    const correctHash = sha256(Buffer.from(testData));
    const wrongHash = sha256(Buffer.from("Different content"));

    const correct = simnet.callReadOnlyFn(
      CONTRACT, "verify-hash",
      [Cl.buffer(Buffer.from(testData)), Cl.buffer(correctHash)], wallet1
    );
    expect(correct.result).toBeBool(true);

    const wrong = simnet.callReadOnlyFn(
      CONTRACT, "verify-hash",
      [Cl.buffer(Buffer.from(testData)), Cl.buffer(wrongHash)], wallet1
    );
    expect(wrong.result).toBeBool(false);
  });
});
```

## Deployment Checklist

- [ ] Run `clarinet check` — no errors
- [ ] Run `npm test` — all tests pass
- [ ] Verify SIP-018 domain `chain-id` matches target network (1=mainnet, 2147483648=testnet)
- [ ] Test signature verification with real wallet keys
- [ ] Check execution costs with `::get_costs`
- [ ] Deploy to testnet, verify all read-only functions
- [ ] Test `get-signing-message` matches off-chain computation
- [ ] Document contract address and SIP-018 domain for client integrations

## Related Patterns

- Block snapshot pattern
- Hash-keyed registry
- Secondary index pattern
- First-write-wins semantics
- SIP-018 structured data signing
