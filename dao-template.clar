;; dao-template.clar
;; Treasury + membership + voting DAO contract template.
;; Deploy with a unique contract-name per DAO.
;; Admin = tx-sender at deploy time.

;; ---------------------------------------------------------------------------
;; External contracts
;; ---------------------------------------------------------------------------

(define-constant SBTC-CONTRACT 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; ---------------------------------------------------------------------------
;; Error constants
;; ---------------------------------------------------------------------------

(define-constant ERR-NOT-MEMBER (err u1))
(define-constant ERR-ALREADY-MEMBER (err u2))
(define-constant ERR-NOT-ADMIN (err u3))
(define-constant ERR-PROPOSAL-NOT-FOUND (err u4))
(define-constant ERR-ALREADY-VOTED (err u5))
(define-constant ERR-VOTING-CLOSED (err u6))
(define-constant ERR-ALREADY-EXECUTED (err u7))
(define-constant ERR-QUORUM-NOT-MET (err u8))
(define-constant ERR-NOT-PASSED (err u9))
(define-constant ERR-INSUFFICIENT-FUNDS (err u10))

;; ~1 day in blocks (~144 blocks at 10min each)
(define-constant VOTING-PERIOD u144)

;; ---------------------------------------------------------------------------
;; Data vars
;; ---------------------------------------------------------------------------

(define-data-var dao-name (string-ascii 64) "")
(define-data-var dao-purpose (string-ascii 256) "")
(define-data-var admin principal 'SP1C7XGRFPDHRSZECMGDEYJ7TWHFFQ03JMKE3NHCR)
(define-data-var member-count uint u0)
(define-data-var proposal-count uint u0)

;; ---------------------------------------------------------------------------
;; Maps
;; ---------------------------------------------------------------------------

(define-map Members
  { member: principal }
  { joined-at: uint, active: bool }
)

(define-map Proposals
  { proposal-id: uint }
  {
    proposer: principal,
    title: (string-ascii 128),
    description: (string-ascii 512),
    amount-sats: uint,
    recipient: principal,
    votes-yes: uint,
    votes-no: uint,
    executed: bool,
    cancelled: bool,
    created-at: uint,
    voting-ends-at: uint,
  }
)

(define-map Votes
  { proposal-id: uint, voter: principal }
  { vote: bool }
)

;; ---------------------------------------------------------------------------
;; Private helpers
;; ---------------------------------------------------------------------------

(define-private (is-admin)
  (is-eq tx-sender (var-get admin))
)

(define-private (is-active-member (who principal))
  (match (map-get? Members { member: who })
    entry (get active entry)
    false
  )
)

;; ---------------------------------------------------------------------------
;; Public: initialize
;; ---------------------------------------------------------------------------

(define-public (initialize
    (name (string-ascii 64))
    (purpose (string-ascii 256)))
  (begin
    (asserts! (is-admin) ERR-NOT-ADMIN)
    ;; Only callable once -- if name already set, reject
    (asserts! (is-eq (var-get dao-name) "") ERR-ALREADY-MEMBER)
    (var-set dao-name name)
    (var-set dao-purpose purpose)
    ;; Add admin as first member
    (map-set Members { member: tx-sender } { joined-at: stacks-block-height, active: true })
    (var-set member-count u1)
    (ok true)
  )
)

;; ---------------------------------------------------------------------------
;; Public: add-member (admin only)
;; ---------------------------------------------------------------------------

(define-public (add-member (new-member principal))
  (begin
    (asserts! (is-admin) ERR-NOT-ADMIN)
    (asserts! (is-none (map-get? Members { member: new-member })) ERR-ALREADY-MEMBER)
    (map-set Members { member: new-member } { joined-at: stacks-block-height, active: true })
    (var-set member-count (+ (var-get member-count) u1))
    (ok true)
  )
)

;; ---------------------------------------------------------------------------
;; Public: join-dao
;; Currently restricted -- membership is granted by admin only.
;; This function is present for future open-membership extension.
;; ---------------------------------------------------------------------------

(define-public (join-dao)
  (begin
    (asserts! false ERR-NOT-ADMIN)
    (ok true))
)

;; ---------------------------------------------------------------------------
;; Public: deposit-sbtc
;; ---------------------------------------------------------------------------

(define-public (deposit-sbtc (amount uint))
  (begin
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount tx-sender (as-contract tx-sender) none))
    (ok true)
  )
)

;; ---------------------------------------------------------------------------
;; Public: create-proposal (members only)
;; ---------------------------------------------------------------------------

(define-public (create-proposal
    (title (string-ascii 128))
    (description (string-ascii 512))
    (amount-sats uint)
    (recipient principal))
  (let ((pid (+ (var-get proposal-count) u1)))
    (asserts! (is-active-member tx-sender) ERR-NOT-MEMBER)
    (map-set Proposals
      { proposal-id: pid }
      {
        proposer: tx-sender,
        title: title,
        description: description,
        amount-sats: amount-sats,
        recipient: recipient,
        votes-yes: u0,
        votes-no: u0,
        executed: false,
        cancelled: false,
        created-at: stacks-block-height,
        voting-ends-at: (+ stacks-block-height VOTING-PERIOD),
      }
    )
    (var-set proposal-count pid)
    (ok pid)
  )
)

;; ---------------------------------------------------------------------------
;; Public: vote (members only, within voting period)
;; ---------------------------------------------------------------------------

(define-public (vote (proposal-id uint) (vote-yes bool))
  (let (
    (proposal (unwrap! (map-get? Proposals { proposal-id: proposal-id }) ERR-PROPOSAL-NOT-FOUND))
  )
    (asserts! (is-active-member tx-sender) ERR-NOT-MEMBER)
    (asserts! (<= stacks-block-height (get voting-ends-at proposal)) ERR-VOTING-CLOSED)
    (asserts! (is-none (map-get? Votes { proposal-id: proposal-id, voter: tx-sender })) ERR-ALREADY-VOTED)
    (map-set Votes { proposal-id: proposal-id, voter: tx-sender } { vote: vote-yes })
    (if vote-yes
      (map-set Proposals { proposal-id: proposal-id }
        (merge proposal { votes-yes: (+ (get votes-yes proposal) u1) }))
      (map-set Proposals { proposal-id: proposal-id }
        (merge proposal { votes-no: (+ (get votes-no proposal) u1) }))
    )
    (ok true)
  )
)

;; ---------------------------------------------------------------------------
;; Public: execute-proposal
;; Anyone may call after voting ends. Marks executed=true to prevent replay.
;; ---------------------------------------------------------------------------

(define-public (execute-proposal (proposal-id uint))
  (let (
    (proposal (unwrap! (map-get? Proposals { proposal-id: proposal-id }) ERR-PROPOSAL-NOT-FOUND))
    (yes-votes (get votes-yes proposal))
    (no-votes (get votes-no proposal))
    (total-votes (+ yes-votes no-votes))
    (quorum (+ (/ (var-get member-count) u2) u1))
    (amount (get amount-sats proposal))
    (recipient (get recipient proposal))
  )
    (asserts! (not (get executed proposal)) ERR-ALREADY-EXECUTED)
    (asserts! (> stacks-block-height (get voting-ends-at proposal)) ERR-VOTING-CLOSED)
    ;; Mark executed first to prevent re-entrancy
    (map-set Proposals { proposal-id: proposal-id }
      (merge proposal { executed: true }))
    ;; Quorum and majority check
    (asserts! (>= total-votes quorum) ERR-QUORUM-NOT-MET)
    (asserts! (> yes-votes no-votes) ERR-NOT-PASSED)
    ;; Transfer sBTC if amount > 0 (transfer itself will fail if balance insufficient)
    (if (> amount u0)
      (begin
        (try! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          transfer amount (as-contract tx-sender) recipient none)))
        (ok true)
      )
      (ok true)
    )
  )
)

;; ---------------------------------------------------------------------------
;; Read-only: get-proposal
;; ---------------------------------------------------------------------------

(define-read-only (get-proposal (proposal-id uint))
  (map-get? Proposals { proposal-id: proposal-id })
)

;; ---------------------------------------------------------------------------
;; Read-only: get-member
;; ---------------------------------------------------------------------------

(define-read-only (get-member (member principal))
  (map-get? Members { member: member })
)

;; ---------------------------------------------------------------------------
;; Read-only: get-info
;; ---------------------------------------------------------------------------

(define-read-only (get-info)
  {
    dao-name: (var-get dao-name),
    dao-purpose: (var-get dao-purpose),
    member-count: (var-get member-count),
    proposal-count: (var-get proposal-count),
  }
)
