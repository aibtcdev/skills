import { hex } from "@scure/base";
import { p2wpkh, Transaction } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BTC_PRIVATE_KEY_HEX = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

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
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true);
    return b;
  }
  const b = new Uint8Array(5);
  b[0] = 0xfe; new DataView(b.buffer).setUint32(1, n, true);
  return b;
}

function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  const msgHash = taggedHash("BIP0322-signed-message", msgBytes);

  const scriptSig = new Uint8Array([
    0x00, // OP_0
    0x20, // push 32 bytes
    ...msgHash,
  ]);

  const concat = (...arrays: Uint8Array[]): Uint8Array => {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { result.set(a, off); off += a.length; }
    return result;
  };

  const raw = concat(
    // version = 0
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    // vin count = 1
    new Uint8Array([0x01]),
    // prev txid = 32 zero bytes
    new Uint8Array(32),
    // prev vout = 0xFFFFFFFF
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    // scriptSig
    varInt(scriptSig.length), scriptSig,
    // sequence = 0
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
    // vout count = 1
    new Uint8Array([0x01]),
    // value = 0 (8 bytes LE)
    new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    // scriptPubKey
    varInt(scriptPubKey.length), scriptPubKey,
    // locktime = 0
    new Uint8Array([0x00, 0x00, 0x00, 0x00]),
  );

  const txid = doubleSha256(raw);
  txid.reverse();
  return txid;
}

const privKeyBytes = hex.decode(BTC_PRIVATE_KEY_HEX);
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);

const p2wpkhOutput = p2wpkh(pubKeyBytes);
const scriptPubKey = p2wpkhOutput.script;

const toSpendTxid = bip322BuildToSpendTxId(MESSAGE, scriptPubKey);

// Build to_sign transaction
const toSignTx = new Transaction({ allowUnknownOutputs: true });
toSignTx.addInput({
  txid: toSpendTxid,
  index: 0,
  witnessUtxo: { script: scriptPubKey, amount: BigInt(0) },
  sequence: 0,
});
toSignTx.addOutput({ script: new Uint8Array([0x6a]), amount: BigInt(0) }); // OP_RETURN

toSignTx.signIdx(privKeyBytes, 0);
toSignTx.finalize();

// Extract witness items
const input = toSignTx.getInput(0);
const witness = input.finalScriptWitness as Uint8Array[];
if (!witness || witness.length === 0) {
  throw new Error("No witness found after signing");
}

function serializeWitness(items: Uint8Array[]): Uint8Array {
  const concat = (...arrays: Uint8Array[]): Uint8Array => {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { result.set(a, off); off += a.length; }
    return result;
  };
  const parts: Uint8Array[] = [varInt(items.length)];
  for (const item of items) {
    parts.push(varInt(item.length));
    parts.push(item);
  }
  return concat(...parts);
}

const witnessBytes = serializeWitness(witness);
const signatureBase64 = Buffer.from(witnessBytes).toString("base64");

console.log("Message:", MESSAGE);
console.log("BIP-322 signature (base64):", signatureBase64);

// Try different field names
const url = `https://aibtc.com/api/claims/code`;

// Try 1: body only with both fields
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    btcAddress: BTC_ADDRESS,
    bitcoinSignature: signatureBase64,
  }),
});
const data1 = await response.json();
console.log("Attempt 1 (body only):", JSON.stringify(data1));

// Try 2: query param + body
const url2 = `https://aibtc.com/api/claims/code?btcAddress=${encodeURIComponent(BTC_ADDRESS)}&address=${encodeURIComponent(BTC_ADDRESS)}`;
const response2 = await fetch(url2, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    bitcoinSignature: signatureBase64,
  }),
});
const data2 = await response2.json();
console.log("Attempt 2 (query+body no btcAddress in body):", JSON.stringify(data2));

