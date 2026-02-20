#!/usr/bin/env bun
/**
 * Stacking skill CLI
 * Proof of Transfer (PoX) stacking operations: query PoX info, check stacking status, lock STX, extend lock period
 *
 * Usage: bun run stacking/stacking.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getStackingService } from "../src/lib/services/stacking.service.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("stacking")
  .description(
    "PoX stacking operations: query cycle info, check stacking status, lock STX for BTC rewards, and extend stacking lock period"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-pox-info
// ---------------------------------------------------------------------------

program
  .command("get-pox-info")
  .description(
    "Get current Proof of Transfer (PoX) cycle information. Returns current and next cycle details, minimum stacking amount, and cycle lengths."
  )
  .action(async () => {
    try {
      const stackingService = getStackingService(NETWORK);
      const poxInfo = await stackingService.getPoxInfo();

      printJson({
        network: NETWORK,
        currentCycle: poxInfo.current_cycle,
        nextCycle: poxInfo.next_cycle,
        minAmountUstx: poxInfo.min_amount_ustx,
        rewardCycleLength: poxInfo.reward_cycle_length,
        prepareCycleLength: poxInfo.prepare_cycle_length,
        currentBurnchainBlockHeight: poxInfo.current_burnchain_block_height,
        totalLiquidSupplyUstx: poxInfo.total_liquid_supply_ustx,
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
    "Check if an address is currently stacking STX. Returns stacking status, amount, and lock period details."
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const stackingService = getStackingService(NETWORK);
      const walletAddress = opts.address || (await getWalletAddress());
      const status = await stackingService.getStackingStatus(walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        ...status,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// stack-stx
// ---------------------------------------------------------------------------

program
  .command("stack-stx")
  .description(
    "Lock STX tokens for stacking to earn BTC rewards. " +
      "Requires a Bitcoin reward address (version + hashbytes) and a burn height within the prepare phase. " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--amount <microStx>",
    "Amount of STX to stack in micro-STX (1 STX = 1,000,000 micro-STX)"
  )
  .requiredOption(
    "--pox-address-version <version>",
    "Bitcoin address version byte: 0 (P2PKH), 1 (P2SH), 4 (P2WPKH), 5 (P2WSH), 6 (P2TR)"
  )
  .requiredOption(
    "--pox-address-hashbytes <hex>",
    "Bitcoin address hash bytes as a hex string (20 bytes for P2PKH/P2SH, 32 bytes for P2WSH/P2TR)"
  )
  .requiredOption(
    "--start-burn-height <blockHeight>",
    "Bitcoin block height at which stacking begins (must be in a prepare phase)"
  )
  .requiredOption(
    "--lock-period <cycles>",
    "Number of reward cycles to lock STX (1-12)"
  )
  .action(
    async (opts: {
      amount: string;
      poxAddressVersion: string;
      poxAddressHashbytes: string;
      startBurnHeight: string;
      lockPeriod: string;
    }) => {
      try {
        const version = parseInt(opts.poxAddressVersion, 10);
        if (isNaN(version) || version < 0) {
          throw new Error(
            "--pox-address-version must be a non-negative integer (0=P2PKH, 1=P2SH, 4=P2WPKH, 5=P2WSH, 6=P2TR)"
          );
        }

        const startBurnHeight = parseInt(opts.startBurnHeight, 10);
        if (isNaN(startBurnHeight) || startBurnHeight <= 0) {
          throw new Error("--start-burn-height must be a positive integer");
        }

        const lockPeriod = parseInt(opts.lockPeriod, 10);
        if (isNaN(lockPeriod) || lockPeriod < 1 || lockPeriod > 12) {
          throw new Error("--lock-period must be an integer between 1 and 12");
        }

        const stackingService = getStackingService(NETWORK);
        const account = await getAccount();
        const result = await stackingService.stack(
          account,
          BigInt(opts.amount),
          { version, hashbytes: opts.poxAddressHashbytes },
          startBurnHeight,
          lockPeriod
        );

        printJson({
          success: true,
          txid: result.txid,
          stacker: account.address,
          amount: opts.amount,
          lockPeriod,
          startBurnHeight,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// extend-stacking
// ---------------------------------------------------------------------------

program
  .command("extend-stacking")
  .description(
    "Extend an existing stacking lock period by additional reward cycles. " +
      "Must already be stacking. Requires an unlocked wallet."
  )
  .requiredOption(
    "--extend-count <cycles>",
    "Number of additional reward cycles to lock (1-12)"
  )
  .requiredOption(
    "--pox-address-version <version>",
    "Bitcoin address version byte (same as used when initially stacking)"
  )
  .requiredOption(
    "--pox-address-hashbytes <hex>",
    "Bitcoin address hash bytes as a hex string (same as used when initially stacking)"
  )
  .action(
    async (opts: {
      extendCount: string;
      poxAddressVersion: string;
      poxAddressHashbytes: string;
    }) => {
      try {
        const extendCount = parseInt(opts.extendCount, 10);
        if (isNaN(extendCount) || extendCount < 1 || extendCount > 12) {
          throw new Error("--extend-count must be an integer between 1 and 12");
        }

        const version = parseInt(opts.poxAddressVersion, 10);
        if (isNaN(version) || version < 0) {
          throw new Error(
            "--pox-address-version must be a non-negative integer"
          );
        }

        const stackingService = getStackingService(NETWORK);
        const account = await getAccount();
        const result = await stackingService.extendStacking(
          account,
          extendCount,
          { version, hashbytes: opts.poxAddressHashbytes }
        );

        printJson({
          success: true,
          txid: result.txid,
          stacker: account.address,
          extendCount,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
