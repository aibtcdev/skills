#!/usr/bin/env bun
/**
 * Nostr skill CLI
 * Nostr protocol operations for AI agents — post notes, read feeds,
 * search by hashtags, manage profiles, and derive keys.
 *
 * Key derivation (default — NIP-06): m/44'/1237'/0'/0/0 → secp256k1 privkey → x-only pubkey
 * This is the standard NIP-06 path used by Alby, Damus, Amethyst, and other Nostr clients.
 * The same mnemonic produces the same npub in any NIP-06-compatible application.
 *
 * Override with --key-source:
 *   --key-source nip06    (default) BIP-39 mnemonic → m/44'/1237'/0'/0/0
 *   --key-source taproot  BIP-39 mnemonic → m/86'/0'/0'/0/0 (same key as bc1p address)
 *   --key-source stacks   BIP-39 mnemonic → m/84'/0'/0'/0/0 (backward-compat BTC segwit path)
 *
 * Usage: bun run nostr/nostr.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  finalizeEvent,
  getPublicKey,
  type EventTemplate,
  type VerifiedEvent,
} from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
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

/** NIP-06 standard derivation path for Nostr keys */
const NIP06_DERIVATION_PATH = "m/44'/1237'/0'/0/0";

/** BIP-86 Taproot derivation path (bc1p... address) */
const TAPROOT_DERIVATION_PATH = "m/86'/coin_type'/0'/0/0";

/** BIP-84 SegWit derivation path (bc1q... address, backward-compat) */
const SEGWIT_DERIVATION_PATH = "m/84'/coin_type'/0'/0/0";

/** Supported key source values for --key-source flag */
type KeySource = "nip06" | "taproot" | "stacks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive Nostr keys from the active wallet account.
 *
 * Respects the --key-source flag:
 *   nip06    (default) — account.nostrPrivateKey derived at m/44'/1237'/0'/0/0
 *   taproot  — account.taprootPrivateKey derived at m/86'/0'/0'/0/0 (x-only, same as bc1p key)
 *   stacks   — account.btcPrivateKey derived at m/84'/0'/0'/0/0 (backward-compat)
 *
 * All three key types are pre-derived during wallet unlock and stored on the Account object.
 */
function deriveNostrKeys(keySource: KeySource = "nip06"): {
  sk: Uint8Array;
  pubkey: string;
  npub: string;
  derivationPath: string;
} {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) {
    throw new Error(
      "Wallet is not unlocked. Run: bun run wallet/wallet.ts unlock --password <password>"
    );
  }

  let sk: Uint8Array;
  let derivationPath: string;

  if (keySource === "taproot") {
    if (!account.taprootPrivateKey) {
      throw new Error("Taproot private key not available in current session");
    }
    sk = account.taprootPrivateKey;
    derivationPath = TAPROOT_DERIVATION_PATH.replace("coin_type", account.network === "mainnet" ? "0" : "1");
  } else if (keySource === "stacks") {
    if (!account.btcPrivateKey) {
      throw new Error("BTC segwit private key not available in current session");
    }
    sk = account.btcPrivateKey;
    derivationPath = SEGWIT_DERIVATION_PATH.replace("coin_type", account.network === "mainnet" ? "0" : "1");
  } else {
    // nip06 (default)
    if (!account.nostrPrivateKey) {
      throw new Error("NIP-06 Nostr private key not available in current session");
    }
    sk = account.nostrPrivateKey;
    derivationPath = NIP06_DERIVATION_PATH;
  }

  const pubkey = getPublicKey(sk); // hex string (x-only, 32 bytes)
  const npub = nip19.npubEncode(pubkey);

  return { sk, pubkey, npub, derivationPath };
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
// Signal amplification helpers
// ---------------------------------------------------------------------------

interface AibtcSignal {
  thesis?: string;
  target_claim?: string;
  beat_topic?: string;
}

/** Where amplify-signal reads takes from (the Signal service, not aibtc.news). */
const SIGNAL_TAKES_URL = "https://1btc-news-api.p-d07.workers.dev/takes";

/**
 * Format a signal as a Nostr note with standard tags. The `r` (URL reference)
 * tag is added only when `sourceUrl` names where the content was actually
 * read; aibtc.news/signals/<id> links return 410 since the v5 migration (#444).
 */
function formatSignalNote(signal: {
  beat?: string;
  content: string;
  signalId?: string;
  sourceUrl?: string;
}): { content: string; tags: string[][] } {
  const parts: string[] = [];

  if (signal.beat) parts.push(`📡 ${signal.beat}`);
  parts.push(signal.content);
  if (signal.signalId) parts.push(`\nSignal: ${signal.signalId}`);
  parts.push("\n#bitcoin #aibtcnews #nostr");

  const tags: string[][] = [
    ["t", "bitcoin"],
    ["t", "aibtcnews"],
    ["t", "nostr"],
  ];
  if (signal.sourceUrl) {
    tags.push(["r", signal.sourceUrl]);
  }

  return { content: parts.join("\n"), tags };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("nostr")
  .description(
    "Nostr protocol operations — post notes, read feeds, search by hashtag tags, " +
      "get/set profiles, derive keys (NIP-06 default), and manage relay connections."
  )
  .version("0.2.0")
  .option(
    "--key-source <source>",
    "Key derivation source: nip06 (default, m/44'/1237'/0'/0/0), taproot (m/86'/0'/0'/0/0), stacks (m/84'/0'/0'/0/0)",
    "nip06"
  );

// ---------------------------------------------------------------------------
// post
// ---------------------------------------------------------------------------

program
  .command("post")
  .description("Post a kind:1 note to configured relays. Requires unlocked wallet.")
  .requiredOption("--content <text>", "Note content")
  .option("--tags <hashtags>", "Comma-separated hashtags (e.g. Bitcoin,sBTC)")
  .action(async (opts: { content: string; tags?: string }) => {
    try {
      const keySource = program.opts().keySource as KeySource;
      const { sk, pubkey } = deriveNostrKeys(keySource);

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
  .action(async (opts: { pubkey?: string; limit: string; relay?: string }) => {
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
  .action(async (opts: { tags: string; limit: string; relay?: string }) => {
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
  .action(async (opts: { pubkey: string }) => {
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
  .action(
    async (opts: {
      name?: string;
      about?: string;
      picture?: string;
      nip05?: string;
      lud16?: string;
    }) => {
      try {
        const keySource = program.opts().keySource as KeySource;
        const { sk, pubkey } = deriveNostrKeys(keySource);

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
    }
  );

// ---------------------------------------------------------------------------
// get-pubkey
// ---------------------------------------------------------------------------

program
  .command("get-pubkey")
  .description(
    "Derive and display your Nostr public key. Defaults to NIP-06 (m/44'/1237'/0'/0/0). " +
      "Use --key-source to select a different derivation path. Requires unlocked wallet."
  )
  .action(async () => {
    try {
      const keySource = program.opts().keySource as KeySource;
      const { pubkey, npub, derivationPath } = deriveNostrKeys(keySource);
      printJson({
        npub,
        hex: pubkey,
        keySource,
        derivationPath,
        note:
          keySource === "nip06"
            ? "NIP-06 standard path — compatible with Alby, Damus, Amethyst, and other Nostr clients."
            : keySource === "taproot"
            ? "Taproot x-only key — same keypair as bc1p address; externally verifiable from taproot address."
            : "BTC SegWit path (m/84') — backward-compatible with original nostr skill (pre NIP-06 update).",
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
// amplify-signal
// ---------------------------------------------------------------------------

program
  .command("amplify-signal")
  .description(
    "Fetch a take by ID from the Signal service (1btc-news-api) and broadcast it as a formatted Nostr note. Requires unlocked wallet."
  )
  .requiredOption("--signal-id <id>", "Take ID from the Signal service (GET https://1btc-news-api.p-d07.workers.dev/takes)")
  .option("--beat <name>", "Beat name for context (e.g. 'BTC Macro')")
  .option("--relays <urls>", "Comma-separated relay URLs (overrides defaults)")
  .action(async (opts: { signalId: string; beat?: string; relays?: string }) => {
    try {
      const keySource = program.opts().keySource as KeySource;
      const { sk, pubkey } = deriveNostrKeys(keySource);
      const relays = opts.relays
        ? opts.relays.split(",").map((r: string) => r.trim())
        : DEFAULT_RELAYS;

      // Fetch the take from the Signal service
      const sourceUrl = `${SIGNAL_TAKES_URL}/${encodeURIComponent(opts.signalId)}`;
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`Failed to fetch signal: ${res.status} ${res.statusText}`);
      const signal = (await res.json()) as AibtcSignal;

      const content = signal.thesis || signal.target_claim || "";
      if (!content) throw new Error("Signal has no content to amplify");

      const { content: noteContent, tags } = formatSignalNote({
        beat: opts.beat || signal.beat_topic,
        content,
        signalId: opts.signalId,
        sourceUrl,
      });

      const template: EventTemplate = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: noteContent,
      };

      const event = finalizeEvent(template, sk);
      const pool = createPool();
      const results = await publishToRelays(pool, event, relays);
      pool.close(relays);

      printJson({
        success: true,
        signalId: opts.signalId,
        eventId: event.id,
        pubkey,
        relays: results,
      });
    } catch (err) {
      handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// amplify-text
// ---------------------------------------------------------------------------

program
  .command("amplify-text")
  .description(
    "Publish signal content directly as a formatted Nostr note (no API fetch needed). Requires unlocked wallet."
  )
  .requiredOption("--content <text>", "Signal content/thesis to broadcast")
  .option("--beat <name>", "Beat name", "BTC Macro")
  .option("--signal-id <id>", "Signal ID, shown in the note body")
  .option("--relays <urls>", "Comma-separated relay URLs (overrides defaults)")
  .action(
    async (opts: {
      content: string;
      beat: string;
      signalId?: string;
      relays?: string;
    }) => {
      try {
        const keySource = program.opts().keySource as KeySource;
        const { sk, pubkey } = deriveNostrKeys(keySource);
        const relays = opts.relays
          ? opts.relays.split(",").map((r: string) => r.trim())
          : DEFAULT_RELAYS;

        const { content: noteContent, tags } = formatSignalNote({
          beat: opts.beat,
          content: opts.content,
          signalId: opts.signalId,
        });

        const template: EventTemplate = {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: noteContent,
        };

        const event = finalizeEvent(template, sk);
        const pool = createPool();
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
    }
  );

// ---------------------------------------------------------------------------

program.parse();
