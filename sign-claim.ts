import { hex } from "@scure/base";
import { p2wpkh, Transaction } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

// Derive BTC key at m/84'/0'/0'/0/0 (mainnet P2WPKH)
const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);

// Verify address
const p2wpkhOutput = p2wpkh(pubKeyBytes);
console.log("Derived BTC address:", p2wpkhOutput.address);
console.log("Expected BTC address:", BTC_ADDRESS);
console.log("Match:", p2wpkhOutput.address === BTC_ADDRESS);

if (p2wpkhOutput.address !== BTC_ADDRESS) {
  throw new Error("Address mismatch — wrong key derivation");
}

// BIP-322 signing helpers
function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const combined = new Uint8Array(tagHash.length * 2 + data.length);
  combined.set(tagHash, 0);
  combined.set(tagHash, tagHash.length);
  combined.set(data, tagHash.length * 2);
  return sha256(combined);
}

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const b = new Uint8Array(3);
  b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true);
  return b;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { result.set(a, off); off += a.length; }
  return result;
}

function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = taggedHash("BIP0322-signed-message", new TextEncoder().encode(message));
  const scriptSig = new Uint8Array([0x00, 0x20, ...msgHash]);
  const raw = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x01]),
    new Uint8Array(32),
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    varInt(scriptSig.length), scriptSig,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x01]),
    new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    varInt(scriptPubKey.length), scriptPubKey,
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
  );
  const txid = doubleSha256(raw);
  txid.reverse();
  return txid;
}

const scriptPubKey = p2wpkhOutput.script;
const toSpendTxid = bip322BuildToSpendTxId(MESSAGE, scriptPubKey);

const toSignTx = new Transaction({ allowUnknownOutputs: true });
toSignTx.addInput({
  txid: toSpendTxid,
  index: 0,
  witnessUtxo: { script: scriptPubKey, amount: BigInt(0) },
  sequence: 0,
});
toSignTx.addOutput({ script: new Uint8Array([0x6a]), amount: BigInt(0) });
toSignTx.signIdx(privKeyBytes, 0);
toSignTx.finalize();

const input = toSignTx.getInput(0);
const witness = input.finalScriptWitness as Uint8Array[];

function serializeWitness(items: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [varInt(items.length)];
  for (const item of items) {
    parts.push(varInt(item.length));
    parts.push(item);
  }
  return concat(...parts);
}

const witnessBytes = serializeWitness(witness);
const signatureBase64 = Buffer.from(witnessBytes).toString("base64");
console.log("\nBIP-322 signature:", signatureBase64);

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
