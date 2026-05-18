#!/usr/bin/env bun
/**
 * Direct signal filing script — bypasses wallet CLI subprocess issue.
 * Signs BIP-322 inline from mnemonic (same approach as heartbeat3.ts).
 *
 * Usage: bun run file-signal-direct.ts --beat <slug> --headline <text> --content <text> [--sources <json>] [--tags <json>] [--disclosure <text>]
 */
import { p2wpkh, Transaction, RawTx, RawWitness, Script } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hashSha256Sync } from "@stacks/encryption";
import { concatBytes } from "@stacks/common";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const NEWS_API_BASE = "https://aibtc.news/api";

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);
const p2wpkhOutput = p2wpkh(pubKeyBytes);
const scriptPubKey = p2wpkhOutput.script;

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = hashSha256Sync(new TextEncoder().encode(tag));
  return hashSha256Sync(concatBytes(tagHash, tagHash, data));
}

function bip322TaggedHash(message: string): Uint8Array {
  return taggedHash("BIP0322-signed-message", new TextEncoder().encode(message));
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

function bip322BuildToSpendTxId(message: string, spk: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const rawTx = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 }],
    outputs: [{ amount: 0n, script: spk }],
    witnesses: [],
    lockTime: 0,
  });
  return doubleSha256(rawTx).reverse();
}

function signBip322(message: string): string {
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);
  const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  toSignTx.addInput({
    txid: toSpendTxid, index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: scriptPubKey },
  });
  toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
  toSignTx.signIdx(privKeyBytes, 0);
  toSignTx.finalizeIdx(0);
  const input = toSignTx.getInput(0);
  if (!input.finalScriptWitness) throw new Error("No witness produced");
  const encodedWitness = RawWitness.encode(input.finalScriptWitness);
  return Buffer.from(encodedWitness).toString("base64");
}

// Parse args
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const beat = getArg("--beat");
const headline = getArg("--headline");
const content = getArg("--content");
const sourcesRaw = getArg("--sources") ?? "[]";
const tagsRaw = getArg("--tags") ?? "[]";
const disclosureRaw = getArg("--disclosure");

if (!beat || !headline || !content) {
  console.error("Usage: bun run file-signal-direct.ts --beat <slug> --headline <text> --content <text>");
  process.exit(1);
}

const timestamp = Math.floor(Date.now() / 1000);
const message = `POST /api/signals:${timestamp}`;
console.log(`Signing message: ${message}`);

const signature = signBip322(message);
console.log(`Signature: ${signature.substring(0, 40)}...`);

const body: Record<string, unknown> = {
  beat_slug: beat,
  btc_address: BTC_ADDRESS,
  headline,
  content,
  sources: JSON.parse(sourcesRaw),
  tags: JSON.parse(tagsRaw),
};

if (disclosureRaw) body.disclosure = disclosureRaw;

console.log("\nRequest body:", JSON.stringify(body, null, 2));

console.log(`\nFiling signal to beat: ${beat}`);
console.log(`Headline: ${headline}`);
console.log(`Content length: ${content.length} chars`);

const res = await fetch(`${NEWS_API_BASE}/signals`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-BTC-Address": BTC_ADDRESS,
    "X-BTC-Signature": signature,
    "X-BTC-Timestamp": String(timestamp),
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`\nResponse ${res.status}:`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
