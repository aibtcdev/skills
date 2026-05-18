// Regenerate claim code using correct BIP-322 (segwitFlag:false)
import { p2wpkh, Transaction, RawTx, RawWitness, Script } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hashSha256Sync } from "@stacks/encryption";
import { concatBytes } from "@stacks/common";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

const seed = mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const child = root.derive("m/84'/0'/0'/0/0");
const privKeyBytes = child.privateKey!;
const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true);
const scriptPubKey = p2wpkh(pubKeyBytes).script;

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = hashSha256Sync(new TextEncoder().encode(tag));
  return hashSha256Sync(concatBytes(tagHash, tagHash, data));
}
function doubleSha256(data: Uint8Array): Uint8Array {
  return hashSha256Sync(hashSha256Sync(data));
}
function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = taggedHash("BIP0322-signed-message", new TextEncoder().encode(message));
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);
  const rawTx = RawTx.encode({
    version: 0, segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: scriptSig, sequence: 0 }],
    outputs: [{ amount: 0n, script: scriptPubKey }],
    witnesses: [], lockTime: 0,
  });
  return doubleSha256(rawTx).reverse();
}

const toSpendTxid = bip322BuildToSpendTxId(MESSAGE, scriptPubKey);
const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
toSignTx.addInput({ txid: toSpendTxid, index: 0, sequence: 0, witnessUtxo: { amount: 0n, script: scriptPubKey } });
toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
toSignTx.signIdx(privKeyBytes, 0);
toSignTx.finalizeIdx(0);

const input = toSignTx.getInput(0);
if (!input.finalScriptWitness) throw new Error("No witness");
const sig = Buffer.from(RawWitness.encode(input.finalScriptWitness)).toString("base64");
console.log("Message:", MESSAGE);
console.log("Signature (BIP-322):", sig);

const resp = await fetch("https://aibtc.com/api/claims/code", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ btcAddress: BTC_ADDRESS, bitcoinSignature: sig }),
});
const data = await resp.json();
console.log("\nResponse:", JSON.stringify(data, null, 2));
