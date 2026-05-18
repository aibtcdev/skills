// Try claim code with BIP-137 signature
import { p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);
console.log("Address:", p2wpkh(pubKeyBytes).address);

// BIP-137 format
const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
const msgBytes = new TextEncoder().encode(MESSAGE);
const varint = msgBytes.length < 0xfd ? new Uint8Array([msgBytes.length]) : new Uint8Array([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff]);
const combined = new Uint8Array([...prefix, ...varint, ...msgBytes]);
const msgHash = sha256(sha256(combined));

const sig = secp256k1.sign(msgHash, privKeyBytes, { prehash: false, lowS: true, format: "recovered" }) as Uint8Array;
const recId = sig[0];
const header = 39 + recId; // P2WPKH base
const bip137 = new Uint8Array(65);
bip137[0] = header;
bip137.set(sig.slice(1, 33), 1);
bip137.set(sig.slice(33, 65), 33);

const sigB64 = Buffer.from(bip137).toString("base64");
console.log("Signature (BIP-137):", sigB64);

const resp = await fetch("https://aibtc.com/api/claims/code", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ btcAddress: BTC_ADDRESS, bitcoinSignature: sigB64 }),
});
const data = await resp.json();
console.log("\nResponse:", JSON.stringify(data, null, 2));
