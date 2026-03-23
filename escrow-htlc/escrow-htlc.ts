#!/usr/bin/env bun
/**
 * escrow-htlc — Trust-minimized HTLC escrow for agent-to-agent sBTC payments.
 *
 * Subcommands:
 *   generate-lock-params   Generate preimage + hashlock pair
 *   lock                   Lock sBTC into escrow
 *   claim                  Claim with preimage (recipient only)
 *   refund                 Refund after timelock expiry (sender only)
 *   get-escrow             Read-only status lookup
 *
 * Usage: bun run escrow-htlc/escrow-htlc.ts <subcommand> [options]
 */

import { Command } from "commander";
import { createHash, randomBytes } from "node:crypto";
import {
  bufferCV,
  principalCV,
  uintCV,
  deserializeCV,
  cvToJSON,
  type ClarityValue,
} from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getContracts, parseContractId } from "../src/lib/config/contracts.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { callContract } from "../src/lib/transactions/builder.js";
import { createFungiblePostCondition } from "../src/lib/transactions/post-conditions.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBuffer(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(
      `Expected 32-byte (64-char) hex, got ${clean.length} chars`
    );
  }
  return Buffer.from(clean, "hex");
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseReadOnlyResult(hex: string): unknown {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const cv = deserializeCV(Buffer.from(clean, "hex"));
  return cvToJSON(cv);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("escrow-htlc")
  .description(
    "Trust-minimized HTLC escrow for agent-to-agent sBTC payments on Stacks"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// generate-lock-params
// ---------------------------------------------------------------------------

program
  .command("generate-lock-params")
  .description(
    "Generate a random preimage + SHA-256 hashlock pair, and a random escrow ID."
  )
  .option(
    "--secret <string>",
    "Use a specific secret string instead of random bytes"
  )
  .action(async (opts: { secret?: string }) => {
    try {
      const preimageBytes = opts.secret
        ? createHash("sha256").update(opts.secret).digest()
        : randomBytes(32);

      const preimage = preimageBytes.toString("hex");
      const hashlock = sha256Hex(preimageBytes);
      const escrowId = randomBytes(32).toString("hex");

      printJson({
        preimage,
        hashlock,
        escrowId,
        warning:
          "Store the preimage securely. Losing it means funds can only be recovered via refund after timelock.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

program
  .command("lock")
  .description(
    "Lock sBTC into escrow with a hashlock and timelock. Requires an unlocked wallet."
  )
  .requiredOption("--escrow-id <hex>", "32-byte hex escrow identifier")
  .requiredOption("--recipient <address>", "Stacks address of the recipient")
  .requiredOption("--amount-sats <n>", "Amount of sBTC in satoshis to lock")
  .requiredOption("--hashlock <hex>", "32-byte SHA-256 hashlock (hex)")
  .requiredOption(
    "--timelock-blocks <n>",
    "Number of blocks from now until expiry"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .option(
    "--contract <contractId>",
    "Full contract ID if deployed at a custom address"
  )
  .action(
    async (opts: {
      escrowId: string;
      recipient: string;
      amountSats: string;
      hashlock: string;
      timelockBlocks: string;
      fee?: string;
      contract?: string;
    }) => {
      try {
        const account = await getAccount();
        const hiro = getHiroApi(NETWORK);
        const contracts = getContracts(NETWORK);
        const resolvedFee = await resolveFee(
          opts.fee,
          NETWORK,
          "contract_call"
        );

        const escrowIdBuf = hexToBuffer(opts.escrowId);
        const hashlockBuf = hexToBuffer(opts.hashlock);
        const amount = BigInt(opts.amountSats);
        const timelockOffset = parseInt(opts.timelockBlocks, 10);

        if (amount <= 0n) {
          throw new Error("--amount-sats must be a positive integer");
        }
        if (timelockOffset <= 0 || isNaN(timelockOffset)) {
          throw new Error("--timelock-blocks must be a positive integer");
        }

        // Get current block height to compute absolute timelock
        const latestBlock = await hiro.getLatestBlock();
        const currentBlock = latestBlock.height;
        const absoluteTimelock = currentBlock + timelockOffset;

        // Resolve contract — defaults to deployer's own address
        const contractId = opts.contract || `${account.address}.escrow-htlc`;
        const { address: contractAddress, name: contractName } =
          parseContractId(contractId);

        const functionArgs: ClarityValue[] = [
          bufferCV(escrowIdBuf),
          principalCV(opts.recipient),
          uintCV(amount),
          bufferCV(hashlockBuf),
          uintCV(BigInt(absoluteTimelock)),
        ];

        // Post condition: sender sends exactly `amount` of sBTC
        const sbtcContract = contracts.SBTC_TOKEN;
        const postCondition = createFungiblePostCondition(
          account.address,
          sbtcContract,
          "sbtc-token",
          "eq",
          amount
        );

        const result = await callContract(account, {
          contractAddress,
          contractName,
          functionName: "lock",
          functionArgs,
          postConditions: [postCondition],
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          escrowId: opts.escrowId,
          sender: account.address,
          recipient: opts.recipient,
          amountSats: opts.amountSats,
          hashlock: opts.hashlock,
          timelockBlock: absoluteTimelock.toString(),
          currentBlock: currentBlock.toString(),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

program
  .command("claim")
  .description(
    "Claim escrowed sBTC by revealing the preimage. Requires the recipient's unlocked wallet."
  )
  .requiredOption("--escrow-id <hex>", "32-byte hex escrow identifier")
  .requiredOption(
    "--preimage <hex>",
    "32-byte preimage whose SHA-256 matches the hashlock"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .option(
    "--contract <contractId>",
    "Full contract ID if deployed at a custom address"
  )
  .action(
    async (opts: {
      escrowId: string;
      preimage: string;
      fee?: string;
      contract?: string;
    }) => {
      try {
        const account = await getAccount();
        const resolvedFee = await resolveFee(
          opts.fee,
          NETWORK,
          "contract_call"
        );

        const escrowIdBuf = hexToBuffer(opts.escrowId);
        const preimageBuf = hexToBuffer(opts.preimage);

        const contractId = opts.contract || `${account.address}.escrow-htlc`;
        const { address: contractAddress, name: contractName } =
          parseContractId(contractId);

        const functionArgs: ClarityValue[] = [
          bufferCV(escrowIdBuf),
          bufferCV(preimageBuf),
        ];

        const result = await callContract(account, {
          contractAddress,
          contractName,
          functionName: "claim",
          functionArgs,
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          escrowId: opts.escrowId,
          preimage: opts.preimage,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// refund
// ---------------------------------------------------------------------------

program
  .command("refund")
  .description(
    "Refund escrowed sBTC to the sender after timelock expiry. Requires the sender's unlocked wallet."
  )
  .requiredOption("--escrow-id <hex>", "32-byte hex escrow identifier")
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .option(
    "--contract <contractId>",
    "Full contract ID if deployed at a custom address"
  )
  .action(
    async (opts: {
      escrowId: string;
      fee?: string;
      contract?: string;
    }) => {
      try {
        const account = await getAccount();
        const resolvedFee = await resolveFee(
          opts.fee,
          NETWORK,
          "contract_call"
        );

        const escrowIdBuf = hexToBuffer(opts.escrowId);

        const contractId = opts.contract || `${account.address}.escrow-htlc`;
        const { address: contractAddress, name: contractName } =
          parseContractId(contractId);

        const functionArgs: ClarityValue[] = [bufferCV(escrowIdBuf)];

        const result = await callContract(account, {
          contractAddress,
          contractName,
          functionName: "refund",
          functionArgs,
          ...(resolvedFee !== undefined && { fee: resolvedFee }),
        });

        printJson({
          success: true,
          txid: result.txid,
          escrowId: opts.escrowId,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-escrow
// ---------------------------------------------------------------------------

program
  .command("get-escrow")
  .description("Read-only lookup of escrow status. Does not require a wallet.")
  .requiredOption("--escrow-id <hex>", "32-byte hex escrow identifier")
  .option(
    "--contract <contractId>",
    "Full contract ID (e.g., SP2...escrow-htlc)"
  )
  .action(
    async (opts: {
      escrowId: string;
      contract?: string;
    }) => {
      try {
        const hiro = getHiroApi(NETWORK);
        const escrowIdBuf = hexToBuffer(opts.escrowId);

        // For read-only calls we need a sender address
        let senderAddress: string;
        try {
          senderAddress = await getWalletAddress();
        } catch {
          senderAddress = "SP000000000000000000002Q6VF78";
        }

        const contractId =
          opts.contract || `${senderAddress}.escrow-htlc`;

        const response = await hiro.callReadOnlyFunction(
          contractId,
          "get-escrow",
          [bufferCV(escrowIdBuf)],
          senderAddress
        );

        if (!response.okay || !response.result) {
          printJson({
            escrowId: opts.escrowId,
            found: false,
            network: NETWORK,
          });
          return;
        }

        const parsed = parseReadOnlyResult(response.result);

        printJson({
          escrowId: opts.escrowId,
          found: true,
          escrow: parsed,
          network: NETWORK,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse();
