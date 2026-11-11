/**
 * BIP-322 "simple" message signing, shared by the signing skill (btc-sign)
 * and the inbox auto-reply outbox signature.
 */

import { hashSha256Sync } from "@stacks/encryption";
import { Transaction, Script, RawWitness, RawTx } from "@scure/btc-signer";

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * SHA-256 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data)
 * Used by BIP-322 ("BIP0322-signed-message") and BIP-341 ("TapSighash").
 */
export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = hashSha256Sync(new TextEncoder().encode(tag));
  return hashSha256Sync(concatBytes(tagHash, tagHash, data));
}

/**
 * BIP-322 message hash: taggedHash("BIP0322-signed-message", msg)
 *
 * Per BIP-322 spec, the tagged hash takes the raw message bytes directly.
 * Prepending a varint length prefix was incorrect — that belongs to BIP-137
 * serialization, not BIP-322's tagged hash construction.
 * See: https://github.com/aibtcdev/x402-sponsor-relay/issues/135
 */
function bip322TaggedHash(message: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(message);
  return taggedHash("BIP0322-signed-message", msgBytes);
}

/**
 * Build the BIP-322 to_spend virtual transaction and return its txid (32 bytes, LE).
 *
 * The to_spend tx is a virtual legacy transaction:
 * - Input: txid=zero32, vout=0xFFFFFFFF, sequence=0, scriptSig = OP_0 push32 <msgHash>
 * - Output: amount=0, script=scriptPubKey of the signing address
 *
 * The txid is computed as double SHA-256 of the legacy (non-segwit) serialization.
 * The returned txid is already in the byte order used by transaction inputs (reversed).
 */
export function bip322BuildToSpendTxId(message: string, scriptPubKey: Uint8Array): Uint8Array {
  const msgHash = bip322TaggedHash(message);
  // scriptSig: OP_0 (0x00) push32 (0x20) <32-byte hash>
  const scriptSig = concatBytes(new Uint8Array([0x00, 0x20]), msgHash);

  // Use RawTx with segwitFlag: false to get legacy (non-segwit) serialization.
  // RawOldTx is not exported from @scure/btc-signer's package index;
  // RawTx with segwitFlag=false produces identical byte output for this virtual tx.
  const rawTx = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [
      {
        txid: new Uint8Array(32),
        index: 0xffffffff,
        finalScriptSig: scriptSig,
        sequence: 0,
      },
    ],
    outputs: [
      {
        amount: 0n,
        script: scriptPubKey,
      },
    ],
    witnesses: [],
    lockTime: 0,
  });

  // txid is double-SHA256 of the serialized tx, returned in little-endian byte order
  return hashSha256Sync(hashSha256Sync(rawTx)).reverse();
}

/**
 * BIP-322 "simple" signing.
 *
 * Builds and signs the to_sign virtual transaction. The private key is used directly —
 * @scure/btc-signer's Transaction.signIdx() auto-detects the address type from witnessUtxo.script
 * and computes the correct sighash (BIP143 for P2WPKH, BIP341 for P2TR).
 *
 * @param message - Plain text message to sign
 * @param privateKey - 32-byte private key (P2WPKH key for bc1q, Taproot key for bc1p)
 * @param scriptPubKey - scriptPubKey of the signing address
 * @returns Base64-encoded BIP-322 "simple" signature (serialized witness)
 */
export function bip322Sign(
  message: string,
  privateKey: Uint8Array,
  scriptPubKey: Uint8Array,
  tapInternalKey?: Uint8Array
): string {
  const toSpendTxid = bip322BuildToSpendTxId(message, scriptPubKey);

  // allowUnknownOutputs: true is required for the OP_RETURN output in BIP-322 virtual transactions.
  const toSignTx = new Transaction({ version: 0, lockTime: 0, allowUnknownOutputs: true });
  // For P2TR signing, tapInternalKey must be the UNTWEAKED x-only pubkey (not extracted from
  // the scriptPubKey, which contains the tweaked key). Pass it explicitly via the parameter.

  toSignTx.addInput({
    txid: toSpendTxid,
    index: 0,
    sequence: 0,
    witnessUtxo: { amount: 0n, script: scriptPubKey },
    ...(tapInternalKey && { tapInternalKey }),
  });
  toSignTx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });

  // signIdx auto-detects P2WPKH vs P2TR from witnessUtxo.script and applies correct sighash
  toSignTx.signIdx(privateKey, 0);
  toSignTx.finalizeIdx(0);

  const input = toSignTx.getInput(0);
  if (!input.finalScriptWitness) {
    throw new Error("BIP-322 signing failed: no witness produced");
  }

  const encodedWitness = RawWitness.encode(input.finalScriptWitness);
  return Buffer.from(encodedWitness).toString("base64");
}
