/**
 * Runestone Builder
 *
 * Minimal Runestone OP_RETURN encoder for single-edict rune transfers.
 * Encodes a Runestone message as an OP_RETURN output script.
 *
 * Protocol spec: https://docs.ordinals.com/runes.html
 *
 * Layout:
 *   OP_RETURN OP_13 <payload>
 *
 * Payload (tag-length-value):
 *   Tag 0 (edicts): [block, tx, amount, output]  — all LEB128-encoded
 *   If change pointer is needed: Tag 22 (pointer): [output_index]
 *
 * For a single edict (no delta encoding needed):
 *   block = rune block height, tx = rune tx index
 *   amount = transfer amount, output = recipient output index
 */

// ---------------------------------------------------------------------------
// LEB128 encoding
// ---------------------------------------------------------------------------

/**
 * Encode a bigint as unsigned LEB128 bytes.
 */
export function encodeLEB128(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("LEB128 only encodes unsigned values");

  const bytes: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value !== 0n);

  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Runestone encoding
// ---------------------------------------------------------------------------

export interface RuneEdict {
  /** Rune ID block height (e.g., 840000) */
  block: bigint;
  /** Rune ID transaction index within block */
  txIndex: bigint;
  /** Amount of runes to transfer (in smallest unit) */
  amount: bigint;
  /** Output index to send runes to */
  outputIndex: number;
}

export interface RunestoneOptions {
  /** The edict (single transfer) */
  edict: RuneEdict;
  /**
   * Output index for remaining rune balance (change pointer).
   * Only set this when the change output is actually included in the
   * transaction. Omitting it (or passing undefined) when there is no change
   * output prevents the Runestone from pointing to a non-existent output,
   * which would otherwise cause the remaining runes to be burned.
   */
  changeOutput?: number;
}

/**
 * Build a Runestone OP_RETURN script for a single-edict rune transfer.
 *
 * Includes an explicit change pointer only when a change output is present.
 */
export function buildRunestoneScript(options: RunestoneOptions): Uint8Array {
  const { edict, changeOutput } = options;

  // Encode the payload
  const parts: Uint8Array[] = [];

  // Tag 0: edicts body
  // For a single edict, the values are: block, tx, amount, output
  // (no delta encoding needed for single edict)
  const tag0 = encodeLEB128(0n);
  const edictBlock = encodeLEB128(edict.block);
  const edictTx = encodeLEB128(edict.txIndex);
  const edictAmount = encodeLEB128(edict.amount);
  const edictOutput = encodeLEB128(BigInt(edict.outputIndex));

  parts.push(tag0, edictBlock);
  parts.push(tag0, edictTx);
  parts.push(tag0, edictAmount);
  parts.push(tag0, edictOutput);

  // Tag 22: default output (change pointer) — only encoded when a change
  // output is actually present in the transaction.
  if (changeOutput !== undefined) {
    const tag22 = encodeLEB128(22n);
    const changeIdx = encodeLEB128(BigInt(changeOutput));
    parts.push(tag22, changeIdx);
  }

  // Calculate total payload length
  const payloadLength = parts.reduce((sum, p) => sum + p.length, 0);

  // Build OP_RETURN OP_13 <pushdata>
  // OP_RETURN = 0x6a, OP_13 = 0x5d
  const script: number[] = [0x6a, 0x5d];

  // Push the payload with proper pushdata encoding
  if (payloadLength < 76) {
    script.push(payloadLength);
  } else if (payloadLength < 256) {
    script.push(0x4c, payloadLength); // OP_PUSHDATA1
  } else {
    script.push(0x4d, payloadLength & 0xff, (payloadLength >> 8) & 0xff); // OP_PUSHDATA2
  }

  // Append payload
  for (const part of parts) {
    for (const byte of part) {
      script.push(byte);
    }
  }

  return new Uint8Array(script);
}

/**
 * Parse a rune ID string (e.g., "840000:1") into block and tx components.
 */
export function parseRuneId(runeId: string): { block: bigint; txIndex: bigint } {
  const [blockStr, txStr] = runeId.split(":");
  if (!blockStr || !txStr) {
    throw new Error(`Invalid rune ID format: "${runeId}". Expected "block:tx" (e.g., "840000:1")`);
  }
  return {
    block: BigInt(blockStr),
    txIndex: BigInt(txStr),
  };
}
