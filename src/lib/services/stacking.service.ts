import {
  ClarityValue,
  uintCV,
  tupleCV,
  bufferCV,
  noneCV,
  someCV,
  principalCV,
  hexToCV,
  cvToValue,
} from "@stacks/transactions";
import { HiroApiService, getHiroApi, PoxInfo } from "./hiro-api.js";
import { getContracts, parseContractId, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";
import { createStxPostCondition } from "../transactions/post-conditions.js";

// ============================================================================
// Types
// ============================================================================

export interface StackingStatus {
  stacked: boolean;
  amountMicroStx: string;
  amountStx: string;
  firstRewardCycle: number;
  lockPeriod: number;
  unlockHeight: number;
  poxAddress?: string;
  /** The PoX contract the network currently runs (from /v2/pox). */
  activePoxContract?: string;
  /** pox-5 only: the signer the STX is staked with. */
  signer?: string;
  /** Set when the result comes with a caveat the caller should surface. */
  warning?: string;
}

/**
 * Raised by write operations when the network no longer runs pox-4. pox-5
 * (Epoch 4.0) removed stack-stx, stack-extend, stack-increase, delegate-stx
 * and revoke-delegate-stx in favour of signer-manager staking (stake,
 * stake-update, unstake), so building these calls would only broadcast a
 * transaction that aborts and still costs the fee.
 */
export class PoxVersionUnsupportedError extends Error {
  constructor(public readonly activePoxContract: string) {
    super(
      `Stacking writes are disabled: this network's active PoX contract is ${activePoxContract}, ` +
        `but this skill only supports pox-4. pox-5 replaced stack-stx / stack-extend / stack-increase / ` +
        `delegate-stx / revoke-delegate-stx with signer-manager staking (stake, stake-update, unstake), ` +
        `which this skill does not implement yet. No transaction was sent.`
    );
    this.name = "PoxVersionUnsupportedError";
  }
}

// ============================================================================
// Stacking Service
// ============================================================================

export class StackingService {
  private hiro: HiroApiService;
  private contracts: ReturnType<typeof getContracts>;

  constructor(private network: Network) {
    this.hiro = getHiroApi(network);
    this.contracts = getContracts(network);
  }

  /**
   * Get current PoX (Proof of Transfer) info
   */
  async getPoxInfo(): Promise<PoxInfo> {
    return this.hiro.getPoxInfo();
  }

  /**
   * Refuse a write unless the network's active PoX contract is the pox-4 this
   * service builds calls for. Fails closed: if the active contract cannot be
   * read, nothing is signed.
   */
  private async assertPox4Active(): Promise<void> {
    let active: string;
    try {
      active = (await this.hiro.getPoxInfo()).contract_id;
    } catch (error) {
      throw new Error(
        `Could not confirm the active PoX contract from the Stacks API ` +
          `(${error instanceof Error ? error.message : String(error)}). No transaction was sent.`
      );
    }
    if (active !== this.contracts.POX_4) {
      throw new PoxVersionUnsupportedError(active || "(unknown)");
    }
  }

  /**
   * Get stacking status for an address
   * Note: Returns whether the address is stacking, but detailed amounts require proper CV parsing
   */
  async getStackingStatus(address: string): Promise<StackingStatus> {
    let active: string | undefined;
    try {
      active = (await this.hiro.getPoxInfo()).contract_id;
    } catch {
      // Unknown: fall back to the pox-4 read below.
    }
    if (active && active !== this.contracts.POX_4) {
      return this.getPox5StakingStatus(address, active);
    }

    try {
      const result = await this.hiro.callReadOnlyFunction(
        this.contracts.POX_4,
        "get-stacker-info",
        [{ type: "principal", value: address } as unknown as ClarityValue],
        address
      );

      if (result.okay && result.result) {
        const isStacked = result.result.includes("some");
        return {
          stacked: isStacked,
          amountMicroStx: "0", // Requires CV parsing
          amountStx: "0",
          firstRewardCycle: 0,
          lockPeriod: 0,
          unlockHeight: 0,
        };
      }
    } catch {
      // Stacker info not found
    }

    return {
      stacked: false,
      amountMicroStx: "0",
      amountStx: "0",
      firstRewardCycle: 0,
      lockPeriod: 0,
      unlockHeight: 0,
    };
  }

  /**
   * Status under pox-5, read from `get-staker-info`:
   * (optional { amount-ustx, first-reward-cycle, num-cycles, signer }).
   * Anything unexpected throws rather than reporting "not stacking".
   */
  private async getPox5StakingStatus(address: string, poxContract: string): Promise<StackingStatus> {
    const result = await this.hiro.callReadOnlyFunction(
      poxContract,
      "get-staker-info",
      [principalCV(address)],
      address
    );
    if (!result.okay || !result.result) {
      throw new Error(`${poxContract} get-staker-info failed: ${result.cause ?? "no result"}`);
    }
    const info = cvToValue(hexToCV(result.result)) as
      | { value?: Record<string, { value: string } | undefined> }
      | null;
    const tuple = info?.value;
    const base = { activePoxContract: poxContract, unlockHeight: 0 };
    if (!tuple) {
      return { ...base, stacked: false, amountMicroStx: "0", amountStx: "0", firstRewardCycle: 0, lockPeriod: 0 };
    }
    const amount = BigInt(tuple["amount-ustx"]?.value ?? "0");
    return {
      ...base,
      stacked: true,
      amountMicroStx: amount.toString(),
      amountStx: formatUstx(amount),
      firstRewardCycle: Number(tuple["first-reward-cycle"]?.value ?? 0),
      lockPeriod: Number(tuple["num-cycles"]?.value ?? 0),
      signer: tuple.signer?.value,
      warning: "unlockHeight is not reported for pox-5 positions.",
    };
  }


  /**
   * Stack STX tokens
   */
  async stack(
    account: Account,
    amount: bigint,
    poxAddress: { version: number; hashbytes: string },
    startBurnHeight: number,
    lockPeriod: number
  ): Promise<TransferResult> {
    await this.assertPox4Active();
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.POX_4);

    const functionArgs: ClarityValue[] = [
      uintCV(amount),
      tupleCV({
        version: bufferCV(Buffer.from([poxAddress.version])),
        hashbytes: bufferCV(Buffer.from(poxAddress.hashbytes, "hex")),
      }),
      uintCV(startBurnHeight),
      uintCV(lockPeriod),
    ];

    // Add post condition: sender must lock exactly `amount` of STX
    const postCondition = createStxPostCondition(
      account.address,
      "eq",
      amount
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "stack-stx",
      functionArgs,
      postConditions: [postCondition],
    });
  }

  /**
   * Extend stacking period
   */
  async extendStacking(
    account: Account,
    extendCount: number,
    poxAddress: { version: number; hashbytes: string }
  ): Promise<TransferResult> {
    await this.assertPox4Active();
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.POX_4);

    const functionArgs: ClarityValue[] = [
      uintCV(extendCount),
      tupleCV({
        version: bufferCV(Buffer.from([poxAddress.version])),
        hashbytes: bufferCV(Buffer.from(poxAddress.hashbytes, "hex")),
      }),
    ];

    // No assets moved from sender (extends existing lock period)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "stack-extend",
      functionArgs,
      postConditions: [],
    });
  }

  /**
   * Increase stacking amount
   */
  async increaseStacking(
    account: Account,
    increaseAmount: bigint
  ): Promise<TransferResult> {
    await this.assertPox4Active();
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.POX_4);

    const functionArgs: ClarityValue[] = [uintCV(increaseAmount)];

    // Add post condition: sender must lock exactly `increaseAmount` of additional STX
    const postCondition = createStxPostCondition(
      account.address,
      "eq",
      increaseAmount
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "stack-increase",
      functionArgs,
      postConditions: [postCondition],
    });
  }

  /**
   * Delegate STX to a stacking pool
   */
  async delegateStx(
    account: Account,
    amount: bigint,
    delegateTo: string,
    untilBurnHeight?: number,
    poxAddress?: { version: number; hashbytes: string }
  ): Promise<TransferResult> {
    await this.assertPox4Active();
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.POX_4);

    const functionArgs: ClarityValue[] = [
      uintCV(amount),
      { type: "principal", value: delegateTo } as unknown as ClarityValue,
      untilBurnHeight ? someCV(uintCV(untilBurnHeight)) : noneCV(),
      poxAddress
        ? someCV(tupleCV({
            version: bufferCV(Buffer.from([poxAddress.version])),
            hashbytes: bufferCV(Buffer.from(poxAddress.hashbytes, "hex")),
          }))
        : noneCV(),
    ];

    // No assets moved from sender (delegation is permission, not transfer)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "delegate-stx",
      functionArgs,
      postConditions: [],
    });
  }

  /**
   * Revoke delegation
   */
  async revokeDelegation(account: Account): Promise<TransferResult> {
    await this.assertPox4Active();
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.POX_4);

    // No assets moved from sender (revokes delegation permission)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "revoke-delegate-stx",
      functionArgs: [],
      postConditions: [],
    });
  }

}

// ============================================================================
// Helper Functions
// ============================================================================

function formatUstx(ustx: bigint): string {
  const whole = ustx / 1_000_000n;
  const frac = (ustx % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

let _stackingServiceInstance: StackingService | null = null;

export function getStackingService(network: Network): StackingService {
  if (!_stackingServiceInstance || _stackingServiceInstance["network"] !== network) {
    _stackingServiceInstance = new StackingService(network);
  }
  return _stackingServiceInstance;
}
