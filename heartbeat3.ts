// Heartbeat using exact BIP-322 pattern from signing/signing.ts
import { p2wpkh, Transaction, RawTx, RawWitness, Script } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hashSha256Sync } from "@stacks/encryption";
import { concatBytes } from "@stacks/common";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);

const p2wpkhOutput = p2wpkh(pubKeyBytes);
const scriptPubKey = p2wpkhOutput.script;

const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
const MESSAGE = `AIBTC Check-In | ${timestamp}`;
console.log("Message:", MESSAGE);

// BIP-322 tagged hash (no varint — correct per spec)
function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = hashSha256Sync(new TextEncoder().encode(tag));
  return hashSha256Sync(concatBytes(tagHash, tagHash, data));
}

function bip322TaggedHash(message: string): Uint8Array {
  return taggedHash("BIP0322-signed-message", new TextEncoder().encode(message));
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}

function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHash(message);
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  // segwitFlag: false forces legacy serialization (no 0x00 0x01 marker bytes)
  const rawTx = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
    witnesses: [],
    lockTime: 0,
  });
  return doubleSha256(rawTx).reverse();
}

const toSpendTxid = bip322BuildToSpendTxId(MESSAGE, scriptPubKey);
const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
toSignTx.addInput({
  txid: toSpendTxid, index: 0,
  sequence: 0,
  witnessUtxo: { amount: 0n, script: scriptPubKey },
});
toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
toSignTx.signIdx(privKeyBytes, 0);
toSignTx.finalizeIdx(0);

const input = toSignTx.getInput(0);
if (!input.finalScriptWitness) throw new Error("No witness produced");

const encodedWitness = RawWitness.encode(input.finalScriptWitness);
const signatureBase64 = Buffer.from(encodedWitness).toString("base64");
console.log("Signature:", signatureBase64);

const response = await fetch("https://aibtc.com/api/heartbeat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ signature: signatureBase64, timestamp, btcAddress: BTC_ADDRESS }),
});

const data = await response.json();
console.log("\nHeartbeat response:", JSON.stringify(data, null, 2));
