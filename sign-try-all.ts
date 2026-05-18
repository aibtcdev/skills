import { hex } from "@scure/base";
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

// BIP-137 message hash
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";
function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const b = new Uint8Array(3);
  b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >> 8) & 0xff;
  return b;
}
const msgBytes = new TextEncoder().encode(MESSAGE);
const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
const formattedMsg = new Uint8Array([...prefixBytes, ...encodeVarInt(msgBytes.length), ...msgBytes]);
const msgHash = sha256(sha256(formattedMsg));

const sigWithRecovery = secp256k1.sign(msgHash, privKeyBytes, {
  prehash: false, lowS: true, format: "recovered",
}) as Uint8Array;

const recId = sigWithRecovery[0];
const rBytes = sigWithRecovery.slice(1, 33);
const sBytes = sigWithRecovery.slice(33, 65);

// Try all possible header bytes for P2WPKH: 39-42
const headerBases = [
  { name: "P2PKH compressed", base: 31 },
  { name: "P2SH-P2WPKH", base: 35 },
  { name: "P2WPKH", base: 39 },
];

for (const { name, base } of headerBases) {
  const header = base + recId;
  const bip137Sig = new Uint8Array(65);
  bip137Sig[0] = header;
  bip137Sig.set(rBytes, 1);
  bip137Sig.set(sBytes, 33);
  const sigB64 = Buffer.from(bip137Sig).toString("base64");
  const sigHex = hex.encode(bip137Sig);

  // Try as base64
  const r1 = await fetch("https://aibtc.com/api/claims/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ btcAddress: BTC_ADDRESS, bitcoinSignature: sigB64 }),
  });
  const d1 = await r1.json();
  console.log(`${name} (h=${header}) b64:`, JSON.stringify(d1));

  // Try as hex
  const r2 = await fetch("https://aibtc.com/api/claims/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ btcAddress: BTC_ADDRESS, bitcoinSignature: sigHex }),
  });
  const d2 = await r2.json();
  console.log(`${name} (h=${header}) hex:`, JSON.stringify(d2));
}
