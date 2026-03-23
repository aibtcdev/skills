;; escrow-htlc.clar
;; Trust-minimized Hash Time-Locked Contract for agent-to-agent sBTC escrow on Stacks.
;; 
;; Design:
;;   lock   → sender deposits sBTC, sets hashlock + absolute timelock
;;   claim  → recipient reveals preimage (sha256 must match hashlock) to receive sBTC
;;   refund → sender reclaims full amount after timelock expires
;;
;; Invariants:
;;   - Zero AMM/DEX dependency: pure HTLC only
;;   - Single settlement asset: sBTC (no mid-flow conversion)
;;   - Double-claim / double-refund both fail cleanly
;;   - Contract prints on every state transition

;; ============================================================
;; Constants
;; ============================================================

(define-constant CONTRACT-OWNER tx-sender)
(define-constant SBTC-TOKEN 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sbtc-token)

(define-constant ERR-ALREADY-EXISTS     (err u100))
(define-constant ERR-NOT-FOUND         (err u101))
(define-constant ERR-ALREADY-CLAIMED   (err u102))
(define-constant ERR-ALREADY-REFUNDED  (err u103))
(define-constant ERR-WRONG-PREIMAGE    (err u104))
(define-constant ERR-TIMELOCK-ACTIVE   (err u105)) ;; refund attempted before expiry
(define-constant ERR-TIMELOCK-EXPIRED  (err u106)) ;; claim attempted after expiry
(define-constant ERR-ZERO-AMOUNT       (err u107))
(define-constant ERR-NOT-RECIPIENT     (err u108))
(define-constant ERR-NOT-SENDER        (err u109))
(define-constant ERR-BAD-TIMELOCK      (err u110)) ;; timelock <= current block

;; ============================================================
;; Data
;; ============================================================

(define-map escrows
  { escrow-id: (buff 32) }
  {
    sender:    principal,
    recipient: principal,
    amount:    uint,          ;; satoshis (sBTC uses 8 decimals; 1 sat = u1)
    hashlock:  (buff 32),     ;; sha256 hash of the preimage
    timelock:  uint,          ;; absolute block height — claim must happen at or before this
    claimed:   bool,
    refunded:  bool
  }
)

;; ============================================================
;; Read-only
;; ============================================================

(define-read-only (get-escrow (escrow-id (buff 32)))
  (map-get? escrows { escrow-id: escrow-id })
)

(define-read-only (is-claimable (escrow-id (buff 32)))
  (match (map-get? escrows { escrow-id: escrow-id })
    escrow (and
              (not (get claimed escrow))
              (not (get refunded escrow))
              (<= block-height (get timelock escrow)))
    false
  )
)

(define-read-only (is-refundable (escrow-id (buff 32)))
  (match (map-get? escrows { escrow-id: escrow-id })
    escrow (and
              (not (get claimed escrow))
              (not (get refunded escrow))
              (> block-height (get timelock escrow)))
    false
  )
)

;; ============================================================
;; Public: lock
;; ============================================================

(define-public (lock
    (escrow-id  (buff 32))
    (recipient  principal)
    (amount     uint)
    (hashlock   (buff 32))
    (timelock   uint))
  (begin
    ;; Validation
    (asserts! (is-none (map-get? escrows { escrow-id: escrow-id })) ERR-ALREADY-EXISTS)
    (asserts! (> amount u0)              ERR-ZERO-AMOUNT)
    (asserts! (> timelock block-height)  ERR-BAD-TIMELOCK)

    ;; Transfer sBTC from sender to this contract
    (try! (contract-call? SBTC-TOKEN transfer amount tx-sender (as-contract tx-sender) none))

    ;; Store escrow
    (map-set escrows
      { escrow-id: escrow-id }
      {
        sender:    tx-sender,
        recipient: recipient,
        amount:    amount,
        hashlock:  hashlock,
        timelock:  timelock,
        claimed:   false,
        refunded:  false
      })

    ;; Emit event
    (print {
      event:      "lock",
      escrow-id:  escrow-id,
      sender:     tx-sender,
      recipient:  recipient,
      amount:     amount,
      hashlock:   hashlock,
      timelock:   timelock,
      block:      block-height
    })

    (ok true)
  )
)

;; ============================================================
;; Public: claim
;; ============================================================

(define-public (claim
    (escrow-id (buff 32))
    (preimage  (buff 32)))
  (let ((escrow (unwrap! (map-get? escrows { escrow-id: escrow-id }) ERR-NOT-FOUND)))
    ;; Access control
    (asserts! (is-eq tx-sender (get recipient escrow)) ERR-NOT-RECIPIENT)
    ;; State checks
    (asserts! (not (get claimed escrow))               ERR-ALREADY-CLAIMED)
    (asserts! (not (get refunded escrow))              ERR-ALREADY-REFUNDED)
    ;; Timelock: must claim at or before expiry
    (asserts! (<= block-height (get timelock escrow))  ERR-TIMELOCK-EXPIRED)
    ;; Hashlock: sha256(preimage) must match stored hashlock
    (asserts! (is-eq (sha256 preimage) (get hashlock escrow)) ERR-WRONG-PREIMAGE)

    ;; Mark claimed before transfer (reentrancy safety)
    (map-set escrows
      { escrow-id: escrow-id }
      (merge escrow { claimed: true }))

    ;; Transfer sBTC to recipient
    (try! (as-contract (contract-call? SBTC-TOKEN transfer
            (get amount escrow)
            tx-sender
            (get recipient escrow)
            none)))

    ;; Emit event
    (print {
      event:      "claim",
      escrow-id:  escrow-id,
      recipient:  (get recipient escrow),
      amount:     (get amount escrow),
      preimage:   preimage,
      block:      block-height
    })

    (ok true)
  )
)

;; ============================================================
;; Public: refund
;; ============================================================

(define-public (refund (escrow-id (buff 32)))
  (let ((escrow (unwrap! (map-get? escrows { escrow-id: escrow-id }) ERR-NOT-FOUND)))
    ;; Access control
    (asserts! (is-eq tx-sender (get sender escrow)) ERR-NOT-SENDER)
    ;; State checks
    (asserts! (not (get claimed escrow))            ERR-ALREADY-CLAIMED)
    (asserts! (not (get refunded escrow))           ERR-ALREADY-REFUNDED)
    ;; Timelock: must be past expiry to refund
    (asserts! (> block-height (get timelock escrow)) ERR-TIMELOCK-ACTIVE)

    ;; Mark refunded before transfer (reentrancy safety)
    (map-set escrows
      { escrow-id: escrow-id }
      (merge escrow { refunded: true }))

    ;; Return full amount to sender — no fees
    (try! (as-contract (contract-call? SBTC-TOKEN transfer
            (get amount escrow)
            tx-sender
            (get sender escrow)
            none)))

    ;; Emit event
    (print {
      event:      "refund",
      escrow-id:  escrow-id,
      sender:     (get sender escrow),
      amount:     (get amount escrow),
      block:      block-height
    })

    (ok true)
  )
)
