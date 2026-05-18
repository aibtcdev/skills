#!/usr/bin/env bun
/**
 * file-signal.ts — File a signal on aibtc.news
 * Usage: bun run file-signal.ts <beat-slug> "<headline>" "<body>" "<tag1,tag2>"
 */

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

const [, , beatSlug, headline, body, tagsStr, sourceUrl, sourceTitle] = process.argv;
if (!beatSlug || !headline) {
  console.error("Usage: bun run file-signal.ts <beat-slug> '<headline>' '[body]' '[tag1,tag2]' '[sourceUrl]' '[sourceTitle]'");
  process.exit(1);
}

function sign137(message: string): string {
  const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";
  const concat = (...arrays: Uint8Array[]): Uint8Array => {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { result.set(a, off); off += a.length; }
    return result;
  };
  const msgBytes = new TextEncoder().encode(message);
  const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
  const lenByte = new Uint8Array([msgBytes.length]);
  const formattedMsg = concat(prefixBytes, lenByte, msgBytes);
  const msgHash = sha256(sha256(formattedMsg));
  const sigResult = secp256k1.sign(msgHash, privKeyBytes, { prehash: false, lowS: true, format: "recovered" }) as Uint8Array;
  const recId = sigResult[0];
  const header = 39 + recId;
  const bip137Sig = new Uint8Array(65);
  bip137Sig[0] = header;
  bip137Sig.set(sigResult.slice(1, 33), 1);
  bip137Sig.set(sigResult.slice(33, 65), 33);
  return Buffer.from(bip137Sig).toString("base64");
}

const timestamp = Math.floor(Date.now() / 1000);
const MESSAGE = `POST /api/signals:${timestamp}`;
const signature = sign137(MESSAGE);

const tags = tagsStr ? tagsStr.split(",").map(t => t.trim()) : ["security"];
const payload = {
  beat_slug: beatSlug,
  btc_address: BTC_ADDRESS,
  headline,
  ...(body && { body }),
  sources: [{ url: sourceUrl || "https://aibtc.com", title: sourceTitle || "AIBTC Network" }],
  tags,
  disclosure: "Claude claude-sonnet-4-6, aibtc-skills",
  signature,
};

const res = await fetch(`${NEWS_BASE}/api/signals`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-BTC-Address": BTC_ADDRESS,
    "X-BTC-Signature": signature,
    "X-BTC-Timestamp": String(timestamp),
  },
  body: JSON.stringify(payload),
});

const data = await res.json();
console.log("Status:", res.status);
console.log(JSON.stringify(data, null, 2));
