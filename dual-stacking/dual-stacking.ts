#!/usr/bin/env bun
/**
 * Dual Stacking skill CLI
 * Earn BTC-denominated rewards (paid in sBTC) by holding sBTC via Dual Stacking.
 * Single contract call. No lockup. Minimum 10,000 sats sBTC.
 *
 * Contract: SP1HFCRKEJ8BYW4D0E3FAWHFDX8A25PPAA83HWWZ9.dual-stacking-v2_0_4
 *
 * Usage: bun run dual-stacking/dual-stacking.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  noneCV,
  someCV,
  principalCV,
  uintCV,
  cvToJSON,
  hexToCV,
  type ClarityValue,
} from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl } from "@aibtc/skills/src/lib/config/networks.js";
import { getHiroApi } from "@aibtc/skills/src/lib/services/hiro-api.js";
import { getAccount, getWalletAddress } from "@aibtc/skills/src/lib/services/x402.service.js";
import { callContract } from "@aibtc/skills/src/lib/transactions/builder.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DUAL_STACKING_CONTRACT =
  "SP1HFCRKEJ8BYW4D0E3FAWHFDX8A25PPAA83HWWZ9.dual-stacking-v2_0_4";

const DUAL_STACKING_ADDRESS = "SP1HFCRKEJ8BYW4D0E3FAWHFDX8A25PPAA83HWWZ9";
const DUAL_STACKING_NAME = "dual-stacking-v2_0_4";

/** Divisor for APR values returned by the contract (divide by 1e6 for %) */
const APR_DIVISOR = 1_000_000;

/** Divisor for sBTC amounts (1 sBTC = 1e8 sats) */
const SBTC_DECIMALS = 1e8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call a read-only function on the dual-stacking contract
 * and return the decoded Clarity value as JSON.
 */
async function readOnly(
  functionName: string,
  args: ClarityValue[],
  sender: string
): Promise<unknown> {
  const hiro = getHiroApi(NETWORK);
  const result = await hiro.callReadOnlyFunction(
    DUAL_STACKING_CONTRACT,
    functionName,
    args,
    sender
  );

  if (!result.okay || !result.result) {
    throw new Error(
      `Contract call failed: ${result.cause ?? "unknown error"}`
    );
  }

  return cvToJSON(hexToCV(result.result));
}

/**
 * Resolve address: use provided value or fall back to active wallet
 */
async function resolveAddress(address?: string): Promise<string> {
  if (address) return address;
  return getWalletAddress();
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("dual-stacking")
  .description(
    "Dual Stacking operations: check enrollment status, enroll to earn sBTC rewards, opt out, and query earned rewards by cycle"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// check-status
// ---------------------------------------------------------------------------

program
  .command("check-status")
  .description(
    "Check enrollment status, APR data, minimum enrollment amount, and current cycle overview for an address. " +
      "Read-only — no wallet required unless --address is omitted."
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const address = await resolveAddress(opts.address);

      const [enrolledThisCycle, enrolledNextCycle, minAmount, aprData, cycleOverview] =
        await Promise.all([
          readOnly("is-enrolled-this-cycle", [principalCV(address)], address),
          readOnly("is-enrolled-in-next-cycle", [principalCV(address)], address),
          readOnly("get-minimum-enrollment-amount", [], address),
          readOnly("get-apr-data", [], address),
          readOnly("current-overview-data", [], address),
        ]);

      // Parse APR data — contract returns {min-apr: uint, max-apr: uint}
      const aprJson = aprData as { value: { "min-apr": { value: string }; "max-apr": { value: string } } };
      const minAprRaw = parseInt(aprJson?.value?.["min-apr"]?.value ?? "500000", 10);
      const maxAprRaw = parseInt(aprJson?.value?.["max-apr"]?.value ?? "5000000", 10);

      // Parse minimum enrollment — contract returns uint (sats * 1e8)
      const minAmountJson = minAmount as { value: string };
      const minEnrollmentRaw = parseInt(minAmountJson?.value ?? "10000", 10);

      // Parse cycleOverview — contract returns a tuple, cvToJSON gives {type, value: {field: {type, value}}}
      const overviewVal = (cycleOverview as { value: Record<string, { value: string }> })?.value ?? {};
      const parsedOverview = {
        currentCycleId: parseInt(overviewVal["cycle-id"]?.value ?? "0", 10),
        snapshotIndex: parseInt(overviewVal["snapshot-index"]?.value ?? "0", 10),
        snapshotsPerCycle: parseInt(overviewVal["snapshots-per-cycle"]?.value ?? "0", 10),
      };

      printJson({
        address,
        network: NETWORK,
        enrolledThisCycle: (enrolledThisCycle as { value: boolean })?.value ?? false,
        enrolledNextCycle: (enrolledNextCycle as { value: boolean })?.value ?? false,
        minimumEnrollmentSats: minEnrollmentRaw,
        apr: {
          minApr: minAprRaw / APR_DIVISOR,
          maxApr: maxAprRaw / APR_DIVISOR,
          unit: "%",
          note: "Multiplier up to 10x with stacked STX via PoX",
        },
        cycleOverview: parsedOverview,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// enroll
// ---------------------------------------------------------------------------

program
  .command("enroll")
  .description(
    "Enroll in Dual Stacking to earn sBTC rewards on your sBTC balance. " +
      "Optionally specify a different address to receive rewards. " +
      "Requires an unlocked wallet."
  )
  .option(
    "--reward-address <address>",
    "Stacks address to receive rewards (defaults to caller's address)"
  )
  .action(async (opts: { rewardAddress?: string }) => {
    try {
      const account = await getAccount();

      // Build the rewarded-address argument:
      // pass (some <principal>) to direct rewards to a different address, else (none)
      const rewardedAddressArg = opts.rewardAddress
        ? someCV(principalCV(opts.rewardAddress))
        : noneCV();

      const result = await callContract(account, {
        contractAddress: DUAL_STACKING_ADDRESS,
        contractName: DUAL_STACKING_NAME,
        functionName: "enroll",
        functionArgs: [rewardedAddressArg],
      });

      printJson({
        success: true,
        txid: result.txid,
        enrolledAddress: account.address,
        rewardAddress: opts.rewardAddress ?? account.address,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// opt-out
// ---------------------------------------------------------------------------

program
  .command("opt-out")
  .description(
    "Opt out of Dual Stacking. Takes effect from the next cycle. " +
      "Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: DUAL_STACKING_ADDRESS,
        contractName: DUAL_STACKING_NAME,
        functionName: "opt-out",
        functionArgs: [],
      });

      printJson({
        success: true,
        txid: result.txid,
        address: account.address,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
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
    "Get earned rewards for a specific cycle and address. Read-only — no wallet required unless --address is omitted."
  )
  .requiredOption("--cycle <n>", "Cycle number to query")
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .option("--rollback <n>", "Rollback offset (default: 0)", "0")
  .action(async (opts: { cycle: string; address?: string; rollback: string }) => {
    try {
      const cycle = parseInt(opts.cycle, 10);
      if (isNaN(cycle) || cycle < 0) {
        throw new Error("--cycle must be a non-negative integer");
      }

      const rollback = parseInt(opts.rollback, 10);
      if (isNaN(rollback) || rollback < 0) {
        throw new Error("--rollback must be a non-negative integer");
      }

      const address = await resolveAddress(opts.address);

      const rewardData = await readOnly(
        "reward-amount-for-cycle-and-address",
        [uintCV(cycle), uintCV(rollback), principalCV(address)],
        address
      );

      // The contract returns a uint (sats)
      const rewardJson = rewardData as { value: string };
      const rewardSats = parseInt(rewardJson?.value ?? "0", 10);

      printJson({
        address,
        cycle,
        rollback,
        rewardSats,
        rewardBtc: (rewardSats / SBTC_DECIMALS).toFixed(8),
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
