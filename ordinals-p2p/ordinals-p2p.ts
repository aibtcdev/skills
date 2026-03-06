#!/usr/bin/env bun
/**
 * Ordinals P2P Trading skill CLI
 *
 * Agent-to-agent ordinals trading via the public trade ledger (ledger.drx4.xyz).
 * Supports offers, counters, transfers, cancellations, and PSBT atomic swaps.
 * All write operations are authenticated with BIP-137 signatures.
 *
 * Usage: bun run ordinals-p2p/ordinals-p2p.ts <subcommand> [options]
 */

import { Command } from "commander";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "@noble/hashes/utils";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { NETWORK } from "../src/lib/config/networks.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LEDGER_BASE =
  NETWORK === "testnet"
    ? "https://ledger-test.drx4.xyz"
    : "https://ledger.drx4.xyz";

const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

function parseIntSafe(value: string, name: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) throw new Error(`Invalid ${name}: ${value}`);
  return n;
}

const BIP137_HEADER_BASE = {
  P2PKH_COMPRESSED: 31,
  P2SH_P2WPKH: 35,
  P2WPKH: 39,
} as const;

// ---------------------------------------------------------------------------
// BIP-137 Signing
// ---------------------------------------------------------------------------

function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    b[1] = n & 0xff;
    b[2] = (n >> 8) & 0xff;
    return b;
  }
  throw new Error(`VarInt too large: ${n}`);
}

function formatBitcoinMessage(message: string): Uint8Array {
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const messageBytes = new TextEncoder().encode(message);
  const lengthBytes = encodeVarInt(messageBytes.length);
  const result = new Uint8Array(
    prefixBytes.length + lengthBytes.length + messageBytes.length
  );
  result.set(prefixBytes, 0);
  result.set(lengthBytes, prefixBytes.length);
  result.set(messageBytes, prefixBytes.length + lengthBytes.length);
  return result;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function ensureBytes(key: Uint8Array | string): Uint8Array {
  if (typeof key === "string") return hexToBytes(key);
  return key;
}

function signBip137(message: string, privateKey: Uint8Array, btcAddress: string): string {
  const formatted = formatBitcoinMessage(message);
  const msgHash = doubleSha256(formatted);

  const sig = secp256k1.sign(msgHash, privateKey, { lowS: true });
  const recoveryId = sig.recovery;
  const compact = sig.toCompactRawBytes(); // 64 bytes: r(32) + s(32)

  const prefix = btcAddress[0];
  let headerBase: number;
  if (prefix === "1" || prefix === "m" || prefix === "n") {
    headerBase = BIP137_HEADER_BASE.P2PKH_COMPRESSED;
  } else if (prefix === "3" || prefix === "2") {
    headerBase = BIP137_HEADER_BASE.P2SH_P2WPKH;
  } else {
    headerBase = BIP137_HEADER_BASE.P2WPKH;
  }

  const bip137Sig = new Uint8Array(65);
  bip137Sig[0] = headerBase + recoveryId;
  bip137Sig.set(compact, 1); // r(32) + s(32)

  return Buffer.from(bip137Sig).toString("base64");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function ledgerGet(path: string): Promise<any> {
  const res = await fetch(`${LEDGER_BASE}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ledger API ${res.status}: ${body}`);
  }
  return res.json();
}

async function ledgerPost(path: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${LEDGER_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Ledger API ${res.status}: ${(data as any).error || JSON.stringify(data)}`);
  }
  return data;
}

function getSignedAccount() {
  const walletManager = getWalletManager();
  const account = walletManager.getActiveAccount();
  if (!account) throw new Error("Wallet is not unlocked.");
  if (!account.btcAddress || !account.btcPrivateKey) {
    throw new Error("Bitcoin keys not available. Unlock your wallet.");
  }
  return {
    ...account,
    btcPrivateKey: ensureBytes(account.btcPrivateKey),
  };
}

function buildAuthFields(
  type: string,
  inscriptionId: string,
  account: ReturnType<typeof getSignedAccount>
) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
  const message = `ordinals-ledger | ${type} | ${account.btcAddress} | ${inscriptionId} | ${timestamp}`;
  const signature = signBip137(message, account.btcPrivateKey, account.btcAddress);
  return {
    from_agent: account.btcAddress,
    from_stx_address: account.address,
    signature,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("ordinals-p2p")
  .description(
    "Peer-to-peer ordinals trading on the trade ledger (ledger.drx4.xyz)"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-trades
// ---------------------------------------------------------------------------

program
  .command("list-trades")
  .description("Browse the public trade ledger with filters.")
  .option("--type <type>", "Filter by type: offer, counter, transfer, cancel, psbt_swap")
  .option("--agent <addr>", "Filter by agent BTC address")
  .option("--inscription <id>", "Filter by inscription ID")
  .option("--status <status>", "Filter by status: open, completed, cancelled, countered")
  .option("--limit <n>", "Results per page", "50")
  .option("--offset <n>", "Pagination offset", "0")
  .action(async (opts) => {
    try {
      const params = new URLSearchParams();
      if (opts.type) params.set("type", opts.type);
      if (opts.agent) params.set("agent", opts.agent);
      if (opts.inscription) params.set("inscription", opts.inscription);
      if (opts.status) params.set("status", opts.status);
      params.set("limit", opts.limit);
      params.set("offset", opts.offset);
      const data = await ledgerGet(`/api/trades?${params}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-trade
// ---------------------------------------------------------------------------

program
  .command("get-trade")
  .description("Get a single trade with related counters/transfers.")
  .requiredOption("--id <tradeId>", "Trade ID")
  .action(async (opts) => {
    try {
      const data = await ledgerGet(`/api/trades/${opts.id}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// create-offer
// ---------------------------------------------------------------------------

program
  .command("create-offer")
  .description("List an inscription for sale. Requires unlocked wallet.")
  .requiredOption("--inscription <id>", "Inscription ID ({txid}i{index})")
  .option("--amount <sats>", "Asking price in satoshis")
  .option("--to <addr>", "Buyer BTC address (optional)")
  .option("--metadata <text>", "Optional metadata")
  .action(async (opts) => {
    try {
      const account = getSignedAccount();
      const auth = buildAuthFields("offer", opts.inscription, account);
      const body: Record<string, any> = {
        type: "offer",
        ...auth,
        inscription_id: opts.inscription,
      };
      if (opts.amount) body.amount_sats = parseIntSafe(opts.amount, "amount");
      if (opts.to) body.to_agent = opts.to;
      if (opts.metadata) body.metadata = opts.metadata;
      const data = await ledgerPost("/api/trades", body);
      printJson({ success: true, ...data });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// counter
// ---------------------------------------------------------------------------

program
  .command("counter")
  .description("Counter an existing offer with a different price.")
  .requiredOption("--parent <tradeId>", "Parent trade ID to counter")
  .requiredOption("--inscription <id>", "Inscription ID")
  .requiredOption("--amount <sats>", "Counter-offer price in satoshis")
  .option("--metadata <text>", "Optional metadata")
  .action(async (opts) => {
    try {
      const account = getSignedAccount();
      const auth = buildAuthFields("counter", opts.inscription, account);
      const body: Record<string, any> = {
        type: "counter",
        ...auth,
        inscription_id: opts.inscription,
        parent_trade_id: parseIntSafe(opts.parent, "parent trade ID"),
        amount_sats: parseIntSafe(opts.amount, "amount"),
      };
      if (opts.metadata) body.metadata = opts.metadata;
      const data = await ledgerPost("/api/trades", body);
      printJson({ success: true, ...data });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description("Record a completed inscription transfer.")
  .requiredOption("--inscription <id>", "Inscription ID")
  .requiredOption("--to <addr>", "Recipient BTC address")
  .option("--tx-hash <txid>", "On-chain transaction hash (optional for sBTC/off-chain transfers)")
  .option("--parent <tradeId>", "Parent trade ID (if closing an offer)")
  .option("--amount <sats>", "Amount in satoshis")
  .option("--metadata <text>", "Optional metadata")
  .action(async (opts) => {
    try {
      const account = getSignedAccount();
      const auth = buildAuthFields("transfer", opts.inscription, account);
      const body: Record<string, any> = {
        type: "transfer",
        ...auth,
        inscription_id: opts.inscription,
        to_agent: opts.to,
      };
      if (opts.txHash) body.tx_hash = opts.txHash;
      if (opts.parent) body.parent_trade_id = parseIntSafe(opts.parent, "parent trade ID");
      if (opts.amount) body.amount_sats = parseIntSafe(opts.amount, "amount");
      if (opts.metadata) body.metadata = opts.metadata;
      const data = await ledgerPost("/api/trades", body);
      printJson({ success: true, ...data });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

program
  .command("cancel")
  .description("Cancel an open offer or counter. Only parties may cancel.")
  .requiredOption("--parent <tradeId>", "Trade ID to cancel")
  .requiredOption("--inscription <id>", "Inscription ID")
  .option("--metadata <text>", "Optional metadata")
  .action(async (opts) => {
    try {
      const account = getSignedAccount();
      const auth = buildAuthFields("cancel", opts.inscription, account);
      const body: Record<string, any> = {
        type: "cancel",
        ...auth,
        inscription_id: opts.inscription,
        parent_trade_id: parseIntSafe(opts.parent, "parent trade ID"),
      };
      if (opts.metadata) body.metadata = opts.metadata;
      const data = await ledgerPost("/api/trades", body);
      printJson({ success: true, ...data });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// psbt-swap
// ---------------------------------------------------------------------------

program
  .command("psbt-swap")
  .description("Record a completed PSBT atomic swap.")
  .requiredOption("--inscription <id>", "Inscription ID")
  .requiredOption("--to <addr>", "Counterparty BTC address")
  .requiredOption("--amount <sats>", "Swap amount in satoshis")
  .requiredOption("--tx-hash <txid>", "Atomic swap transaction hash")
  .option("--metadata <text>", "Optional metadata")
  .action(async (opts) => {
    try {
      const account = getSignedAccount();
      const auth = buildAuthFields("psbt_swap", opts.inscription, account);
      const body: Record<string, any> = {
        type: "psbt_swap",
        ...auth,
        inscription_id: opts.inscription,
        to_agent: opts.to,
        amount_sats: parseIntSafe(opts.amount, "amount"),
        tx_hash: opts.txHash,
      };
      if (opts.metadata) body.metadata = opts.metadata;
      const data = await ledgerPost("/api/trades", body);
      printJson({ success: true, ...data });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// my-trades
// ---------------------------------------------------------------------------

program
  .command("my-trades")
  .description("List trades involving the active wallet (or a given address).")
  .option("--address <btcAddr>", "BTC address to query (defaults to active wallet)")
  .option("--status <status>", "Filter by status")
  .option("--limit <n>", "Results per page", "50")
  .action(async (opts) => {
    try {
      let addr = opts.address;
      if (!addr) {
        try {
          addr = getSignedAccount().btcAddress!;
        } catch {
          handleError(new Error("Provide --address <btcAddr> or unlock your wallet first."));
          return;
        }
      }
      const params = new URLSearchParams();
      params.set("agent", addr);
      if (opts.status) params.set("status", opts.status);
      params.set("limit", opts.limit);
      const data = await ledgerGet(`/api/trades?${params}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

program
  .command("agents")
  .description("List agents registered on the trade ledger.")
  .option("--limit <n>", "Results per page", "50")
  .action(async (opts) => {
    try {
      const data = await ledgerGet(`/api/agents?limit=${opts.limit}`);
      printJson(data);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
