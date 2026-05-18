import { hex } from "@scure/base";
import { p2wpkh, p2pkh } from "@scure/btc-signer";
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
console.log("Private key:", hex.encode(privKeyBytes));
console.log("Public key:", hex.encode(pubKeyBytes));
console.log("BTC P2WPKH address:", p2wpkh(pubKeyBytes).address);
console.log("BTC P2PKH address:", p2pkh(pubKeyBytes).address);

// BIP-137 sign
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
const header = 39 + recId; // P2WPKH base
console.log("\nBIP-137 header:", header, "recId:", recId);

// Now recover the pubkey - pass full 65 bytes [recId, r, s], prehash: false
const recoveredPub = secp256k1.recoverPublicKey(sigWithRecovery, msgHash, { prehash: false });
console.log("Recovered pubkey:", hex.encode(recoveredPub));
console.log("Original pubkey: ", hex.encode(pubKeyBytes));
console.log("Match:", hex.encode(recoveredPub) === hex.encode(pubKeyBytes));
console.log("Recovered P2WPKH:", p2wpkh(recoveredPub).address);
console.log("Match address:", p2wpkh(recoveredPub).address === BTC_ADDRESS);
