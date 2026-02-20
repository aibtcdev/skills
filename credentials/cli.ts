#!/usr/bin/env bun
/**
 * Credentials skill CLI
 * AES-256-GCM encrypted credential storage at ~/.aibtc/credentials.json
 *
 * Usage: bun run credentials/cli.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  addCredential,
  getCredential,
  listCredentials,
  deleteCredential,
  rotatePassword,
} from "./store.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("credentials")
  .description(
    "AES-256-GCM encrypted credential storage. Store, retrieve, and manage named secrets."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

program
  .command("add")
  .description("Add or update an encrypted credential")
  .requiredOption("--id <id>", "Credential identifier (e.g. hiro-api-key)")
  .requiredOption("--value <value>", "Plaintext secret value (sensitive)")
  .requiredOption("--password <password>", "Master password for encryption (sensitive)")
  .option("--label <label>", "Human-readable label (default: same as id)")
  .option("--category <category>", "Category tag (e.g. api-key, token, url, secret)", "secret")
  .action(
    async (opts: {
      id: string;
      value: string;
      password: string;
      label?: string;
      category: string;
    }) => {
      try {
        const cred = await addCredential(
          opts.id,
          opts.value,
          opts.password,
          opts.label,
          opts.category
        );
        printJson({
          success: true,
          id: cred.id,
          label: cred.label,
          category: cred.category,
          createdAt: cred.createdAt,
          updatedAt: cred.updatedAt,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

program
  .command("get")
  .description("Decrypt and retrieve a credential value")
  .requiredOption("--id <id>", "Credential identifier")
  .requiredOption("--password <password>", "Master password for decryption (sensitive)")
  .action(async (opts: { id: string; password: string }) => {
    try {
      const cred = await getCredential(opts.id, opts.password);
      printJson({
        id: cred.id,
        label: cred.label,
        category: cred.category,
        value: cred.value,
        createdAt: cred.createdAt,
        updatedAt: cred.updatedAt,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command("list")
  .description("List all credential IDs and labels (no secret values returned)")
  .action(async () => {
    try {
      const credentials = await listCredentials();
      printJson({
        count: credentials.length,
        credentials,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

program
  .command("delete")
  .description("Permanently delete a credential (requires password + confirmation)")
  .requiredOption("--id <id>", "Credential identifier to delete")
  .requiredOption("--password <password>", "Master password (sensitive)")
  .requiredOption(
    "--confirm <word>",
    'Must be exactly "DELETE" to confirm permanent deletion'
  )
  .action(
    async (opts: { id: string; password: string; confirm: string }) => {
      try {
        if (opts.confirm !== "DELETE") {
          handleError(
            new Error(
              'Confirmation required: pass --confirm DELETE to permanently delete a credential'
            )
          );
        }
        await deleteCredential(opts.id, opts.password);
        printJson({
          success: true,
          deleted: opts.id,
          message: `Credential "${opts.id}" has been permanently deleted.`,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// rotate-password
// ---------------------------------------------------------------------------

program
  .command("rotate-password")
  .description("Re-encrypt all credentials with a new master password")
  .requiredOption("--old-password <password>", "Current master password (sensitive)")
  .requiredOption("--new-password <password>", "New master password, min 8 chars (sensitive)")
  .action(async (opts: { oldPassword: string; newPassword: string }) => {
    try {
      const count = await rotatePassword(opts.oldPassword, opts.newPassword);
      printJson({
        success: true,
        message: `Password rotated. ${count} credential${count === 1 ? "" : "s"} re-encrypted.`,
        count,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parseAsync(process.argv);
