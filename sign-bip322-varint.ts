// Use the MCP server's bip322TaggedHash implementation (with varint prefix)
import { hex } from "@scure/base";
import { p2wpkh, Transaction, RawTx } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hashSha256Sync } from "@stacks/encryption";
import { concatBytes } from "@stacks/common";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

// Derive BTC key at m/84'/0'/0'/0/0
const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);

const p2wpkhOutput = p2wpkh(pubKeyBytes);
console.log("BTC address:", p2wpkhOutput.address);
console.log("Match:", p2wpkhOutput.address === BTC_ADDRESS);

// MCP server's bip322TaggedHash WITH varint prefix
function encodeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const buf = new Uint8Array(3);
  buf[0] = 0xfd; buf[1] = n & 0xff; buf[2] = (n >> 8) & 0xff;
  return buf;
}

function bip322TaggedHashWithVarInt(message: string): Uint8Array {
  const tagBytes = new TextEncoder().encode("BIP0322-signed-message");
  const tagHash = hashSha256Sync(tagBytes);
  const msgBytes = new TextEncoder().encode(message);
  const varint = encodeVarInt(msgBytes.length);
  const msgPart = concatBytes(varint, msgBytes);
  return hashSha256Sync(concatBytes(tagHash, tagHash, msgPart));
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHashWithVarInt(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const rawTx = RawTx.encode({
    version: 0,
    inputs: [{
      txid: new Uint8Array(32),
      index: 0xffffffff,
      finalScriptSig: scriptSig,
      sequence: 0,
    }],
    outputs: [{
      amount: 0n,
      script: scriptPubKey,
    }],
    lockTime: 0,
  });
  return doubleSha256(rawTx).reverse();
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

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  const b = new Uint8Array(3);
  b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >> 8) & 0xff;
  return b;
}

function serializeWitness(items: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [varInt(items.length)];
  for (const item of items) {
    parts.push(varInt(item.length));
    parts.push(item);
  }
  const total = parts.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { result.set(p, off); off += p.length; }
  return result;
}

const witnessBytes = serializeWitness(witness);
const signatureBase64 = Buffer.from(witnessBytes).toString("base64");
console.log("BIP-322 (with varint) signature:", signatureBase64);

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
