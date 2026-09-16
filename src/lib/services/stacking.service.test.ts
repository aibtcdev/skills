/**
 * Ported from aibtcdev/aibtc-mcp-server tests/services/stacking.test.ts (#682),
 * using the service's dependency seam instead of module mocks, plus coverage
 * for the active-PoX-contract guard this repo adds.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Cl, type ClarityValue, cvToJSON, deserializeCV, serializeCV } from "@stacks/transactions";
import {
  PoxVersionUnsupportedError,
  StackingService,
  buildPayoutCalldata,
  type StackingServiceDeps,
} from "./stacking.service.js";
import { btcAddressToPoxAddr } from "../utils/bitcoin.js";

const reads = new Map<string, ClarityValue>();
let burnHeight = 0;
let activePox = "SP000000000000000000002Q6VF78.pox-5";
let balance = { balance: "10000000000", locked: "0", burnchain_unlock_height: 0 };
let contractInterface: unknown = { functions: [] };

const hiro = {
  callReadOnlyFunction: mock(async (_contract: string, fn: string, args: ClarityValue[]) => {
    const key = `${fn}:${args.map((a) => JSON.stringify(cvToJSON(a))).join(",")}`;
    const value = reads.get(key) ?? reads.get(fn);
    if (!value) return { okay: false, cause: `unmocked read ${key}` };
    return { okay: true, result: `0x${serializeCV(value)}` };
  }),
  getCoreApiInfo: mock(async () => ({ burn_block_height: burnHeight })),
  getStxBalance: mock(async () => balance),
  getContractInterface: mock(async () => contractInterface),
  getPoxInfo: mock(async () => ({ contract_id: activePox })),
} as unknown as NonNullable<StackingServiceDeps["hiro"]>;

const callContract = mock(async (..._args: unknown[]) => ({ txid: "0xabc", rawTx: "00" }));

function service(): StackingService {
  return new StackingService("mainnet", {
    hiro,
    callContract: callContract as unknown as NonNullable<StackingServiceDeps["callContract"]>,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastCall(index = 0): any {
  return (callContract.mock.calls[index] as unknown[])[1];
}

const STAKER = "SP2V64EB40ZBQBV55A294ABWM53G4T5S9PKKPYGKV";
const MANAGER = "SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2";
const OTHER_MANAGER = "SP3ZA8J49HPS7M3KD7EB01Y0ZAJS7VJS2NG87MDGN.planbetter-signer-manager";
const account = { address: STAKER, privateKey: "00", network: "mainnet" } as never;

// Mainnet parameters: cycle 143 spans 966350..968449, prepare phase from 968350.
const FIRST = 666050;
const LENGTH = 2100;

function setStaker(info: { amount: bigint; first: number; cycles: number; signer: string } | null) {
  reads.set(
    `get-staker-info:${JSON.stringify(cvToJSON(Cl.principal(STAKER)))}`,
    info
      ? Cl.some(
          Cl.tuple({
            "amount-ustx": Cl.uint(info.amount),
            "first-reward-cycle": Cl.uint(info.first),
            "num-cycles": Cl.uint(info.cycles),
            signer: Cl.principal(info.signer),
          })
        )
      : Cl.none()
  );
}

beforeEach(() => {
  reads.clear();
  callContract.mockClear();
  reads.set(
    "get-pox-info",
    Cl.ok(
      Cl.tuple({
        "min-amount-ustx": Cl.uint(50_000_000_000n),
        "reward-cycle-id": Cl.uint(143),
        "prepare-cycle-length": Cl.uint(100),
        "first-burnchain-block-height": Cl.uint(FIRST),
        "reward-cycle-length": Cl.uint(LENGTH),
        "total-liquid-supply-ustx": Cl.uint(1n),
      })
    )
  );
  reads.set("get-bond-membership", Cl.none());
  reads.set("get-signer-info", Cl.some(Cl.bufferFromHex("02".padEnd(66, "0"))));
  burnHeight = 967282;
  activePox = "SP000000000000000000002Q6VF78.pox-5";
  balance = { balance: "10000000000", locked: "0", burnchain_unlock_height: 0 };
  contractInterface = { functions: [] };
  setStaker(null);
});

describe("getPoxState", () => {
  test("derives the cycle and prepare phase the way pox-5 does", async () => {
    expect(await service().getPoxState()).toMatchObject({
      rewardCycle: 143,
      nextCycleStartHeight: 968450,
      preparePhaseStartHeight: 968350,
      inPreparePhase: false,
    });
    burnHeight = 968350;
    expect((await service().getPoxState()).inPreparePhase).toBe(true);
  });
});

describe("stake", () => {
  test("stakes with the signer manager, current burn height and a staking post-condition", async () => {
    const result = await service().stake(account, {
      signerManager: MANAGER,
      amountUstx: 2_780_000_000n,
      numCycles: 96,
    });

    const options = lastCall();
    expect(options.contractName).toBe("pox-5");
    expect(options.functionName).toBe("stake");
    expect(options.functionArgs.map((a: ClarityValue) => cvToJSON(a).value)).toEqual([
      MANAGER,
      "2780000000",
      "96",
      "967282",
      null,
    ]);
    expect(options.postConditionMode).toBe(2);
    expect(options.postConditions).toEqual([
      { type: "staking-postcondition", address: STAKER, condition: "eq", amount: "2780000000" },
    ]);
    expect(result.unlockCycle).toBe(240);
    expect(result.unlockBurnHeight).toBe(FIRST + 240 * LENGTH);
  });

  test("passes payout calldata as (some buff)", async () => {
    const calldata = buildPayoutCalldata({ version: 4, hashbytesHex: "11".repeat(20) }, 3000n);
    await service().stake(account, { signerManager: MANAGER, amountUstx: 1_000_000n, numCycles: 1, signerCalldata: calldata });
    expect(cvToJSON(lastCall().functionArgs[4]).type).toBe(`(optional (buff ${calldata.length}))`);
  });

  test("refuses during the prepare phase without signing", async () => {
    burnHeight = 968400;
    await expect(service().stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 1 })).rejects.toThrow(
      /prepare phase/
    );
    expect(callContract).not.toHaveBeenCalled();
  });

  test("refuses when already staking", async () => {
    setStaker({ amount: 5n, first: 144, cycles: 2, signer: MANAGER });
    await expect(service().stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 1 })).rejects.toThrow(
      /already staking/
    );
    expect(callContract).not.toHaveBeenCalled();
  });

  test("refuses an unregistered signer manager", async () => {
    reads.set("get-signer-info", Cl.none());
    await expect(service().stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 1 })).rejects.toThrow(
      /not a registered pox-5 signer manager/
    );
  });

  test("refuses more STX than the account holds", async () => {
    await expect(
      service().stake(account, { signerManager: MANAGER, amountUstx: 20_000_000_000n, numCycles: 1 })
    ).rejects.toThrow(/Insufficient STX/);
  });

  test("rejects an out-of-range lock period", async () => {
    await expect(service().stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 97 })).rejects.toThrow(
      /between 1 and 96/
    );
  });
});

describe("active PoX contract guard", () => {
  test("every write refuses without signing when pox-5 is not the active contract", async () => {
    activePox = "SP000000000000000000002Q6VF78.pox-6";
    setStaker({ amount: 5n, first: 144, cycles: 10, signer: MANAGER });
    const svc = service();
    const writes = [
      () => svc.stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 1 }),
      () => svc.updateStake(account, { cyclesToExtend: 1, amountIncreaseUstx: 0n }),
      () => svc.unstake(account),
      () => svc.pullSignerRewards(account, MANAGER, 143, 1n),
      () => svc.claimStakerRewards(account, MANAGER, 143, "staker-arg"),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(PoxVersionUnsupportedError);
    }
    expect(callContract).not.toHaveBeenCalled();
  });

  test("refuses when the active contract cannot be read", async () => {
    (hiro.getPoxInfo as unknown as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expect(service().stake(account, { signerManager: MANAGER, amountUstx: 1n, numCycles: 1 })).rejects.toThrow(
      /Could not confirm the active PoX contract/
    );
    expect(callContract).not.toHaveBeenCalled();
  });
});

describe("updateStake", () => {
  test("names the current signer as old-signer-manager and locks the new total", async () => {
    setStaker({ amount: 64_686_000_000n, first: 144, cycles: 10, signer: MANAGER });
    balance = { balance: "70000000000", locked: "64686000000", burnchain_unlock_height: 0 };
    const result = await service().updateStake(account, {
      signerManager: OTHER_MANAGER,
      cyclesToExtend: 1,
      amountIncreaseUstx: 1_000_000_000n,
    });

    const options = lastCall();
    expect(options.functionName).toBe("stake-update");
    expect(options.functionArgs.map((a: ClarityValue) => cvToJSON(a).value)).toEqual([
      OTHER_MANAGER,
      MANAGER,
      "1",
      "1000000000",
      null,
    ]);
    expect(options.postConditions[0]).toMatchObject({
      type: "staking-postcondition",
      condition: "eq",
      amount: "65686000000",
    });
    expect(result.unlockCycle).toBe(155);
  });

  test("refuses an increase larger than the unlocked balance", async () => {
    setStaker({ amount: 5n, first: 144, cycles: 2, signer: MANAGER });
    balance = { balance: "100", locked: "90", burnchain_unlock_height: 0 };
    await expect(service().updateStake(account, { cyclesToExtend: 0, amountIncreaseUstx: 50n })).rejects.toThrow(
      /Insufficient unlocked STX/
    );
  });

  test("refuses a no-op update", async () => {
    setStaker({ amount: 5n, first: 144, cycles: 2, signer: MANAGER });
    await expect(service().updateStake(account, { cyclesToExtend: 0, amountIncreaseUstx: 0n })).rejects.toThrow(
      /Nothing to update/
    );
  });
});

describe("unstake", () => {
  test("unstakes from the current signer with a pox post-condition", async () => {
    setStaker({ amount: 5n, first: 144, cycles: 10, signer: MANAGER });
    const result = await service().unstake(account);

    const options = lastCall();
    expect(options.functionName).toBe("unstake");
    expect(cvToJSON(options.functionArgs[0]).value).toBe(MANAGER);
    expect(options.postConditions[0]).toMatchObject({ type: "pox-postcondition", condition: "will-perform" });
    expect(result.unlockCycle).toBe(144);
  });

  test("refuses when the stake already unlocks next cycle", async () => {
    setStaker({ amount: 5n, first: 143, cycles: 1, signer: MANAGER });
    await expect(service().unstake(account)).rejects.toThrow(/would not unlock it sooner/);
  });
});

describe("signer managers", () => {
  test("reads the claim path from the manager's interface", async () => {
    const svc = service();
    const iface = (args: string[]) => ({
      functions: [
        {
          name: "claim-staker-rewards",
          access: "public",
          args: args.map((name) => ({ name, type: "uint128" })),
          outputs: { type: "" },
        },
      ],
    });
    contractInterface = iface(["staker", "reward-cycle", "bond-index"]);
    expect(await svc.getClaimStyle(MANAGER)).toBe("staker-arg");
    contractInterface = iface(["reward-cycle", "bond-index"]);
    expect(await svc.getClaimStyle(MANAGER)).toBe("caller");
    contractInterface = { functions: [] };
    expect(await svc.getClaimStyle(OTHER_MANAGER)).toBe("none");
  });

  test("pulls STX-staker rewards with an empty bond list, then claims for the staker", async () => {
    const svc = service();
    await svc.pullSignerRewards(account, MANAGER, 143, 500n);
    await svc.claimStakerRewards(account, MANAGER, 143, "staker-arg");

    const pull = lastCall(0);
    const claim = lastCall(1);
    expect(pull.functionName).toBe("claim-rewards");
    expect(cvToJSON(pull.functionArgs[0]).value).toEqual([]);
    expect(pull.postConditions[0]).toMatchObject({
      condition: "gte",
      amount: "500",
      address: "SP000000000000000000002Q6VF78.pox-5",
    });
    expect(claim.functionName).toBe("claim-staker-rewards");
    expect(claim.functionArgs.map((a: ClarityValue) => cvToJSON(a).value)).toEqual([STAKER, "143", null]);
    // Nothing may leave the caller: the only condition is on the manager.
    expect(claim.postConditions).toHaveLength(1);
    expect(claim.postConditions[0].address).toBe(MANAGER);
  });
});

describe("payout calldata", () => {
  test("encodes { pox-addr, max-fee } from a Bitcoin address", () => {
    const poxAddr = btcAddressToPoxAddr("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "mainnet");
    expect(poxAddr.version).toBe(4);
    const decoded = cvToJSON(deserializeCV(Buffer.from(buildPayoutCalldata(poxAddr, 2500n)).toString("hex")));
    expect(decoded.value["max-fee"].value).toBe("2500");
    expect(decoded.value["pox-addr"].value.version.value).toBe("0x04");
    expect(decoded.value["pox-addr"].value.hashbytes.value).toBe(`0x${poxAddr.hashbytesHex}`);
  });
});
