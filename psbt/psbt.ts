#!/usr/bin/env bun
/**
 * PSBT skill CLI
 * Bitcoin PSBT (Partially Signed Bitcoin Transaction) signing and broadcast
 *
 * Usage: bun run psbt/psbt.ts <subcommand> [options]
 */

import * as btc from "@scure/btc-signer";
import { Command } from "commander";
import {
  P2TR_INPUT_BASE_VBYTES,
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
} from "../src/lib/config/bitcoin-constants.js";
import { NETWORK } from "../src/lib/config/networks.js";
import { MempoolApi, getMempoolTxUrl } from "../src/lib/services/mempool-api.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";

// ---------------------------------------------------------------------------
// PSBT helpers (mirrors psbt.helpers.ts in aibtc-mcp-server)
// ---------------------------------------------------------------------------

function decodePsbtBase64(psbtBase64: string): btc.Transaction {
  const bytes = Buffer.from(psbtBase64, "base64");
  if (bytes.length === 0) {
    throw new Error("Invalid PSBT: empty base64 payload");
  }
  return btc.Transaction.fromPSBT(bytes, {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    disableScriptCheck: true,
  });
}

function encodePsbtBase64(tx: btc.Transaction): string {
  return Buffer.from(tx.toPSBT()).toString("base64");
}

function decodeScriptType(script: Uint8Array): string {
  try {
    return btc.OutScript.decode(script).type;
  } catch {
    return "unknown";
  }
}

function detectInputScriptType(
  input: ReturnType<btc.Transaction["getInput"]>
): string {
  if (!input.witnessUtxo?.script) {
    return "unknown";
  }
  return decodeScriptType(input.witnessUtxo.script);
}

function getInputSigningStatus(
  input: ReturnType<btc.Transaction["getInput"]>
): "finalized" | "partially_signed" | "unsigned" {
  if (input.finalScriptSig || input.finalScriptWitness) {
    return "finalized";
  }
  if (input.partialSig?.length || input.tapKeySig) {
    return "partially_signed";
  }
  return "unsigned";
}

/**
 * Estimate vsize for a PSBT based on its input/output structure.
 * Falls back to tx.vsize when witness UTXOs are present.
 */
function estimatePsbtVsize(tx: btc.Transaction): number {
  try {
    // If the PSBT has witness UTXO data we can compute an accurate vsize
    return tx.vsize;
  } catch {
    // Fallback: approximate from input/output count
    let inputVbytes = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const scriptType = detectInputScriptType(input);
      if (scriptType === "tr" || scriptType === "tr_ms" || scriptType === "tr_ns") {
        // P2TR_INPUT_BASE_VBYTES (~41) + 16 witness vbytes = ~57 vbytes total
        // (41 non-witness bytes + ~16.5 witness bytes at 0.25 weight = ~57 vbytes for a key-path spend)
        inputVbytes += Math.ceil(P2TR_INPUT_BASE_VBYTES + 16);
      } else {
        // Default to P2WPKH
        inputVbytes += P2WPKH_INPUT_VBYTES;
      }
    }
    const outputVbytes = tx.outputsLength * P2WPKH_OUTPUT_VBYTES;
    return Math.ceil(TX_OVERHEAD_VBYTES + inputVbytes + outputVbytes);
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("psbt")
  .description(
    "Bitcoin PSBT operations: estimate fees, sign PSBTs with the active wallet, and broadcast finalized PSBTs"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// estimate-fee
// ---------------------------------------------------------------------------

program
  .command("estimate-fee")
  .description(
    "Estimate the network fee for a PSBT. Returns fee estimates at fast, medium, and slow fee tiers, " +
      "plus the current fee embedded in the PSBT if witness UTXOs are present."
  )
  .requiredOption("--psbt <base64>", "PSBT in base64 format")
  .action(async (opts: { psbt: string }) => {
    try {
      const tx = decodePsbtBase64(opts.psbt);
      const vsize = estimatePsbtVsize(tx);

      const mempool = new MempoolApi(NETWORK);
      const feeTiers = await mempool.getFeeTiers();

      let currentFeeSats: string | undefined;
      try {
        currentFeeSats = tx.fee.toString();
      } catch {
        currentFeeSats = undefined;
      }

      const inputs = Array.from({ length: tx.inputsLength }, (_, idx) => {
        const input = tx.getInput(idx);
        return {
          index: idx,
          scriptType: detectInputScriptType(input),
          status: getInputSigningStatus(input),
          amountSats: input.witnessUtxo?.amount?.toString(),
        };
      });

      const outputs = Array.from({ length: tx.outputsLength }, (_, idx) => {
        const output = tx.getOutput(idx);
        return {
          index: idx,
          amountSats: output.amount?.toString(),
        };
      });

      printJson({
        network: NETWORK,
        vsize,
        inputsLength: tx.inputsLength,
        outputsLength: tx.outputsLength,
        isFinalized: tx.isFinal,
        inputs,
        outputs,
        feeEstimates: {
          fast: {
            satPerVb: feeTiers.fast,
            totalSats: Math.ceil(vsize * feeTiers.fast),
          },
          medium: {
            satPerVb: feeTiers.medium,
            totalSats: Math.ceil(vsize * feeTiers.medium),
          },
          slow: {
            satPerVb: feeTiers.slow,
            totalSats: Math.ceil(vsize * feeTiers.slow),
          },
        },
        currentFeeSats,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

program
  .command("sign")
  .description(
    "Sign one or more PSBT inputs with the active wallet's BTC private keys. " +
      "Supports both P2WPKH (native SegWit) and Taproot key paths. " +
      "Requires an unlocked wallet."
  )
  .requiredOption("--psbt <base64>", "PSBT in base64 format to sign")
  .option(
    "--inputs <indexes>",
    "Comma-separated input indexes to sign (signs all signable inputs if omitted)"
  )
  .option(
    "--finalize",
    "Finalize signed inputs immediately after signing",
    false
  )
  .action(
    async (opts: { psbt: string; inputs?: string; finalize: boolean }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();

        if (!account?.btcPrivateKey && !account?.taprootPrivateKey) {
          throw new Error(
            "No BTC signing keys available. Unlock wallet first with: bun run wallet/wallet.ts unlock"
          );
        }

        const tx = decodePsbtBase64(opts.psbt);

        // Determine which input indexes to attempt
        let indexes: number[];
        if (opts.inputs) {
          indexes = opts.inputs
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => {
              const n = parseInt(s, 10);
              if (isNaN(n) || n < 0) {
                throw new Error(
                  `--inputs contains invalid index: "${s}". Provide non-negative integers.`
                );
              }
              return n;
            });
          // Deduplicate
          indexes = Array.from(new Set(indexes));
        } else {
          indexes = Array.from({ length: tx.inputsLength }, (_, i) => i);
        }

        const signedInputs: number[] = [];
        const skippedInputs: Array<{ index: number; reason: string }> = [];
        const finalizedInputs: number[] = [];

        for (const idx of indexes) {
          if (idx < 0 || idx >= tx.inputsLength) {
            skippedInputs.push({ index: idx, reason: "input index out of range" });
            continue;
          }

          let signed = false;
          const errors: string[] = [];

          // Attempt with P2WPKH key
          if (account.btcPrivateKey) {
            try {
              tx.signIdx(account.btcPrivateKey, idx);
              signed = true;
            } catch (e) {
              errors.push(`btc key: ${String(e)}`);
            }
          }

          // Attempt with Taproot key if P2WPKH signing did not succeed
          if (!signed && account.taprootPrivateKey) {
            try {
              tx.signIdx(account.taprootPrivateKey, idx);
              signed = true;
            } catch (e) {
              errors.push(`taproot key: ${String(e)}`);
            }
          }

          if (!signed) {
            skippedInputs.push({
              index: idx,
              reason:
                errors.length > 0
                  ? errors.join(" | ")
                  : "no matching key for this input",
            });
            continue;
          }

          signedInputs.push(idx);

          if (opts.finalize) {
            try {
              tx.finalizeIdx(idx);
              finalizedInputs.push(idx);
            } catch (e) {
              skippedInputs.push({
                index: idx,
                reason: `signed but not finalizable yet: ${String(e)}`,
              });
            }
          }
        }

        printJson({
          success: signedInputs.length > 0,
          network: NETWORK,
          signedInputs,
          finalizedInputs,
          skippedInputs,
          psbtBase64: encodePsbtBase64(tx),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

program
  .command("broadcast")
  .description(
    "Finalize a fully signed PSBT and broadcast it to the Bitcoin network via mempool.space. " +
      "All inputs must be signed before calling this subcommand."
  )
  .requiredOption("--psbt <base64>", "Fully signed PSBT in base64 format")
  .action(async (opts: { psbt: string }) => {
    try {
      const tx = decodePsbtBase64(opts.psbt);

      // Finalize all inputs
      tx.finalize();

      const rawTx = tx.extract();
      const txHex = Buffer.from(rawTx).toString("hex");

      const mempool = new MempoolApi(NETWORK);
      const txid = await mempool.broadcastTransaction(txHex);

      printJson({
        success: true,
        network: NETWORK,
        txid,
        explorerUrl: getMempoolTxUrl(txid, NETWORK),
        txHex,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
