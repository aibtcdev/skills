import { hex, base64 } from "@scure/base";
import { p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

// Derive BTC key at m/84'/0'/0'/0/0
const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);

// Verify address
const p2wpkhOutput = p2wpkh(pubKeyBytes);
console.log("BTC address:", p2wpkhOutput.address);
console.log("Match:", p2wpkhOutput.address === BTC_ADDRESS);

// BIP-137 message: "\x18Bitcoin Signed Message:\n" + varInt(msg.length) + msg
// The \x18 is the varint for 24 (length of "Bitcoin Signed Message:\n")
const BITCOIN_MSG_PREFIX = "\x18Bitcoin Signed Message:\n";

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const b = new Uint8Array(3);
  b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >> 8) & 0xff;
  return b;
}

const msgBytes = new TextEncoder().encode(MESSAGE);
const prefixBytes = new TextEncoder().encode(BITCOIN_MSG_PREFIX);
const lengthBytes = varInt(msgBytes.length);

const concat = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { result.set(a, off); off += a.length; }
  return result;
};

const formattedMsg = concat(prefixBytes, lengthBytes, msgBytes);
const msgHash = sha256(sha256(formattedMsg));
console.log("Message hash:", hex.encode(msgHash));

// Sign with secp256k1 using "recovered" format: [recoveryId, r (32), s (32)]
const sigWithRecovery = secp256k1.sign(msgHash, privKeyBytes, {
  prehash: false,
  lowS: true,
  format: "recovered",
}) as Uint8Array;

const recId = sigWithRecovery[0];
// BIP-137 header byte for P2WPKH (bc1q native SegWit): base 39
const header = 39 + recId;
console.log("Header byte:", header, "recovery id:", recId);

const rBytes = sigWithRecovery.slice(1, 33);
const sBytes = sigWithRecovery.slice(33, 65);

const bip137Sig = new Uint8Array(65);
bip137Sig[0] = header;
bip137Sig.set(rBytes, 1);
bip137Sig.set(sBytes, 33);

const signatureBase64 = Buffer.from(bip137Sig).toString("base64");
console.log("BIP-137 signature (base64):", signatureBase64);
console.log("Sig length:", bip137Sig.length, "(should be 65)");
console.log("First byte:", bip137Sig[0], "(should be 39-42)");

// POST to get claim code
const response = await fetch("https://aibtc.com/api/claims/code", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    btcAddress: BTC_ADDRESS,
    bitcoinSignature: signatureBase64,
  }),
});

const data = await response.json();
console.log("\nClaim code response:", JSON.stringify(data, null, 2));
