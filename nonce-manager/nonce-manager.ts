#!/usr/bin/env bun
/**
 * Nonce Manager skill CLI
 * Cross-process Stacks nonce oracle — atomic acquire/release prevents mempool collisions
 *
 * Usage: bun run nonce-manager/nonce-manager.ts <subcommand> [options]
 */

import { Command } from "commander";
import { acquireNonce, releaseNonce, syncNonce, getStatus, type FailureKind } from "./nonce-store.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const program = new Command("nonce-manager")
  .description("Cross-process Stacks nonce oracle — prevents mempool collisions across skills")
  .version("1.0.0");

// ---- acquire ----

program
  .command("acquire")
  .description("Get the next nonce for a Stacks address (atomically incremented)")
  .requiredOption("--address <address>", "Stacks address")
  .action(async (options: { address: string }) => {
    try {
      const result = await acquireNonce(options.address);
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

// ---- release ----

program
  .command("release")
  .description("Mark a nonce as confirmed or failed after transaction outcome")
  .requiredOption("--address <address>", "Stacks address")
  .requiredOption("--nonce <nonce>", "Nonce value to release", parseInt)
  .option("--failed", "Mark as failed (default is success)")
  .option("--rejected", "Failure kind: tx never reached mempool, nonce can be reused")
  .option("--broadcast", "Failure kind: tx reached mempool, nonce consumed (default for --failed)")
  .action(async (options: { address: string; nonce: number; failed?: boolean; rejected?: boolean; broadcast?: boolean }) => {
    try {
      const success = !options.failed;
      const failureKind: FailureKind | undefined = !success
        ? (options.rejected ? "rejected" : "broadcast")
        : undefined;
      const result = await releaseNonce(options.address, options.nonce, success, failureKind);
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

// ---- sync ----

program
  .command("sync")
  .description("Force re-sync nonce state from Hiro API")
  .requiredOption("--address <address>", "Stacks address")
  .action(async (options: { address: string }) => {
    try {
      const result = await syncNonce(options.address);
      printJson(result);
    } catch (error) {
      handleError(error);
    }
  });

// ---- status ----

program
  .command("status")
  .description("Show current nonce state for one or all tracked addresses")
  .option("--address <address>", "Stacks address (omit for all)")
  .action(async (options: { address?: string }) => {
    try {
      const result = getStatus(options.address);
      printJson(result ?? {});
    } catch (error) {
      handleError(error);
    }
  });

program.parse();
