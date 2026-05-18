import { hex } from "@scure/base";
import { p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

const BTC_PRIVATE_KEY_HEX = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";

const privKeyBytes = hex.decode(BTC_PRIVATE_KEY_HEX);
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);
console.log("Public key:", hex.encode(pubKeyBytes));

// Derive BTC address from pubkey
const p2wpkhOutput = p2wpkh(pubKeyBytes);
console.log("Derived BTC address:", p2wpkhOutput.address);
console.log("Expected BTC address:", BTC_ADDRESS);
console.log("Match:", p2wpkhOutput.address === BTC_ADDRESS);
