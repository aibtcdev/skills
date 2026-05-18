#!/usr/bin/env bun
/**
 * claim-beat.ts — Claim a beat on aibtc.news using BIP-137 signature
 * Usage: bun run claim-beat.ts <beat-slug>
 */

import { p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const NEWS_BASE = "https://aibtc.news";

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;

const [, , beatSlug] = process.argv;
if (!beatSlug) {
  console.error("Usage: bun run claim-beat.ts <beat-slug>");
  process.exit(1);
}

const timestamp = Math.floor(Date.now() / 1000);
const MESSAGE = `PATCH /api/beats/${beatSlug}:${timestamp}`;
console.log("Signing:", MESSAGE);

// BIP-137 signing
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";
function varInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const b = new Uint8Array(3);
  b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >> 8) & 0xff;
  return b;
}
const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { result.set(a, off); off += a.length; }
  return result;
};
const msgBytes = new TextEncoder().encode(MESSAGE);
const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
const lengthBytes = varInt(msgBytes.length);
const formattedMsg = concat(prefixBytes, lengthBytes, msgBytes);
const msgHash = sha256(sha256(formattedMsg));

const sigResult = secp256k1.sign(msgHash, privKeyBytes, { prehash: false, lowS: true, format: "recovered" }) as Uint8Array;
const recId = sigResult[0];
const header = 39 + recId; // P2WPKH native segwit
const bip137Sig = new Uint8Array(65);
bip137Sig[0] = header;
bip137Sig.set(sigResult.slice(1, 33), 1);
bip137Sig.set(sigResult.slice(33, 65), 33);
const signature = Buffer.from(bip137Sig).toString("base64");
console.log("Signature (65 bytes, BIP-137):", signature.slice(0, 20) + "...");

// PATCH the beat to claim it
const res = await fetch(`${NEWS_BASE}/api/beats/${beatSlug}`, {
  method: "PATCH",
  headers: {
    "Content-Type": "application/json",
    "X-BTC-Address": BTC_ADDRESS,
    "X-BTC-Signature": signature,
    "X-BTC-Timestamp": String(timestamp),
  },
  body: JSON.stringify({ btc_address: BTC_ADDRESS }),
});

const data = await res.json();
console.log("Status:", res.status);
console.log(JSON.stringify(data, null, 2));
