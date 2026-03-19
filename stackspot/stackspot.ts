#!/usr/bin/env bun
/**
 * Stackspot skill CLI
 * Stacking lottery pots on stackspot.app — pool STX into pots that stack via PoX,
 * VRF picks a random winner for sBTC rewards, all participants get their STX back.
 *
 * Usage: bun run stackspot/stackspot.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount } from "../src/lib/services/x402.service.js";
import { callContract } from "../src/lib/transactions/builder.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import {
  uintCV,
  contractPrincipalCV,
  PostConditionMode,
} from "@stacks/transactions";
import {
  PLATFORM_ADDRESS,
  PLATFORM_CONTRACT,
  KNOWN_POTS,
  parseContractName,
  callPotReadOnly,
} from "../src/lib/utils/stackspot-shared.js";

const SKILL_NAME = "stackspot";

const program = new Command();

program
  .name(SKILL_NAME)
  .description(
    "Stacking lottery pots on stackspot.app — pool STX into pots that stack via PoX, " +
      "VRF picks a random winner for sBTC rewards, all participants get their STX back. Mainnet-only."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-pots
// ---------------------------------------------------------------------------

program
  .command("list-pots")
  .description(
    "List all known stackspot pot contracts with their current on-chain value and lock status."
  )
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const pots = await Promise.all(
        KNOWN_POTS.map(async (pot) => {
          let currentValueUstx: unknown = null;
          let isLocked: unknown = null;
          try {
            currentValueUstx = await callPotReadOnly(
              pot.contractName,
              "get-pot-value",
              []
            );
          } catch {
            // pot may not be deployed on current network — skip gracefully
          }
          try {
            isLocked = await callPotReadOnly(pot.contractName, "is-locked", []);
          } catch {
            // same
          }
          return {
            name: pot.name,
            contract: `${pot.deployer}.${pot.contractName}`,
            maxParticipants: pot.maxParticipants,
            minAmountStx: pot.minAmountStx,
            currentValueUstx,
            isLocked,
          };
        })
      );

      printJson({
        network: NETWORK,
        potCount: pots.length,
        pots,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-pot-state
// ---------------------------------------------------------------------------

program
  .command("get-pot-state")
  .description(
    "Get full on-chain state for a pot: value, lock status, configs, pool config, and details."
  )
  .requiredOption(
    "--contract-name <name>",
    "Pot contract name or full identifier (e.g., SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG or STXLFG)"
  )
  .action(async (opts: { contractName: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const parsed = parseContractName(opts.contractName);
      const contractId = `${parsed.deployer}.${parsed.contractName}`;

      const [potValue, isLocked, configs, poolConfig, details] =
        await Promise.all([
          callPotReadOnly(opts.contractName, "get-pot-value", []),
          callPotReadOnly(opts.contractName, "is-locked", []),
          callPotReadOnly(opts.contractName, "get-configs", []),
          callPotReadOnly(opts.contractName, "get-pool-config", []),
          callPotReadOnly(opts.contractName, "get-pot-details", []),
        ]);

      printJson({
        network: NETWORK,
        contractName: parsed.contractName,
        contractId,
        state: {
          potValueUstx: potValue,
          isLocked,
          configs,
          poolConfig,
          details,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// join-pot
// ---------------------------------------------------------------------------

program
  .command("join-pot")
  .description(
    "Contribute STX to a pot. STX is locked until the stacking cycle completes. " +
      "Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--contract-name <name>",
    "Pot name or full identifier (e.g., SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85.STXLFG or STXLFG)"
  )
  .requiredOption(
    "--amount <microStx>",
    "Amount to contribute in micro-STX (1 STX = 1,000,000 micro-STX)"
  )
  .action(async (opts: { contractName: string; amount: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const amount = BigInt(opts.amount);
      if (amount <= 0n) {
        throw new Error("--amount must be a positive integer in micro-STX");
      }

      const parsed = parseContractName(opts.contractName);

      const knownPot = KNOWN_POTS.find(
        (p) => p.contractName === parsed.contractName
      );
      if (knownPot) {
        const minUstx = BigInt(knownPot.minAmountStx) * 1_000_000n;
        if (amount < minUstx) {
          throw new Error(
            `--amount ${opts.amount} is below the minimum for ${parsed.contractName}: ` +
              `${minUstx} micro-STX (${knownPot.minAmountStx} STX)`
          );
        }
      }

      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: parsed.deployer,
        contractName: parsed.contractName,
        functionName: "join-pot",
        functionArgs: [uintCV(amount)],
        postConditionMode: PostConditionMode.Allow,
      });

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        pot: {
          contractName: parsed.contractName,
          amountUstx: opts.amount,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// start-pot
// ---------------------------------------------------------------------------

program
  .command("start-pot")
  .description(
    "Trigger a full pot to begin stacking via the platform contract. " +
      "Must be called during the PoX prepare phase. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--contract-name <name>",
    "Pot name or full identifier to start stacking"
  )
  .action(async (opts: { contractName: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const parsed = parseContractName(opts.contractName);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: PLATFORM_ADDRESS,
        contractName: PLATFORM_CONTRACT,
        functionName: "start-stackspot-jackpot",
        functionArgs: [contractPrincipalCV(parsed.deployer, parsed.contractName)],
        postConditionMode: PostConditionMode.Allow,
      });

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        pot: {
          contractName: parsed.contractName,
        },
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
    "Claim sBTC rewards from a completed pot. Only the VRF-selected winner receives sBTC; " +
      "all participants recover their STX. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--contract-name <name>",
    "Pot name or full identifier to claim rewards from"
  )
  .action(async (opts: { contractName: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const parsed = parseContractName(opts.contractName);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: parsed.deployer,
        contractName: parsed.contractName,
        functionName: "claim-pot-reward",
        functionArgs: [contractPrincipalCV(parsed.deployer, parsed.contractName)],
        postConditionMode: PostConditionMode.Allow,
      });

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        pot: {
          contractName: parsed.contractName,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// cancel-pot
// ---------------------------------------------------------------------------

program
  .command("cancel-pot")
  .description(
    "Cancel a pot before stacking begins to recover contributed STX. " +
      "The pot must not be locked. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--contract-name <name>",
    "Pot name or full identifier to cancel"
  )
  .action(async (opts: { contractName: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          `${SKILL_NAME} skill is mainnet-only. Set NETWORK=mainnet to use this skill.`
        );
      }

      const parsed = parseContractName(opts.contractName);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: parsed.deployer,
        contractName: parsed.contractName,
        functionName: "cancel-pot",
        functionArgs: [contractPrincipalCV(parsed.deployer, parsed.contractName)],
        postConditionMode: PostConditionMode.Allow,
      });

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        pot: {
          contractName: parsed.contractName,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
