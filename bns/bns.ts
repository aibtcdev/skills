#!/usr/bin/env bun
/**
 * BNS skill CLI
 * Bitcoin Name System (BNS) operations: lookup, reverse-lookup, info, availability, pricing, and registration
 *
 * Usage: bun run bns/bns.ts <subcommand> [options]
 */

import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getBnsService } from "../src/lib/services/bns.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// BNS helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Stacks address: prefer explicit arg, fall back to wallet session.
 */
async function getStxAddress(address?: string): Promise<string> {
  if (address) {
    return address;
  }

  try {
    return await getWalletAddress();
  } catch {
    throw new Error(
      "No Stacks address provided and wallet is not unlocked. " +
        "Either provide --address or unlock your wallet first."
    );
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("bns")
  .description(
    "Bitcoin Name System (BNS) operations: lookup names, reverse-lookup addresses, " +
      "check availability, get pricing, list domains, and register .btc names"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

program
  .command("lookup")
  .description(
    "Resolve a .btc domain name to its Stacks address."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to lookup (e.g., 'alice.btc' or 'alice')"
  )
  .action(async (opts: { name: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const result = await bnsService.lookupName(opts.name);

      if (!result) {
        printJson({
          name: opts.name,
          found: false,
          message: "Name not found or not registered",
        });
        return;
      }

      printJson({
        name: result.name,
        found: true,
        address: result.address,
        namespace: result.namespace,
        expireBlock: result.expireBlock,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// reverse-lookup
// ---------------------------------------------------------------------------

program
  .command("reverse-lookup")
  .description(
    "Get the BNS domain names owned by an address. " +
      "Combines results from BNS V2 and V1."
  )
  .option(
    "--address <address>",
    "Stacks address to lookup (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const walletAddress = await getStxAddress(opts.address);
      const names = await bnsService.reverseLookup(walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        namesCount: names.length,
        names,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-info
// ---------------------------------------------------------------------------

program
  .command("get-info")
  .description(
    "Get detailed information about a BNS domain name."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to look up (e.g., 'alice.btc')"
  )
  .action(async (opts: { name: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const info = await bnsService.getNameInfo(opts.name);

      if (!info) {
        printJson({
          name: opts.name,
          found: false,
          message: "Name not found",
        });
        return;
      }

      printJson({
        network: NETWORK,
        found: true,
        ...info,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// check-availability
// ---------------------------------------------------------------------------

program
  .command("check-availability")
  .description(
    "Check if a BNS domain name is available for registration."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to check (e.g., 'alice' or 'alice.btc')"
  )
  .action(async (opts: { name: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const available = await bnsService.checkAvailability(opts.name);

      printJson({
        name: opts.name.endsWith(".btc") ? opts.name : `${opts.name}.btc`,
        available,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-price
// ---------------------------------------------------------------------------

program
  .command("get-price")
  .description(
    "Get the registration price for a BNS domain name in STX."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to check (e.g., 'alice' or 'alice.btc')"
  )
  .action(async (opts: { name: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const price = await bnsService.getPrice(opts.name);

      printJson({
        name: opts.name.endsWith(".btc") ? opts.name : `${opts.name}.btc`,
        network: NETWORK,
        price: {
          units: price.units,
          microStx: price.amount,
          stx: price.amountStx + " STX",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list-user-domains
// ---------------------------------------------------------------------------

program
  .command("list-user-domains")
  .description(
    "List all BNS domains owned by an address."
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const walletAddress = await getStxAddress(opts.address);
      const domains = await bnsService.getUserDomains(walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        domainsCount: domains.length,
        domains,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// claim-fast
// ---------------------------------------------------------------------------

program
  .command("claim-fast")
  .description(
    "Register a BNS domain name in a single transaction using name-claim-fast. " +
      "This is the RECOMMENDED method — no preorder/register wait needed. " +
      "Burns the name price in STX and mints the BNS NFT atomically. " +
      "Works for all open namespaces (BNS V2). Requires an unlocked wallet."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to claim (e.g., 'myname' or 'myname.btc')"
  )
  .option(
    "--send-to <address>",
    "Optional recipient address (defaults to wallet's own address)"
  )
  .action(async (opts: { name: string; sendTo?: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const account = await getAccount();

      // Check availability first
      const available = await bnsService.checkAvailability(opts.name);
      if (!available) {
        throw new Error(`Name "${opts.name}" is not available for registration`);
      }

      // Get price for reference
      const price = await bnsService.getPrice(opts.name);

      // Perform the claim
      const result = await bnsService.claimNameFast(account, opts.name, opts.sendTo);

      const fullName = opts.name.endsWith(".btc") ? opts.name : `${opts.name}.btc`;

      printJson({
        success: true,
        method: "name-claim-fast (single transaction)",
        name: fullName,
        sendTo: opts.sendTo || account.address,
        txid: result.txid,
        network: NETWORK,
        price: price
          ? {
              microStx: price.amount,
              stx: price.amountStx + " STX",
            }
          : null,
        message: `Name "${fullName}" claimed! Once confirmed (~10 min), it will be registered to ${opts.sendTo || account.address}.`,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// preorder
// ---------------------------------------------------------------------------

program
  .command("preorder")
  .description(
    "Preorder a BNS domain name (step 1 of 2-step registration). " +
      "NOTE: For .btc names, prefer claim-fast — it registers in one transaction. " +
      "Use this 2-step flow only for non-.btc namespaces or if claim-fast is unavailable. " +
      "After preorder is confirmed (~10 minutes), call register with the same salt. " +
      "IMPORTANT: Save the returned salt — you'll need it for the register step! " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to preorder (e.g., 'myname' or 'myname.btc')"
  )
  .option(
    "--salt <hex>",
    "Optional salt for the preorder hash (auto-generated if omitted)"
  )
  .action(async (opts: { name: string; salt?: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const account = await getAccount();

      // Check availability first
      const available = await bnsService.checkAvailability(opts.name);
      if (!available) {
        throw new Error(`Name "${opts.name}" is not available for registration`);
      }

      // Get price for reference
      const price = await bnsService.getPrice(opts.name);

      // Generate salt if not provided
      const usedSalt = opts.salt || randomBytes(16).toString("hex");

      // Perform the preorder
      const result = await bnsService.preorderName(account, opts.name, usedSalt);

      const fullName = opts.name.endsWith(".btc") ? opts.name : `${opts.name}.btc`;

      printJson({
        success: true,
        step: "1 of 2 (preorder)",
        name: fullName,
        salt: usedSalt,
        txid: result.txid,
        network: NETWORK,
        price: price
          ? {
              microStx: price.amount,
              stx: price.amountStx + " STX",
            }
          : null,
        nextStep:
          "Wait for this transaction to be confirmed (~10 minutes), then call register with the same name and salt.",
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

program
  .command("register")
  .description(
    "Register a BNS domain name after preorder is confirmed (step 2 of 2-step registration). " +
      "You MUST use the same salt from the preorder step. " +
      "Only call this after the preorder transaction has been confirmed on-chain (~10 minutes). " +
      "Requires an unlocked wallet."
  )
  .requiredOption(
    "--name <name>",
    "BNS name to register (must match the preordered name)"
  )
  .requiredOption(
    "--salt <hex>",
    "The hex salt used in the preorder step (REQUIRED — must match exactly)"
  )
  .action(async (opts: { name: string; salt: string }) => {
    try {
      const bnsService = getBnsService(NETWORK);
      const account = await getAccount();

      // Perform the registration
      const result = await bnsService.registerName(account, opts.name, opts.salt);

      const fullName = opts.name.endsWith(".btc") ? opts.name : `${opts.name}.btc`;

      printJson({
        success: true,
        step: "2 of 2 (register)",
        name: fullName,
        txid: result.txid,
        network: NETWORK,
        message: `Registration submitted! Once confirmed, "${fullName}" will be registered to your address.`,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
