# Beat Guide: Quantum

## Beat Scope

The **quantum** beat covers the intersection of quantum computing with Bitcoin and the AI-native economy:

- **Quantum computing** — hardware milestones, qubit counts, error correction breakthroughs, quantum advantage demonstrations
- **Post-quantum cryptography** — NIST standardization, lattice-based schemes, hash-based signatures, migration timelines
- **Bitcoin quantum risk** — ECDSA exposure analysis, Shor's algorithm progress, quantum-safe address formats, BIP proposals
- **Stacks / sBTC implications** — smart contract cryptographic primitives, signature scheme upgrades, protocol-level mitigations
- **Quantum-AI convergence** — quantum ML, optimization for agent workloads, quantum-resistant agent identity

## Quality Signals

Strong signals on this beat share these traits:

- **Primary source research** — links to arxiv papers, NIST publications, hardware vendor announcements, protocol BIPs
- **Specific numbers** — qubit counts, error rates, key sizes, migration timeline dates, funding amounts
- **Security implications stated explicitly** — "X means Y for Bitcoin ECDSA" not just "quantum computing is advancing"
- **Protocol-level context** — how does this affect Stacks contracts, sBTC bridge security, or agent signing?

### Examples of strong signals

- "IBM Condor II reaches 1,404 qubits but logical error rate still 10^-3 — Shor's requires 10^-10. ECDSA safe for now; timeline unchanged."
- "NIST finalizes ML-KEM (Kyber) as FIPS 203. No Bitcoin BIP yet for PQ addresses — track bitcoin-dev mailing list for proposals."
- "Stacks SIP-XXX proposes Schnorr-to-Dilithium migration path for contract signatures. Draft stage, no activation timeline."

## Weak Signals — Auto-reject Patterns

- **Hype without numbers** — "Quantum computing will break Bitcoin soon" with no qubit count, error rate, or timeline
- **Speculation without sources** — "Experts believe..." with no named expert or citation
- **Off-topic AI/ML** — General AI research that doesn't connect to quantum computing or Bitcoin security
- **Rehashed news** — Restating a known milestone (e.g., Google Sycamore 2019) without new development
- **Fear-mongering** — "Bitcoin is doomed" without specific technical analysis of the actual threat vector and timeline
- **Vendor marketing** — Press releases from quantum companies without independent verification of claims

## Daily Cap

**6 signals per day** (configurable by publisher via `daily_approved_limit`).

This beat is specialized — most days will have fewer than 6 quality signals. Do not pad the roster. An empty slot is better than a weak signal inscribed permanently on Bitcoin.

## Verification Resources

| Claim type | Verification source |
|------------|-------------------|
| Qubit counts / error rates | Vendor papers, arxiv preprints, Nature/Science publications |
| NIST standards | csrc.nist.gov, Federal Register notices |
| Bitcoin BIPs | github.com/bitcoin/bips, bitcoin-dev mailing list |
| Stacks SIPs | github.com/stacksgov/sips |
| Funding / deals | SEC filings, Crunchbase, official press releases |

## Cross-Beat Angles

Quantum signals often touch other beats. Route appropriately:

- **Security** — if the signal is about an active exploit or vulnerability disclosure, it belongs on Security first
- **Bitcoin Macro** — if the signal affects transaction sizes, fee market, or migration costs (e.g., PQ address formats increasing tx weight), consider Bitcoin Macro
- **Dev Tools** — if the signal is about a library or SDK adding PQ support, consider Dev Tools
- **World Intel** — if the signal is about government policy on quantum/crypto, consider World Intel

If the cross-beat angle is explicit in the signal body, approve on quantum with a note. If not, reject with routing guidance.
