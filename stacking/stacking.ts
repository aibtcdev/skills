#!/usr/bin/env bun
/**
 * Stacking skill CLI
 * PoX-5 staking: query cycle state and staking status, list signer managers,
 * stake / update / unstake STX, and check or claim sBTC rewards.
 *
 * Usage: bun run stacking/stacking.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import {
  MAX_STAKE_CYCLES,
  buildPayoutCalldata,
  getStackingService,
  type PoxState,
  type StakerInfo,
} from "../src/lib/services/stacking.service.js";
import { btcAddressToPoxAddr } from "../src/lib/utils/bitcoin.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stx(ustx: bigint): string {
  const whole = ustx / 1_000_000n;
  const frac = (ustx % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac} STX`;
}

function parseIntStrict(raw: string, flag: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `from ${min} to ${max}`;
    throw new Error(`${flag} must be an integer ${range}, got "${raw}"`);
  }
  return Number(s);
}

function parseUstx(raw: string, flag: string, allowZero: boolean): bigint {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s) || (!allowZero && BigInt(s) === 0n)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer amount in micro-STX, got "${raw}"`);
  }
  return BigInt(s);
}

function poxSummary(pox: PoxState) {
  return {
    contract: pox.contractId,
    burnHeight: pox.burnHeight,
    rewardCycle: pox.rewardCycle,
    nextCycleStartHeight: pox.nextCycleStartHeight,
    preparePhaseStartHeight: pox.preparePhaseStartHeight,
    inPreparePhase: pox.inPreparePhase,
  };
}

function stakerSummary(info: StakerInfo) {
  return {
    signerManager: info.signerManager,
    amountUstx: info.amountUstx.toString(),
    amount: stx(info.amountUstx),
    firstRewardCycle: info.firstRewardCycle,
    numCycles: info.numCycles,
    unlockCycle: info.unlockCycle,
    unlockBurnHeight: info.unlockBurnHeight,
  };
}

interface PayoutOptions {
  btcRewardAddress?: string;
  maxWithdrawalFeeSats?: string;
  signerCalldataHex?: string;
}

function addPayoutOptions(command: Command): Command {
  return command
    .option(
      "--btc-reward-address <address>",
      "Bitcoin address to receive rewards, encoded as { pox-addr, max-fee } signer calldata (the shape reference " +
        "signer managers use to pay via an sBTC withdrawal). Some managers require it, some ignore it."
    )
    .option(
      "--max-withdrawal-fee-sats <sats>",
      "Max sBTC withdrawal fee per payout when --btc-reward-address is set (default 3000)"
    )
    .option(
      "--signer-calldata-hex <hex>",
      "Advanced: raw signer calldata (hex, max 500 bytes). Cannot be combined with --btc-reward-address."
    );
}

function resolveCalldata(opts: PayoutOptions): Uint8Array | undefined {
  if (opts.btcRewardAddress && opts.signerCalldataHex) {
    throw new Error("Pass either --btc-reward-address or --signer-calldata-hex, not both.");
  }
  if (opts.maxWithdrawalFeeSats !== undefined && !opts.btcRewardAddress) {
    throw new Error("--max-withdrawal-fee-sats only applies with --btc-reward-address.");
  }
  if (opts.btcRewardAddress) {
    const maxFee =
      opts.maxWithdrawalFeeSats === undefined
        ? 3000n
        : BigInt(parseIntStrict(opts.maxWithdrawalFeeSats, "--max-withdrawal-fee-sats", 0));
    return buildPayoutCalldata(btcAddressToPoxAddr(opts.btcRewardAddress, NETWORK), maxFee);
  }
  if (opts.signerCalldataHex) {
    const hex = opts.signerCalldataHex.replace(/^0x/, "");
    if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
      throw new Error("--signer-calldata-hex must be a non-empty, even-length hex string.");
    }
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("stacking")
  .description(
    "PoX-5 staking: cycle state, staking status, signer managers, stake / update / unstake STX, and sBTC rewards"
  )
  .version("0.2.0");

// ---------------------------------------------------------------------------
// get-pox-info
// ---------------------------------------------------------------------------

program
  .command("get-pox-info")
  .description(
    "Current PoX-5 state: reward cycle, burn height, next cycle start, and whether the prepare phase is active " +
      "(stake, extend and unstake are refused during it)."
  )
  .action(async () => {
    try {
      const pox = await getStackingService(NETWORK).getPoxState();
      printJson({
        network: NETWORK,
        ...poxSummary(pox),
        firstBurnHeight: pox.firstBurnHeight,
        rewardCycleLength: pox.rewardCycleLength,
        prepareCycleLength: pox.prepareCycleLength,
        signerSetMinUstx: pox.signerSetMinUstx.toString(),
        totalLiquidSupplyUstx: pox.totalLiquidSupplyUstx.toString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-stacking-status
// ---------------------------------------------------------------------------

program
  .command("get-stacking-status")
  .description(
    "PoX-5 staking status for an address: locked amount, signer manager, lock period, unlock cycle and burn " +
      "height, protocol bond membership, and locked/unlocked STX balance."
  )
  .option("--address <address>", "Stacks address to check (uses active wallet if omitted)")
  .action(async (opts: { address?: string }) => {
    try {
      const address = opts.address || (await getWalletAddress());
      const status = await getStackingService(NETWORK).getStakingStatus(address);
      printJson({
        address,
        network: NETWORK,
        staking: status.staking !== null,
        stake: status.staking ? stakerSummary(status.staking) : null,
        bond: status.bond
          ? {
              bondIndex: status.bond.bondIndex,
              signerManager: status.bond.signerManager,
              amountUstx: status.bond.amountUstx.toString(),
              amountSats: status.bond.amountSats.toString(),
              isL1Lock: status.bond.isL1Lock,
            }
          : null,
        balance: {
          totalUstx: status.account.balanceUstx.toString(),
          lockedUstx: status.account.lockedUstx.toString(),
          unlockedUstx: status.account.unlockedUstx.toString(),
          burnchainUnlockHeight: status.account.burnchainUnlockHeight,
        },
        pox: poxSummary(status.pox),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list-signers
// ---------------------------------------------------------------------------

program
  .command("list-signers")
  .description(
    "List PoX-5 signer managers in the signer set for a reward cycle (default: next cycle) with the STX " +
      "delegated to each. A signer manager is what stack-stx stakes with."
  )
  .option("--reward-cycle <cycle>", "Reward cycle to list (default: the next cycle, which a new stake joins)")
  .option("--with-payout-info", "Also read how each manager pays stakers (one extra request per signer)", false)
  .action(async (opts: { rewardCycle?: string; withPayoutInfo: boolean }) => {
    try {
      const service = getStackingService(NETWORK);
      const pox = await service.getPoxState();
      const cycle =
        opts.rewardCycle === undefined ? pox.rewardCycle + 1 : parseIntStrict(opts.rewardCycle, "--reward-cycle", 1);
      const signers = (await service.getSignerSet(cycle)).sort((a, b) =>
        b.delegatedUstx > a.delegatedUstx ? 1 : b.delegatedUstx < a.delegatedUstx ? -1 : 0
      );

      const rows = [];
      for (const s of signers) {
        rows.push({
          signerManager: s.signerManager,
          delegatedUstx: s.delegatedUstx.toString(),
          delegated: stx(s.delegatedUstx),
          ...(opts.withPayoutInfo && { stakerClaim: await service.getClaimStyle(s.signerManager) }),
        });
      }

      printJson({
        network: NETWORK,
        rewardCycle: cycle,
        count: rows.length,
        signers: rows,
        ...(opts.withPayoutInfo && {
          stakerClaimKey: {
            "staker-arg": "on-chain; claim-rewards works",
            caller: "on-chain; claim-rewards works (paid to the caller)",
            none: "no on-chain staker claim; the manager pays off-chain or not at all",
          },
        }),
        note:
          "Managers can restrict who may stake (allowlists, minimums, required payout calldata). Check a " +
          "manager's own terms before staking; a refused stake aborts on chain. Only signers at or above the " +
          "signer-set minimum appear here; other registered managers can still be staked with by contract id.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// stack-stx
// ---------------------------------------------------------------------------

addPayoutOptions(
  program
    .command("stack-stx")
    .description(
      `Lock STX in PoX-5 with a signer manager to earn sBTC rewards. The lock starts next reward cycle and lasts ` +
        `--num-cycles cycles (1-${MAX_STAKE_CYCLES}). Refused during the prepare phase and if already staking ` +
        `(use extend-stacking). Requires an unlocked wallet.`
    )
    .requiredOption(
      "--signer-manager <contractId>",
      "Signer manager contract id (see list-signers), e.g. SP8HK160YD5GHXP69VGA0TC7AQJ1X4CDW3XVERSE.xverse-signer-manager-2"
    )
    .requiredOption("--amount <microStx>", "Amount to lock, in micro-STX (1 STX = 1,000,000 micro-STX)")
    .requiredOption("--num-cycles <cycles>", `Reward cycles to lock (1-${MAX_STAKE_CYCLES}; one cycle is about two weeks)`)
).action(async (opts: PayoutOptions & { signerManager: string; amount: string; numCycles: string }) => {
  try {
    const amountUstx = parseUstx(opts.amount, "--amount", false);
    const numCycles = parseIntStrict(opts.numCycles, "--num-cycles", 1, MAX_STAKE_CYCLES);
    const signerCalldata = resolveCalldata(opts);
    const account = await getAccount();
    const result = await getStackingService(NETWORK).stake(account, {
      signerManager: opts.signerManager,
      amountUstx,
      numCycles,
      signerCalldata,
    });

    printJson({
      success: true,
      txid: result.txid,
      explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      staker: account.address,
      signerManager: opts.signerManager,
      amountUstx: amountUstx.toString(),
      amount: stx(amountUstx),
      firstRewardCycle: result.pox.rewardCycle + 1,
      numCycles,
      unlockCycle: result.unlockCycle,
      unlockBurnHeight: result.unlockBurnHeight,
      rewardPayout: opts.btcRewardAddress
        ? `BTC to ${opts.btcRewardAddress} (if the manager supports it)`
        : opts.signerCalldataHex
          ? "custom signer calldata"
          : "sBTC (if the manager supports it)",
      network: NETWORK,
    });
  } catch (error) {
    handleError(error);
  }
});

// ---------------------------------------------------------------------------
// extend-stacking
// ---------------------------------------------------------------------------

addPayoutOptions(
  program
    .command("extend-stacking")
    .description(
      `Update an existing PoX-5 stake (stake-update): extend the lock, add STX, switch signer manager, or change ` +
        `payout calldata, in any combination. Refused during the prepare phase. The lock may not run more than ` +
        `${MAX_STAKE_CYCLES} cycles past the next cycle. Requires an unlocked wallet.`
    )
    .option("--cycles-to-extend <cycles>", "Cycles to add to the current unlock cycle", "0")
    .option("--amount-increase <microStx>", "Additional micro-STX to lock", "0")
    .option("--signer-manager <contractId>", "New signer manager contract id (defaults to the current one)")
).action(
  async (opts: PayoutOptions & { cyclesToExtend: string; amountIncrease: string; signerManager?: string }) => {
    try {
      const cyclesToExtend = parseIntStrict(opts.cyclesToExtend, "--cycles-to-extend", 0, MAX_STAKE_CYCLES);
      const amountIncreaseUstx = parseUstx(opts.amountIncrease, "--amount-increase", true);
      const signerCalldata = resolveCalldata(opts);
      const account = await getAccount();
      const result = await getStackingService(NETWORK).updateStake(account, {
        signerManager: opts.signerManager,
        cyclesToExtend,
        amountIncreaseUstx,
        signerCalldata,
      });

      printJson({
        success: true,
        txid: result.txid,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        staker: account.address,
        previous: stakerSummary(result.previous),
        signerManager: result.signerManager,
        newAmountUstx: result.newAmountUstx.toString(),
        newAmount: stx(result.newAmountUstx),
        unlockCycle: result.unlockCycle,
        unlockBurnHeight: result.unlockBurnHeight,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  }
);

// ---------------------------------------------------------------------------
// unstake-stx
// ---------------------------------------------------------------------------

program
  .command("unstake-stx")
  .description(
    "Stop a PoX-5 stake early (pox-5 unstake). The STX stays locked through the current reward cycle and " +
      "unlocks at the start of the next one. Refused during the prepare phase. Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const account = await getAccount();
      const result = await getStackingService(NETWORK).unstake(account);
      printJson({
        success: true,
        txid: result.txid,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        staker: account.address,
        previous: stakerSummary(result.previous),
        unlockCycle: result.unlockCycle,
        unlockBurnHeight: result.unlockBurnHeight,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-rewards
// ---------------------------------------------------------------------------

program
  .command("get-rewards")
  .description(
    "sBTC rewards an address has earned from its signer manager for one reward cycle and not yet claimed " +
      "(before manager fees), whether the manager still has to pull them from pox-5, and whether the manager " +
      "supports an on-chain staker claim."
  )
  .requiredOption("--reward-cycle <cycle>", "Reward cycle to check")
  .option("--address <address>", "Stacks address (uses active wallet if omitted)")
  .option("--signer-manager <contractId>", "Signer manager to check (defaults to the address's current one)")
  .action(async (opts: { rewardCycle: string; address?: string; signerManager?: string }) => {
    try {
      const rewardCycle = parseIntStrict(opts.rewardCycle, "--reward-cycle", 0);
      const service = getStackingService(NETWORK);
      const staker = opts.address || (await getWalletAddress());
      const manager = opts.signerManager ?? (await service.getStakerInfo(staker))?.signerManager;
      if (!manager) {
        throw new Error(
          `${staker} is not currently staking; pass --signer-manager to check rewards from a past signer.`
        );
      }
      const [earnedSats, unpulledSats, claimStyle] = await Promise.all([
        service.getStakerUnclaimedRewards(manager, rewardCycle, staker),
        service.getSignerUnpulledRewards(manager, rewardCycle),
        service.getClaimStyle(manager),
      ]);
      printJson({
        address: staker,
        network: NETWORK,
        rewardCycle,
        signerManager: manager,
        unclaimedSatsBeforeFees: earnedSats.toString(),
        managerUnpulledSats: unpulledSats.toString(),
        stakerClaim: claimStyle,
        next:
          earnedSats === 0n
            ? "Nothing to claim for this cycle."
            : claimStyle === "none"
              ? "This manager has no on-chain staker claim; it pays stakers off-chain."
              : "Run claim-rewards with this --reward-cycle.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// claim-rewards
// ---------------------------------------------------------------------------

program
  .command("claim-rewards")
  .description(
    "Claim PoX-5 sBTC rewards for one reward cycle through the signer manager. If the manager has not yet " +
      "pulled that cycle's rewards from pox-5, this first sends the manager's permissionless claim-rewards (a " +
      "second transaction, paid by this wallet), then the staker claim. Not available for managers that pay " +
      "off-chain. Requires an unlocked wallet."
  )
  .requiredOption("--reward-cycle <cycle>", "Reward cycle to claim")
  .option("--signer-manager <contractId>", "Signer manager to claim from (defaults to the wallet's current one)")
  .action(async (opts: { rewardCycle: string; signerManager?: string }) => {
    try {
      const rewardCycle = parseIntStrict(opts.rewardCycle, "--reward-cycle", 0);
      const service = getStackingService(NETWORK);
      const account = await getAccount();
      const manager = opts.signerManager ?? (await service.getStakerInfo(account.address))?.signerManager;
      if (!manager) {
        throw new Error(
          `${account.address} is not currently staking; pass --signer-manager to claim from a past signer.`
        );
      }

      const [earnedSats, unpulledSats, claimStyle] = await Promise.all([
        service.getStakerUnclaimedRewards(manager, rewardCycle, account.address),
        service.getSignerUnpulledRewards(manager, rewardCycle),
        service.getClaimStyle(manager),
      ]);
      if (claimStyle === "none") {
        throw new Error(`${manager} has no on-chain staker claim (claim-staker-rewards); it pays stakers off-chain.`);
      }
      if (earnedSats === 0n) {
        throw new Error(`No unclaimed rewards for ${account.address} from ${manager} in cycle ${rewardCycle}.`);
      }

      let managerPull: { txid: string; explorerUrl: string } | null = null;
      if (unpulledSats > 0n) {
        const pulled = await service.pullSignerRewards(account, manager, rewardCycle, unpulledSats);
        managerPull = { txid: pulled.txid, explorerUrl: getExplorerTxUrl(pulled.txid, NETWORK) };
      }

      const claim = await service.claimStakerRewards(account, manager, rewardCycle, claimStyle);
      printJson({
        success: true,
        network: NETWORK,
        rewardCycle,
        signerManager: manager,
        unclaimedSatsBeforeFees: earnedSats.toString(),
        managerPull,
        txid: claim.txid,
        explorerUrl: getExplorerTxUrl(claim.txid, NETWORK),
        ...(managerPull && {
          note: "Two transactions were sent in nonce order: the manager's pull, then the staker claim.",
        }),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
