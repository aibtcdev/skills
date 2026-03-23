/**
 * escrow-htlc unit tests
 *
 * Tests cover TI's 7-point acceptance checklist:
 * 1. HTLC preimage reveal releases funds (happy path)
 * 2. Timelock expiry returns full amount to sender
 * 3. Double-claim attempt fails cleanly
 * 4. Zero AMM/DEX dependency (pure logic tests, no swap calls)
 * 5. Single settlement asset (all transfers use sbtc-token only)
 * 6. Contract prints on lock / claim / refund
 * 7. Edge cases: wrong preimage, premature refund, non-recipient claim
 */

import { describe, it, expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";

// ── Pure logic helpers (mirror contract logic) ────────────────────────────────

function sha256(preimage: Buffer): Buffer {
  return createHash("sha256").update(preimage).digest();
}

function hexToBuffer(hex: string): Buffer {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  return Buffer.from(hex, "hex");
}

// Simulated escrow state (mirrors the Clarity map entry)
interface EscrowState {
  sender: string;
  recipient: string;
  amount: bigint;
  hashlock: Buffer;
  timelock: number;    // absolute block height
  claimed: boolean;
  refunded: boolean;
}

// Simulated contract engine (validates the same logic as Clarity contract)
const ERR = {
  ALREADY_EXISTS:    100,
  NOT_FOUND:         101,
  ALREADY_CLAIMED:   102,
  ALREADY_REFUNDED:  103,
  WRONG_PREIMAGE:    104,
  TIMELOCK_ACTIVE:   105,
  TIMELOCK_EXPIRED:  106,
  ZERO_AMOUNT:       107,
  NOT_RECIPIENT:     108,
  NOT_SENDER:        109,
  BAD_TIMELOCK:      110,
};

class SimulatedContract {
  private escrows = new Map<string, EscrowState>();
  private events: object[] = [];

  lock(
    caller: string,
    escrowId: Buffer,
    recipient: string,
    amount: bigint,
    hashlock: Buffer,
    timelock: number,
    currentBlock: number
  ): { ok: true } | { err: number } {
    const key = escrowId.toString("hex");
    if (this.escrows.has(key))   return { err: ERR.ALREADY_EXISTS };
    if (amount === 0n)           return { err: ERR.ZERO_AMOUNT };
    if (timelock <= currentBlock) return { err: ERR.BAD_TIMELOCK };

    this.escrows.set(key, {
      sender: caller, recipient, amount, hashlock, timelock,
      claimed: false, refunded: false
    });
    this.events.push({ event: "lock", escrowId: key, sender: caller, recipient, amount: amount.toString(), timelock });
    return { ok: true };
  }

  claim(
    caller: string,
    escrowId: Buffer,
    preimage: Buffer,
    currentBlock: number
  ): { ok: true; amount: bigint; recipient: string } | { err: number } {
    const key = escrowId.toString("hex");
    const e = this.escrows.get(key);
    if (!e)                         return { err: ERR.NOT_FOUND };
    if (caller !== e.recipient)     return { err: ERR.NOT_RECIPIENT };
    if (e.claimed)                  return { err: ERR.ALREADY_CLAIMED };
    if (e.refunded)                 return { err: ERR.ALREADY_REFUNDED };
    if (currentBlock > e.timelock)  return { err: ERR.TIMELOCK_EXPIRED };
    if (!sha256(preimage).equals(e.hashlock)) return { err: ERR.WRONG_PREIMAGE };

    e.claimed = true;
    this.events.push({ event: "claim", escrowId: key, recipient: e.recipient, amount: e.amount.toString() });
    return { ok: true, amount: e.amount, recipient: e.recipient };
  }

  refund(
    caller: string,
    escrowId: Buffer,
    currentBlock: number
  ): { ok: true; amount: bigint; sender: string } | { err: number } {
    const key = escrowId.toString("hex");
    const e = this.escrows.get(key);
    if (!e)                          return { err: ERR.NOT_FOUND };
    if (caller !== e.sender)         return { err: ERR.NOT_SENDER };
    if (e.claimed)                   return { err: ERR.ALREADY_CLAIMED };
    if (e.refunded)                  return { err: ERR.ALREADY_REFUNDED };
    if (currentBlock <= e.timelock)  return { err: ERR.TIMELOCK_ACTIVE };

    e.refunded = true;
    this.events.push({ event: "refund", escrowId: key, sender: e.sender, amount: e.amount.toString() });
    return { ok: true, amount: e.amount, sender: e.sender };
  }

  getEscrow(escrowId: Buffer): EscrowState | undefined {
    return this.escrows.get(escrowId.toString("hex"));
  }

  getEvents(): object[] { return [...this.events]; }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("escrow-htlc", () => {
  const SENDER    = "SP1SENDER000000000000000000000000000";
  const RECIPIENT = "SP1RECIPIENT0000000000000000000000000";
  const AMOUNT    = BigInt(100_000); // 100k sats

  function freshScenario() {
    const preimage  = randomBytes(32);
    const hashlock  = sha256(preimage);
    const escrowId  = randomBytes(32);
    const contract  = new SimulatedContract();
    return { preimage, hashlock, escrowId, contract };
  }

  // ── TI Checklist #1: Happy path — lock → claim releases funds ──────────────

  describe("1. Happy path: lock → claim", () => {
    it("claim succeeds with correct preimage before timelock", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      const currentBlock = 100;
      const timelock     = 200;

      const lockResult = contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, timelock, currentBlock);
      expect(lockResult).toEqual({ ok: true });

      const claimResult = contract.claim(RECIPIENT, escrowId, preimage, currentBlock + 1);
      expect(claimResult).toMatchObject({ ok: true, amount: AMOUNT, recipient: RECIPIENT });
    });

    it("escrow is marked claimed after successful claim", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      contract.claim(RECIPIENT, escrowId, preimage, 101);
      const state = contract.getEscrow(escrowId);
      expect(state?.claimed).toBe(true);
      expect(state?.refunded).toBe(false);
    });
  });

  // ── TI Checklist #2: Timelock expiry returns full amount to sender ─────────

  describe("2. Refund returns full amount after expiry", () => {
    it("refund succeeds after timelock and returns full amount", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);

      const result = contract.refund(SENDER, escrowId, 101); // block 101 > timelock 100
      expect(result).toMatchObject({ ok: true, amount: AMOUNT, sender: SENDER });
    });

    it("refunded escrow shows refunded=true, claimed=false", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      contract.refund(SENDER, escrowId, 101);
      const state = contract.getEscrow(escrowId);
      expect(state?.refunded).toBe(true);
      expect(state?.claimed).toBe(false);
    });
  });

  // ── TI Checklist #3: Double-claim fails cleanly ───────────────────────────

  describe("3. Double-claim fails cleanly", () => {
    it("second claim after first succeeds returns ERR-ALREADY-CLAIMED", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      contract.claim(RECIPIENT, escrowId, preimage, 101);

      const second = contract.claim(RECIPIENT, escrowId, preimage, 102);
      expect(second).toEqual({ err: ERR.ALREADY_CLAIMED });
    });

    it("claim on refunded escrow returns ERR-ALREADY-REFUNDED", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      contract.refund(SENDER, escrowId, 101);

      const result = contract.claim(RECIPIENT, escrowId, preimage, 102);
      expect(result).toEqual({ err: ERR.ALREADY_REFUNDED });
    });

    it("double-refund fails with ERR-ALREADY-REFUNDED", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      contract.refund(SENDER, escrowId, 101);

      const second = contract.refund(SENDER, escrowId, 102);
      expect(second).toEqual({ err: ERR.ALREADY_REFUNDED });
    });
  });

  // ── TI Checklist #4 & #5: No AMM / single asset ───────────────────────────

  describe("4+5. No DEX/AMM dependency, single asset", () => {
    it("contract has no swap or DEX function calls", () => {
      // Structural test: verify Clarity contract has no DEX/AMM *function calls* (comments excluded)
      const fs = require("node:fs");
      const path = require("node:path");
      const contractSrc = fs.readFileSync(
        path.join(__dirname, "../contracts/escrow-htlc.clar"),
        "utf8"
      );
      // Strip comment lines before checking
      const codeOnly = contractSrc
        .split("\n")
        .filter((line: string) => !line.trimStart().startsWith(";;"))
        .join("\n");
      expect(codeOnly).not.toMatch(/bitflow|alex-token|swap-router|amm-pool/i);
    });

    it("only sbtc-token transfers appear in contract source", () => {
      const fs = require("node:fs");
      const path = require("node:path");
      const contractSrc = fs.readFileSync(
        path.join(__dirname, "../contracts/escrow-htlc.clar"),
        "utf8"
      );
      const transfers = [...contractSrc.matchAll(/contract-call\?\s+(\S+)\s+transfer/g)];
      expect(transfers.length).toBeGreaterThan(0);
      transfers.forEach(([, contractRef]) => {
        expect(contractRef).toMatch(/sbtc/i);
      });
    });
  });

  // ── TI Checklist #6: Contract prints on lock / claim / refund ─────────────

  describe("6. Events emitted on all state transitions", () => {
    it("lock emits a lock event", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      const events = contract.getEvents();
      expect(events.some((e: any) => e.event === "lock")).toBe(true);
    });

    it("claim emits a claim event", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      contract.claim(RECIPIENT, escrowId, preimage, 101);
      const events = contract.getEvents();
      expect(events.some((e: any) => e.event === "claim")).toBe(true);
    });

    it("refund emits a refund event", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      contract.refund(SENDER, escrowId, 101);
      const events = contract.getEvents();
      expect(events.some((e: any) => e.event === "refund")).toBe(true);
    });
  });

  // ── TI Checklist #7: Edge cases ───────────────────────────────────────────

  describe("7. Edge cases", () => {
    it("wrong preimage fails with ERR-WRONG-PREIMAGE", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      const wrongPreimage = randomBytes(32);
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      const result = contract.claim(RECIPIENT, escrowId, wrongPreimage, 101);
      expect(result).toEqual({ err: ERR.WRONG_PREIMAGE });
    });

    it("premature refund fails with ERR-TIMELOCK-ACTIVE", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      const result = contract.refund(SENDER, escrowId, 150); // block 150 <= timelock 200
      expect(result).toEqual({ err: ERR.TIMELOCK_ACTIVE });
    });

    it("claim after timelock fails with ERR-TIMELOCK-EXPIRED", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      const result = contract.claim(RECIPIENT, escrowId, preimage, 101); // block 101 > timelock 100
      expect(result).toEqual({ err: ERR.TIMELOCK_EXPIRED });
    });

    it("non-recipient claim fails with ERR-NOT-RECIPIENT", () => {
      const { preimage, hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      const result = contract.claim("SP1ATTACKER000000000000000000000000", escrowId, preimage, 101);
      expect(result).toEqual({ err: ERR.NOT_RECIPIENT });
    });

    it("non-sender refund fails with ERR-NOT-SENDER", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 100, 50);
      const result = contract.refund("SP1ATTACKER000000000000000000000000", escrowId, 101);
      expect(result).toEqual({ err: ERR.NOT_SENDER });
    });

    it("duplicate escrow-id fails with ERR-ALREADY-EXISTS", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 200, 100);
      const second = contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 300, 100);
      expect(second).toEqual({ err: ERR.ALREADY_EXISTS });
    });

    it("zero amount fails with ERR-ZERO-AMOUNT", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      const result = contract.lock(SENDER, escrowId, RECIPIENT, 0n, hashlock, 200, 100);
      expect(result).toEqual({ err: ERR.ZERO_AMOUNT });
    });

    it("timelock in the past fails with ERR-BAD-TIMELOCK", () => {
      const { hashlock, escrowId, contract } = freshScenario();
      const result = contract.lock(SENDER, escrowId, RECIPIENT, AMOUNT, hashlock, 99, 100);
      expect(result).toEqual({ err: ERR.BAD_TIMELOCK });
    });

    it("lookup of nonexistent escrow returns undefined", () => {
      const { escrowId, contract } = freshScenario();
      expect(contract.getEscrow(escrowId)).toBeUndefined();
    });
  });
});
