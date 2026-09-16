/**
 * PoX-5 stacking.
 *
 * PoX-5 replaced pox-4 at reward cycle 141 on mainnet, and it is not a rename:
 *
 * - Every stake names a SIGNER MANAGER, a contract implementing pox-5's
 *   `signer-manager-trait`. There is no pool delegation (`delegate-stx`) and no
 *   PoX reward address on the stake itself; the manager's `validate-stake!`
 *   decides who may join and reads any payout preferences out of
 *   `signer-calldata`.
 * - Rewards are paid in sBTC to the signer manager, not the staker. Getting a
 *   staker paid takes the manager pulling its share out of pox-5
 *   (`manager.claim-rewards`) and then paying the staker
 *   (`manager.claim-staker-rewards`). Each manager implements that second step
 *   its own way, and some pay out off-chain, so the claim path is read from the
 *   manager's interface rather than assumed.
 * - `stake`, `stake-update` and `unstake` are refused during the prepare phase
 *   (the last `prepare-cycle-length` blocks of a cycle).
 *
 * Locking STX is not a transfer, so these calls carry pox-5's own post-condition
 * types (a staking lock amount, or "performs PoX") rather than STX transfer
 * conditions.
 *
 * Every write first confirms pox-5 is still the network's active PoX contract,
 * so a future PoX version refuses before signing instead of aborting on chain.
 *
 * Ported from aibtcdev/aibtc-mcp-server#682; keep the two in step.
 */

import {
  ClarityValue,
  Pc,
  PostConditionMode,
  bufferCV,
  contractPrincipalCV,
  cvToJSON,
  hexToCV,
  listCV,
  noneCV,
  principalCV,
  serializeCV,
  someCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { HiroApiService, getHiroApi } from "./hiro-api.js";
import { getContracts, parseContractId, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";

// ============================================================================
// Constants mirrored from pox-5
// ============================================================================

/** pox-5 `MAX_NUM_CYCLES`. */
export const MAX_STAKE_CYCLES = 96;

/** Hard stop when walking the signer-set linked list. */
const MAX_SIGNERS_WALKED = 200;


// ============================================================================
// Types
// ============================================================================

export interface PoxState {
  contractId: string;
  burnHeight: number;
  rewardCycle: number;
  firstBurnHeight: number;
  rewardCycleLength: number;
  prepareCycleLength: number;
  /** Burn height where the next reward cycle begins. */
  nextCycleStartHeight: number;
  /** Burn height where this cycle's prepare phase begins. */
  preparePhaseStartHeight: number;
  inPreparePhase: boolean;
  /** Minimum a signer needs delegated to join the signer set (not a per-staker minimum). */
  signerSetMinUstx: bigint;
  totalLiquidSupplyUstx: bigint;
}

export interface StakerInfo {
  amountUstx: bigint;
  firstRewardCycle: number;
  numCycles: number;
  /** First cycle in which the STX is unlocked. */
  unlockCycle: number;
  unlockBurnHeight: number;
  signerManager: string;
}

export interface BondMembership {
  bondIndex: number;
  amountUstx: bigint;
  amountSats: bigint;
  isL1Lock: boolean;
  signerManager: string;
}

export interface StakingStatus {
  address: string;
  pox: PoxState;
  staking: StakerInfo | null;
  bond: BondMembership | null;
  account: {
    balanceUstx: bigint;
    lockedUstx: bigint;
    unlockedUstx: bigint;
    burnchainUnlockHeight: number;
  };
}

export interface SignerSetEntry {
  signerManager: string;
  delegatedUstx: bigint;
}

/**
 * How a signer manager pays its stakers, read from its public interface.
 * - `staker-arg`: `claim-staker-rewards(staker, reward-cycle, bond-index)`, callable by anyone
 * - `caller`:     `claim-staker-rewards(reward-cycle, bond-index)`, pays the caller
 * - `none`:       no on-chain staker claim (the manager pays off-chain, or not at all)
 */
export type ClaimStyle = "staker-arg" | "caller" | "none";

export interface StakeOptions {
  signerManager: string;
  amountUstx: bigint;
  numCycles: number;
  signerCalldata?: Uint8Array;
}

export interface UpdateStakeOptions {
  /** New signer manager; defaults to the current one. */
  signerManager?: string;
  cyclesToExtend: number;
  amountIncreaseUstx: bigint;
  signerCalldata?: Uint8Array;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Decode a Clarity value to plain JS: tuples to objects, lists to arrays,
 * optionals to value-or-null, responses to their inner value, uints to strings.
 * (`cvToValue` only unwraps the outermost layer.)
 */
function plain(cv: ClarityValue): unknown {
  const unwrap = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(unwrap);
    const n = node as { type?: string; value?: unknown };
    if (typeof n.type === "string" && "value" in n) {
      if (n.type.startsWith("(optional") && n.value === null) return null;
      return unwrap(n.value);
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, unwrap(v)]));
  };
  return unwrap(cvToJSON(cv));
}

function toNumber(v: unknown): number {
  return Number(v as bigint | number | string);
}

function toBigInt(v: unknown): bigint {
  return BigInt(v as bigint | number | string);
}

function assertContractId(id: string, label: string): void {
  if (!/^S[PMTN][0-9A-Z]{28,40}\.[a-zA-Z][a-zA-Z0-9-_]{0,39}$/.test(id)) {
    throw new Error(`${label} must be a contract id like SP....name, got "${id}"`);
  }
}

function contractCV(id: string): ClarityValue {
  const { address, name } = parseContractId(id);
  return contractPrincipalCV(address, name);
}

function calldataCV(calldata?: Uint8Array): ClarityValue {
  if (!calldata) return noneCV();
  if (calldata.length > 500) {
    throw new Error(`signer calldata is ${calldata.length} bytes; pox-5 accepts at most 500`);
  }
  return someCV(bufferCV(calldata));
}

/**
 * Payout calldata in the shape reference signer managers decode:
 * `{ pox-addr: { version, hashbytes }, max-fee }`. Managers derived from the
 * pox-5 reference implementation use it to pay rewards to a Bitcoin address via
 * an sBTC withdrawal, capped at `max-fee` sats of withdrawal fee. Whether a given
 * manager accepts it is up to that manager's `validate-stake!`.
 */
export function buildPayoutCalldata(
  poxAddr: { version: number; hashbytesHex: string },
  maxFeeSats: bigint
): Uint8Array {
  const serialized = serializeCV(
    tupleCV({
      "pox-addr": tupleCV({
        version: bufferCV(Uint8Array.from([poxAddr.version])),
        hashbytes: bufferCV(Buffer.from(poxAddr.hashbytesHex, "hex")),
      }),
      "max-fee": uintCV(maxFeeSats),
    })
  );
  return typeof serialized === "string"
    ? Uint8Array.from(Buffer.from(serialized, "hex"))
    : serialized;
}


/** Raised by writes when the network's active PoX contract is not the one this service targets. */
export class PoxVersionUnsupportedError extends Error {
  constructor(
    public readonly activePoxContract: string,
    public readonly supportedPoxContract: string
  ) {
    super(
      `Stacking writes are disabled: this network's active PoX contract is ${activePoxContract}, ` +
        `but this skill targets ${supportedPoxContract}. No transaction was sent.`
    );
    this.name = "PoxVersionUnsupportedError";
  }
}

// ============================================================================
// Service
// ============================================================================

/** Test seam: replace the Stacks API client and the contract-call builder. */
export interface StackingServiceDeps {
  hiro?: Pick<
    HiroApiService,
    "callReadOnlyFunction" | "getCoreApiInfo" | "getStxBalance" | "getContractInterface" | "getPoxInfo"
  >;
  callContract?: typeof callContract;
}

export class StackingService {
  private hiro: NonNullable<StackingServiceDeps["hiro"]>;
  private call: typeof callContract;
  private poxContract: string;

  constructor(
    private network: Network,
    deps: StackingServiceDeps = {}
  ) {
    this.hiro = deps.hiro ?? getHiroApi(network);
    this.call = deps.callContract ?? callContract;
    this.poxContract = getContracts(network).POX_5;
  }

  get contractId(): string {
    return this.poxContract;
  }

  private async read(
    contractId: string,
    functionName: string,
    args: ClarityValue[] = []
  ): Promise<unknown> {
    const sender = parseContractId(this.poxContract).address;
    const result = await this.hiro.callReadOnlyFunction(contractId, functionName, args, sender);
    if (!result.okay || !result.result) {
      throw new Error(`${contractId}::${functionName} failed: ${result.cause ?? "no result"}`);
    }
    return plain(hexToCV(result.result));
  }

  private readPox(functionName: string, args: ClarityValue[] = []): Promise<unknown> {
    return this.read(this.poxContract, functionName, args);
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  async getPoxState(): Promise<PoxState> {
    const [info, core] = await Promise.all([
      this.readPox("get-pox-info") as Promise<Record<string, unknown>>,
      this.hiro.getCoreApiInfo(),
    ]);
    const firstBurnHeight = toNumber(info["first-burnchain-block-height"]);
    const rewardCycleLength = toNumber(info["reward-cycle-length"]);
    const prepareCycleLength = toNumber(info["prepare-cycle-length"]);
    const burnHeight = core.burn_block_height;
    // Mirrors pox-5 burn-height-to-reward-cycle / reward-cycle-to-burn-height.
    const rewardCycle = Math.floor((burnHeight - firstBurnHeight) / rewardCycleLength);
    const nextCycleStartHeight = firstBurnHeight + (rewardCycle + 1) * rewardCycleLength;
    const preparePhaseStartHeight = nextCycleStartHeight - prepareCycleLength;

    return {
      contractId: this.poxContract,
      burnHeight,
      rewardCycle,
      firstBurnHeight,
      rewardCycleLength,
      prepareCycleLength,
      nextCycleStartHeight,
      preparePhaseStartHeight,
      inPreparePhase: burnHeight >= preparePhaseStartHeight,
      signerSetMinUstx: toBigInt(info["min-amount-ustx"]),
      totalLiquidSupplyUstx: toBigInt(info["total-liquid-supply-ustx"]),
    };
  }

  private rewardCycleStartHeight(pox: PoxState, cycle: number): number {
    return pox.firstBurnHeight + cycle * pox.rewardCycleLength;
  }

  async getStakerInfo(address: string, pox?: PoxState): Promise<StakerInfo | null> {
    const raw = (await this.readPox("get-staker-info", [principalCV(address)])) as Record<
      string,
      unknown
    > | null;
    if (!raw) return null;
    const state = pox ?? (await this.getPoxState());
    const firstRewardCycle = toNumber(raw["first-reward-cycle"]);
    const numCycles = toNumber(raw["num-cycles"]);
    const unlockCycle = firstRewardCycle + numCycles;
    return {
      amountUstx: toBigInt(raw["amount-ustx"]),
      firstRewardCycle,
      numCycles,
      unlockCycle,
      unlockBurnHeight: this.rewardCycleStartHeight(state, unlockCycle),
      signerManager: String(raw["signer"]),
    };
  }

  async getBondMembership(address: string): Promise<BondMembership | null> {
    const raw = (await this.readPox("get-bond-membership", [principalCV(address)])) as Record<
      string,
      unknown
    > | null;
    if (!raw) return null;
    return {
      bondIndex: toNumber(raw["bond-index"]),
      amountUstx: toBigInt(raw["amount-ustx"]),
      amountSats: toBigInt(raw["amount-sats"]),
      isL1Lock: Boolean(raw["is-l1-lock"]),
      signerManager: String(raw["signer"]),
    };
  }

  async getStakingStatus(address: string): Promise<StakingStatus> {
    const pox = await this.getPoxState();
    const [staking, bond, balance] = await Promise.all([
      this.getStakerInfo(address, pox),
      this.getBondMembership(address),
      this.hiro.getStxBalance(address),
    ]);
    const balanceUstx = BigInt(balance.balance);
    const lockedUstx = BigInt(balance.locked);
    return {
      address,
      pox,
      staking,
      bond,
      account: {
        balanceUstx,
        lockedUstx,
        unlockedUstx: balanceUstx - lockedUstx,
        burnchainUnlockHeight: balance.burnchain_unlock_height,
      },
    };
  }

  /** Whether pox-5 has a signer key registered for this manager. */
  async isRegisteredSigner(signerManager: string): Promise<boolean> {
    const key = await this.readPox("get-signer-info", [contractCV(signerManager)]);
    return key !== null;
  }

  /** Walk pox-5's signer-set linked list for a reward cycle. */
  async getSignerSet(cycle: number): Promise<SignerSetEntry[]> {
    const entries: SignerSetEntry[] = [];
    let next = (await this.readPox("get-signer-set-first-item-for-cycle", [
      uintCV(cycle),
    ])) as string | null;

    while (next !== null && entries.length < MAX_SIGNERS_WALKED) {
      const signer = next;
      const delegated = await this.readPox("get-amount-delegated-for-signer", [
        principalCV(signer),
        uintCV(cycle),
      ]);
      entries.push({ signerManager: signer, delegatedUstx: toBigInt(delegated) });
      next = (await this.readPox("get-signer-set-next-item-for-cycle", [
        principalCV(signer),
        uintCV(cycle),
      ])) as string | null;
    }
    return entries;
  }

  async getClaimStyle(signerManager: string): Promise<ClaimStyle> {
    const iface = await this.hiro.getContractInterface(signerManager);
    const fn = iface.functions.find(
      (f) => f.name === "claim-staker-rewards" && f.access === "public"
    );
    if (!fn) return "none";
    const names = fn.args.map((a) => a.name);
    if (names.length === 3 && names[0] === "staker" && names[1] === "reward-cycle") {
      return "staker-arg";
    }
    if (names.length === 2 && names[0] === "reward-cycle") {
      return "caller";
    }
    return "none";
  }

  /** sBTC the staker has earned from this signer for a cycle and not yet claimed (before manager fees). */
  async getStakerUnclaimedRewards(
    signerManager: string,
    rewardCycle: number,
    staker: string
  ): Promise<bigint> {
    return toBigInt(
      await this.readPox("get-earned-staker-rewards", [
        principalCV(signerManager),
        uintCV(rewardCycle),
        noneCV(),
        principalCV(staker),
      ])
    );
  }

  /** sBTC pox-5 still holds for the signer manager for a cycle (not yet pulled by the manager). */
  async getSignerUnpulledRewards(signerManager: string, rewardCycle: number): Promise<bigint> {
    return toBigInt(
      await this.readPox("get-earned", [principalCV(signerManager), uintCV(rewardCycle), noneCV()])
    );
  }

  // --------------------------------------------------------------------------
  // Writes
  // --------------------------------------------------------------------------

  /** Refuse to sign unless pox-5 is the network's active PoX contract. */
  private async assertPox5Active(): Promise<void> {
    let active: string;
    try {
      active = (await this.hiro.getPoxInfo()).contract_id;
    } catch (error) {
      throw new Error(
        `Could not confirm the active PoX contract from the Stacks API ` +
          `(${error instanceof Error ? error.message : String(error)}). No transaction was sent.`
      );
    }
    if (active !== this.poxContract) {
      throw new PoxVersionUnsupportedError(active || "(unknown)", this.poxContract);
    }
  }

  private assertNotPreparePhase(pox: PoxState, action: string): void {
    if (pox.inPreparePhase) {
      throw new Error(
        `pox-5 refuses ${action} during the prepare phase. Burn height ${pox.burnHeight} is inside ` +
          `the prepare phase that started at ${pox.preparePhaseStartHeight}; try again at or after ` +
          `burn height ${pox.nextCycleStartHeight} (reward cycle ${pox.rewardCycle + 1}).`
      );
    }
  }

  async stake(account: Account, options: StakeOptions): Promise<TransferResult & { pox: PoxState; unlockCycle: number; unlockBurnHeight: number }> {
    const { signerManager, amountUstx, numCycles, signerCalldata } = options;
    assertContractId(signerManager, "signerManager");
    if (amountUstx <= 0n) throw new Error("amount must be greater than zero");
    if (!Number.isInteger(numCycles) || numCycles < 1 || numCycles > MAX_STAKE_CYCLES) {
      throw new Error(`numCycles must be an integer between 1 and ${MAX_STAKE_CYCLES}`);
    }

    await this.assertPox5Active();
    const status = await this.getStakingStatus(account.address);
    const { pox } = status;
    this.assertNotPreparePhase(pox, "stake");
    if (status.staking) {
      throw new Error(
        `${account.address} is already staking ${status.staking.amountUstx} uSTX with ` +
          `${status.staking.signerManager}. Use extend_stacking to extend, increase or switch signer.`
      );
    }
    // pox-5 counts locked + unlocked STX (a bond rolling over into a stake is still locked).
    if (status.account.balanceUstx < amountUstx) {
      throw new Error(
        `Insufficient STX: ${status.account.balanceUstx} uSTX total, ${amountUstx} uSTX requested.`
      );
    }
    if (!(await this.isRegisteredSigner(signerManager))) {
      throw new Error(
        `${signerManager} is not a registered pox-5 signer manager. Use list_stacking_signers to pick one.`
      );
    }

    const { address, name } = parseContractId(this.poxContract);
    const result = await this.call(account, {
      contractAddress: address,
      contractName: name,
      functionName: "stake",
      functionArgs: [
        contractCV(signerManager),
        uintCV(amountUstx),
        uintCV(numCycles),
        // Any height in the current cycle makes the next cycle the first reward cycle.
        uintCV(pox.burnHeight),
        calldataCV(signerCalldata),
      ],
      postConditionMode: PostConditionMode.Deny,
      postConditions: [Pc.principal(account.address).willSendEq(amountUstx).ustxToLock()],
    });

    const unlockCycle = pox.rewardCycle + 1 + numCycles;
    return {
      ...result,
      pox,
      unlockCycle,
      unlockBurnHeight: this.rewardCycleStartHeight(pox, unlockCycle),
    };
  }

  async updateStake(
    account: Account,
    options: UpdateStakeOptions
  ): Promise<TransferResult & { previous: StakerInfo; newAmountUstx: bigint; signerManager: string; unlockCycle: number; unlockBurnHeight: number }> {
    const { cyclesToExtend, amountIncreaseUstx, signerCalldata } = options;
    if (!Number.isInteger(cyclesToExtend) || cyclesToExtend < 0) {
      throw new Error("cyclesToExtend must be a non-negative integer");
    }
    if (amountIncreaseUstx < 0n) throw new Error("amountIncrease must not be negative");

    await this.assertPox5Active();
    const status = await this.getStakingStatus(account.address);
    const { pox } = status;
    const current = status.staking;
    if (!current) {
      throw new Error(`${account.address} is not staking. Use stack_stx to start.`);
    }
    this.assertNotPreparePhase(pox, "stake-update");

    const signerManager = options.signerManager ?? current.signerManager;
    assertContractId(signerManager, "signerManager");
    if (
      cyclesToExtend === 0 &&
      amountIncreaseUstx === 0n &&
      signerManager === current.signerManager &&
      !signerCalldata
    ) {
      throw new Error("Nothing to update: pass cyclesToExtend, amountIncrease, a new signerManager or payout calldata.");
    }

    const unlockCycle = current.unlockCycle + cyclesToExtend;
    // pox-5 recomputes num-cycles from the next cycle to the unlock cycle.
    const numCycles = unlockCycle - pox.rewardCycle - 1;
    if (numCycles < 1 || numCycles > MAX_STAKE_CYCLES) {
      throw new Error(
        `The lock would run ${numCycles} cycles from the next cycle; pox-5 allows 1 to ${MAX_STAKE_CYCLES}.`
      );
    }
    if (status.account.unlockedUstx < amountIncreaseUstx) {
      throw new Error(
        `Insufficient unlocked STX: ${status.account.unlockedUstx} uSTX unlocked, ${amountIncreaseUstx} uSTX requested.`
      );
    }
    if (signerManager !== current.signerManager && !(await this.isRegisteredSigner(signerManager))) {
      throw new Error(
        `${signerManager} is not a registered pox-5 signer manager. Use list_stacking_signers to pick one.`
      );
    }

    const newAmountUstx = current.amountUstx + amountIncreaseUstx;
    const { address, name } = parseContractId(this.poxContract);
    const result = await this.call(account, {
      contractAddress: address,
      contractName: name,
      functionName: "stake-update",
      functionArgs: [
        contractCV(signerManager),
        contractCV(current.signerManager),
        uintCV(cyclesToExtend),
        uintCV(amountIncreaseUstx),
        calldataCV(signerCalldata),
      ],
      postConditionMode: PostConditionMode.Deny,
      // The staking condition is on the resulting total lock, not the increment.
      postConditions: [Pc.principal(account.address).willSendEq(newAmountUstx).ustxToLock()],
    });

    return {
      ...result,
      previous: current,
      newAmountUstx,
      signerManager,
      unlockCycle,
      unlockBurnHeight: this.rewardCycleStartHeight(pox, unlockCycle),
    };
  }

  async unstake(
    account: Account
  ): Promise<TransferResult & { previous: StakerInfo; unlockCycle: number; unlockBurnHeight: number }> {
    await this.assertPox5Active();
    const status = await this.getStakingStatus(account.address);
    const { pox } = status;
    const current = status.staking;
    if (!current) {
      throw new Error(`${account.address} is not staking.`);
    }
    this.assertNotPreparePhase(pox, "unstake");
    if (current.unlockCycle <= pox.rewardCycle + 1) {
      throw new Error(
        `This stake already unlocks at the start of cycle ${current.unlockCycle} ` +
          `(burn height ${current.unlockBurnHeight}); unstaking would not unlock it sooner.`
      );
    }

    const { address, name } = parseContractId(this.poxContract);
    const result = await this.call(account, {
      contractAddress: address,
      contractName: name,
      functionName: "unstake",
      functionArgs: [contractCV(current.signerManager)],
      postConditionMode: PostConditionMode.Deny,
      postConditions: [Pc.origin().willPerformPox()],
    });

    const unlockCycle = pox.rewardCycle + 1;
    return {
      ...result,
      previous: current,
      unlockCycle,
      unlockBurnHeight: this.rewardCycleStartHeight(pox, unlockCycle),
    };
  }

  /**
   * Have the signer manager pull its STX-staking rewards for a cycle out of pox-5.
   * Permissionless on reference managers. An empty bond-period list claims the
   * STX-staker bucket only, which is all an STX staker's payout draws on.
   */
  async pullSignerRewards(
    account: Account,
    signerManager: string,
    rewardCycle: number,
    unpulledSats: bigint
  ): Promise<TransferResult> {
    await this.assertPox5Active();
    const { address, name } = parseContractId(signerManager);
    const sbtc = getContracts(this.network).SBTC_TOKEN as `${string}.${string}`;
    return this.call(account, {
      contractAddress: address,
      contractName: name,
      functionName: "claim-rewards",
      functionArgs: [
        listCV([]),
        uintCV(rewardCycle),
      ],
      postConditionMode: PostConditionMode.Deny,
      // pox-5 pays the manager; more may have accrued by the time this mines.
      postConditions: [Pc.principal(this.poxContract as `${string}.${string}`).willSendGte(unpulledSats).ft(sbtc, "sbtc-token")],
    });
  }

  /** Pay this staker their share of a cycle's rewards through the signer manager. */
  async claimStakerRewards(
    account: Account,
    signerManager: string,
    rewardCycle: number,
    style: Exclude<ClaimStyle, "none">
  ): Promise<TransferResult> {
    await this.assertPox5Active();
    const { address, name } = parseContractId(signerManager);
    const sbtc = getContracts(this.network).SBTC_TOKEN as `${string}.${string}`;
    const args =
      style === "staker-arg"
        ? [principalCV(account.address), uintCV(rewardCycle), noneCV()]
        : [uintCV(rewardCycle), noneCV()];
    return this.call(account, {
      contractAddress: address,
      contractName: name,
      functionName: "claim-staker-rewards",
      functionArgs: args,
      postConditionMode: PostConditionMode.Deny,
      // The manager sends sBTC to the staker (or into an sBTC withdrawal to their
      // BTC address). Fees and earlier settled balances make the exact amount
      // manager-specific; nothing may leave the caller.
      postConditions: [Pc.principal(signerManager as `${string}.${string}`).willSendGte(1).ft(sbtc, "sbtc-token")],
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

let _stackingServiceInstance: StackingService | null = null;

export function getStackingService(network: Network): StackingService {
  if (!_stackingServiceInstance || _stackingServiceInstance["network"] !== network) {
    _stackingServiceInstance = new StackingService(network);
  }
  return _stackingServiceInstance;
}
