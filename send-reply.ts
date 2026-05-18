#!/usr/bin/env bun
/**
 * send-reply.ts — Reply to an AIBTC inbox message (free, BIP-137 signature)
 * Usage: bun run send-reply.ts <messageId> "<reply text>"
 *
 * Signs "Inbox Reply | {messageId} | {reply text}" with BIP-137 and POSTs to outbox.
 * Max 500 chars total for the signing string.
 */

import { p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC =
  "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const OUTBOX_URL = `https://aibtc.com/api/outbox/${BTC_ADDRESS}`;

const [, , messageId, replyText] = process.argv;

if (!messageId || !replyText) {
  console.error(
    JSON.stringify({ error: "Usage: bun run send-reply.ts <messageId> '<reply text>'" })
  );
  process.exit(1);
}

// Compute max reply length so total signing string <= 500 chars
const PREFIX = `Inbox Reply | ${messageId} | `;
const MAX_REPLY = 500 - PREFIX.length;
const reply = replyText.length > MAX_REPLY ? replyText.slice(0, MAX_REPLY - 3) + "..." : replyText;
const signingString = `${PREFIX}${reply}`;

console.log(`Signing string (${signingString.length} chars): ${signingString}`);

// Derive BTC key
const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);
const derivedAddress = p2wpkh(pubKeyBytes).address;
console.log(`Derived address: ${derivedAddress}`);
if (derivedAddress !== BTC_ADDRESS) {
  console.error(JSON.stringify({ error: `Address mismatch: ${derivedAddress} != ${BTC_ADDRESS}` }));
  process.exit(1);
}

// BIP-137 sign
const prefixBytes = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
const msgBytes = new TextEncoder().encode(signingString);
const varint =
  msgBytes.length < 0xfd
    ? new Uint8Array([msgBytes.length])
    : new Uint8Array([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff]);
const combined = new Uint8Array([...prefixBytes, ...varint, ...msgBytes]);
const msgHash = sha256(sha256(combined));

const sig = secp256k1.sign(msgHash, privKeyBytes, {
  prehash: false,
  lowS: true,
  format: "recovered",
}) as Uint8Array;
const recId = sig[0];
const header = 39 + recId; // P2WPKH base
const bip137 = new Uint8Array(65);
bip137[0] = header;
bip137.set(sig.slice(1, 33), 1);
bip137.set(sig.slice(33, 65), 33);

const signature = Buffer.from(bip137).toString("base64");
console.log(`Signature: ${signature}`);

// Write to temp file and POST
const body = { messageId, reply, signature };
const tmpFile = `/tmp/reply-${Date.now()}.json`;
await Bun.write(tmpFile, JSON.stringify(body));
console.log(`Posting to ${OUTBOX_URL}...`);

const res = await fetch(OUTBOX_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const responseText = await res.text();
let responseData: unknown;
try {
  responseData = JSON.parse(responseText);
} catch {
  responseData = { raw: responseText };
}

if (res.status === 201 || res.status === 200) {
  console.log(JSON.stringify({ success: true, status: res.status, response: responseData }, null, 2));
  process.exit(0);
}

console.error(
  JSON.stringify({ error: `Reply failed (${res.status})`, response: responseData })
);
process.exit(1);
