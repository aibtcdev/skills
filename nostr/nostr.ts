#!/usr/bin/env bun
/**
 * Nostr skill CLI
 * Nostr protocol operations for AI agents — post notes, read feeds,
 * search by hashtags, manage profiles, and derive keys.
 *
 * Key derivation (BTC-shared): BIP84 m/84'/0'/0'/0/0 → secp256k1 privkey → x-only pubkey
 * Same keypair as BTC wallet (npub ↔ taproot address share the same key).
 * NOTE: This is NOT NIP-06 (which uses m/44'/1237'/0'/0/0). We intentionally
 * reuse the BTC key so the agent has a single identity across both protocols.
 *
 * Usage: bun run nostr/nostr.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  finalizeEvent,
  getPublicKey,
  nip19,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools/filter";
import WebSocket from "ws";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

const WS_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Key Derivation (BTC-shared)
 *
 * BIP39 mnemonic → BIP32 seed → m/84'/0'/0'/0/0 → 32-byte secp256k1 private key
 *
 * The private key is used directly as the Nostr secret key (sk).
 * The x-only public key (32 bytes) is the Nostr pubkey.
 *
 * This is the same key used for the BTC taproot address, so:
 *   npub ↔ BTC address share the same underlying keypair.
 *
 * NOTE: This is NOT NIP-06 derivation (which uses m/44'/1237'/0'/0/0).
 * The BTC path is intentional — agents get a shared identity across
 * Bitcoin and Nostr from a single mnemonic.
 */
function deriveNostrKeys(): { sk: Uint8Array; pubkey: string; npub: string } {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Run: bun run wallet/wallet.ts unlock --password <password>"
    );
  }

  // The BIP84 derivation at m/84'/0'/0'/0/0 gives us a secp256k1 private key.
  // We use the raw 32-byte private key as the Nostr secret key.
  const sk = account.privateKey; // Uint8Array (32 bytes)
  const pubkey = getPublicKey(sk); // hex string (x-only, 32 bytes)
  const npub = nip19.npubEncode(pubkey);

  return { sk, pubkey, npub };
}

/**
 * Resolve a pubkey that may be hex or npub to hex format.
 */
function resolveHexPubkey(input: string): string {
  if (input.startsWith("npub")) {
    const { data } = nip19.decode(input);
    return data as string;
  }
  return input;
}

/**
 * Create a SimplePool with WebSocket polyfill for Node/Bun environments.
 */
function createPool(): SimplePool {
  // nostr-tools SimplePool needs a WebSocket implementation in non-browser envs
  (globalThis as any).WebSocket = WebSocket;
  return new SimplePool();
}

/**
 * Publish an event to relays and return per-relay status.
 */
async function publishToRelays(
  pool: SimplePool,
  event: VerifiedEvent,
  relays: string[]
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const promises = relays.map(async (relay) => {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), WS_TIMEOUT_MS)
      );
      // pool.publish returns Promise<string>[] in nostr-tools v2+
      const pubPromises = pool.publish([relay], event);
      await Promise.race([...pubPromises, timeoutPromise]);
      results[relay] = "ok";
    } catch (err: any) {
      results[relay] = `error: ${err.message}`;
    }
  });
  await Promise.allSettled(promises);
  return results;
}

/**
 * Query relays for events matching a filter.
 */
async function queryRelays(
  pool: SimplePool,
  relays: string[],
  filter: Filter
): Promise<any[]> {
  const events = await Promise.race([
    pool.querySync(relays, filter),
    new Promise<any[]>((_, reject) =>
      setTimeout(() => reject(new Error("query timeout")), WS_TIMEOUT_MS * 2)
    ),
  ]);
  return events;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("nostr")
  .description(
    "Nostr protocol operations — post notes, read feeds, search by hashtag tags, " +
      "get/set profiles, derive keys (BTC-shared path), and manage relay connections."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------

program
  .command("post")
  .description("Post a kind:1 note to configured relays. Requires unlocked wallet.")
  .requiredOption("--content <text>", "Note content")
  .option("--tags <hashtags>", "Comma-separated hashtags (e.g. Bitcoin,sBTC)")
  .action(async (opts) => {
    try {
      const { sk, pubkey } = deriveNostrKeys();

      const tags: string[][] = [];
      if (opts.tags) {
        for (const t of opts.tags.split(",")) {
          tags.push(["t", t.trim().toLowerCase()]);
        }
      }

      const template: EventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: opts.content,
      };

      const event = finalizeEvent(template, sk);
      const pool = createPool();
      const relays = DEFAULT_RELAYS;
      const results = await publishToRelays(pool, event, relays);

      pool.close(relays);
      printJson({
        success: true,
        eventId: event.id,
        pubkey,
        relays: results,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// read-feed
// ---------------------------------------------------------------------------

program
  .command("read-feed")
  .description("Read recent notes from relays. No wallet required.")
  .option("--pubkey <hex-or-npub>", "Filter by author pubkey")
  .option("--limit <n>", "Max notes to fetch", "20")
  .option("--relay <url>", "Override relay URL")
  .action(async (opts) => {
    try {
      const pool = createPool();
      const relays = opts.relay ? [opts.relay] : DEFAULT_RELAYS;
      const filter: Filter = {
        kinds: [1],
        limit: parseInt(opts.limit, 10),
      };
      if (opts.pubkey) {
        filter.authors = [resolveHexPubkey(opts.pubkey)];
      }

      const events = await queryRelays(pool, relays, filter);
      pool.close(relays);

      const notes = events
        .sort((a: any, b: any) => b.created_at - a.created_at)
        .map((e: any) => ({
          id: e.id,
          pubkey: e.pubkey,
          content: e.content,
          created_at: e.created_at,
          tags: e.tags,
        }));

      printJson(notes);
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// search-tags
// ---------------------------------------------------------------------------

program
  .command("search-tags")
  .description(
    "Search notes by hashtag tags using NIP-12 #t filter. " +
      "Does NOT use NIP-50 search — most relays don't support it."
  )
  .requiredOption("--tags <hashtags>", "Comma-separated hashtags to search")
  .option("--limit <n>", "Max notes to fetch", "20")
  .option("--relay <url>", "Override relay URL")
  .action(async (opts) => {
    try {
      const pool = createPool();
      const relays = opts.relay ? [opts.relay] : DEFAULT_RELAYS;
      const hashtags = opts.tags.split(",").map((t: string) => t.trim().toLowerCase());

      const filter: Filter = {
        kinds: [1],
        "#t": hashtags,
        limit: parseInt(opts.limit, 10),
      };

      const events = await queryRelays(pool, relays, filter);
      pool.close(relays);

      const notes = events
        .sort((a: any, b: any) => b.created_at - a.created_at)
        .map((e: any) => ({
          id: e.id,
          pubkey: e.pubkey,
          content: e.content,
          created_at: e.created_at,
          tags: e.tags,
        }));

      printJson(notes);
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// get-profile
// ---------------------------------------------------------------------------

program
  .command("get-profile")
  .description("Get a user's kind:0 profile metadata.")
  .requiredOption("--pubkey <hex-or-npub>", "User pubkey (hex or npub)")
  .action(async (opts) => {
    try {
      const pool = createPool();
      const relays = DEFAULT_RELAYS;
      const pubkey = resolveHexPubkey(opts.pubkey);

      const filter: Filter = {
        kinds: [0],
        authors: [pubkey],
        limit: 1,
      };

      const events = await queryRelays(pool, relays, filter);
      pool.close(relays);

      if (events.length === 0) {
        printJson({ error: "Profile not found", pubkey });
        return;
      }

      // kind:0 content is a JSON string with profile metadata
      const profile = JSON.parse(events[0].content);
      printJson({ pubkey, ...profile });
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// set-profile
// ---------------------------------------------------------------------------

program
  .command("set-profile")
  .description("Set your kind:0 profile metadata. Requires unlocked wallet.")
  .option("--name <name>", "Display name")
  .option("--about <about>", "About/bio text")
  .option("--picture <url>", "Profile picture URL")
  .option("--nip05 <nip05>", "NIP-05 identifier (e.g. user@domain.com)")
  .option("--lud16 <lud16>", "Lightning address (e.g. user@getalby.com)")
  .action(async (opts) => {
    try {
      const { sk, pubkey } = deriveNostrKeys();

      // Fetch existing profile to merge (kind:0 is replaceable — publishing
      // a new event wipes fields not included). This prevents set-profile
      // --name "foo" from deleting about, picture, etc.
      const pool = createPool();
      const relays = DEFAULT_RELAYS;
      let existing: Record<string, string> = {};
      try {
        const profileEvents = await queryRelays(pool, relays, {
          kinds: [0],
          authors: [pubkey],
          limit: 1,
        });
        if (profileEvents.length > 0) {
          existing = JSON.parse(profileEvents[0].content);
        }
      } catch {
        // If fetch fails, proceed with empty — user's new fields will still apply
      }

      const content: Record<string, string> = { ...existing };
      if (opts.name) content.name = opts.name;
      if (opts.about) content.about = opts.about;
      if (opts.picture) content.picture = opts.picture;
      if (opts.nip05) content.nip05 = opts.nip05;
      if (opts.lud16) content.lud16 = opts.lud16;

      const template: EventTemplate = {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify(content),
      };

      const event = finalizeEvent(template, sk);
      const results = await publishToRelays(pool, event, relays);

      pool.close(relays);
      printJson({
        success: true,
        eventId: event.id,
        pubkey,
        profile: content,
        relays: results,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// get-pubkey
// ---------------------------------------------------------------------------

program
  .command("get-pubkey")
  .description(
    "Derive and display your Nostr public key from the BIP84 wallet (BTC-shared key). " +
      "Requires unlocked wallet."
  )
  .action(async () => {
    try {
      const { pubkey, npub } = deriveNostrKeys();
      printJson({
        npub,
        hex: pubkey,
        derivationPath: "m/84'/0'/0'/0/0",
        note: "Same secp256k1 key as BTC wallet. x-only pubkey used for Nostr identity.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// relay-list
// ---------------------------------------------------------------------------

program
  .command("relay-list")
  .description("List configured relay URLs.")
  .action(() => {
    printJson({
      relays: DEFAULT_RELAYS,
      note: "relay.nostr.band is often unreachable from sandboxed environments. Prefer damus + nos.lol.",
    });
  });

// ---------------------------------------------------------------------------

program.parse();
