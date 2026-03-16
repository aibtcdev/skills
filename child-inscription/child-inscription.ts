#!/usr/bin/env bun
/**
 * Child Inscription skill CLI
 * Parent-child Ordinals inscriptions per the Ordinals provenance spec:
 * estimate fees, broadcast commit tx, and reveal the child inscription.
 *
 * Usage: bun run child-inscription/child-inscription.ts <subcommand> [options]
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { NETWORK, getMempoolTxUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { MempoolApi } from "../src/lib/services/mempool-api.js";
import {
  buildChildCommitTransaction,
  buildChildRevealTransaction,
  deriveChildRevealScript,
  lookupParentInscription,
} from "../src/lib/transactions/child-inscription-builder.js";
import { signBtcTransaction } from "../src/lib/transactions/bitcoin-builder.js";
import {
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  P2TR_OUTPUT_VBYTES,
  P2TR_INPUT_BASE_VBYTES,
  TX_OVERHEAD_VBYTES,
  DUST_THRESHOLD,
  WITNESS_OVERHEAD_VBYTES,
} from "../src/lib/config/bitcoin-constants.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import type { InscriptionData } from "../src/lib/transactions/inscription-builder.js";

// ---------------------------------------------------------------------------
// State file path (relative to cwd)
// ---------------------------------------------------------------------------

const STATE_FILE = resolve(process.cwd(), ".child-inscription-state.json");

interface ChildInscriptionState {
  parentInscriptionId: string;
  contentType: string;
  contentBase64: string;
  commitTxid: string;
  revealAmount: number;
  feeRate: number;
  timestamp: string;
}

function saveState(state: ChildInscriptionState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState(): ChildInscriptionState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `State file not found at ${STATE_FILE}. ` +
        "Run the 'inscribe' subcommand first to broadcast the commit transaction."
    );
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ChildInscriptionState;
}

// ---------------------------------------------------------------------------
// Fee rate resolution helper
// ---------------------------------------------------------------------------

type FeeRateLabel = "fast" | "medium" | "slow";

async function resolveFeeRate(
  input: string | undefined,
  mempoolApi: MempoolApi
): Promise<number> {
  if (!input) {
    const fees = await mempoolApi.getFeeEstimates();
    return fees.halfHourFee;
  }
  if (input === "fast" || input === "medium" || input === "slow") {
    const fees = await mempoolApi.getFeeEstimates();
    const labels: Record<FeeRateLabel, number> = {
      fast: fees.fastestFee,
      medium: fees.halfHourFee,
      slow: fees.hourFee,
    };
    return labels[input as FeeRateLabel];
  }
  const n = parseFloat(input);
  if (isNaN(n) || n <= 0) {
    throw new Error("--fee-rate must be 'fast', 'medium', 'slow', or a positive number");
  }
  return n;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("child-inscription")
  .description(
    "Parent-child Ordinals inscriptions: estimate fees, broadcast commit tx, " +
      "and reveal child inscription establishing on-chain provenance."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

program
  .command("estimate")
  .description(
    "Estimate the total cost (commit fee + reveal amount) for a child inscription. " +
      "No wallet required — pure fee calculation."
  )
  .requiredOption("--parent-id <inscription-id>", "Parent inscription ID (e.g. abc123...i0)")
  .requiredOption(
    "--content-type <mime>",
    "MIME type of the child content (e.g. text/plain, image/png)"
  )
  .option(
    "--content <string>",
    "Child content as a UTF-8 string (use --content-file for binary)"
  )
  .option(
    "--content-file <path>",
    "Path to a file whose bytes will be used as child content (for binary/large content)"
  )
  .option(
    "--fee-rate <sats-per-vbyte>",
    "Fee rate in sat/vB (default: current mempool medium fee)"
  )
  .action(
    async (opts: {
      parentId: string;
      contentType: string;
      content?: string;
      contentFile?: string;
      feeRate?: string;
    }) => {
      try {
        if (!opts.content && !opts.contentFile) {
          throw new Error("Either --content or --content-file is required");
        }

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const body = opts.contentFile
          ? readFileSync(resolve(opts.contentFile))
          : Buffer.from(opts.content!, "utf8");

        // Commit tx size: 2 P2WPKH inputs + 1 P2TR output + 1 P2WPKH change
        const commitInputs = 2;
        const commitSize =
          TX_OVERHEAD_VBYTES +
          commitInputs * P2WPKH_INPUT_VBYTES +
          P2TR_OUTPUT_VBYTES +
          P2WPKH_OUTPUT_VBYTES;
        const commitFee = Math.ceil(commitSize * actualFeeRate);

        // Reveal tx: 2 P2TR inputs (commit script-path + parent key-path) + 2 P2TR outputs
        const revealWitnessSize =
          Math.ceil((body.length / 4) * 1.25) + WITNESS_OVERHEAD_VBYTES;
        const revealSize =
          TX_OVERHEAD_VBYTES +
          P2TR_INPUT_BASE_VBYTES + // commit input (script-path)
          P2TR_INPUT_BASE_VBYTES + // parent input (key-path)
          revealWitnessSize +
          P2TR_OUTPUT_VBYTES * 2; // parent return + child output
        const revealFee = Math.ceil(revealSize * actualFeeRate);

        // Amount to lock in the commit output (covers reveal fee + 2x dust + buffer)
        const revealAmount = revealFee + DUST_THRESHOLD * 2 + 1000;
        const totalCost = commitFee + revealAmount;

        printJson({
          parentId: opts.parentId,
          contentType: opts.contentType,
          contentSize: body.length,
          feeRate: actualFeeRate,
          fees: {
            commitFee,
            revealFee,
            revealAmount,
            totalCost,
          },
          breakdown:
            `Commit tx: ${commitFee} sats | ` +
            `Reveal amount: ${revealAmount} sats (includes ${revealFee} reveal fee) | ` +
            `Total: ${totalCost} sats`,
          note: "Estimate only. Actual fees vary with UTXO selection. Includes extra cost for parent UTXO input and parent return output.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// inscribe  (Step 1: commit tx)
// ---------------------------------------------------------------------------

program
  .command("inscribe")
  .description(
    "Step 1 — Broadcast the commit transaction for a child inscription. " +
      "Requires an unlocked wallet with BTC. Your Taproot address must own the parent inscription. " +
      "After this confirms (10–60 min), run 'reveal' to complete."
  )
  .requiredOption("--parent-id <inscription-id>", "Parent inscription ID. Must be owned by your Taproot address.")
  .requiredOption(
    "--content-type <mime>",
    "MIME type of the child content (e.g. text/plain, image/png)"
  )
  .option(
    "--content <string>",
    "Child content as a UTF-8 string (use --content-file for binary)"
  )
  .option(
    "--content-file <path>",
    "Path to a file whose bytes will be used as child content (for binary/large content)"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast (~10 min), medium (~30 min), slow (~1 hr), or sat/vB integer (default: medium)"
  )
  .action(
    async (opts: {
      parentId: string;
      contentType: string;
      content?: string;
      contentFile?: string;
      feeRate?: string;
    }) => {
      try {
        if (!opts.content && !opts.contentFile) {
          throw new Error("Either --content or --content-file is required");
        }

        // Wallet check
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();
        if (!sessionInfo) {
          throw new Error("Wallet not unlocked. Run 'bun run wallet/wallet.ts unlock' first.");
        }
        if (!sessionInfo.btcAddress || !sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet does not have Bitcoin addresses. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (
          !account?.btcPrivateKey ||
          !account?.btcPublicKey ||
          !account?.taprootPrivateKey ||
          !account?.taprootPublicKey
        ) {
          throw new Error(
            "Bitcoin and Taproot keys not available. Wallet may not be unlocked."
          );
        }

        // Validate parent ownership
        const parentInfo = await lookupParentInscription(opts.parentId);
        if (parentInfo.address !== sessionInfo.taprootAddress) {
          throw new Error(
            `Parent inscription is owned by ${parentInfo.address}, ` +
              `but your Taproot address is ${sessionInfo.taprootAddress}. ` +
              "You must own the parent inscription."
          );
        }

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const body = opts.contentFile
          ? readFileSync(resolve(opts.contentFile))
          : Buffer.from(opts.content!, "utf8");
        const inscription: InscriptionData = {
          contentType: opts.contentType,
          body,
        };

        // Get funding UTXOs (from P2WPKH address)
        const utxos = await mempoolApi.getUtxos(sessionInfo.btcAddress);
        if (utxos.length === 0) {
          throw new Error(
            `No UTXOs found at ${sessionInfo.btcAddress}. Fund your wallet before inscribing.`
          );
        }

        // Build and sign commit tx
        const commitResult = buildChildCommitTransaction({
          utxos,
          inscription,
          parentInscriptionId: opts.parentId,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderAddress: sessionInfo.btcAddress,
          network: NETWORK,
        });

        const commitSigned = signBtcTransaction(
          commitResult.tx,
          account.btcPrivateKey
        );
        const commitTxid = await mempoolApi.broadcastTransaction(commitSigned.txHex);
        const commitExplorerUrl = getMempoolTxUrl(commitTxid, NETWORK);

        // Persist state for the reveal step
        const contentBase64 = body.toString("base64");
        saveState({
          parentInscriptionId: opts.parentId,
          contentType: opts.contentType,
          contentBase64,
          commitTxid,
          revealAmount: commitResult.revealAmount,
          feeRate: actualFeeRate,
          timestamp: new Date().toISOString(),
        });

        printJson({
          status: "commit_broadcast",
          message:
            "Commit transaction broadcast. " +
            "Wait for confirmation (typically 10–60 min), then run 'reveal'.",
          commitTxid,
          commitExplorerUrl,
          revealAddress: commitResult.revealAddress,
          revealAmount: commitResult.revealAmount,
          commitFee: commitResult.fee,
          feeRate: actualFeeRate,
          parentInscriptionId: opts.parentId,
          parentUtxo: {
            txid: parentInfo.txid,
            vout: parentInfo.vout,
            value: parentInfo.value,
          },
          contentType: opts.contentType,
          contentSize: body.length,
          stateFile: STATE_FILE,
          nextStep:
            "After commit confirms, run: bun run child-inscription/child-inscription.ts reveal " +
            `--commit-txid ${commitTxid} --vout 0`,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// reveal  (Step 2: reveal tx)
// ---------------------------------------------------------------------------

program
  .command("reveal")
  .description(
    "Step 2 — Broadcast the reveal transaction to complete a child inscription. " +
      "The commit transaction MUST be confirmed before calling this. " +
      "Reads content and parent info from the state file written by 'inscribe'."
  )
  .requiredOption(
    "--commit-txid <txid>",
    "Transaction ID of the confirmed commit transaction (64 hex chars)"
  )
  .requiredOption(
    "--vout <num>",
    "Output index of the commit transaction (almost always 0)",
    "0"
  )
  .action(
    async (opts: { commitTxid: string; vout: string }) => {
      try {
        // Validate txid format
        if (!/^[0-9a-fA-F]{64}$/.test(opts.commitTxid)) {
          throw new Error("--commit-txid must be a 64-character hex string");
        }
        const vout = parseInt(opts.vout, 10);
        if (isNaN(vout) || vout < 0) {
          throw new Error("--vout must be a non-negative integer");
        }

        // Wallet check
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();
        if (!sessionInfo) {
          throw new Error("Wallet not unlocked. Run 'bun run wallet/wallet.ts unlock' first.");
        }
        if (!sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet does not have a Taproot address. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (
          !account?.btcPrivateKey ||
          !account?.btcPublicKey ||
          !account?.taprootPrivateKey ||
          !account?.taprootPublicKey
        ) {
          throw new Error(
            "Bitcoin and Taproot keys not available. Wallet may not be unlocked."
          );
        }

        // Load persisted state
        const state = loadState();

        // Verify commit txid matches state
        if (state.commitTxid !== opts.commitTxid) {
          throw new Error(
            `Commit txid mismatch: state file has ${state.commitTxid} but --commit-txid is ${opts.commitTxid}. ` +
              "Ensure you are revealing the correct commit transaction."
          );
        }

        // Validate parent is still owned by this wallet
        const parentInfo = await lookupParentInscription(state.parentInscriptionId);
        if (parentInfo.address !== sessionInfo.taprootAddress) {
          throw new Error(
            `Parent inscription is no longer at your Taproot address. ` +
              `Current owner: ${parentInfo.address}. ` +
              "Do not transfer the parent between inscribe and reveal."
          );
        }

        const body = Buffer.from(state.contentBase64, "base64");
        const inscription: InscriptionData = {
          contentType: state.contentType,
          body,
        };

        const mempoolApi = new MempoolApi(NETWORK);
        // Use the stored fee rate (or current rate if higher) to ensure
        // the locked revealAmount is sufficient for the reveal tx fees.
        const currentFeeRate = await resolveFeeRate(undefined, mempoolApi);
        const actualFeeRate = Math.max(state.feeRate, currentFeeRate);

        // Derive the same reveal script as was used in the commit
        const p2trReveal = deriveChildRevealScript({
          inscription,
          parentInscriptionId: state.parentInscriptionId,
          senderPubKey: account.btcPublicKey,
          network: NETWORK,
        });

        // Build reveal tx (spends commit output + parent UTXO)
        const revealResult = buildChildRevealTransaction({
          commitTxid: opts.commitTxid,
          commitVout: vout,
          commitAmount: state.revealAmount,
          revealScript: p2trReveal,
          parentUtxo: {
            txid: parentInfo.txid,
            vout: parentInfo.vout,
            value: parentInfo.value,
          },
          parentOwnerTaprootInternalPubKey: account.taprootPublicKey,
          recipientAddress: sessionInfo.taprootAddress,
          feeRate: actualFeeRate,
          network: NETWORK,
        });

        // Sign both inputs:
        //   Input[0] (commit output) — script-path spend → btcPrivateKey
        //   Input[1] (parent UTXO)  — key-path spend    → taprootPrivateKey
        revealResult.tx.sign(account.btcPrivateKey);
        revealResult.tx.sign(account.taprootPrivateKey);
        revealResult.tx.finalize();

        const revealTxid = await mempoolApi.broadcastTransaction(revealResult.tx.hex);
        const inscriptionId = `${revealTxid}i0`;

        printJson({
          status: "success",
          message: "Child inscription created successfully.",
          inscriptionId,
          parentInscriptionId: state.parentInscriptionId,
          contentType: state.contentType,
          contentSize: body.length,
          commit: {
            txid: opts.commitTxid,
            explorerUrl: getMempoolTxUrl(opts.commitTxid, NETWORK),
          },
          reveal: {
            txid: revealTxid,
            fee: revealResult.fee,
            explorerUrl: getMempoolTxUrl(revealTxid, NETWORK),
          },
          recipientAddress: sessionInfo.taprootAddress,
          note: "The child inscription will appear once the reveal transaction confirms. The parent inscription has been returned to your address.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
