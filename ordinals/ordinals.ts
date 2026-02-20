#!/usr/bin/env bun
/**
 * Ordinals skill CLI
 * Bitcoin inscription operations: receive address, fee estimation, inscribe (commit+reveal), get inscription
 *
 * Usage: bun run ordinals/ordinals.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  P2WPKH_INPUT_VBYTES,
  P2WPKH_OUTPUT_VBYTES,
  P2TR_OUTPUT_VBYTES,
  TX_OVERHEAD_VBYTES,
  DUST_THRESHOLD,
  P2TR_INPUT_BASE_VBYTES,
} from "../src/lib/config/bitcoin-constants.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { MempoolApi, getMempoolTxUrl } from "../src/lib/services/mempool-api.js";
import { InscriptionParser } from "../src/lib/services/inscription-parser.js";
import {
  buildCommitTransaction,
  buildRevealTransaction,
  type InscriptionData,
} from "../src/lib/transactions/inscription-builder.js";
import { signBtcTransaction } from "../src/lib/transactions/bitcoin-builder.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve fee rate string or number to an actual sat/vB number.
 */
async function resolveFeeRate(
  feeRateInput: string | undefined,
  api: MempoolApi
): Promise<number> {
  if (!feeRateInput || feeRateInput === "medium") {
    const fees = await api.getFeeEstimates();
    return fees.halfHourFee;
  }

  if (feeRateInput === "fast") {
    const fees = await api.getFeeEstimates();
    return fees.fastestFee;
  }

  if (feeRateInput === "slow") {
    const fees = await api.getFeeEstimates();
    return fees.hourFee;
  }

  const numeric = parseFloat(feeRateInput);
  if (isNaN(numeric) || numeric <= 0) {
    throw new Error(
      "--fee-rate must be 'fast', 'medium', 'slow', or a positive number (sat/vB)"
    );
  }
  return numeric;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("ordinals")
  .description(
    "Bitcoin ordinals operations: get Taproot address, estimate inscription fees, inscribe (two-step commit/reveal), and fetch inscription content."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-taproot-address
// ---------------------------------------------------------------------------

program
  .command("get-taproot-address")
  .description(
    "Get the wallet's Taproot (P2TR) address for receiving inscriptions. " +
      "Uses BIP86 derivation (m/86'/0'/0'/0/0). Requires an unlocked wallet."
  )
  .action(async () => {
    try {
      const walletManager = getWalletManager();
      const sessionInfo = walletManager.getSessionInfo();

      if (!sessionInfo?.taprootAddress) {
        throw new Error(
          "Wallet not unlocked or doesn't have a Taproot address. " +
            "Use wallet/wallet.ts unlock first."
        );
      }

      printJson({
        address: sessionInfo.taprootAddress,
        network: NETWORK,
        purpose: "receive_inscriptions",
        derivationPath:
          NETWORK === "mainnet" ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0",
        note: "Use this address to receive inscriptions created by the inscribe subcommand",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// estimate-fee
// ---------------------------------------------------------------------------

program
  .command("estimate-fee")
  .description(
    "Calculate the total cost (in satoshis) for creating an inscription. " +
      "Returns breakdown of commit fee, reveal fee, and total cost. " +
      "Content should be provided as a base64-encoded string."
  )
  .requiredOption(
    "--content-type <type>",
    "MIME type (e.g., 'text/plain', 'image/png')"
  )
  .requiredOption(
    "--content-base64 <base64>",
    "Content as base64-encoded string"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate in sat/vB (default: current medium fee from mempool.space)"
  )
  .action(
    async (opts: {
      contentType: string;
      contentBase64: string;
      feeRate?: string;
    }) => {
      try {
        const body = Buffer.from(opts.contentBase64, "base64");

        const api = new MempoolApi(NETWORK);
        let actualFeeRate: number;

        if (opts.feeRate) {
          actualFeeRate = await resolveFeeRate(opts.feeRate, api);
        } else {
          const fees = await api.getFeeEstimates();
          actualFeeRate = fees.halfHourFee;
        }

        // Commit tx size (assume 2 inputs for simplicity)
        const commitInputs = 2;
        const commitSize =
          TX_OVERHEAD_VBYTES +
          commitInputs * P2WPKH_INPUT_VBYTES +
          P2TR_OUTPUT_VBYTES +
          P2WPKH_OUTPUT_VBYTES;
        const commitFee = Math.ceil(commitSize * actualFeeRate);

        // Reveal tx size (1 input with inscription witness + 1 output)
        const WITNESS_OVERHEAD_VBYTES = 80;
        const revealWitnessSize =
          Math.ceil((body.length / 4) * 1.25) + WITNESS_OVERHEAD_VBYTES;
        const revealSize =
          TX_OVERHEAD_VBYTES +
          P2TR_INPUT_BASE_VBYTES +
          revealWitnessSize +
          P2TR_OUTPUT_VBYTES;
        const revealFee = Math.ceil(revealSize * actualFeeRate);

        // Amount locked in reveal output
        const revealAmount = revealFee + DUST_THRESHOLD + 1000;

        // Total cost
        const totalCost = commitFee + revealAmount;

        printJson({
          contentType: opts.contentType,
          contentSize: body.length,
          feeRate: actualFeeRate,
          fees: {
            commitFee,
            revealFee,
            revealAmount,
            totalCost,
          },
          breakdown: `Commit tx: ${commitFee} sats | Reveal amount: ${revealAmount} sats (includes ${revealFee} reveal fee) | Total: ${totalCost} sats`,
          note: "This is an estimate. Actual fees may vary based on UTXO selection.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// inscribe (Step 1: commit)
// ---------------------------------------------------------------------------

program
  .command("inscribe")
  .description(
    "Create a Bitcoin inscription — STEP 1: Broadcast commit transaction.\n\n" +
      "Broadcasts the commit tx and returns immediately. Does NOT wait for confirmation.\n\n" +
      "After the commit confirms (typically 10-60 min), use 'inscribe-reveal' with the same " +
      "contentType and contentBase64 to complete the inscription.\n\n" +
      "Returns: commitTxid, revealAddress, revealAmount, and feeRate (save for inscribe-reveal)."
  )
  .requiredOption(
    "--content-type <type>",
    "MIME type (e.g., 'text/plain', 'image/png', 'text/html')"
  )
  .requiredOption(
    "--content-base64 <base64>",
    "Content as base64-encoded string"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast | medium | slow | number in sat/vB (default: medium)"
  )
  .action(
    async (opts: {
      contentType: string;
      contentBase64: string;
      feeRate?: string;
    }) => {
      try {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();

        if (!sessionInfo) {
          throw new Error(
            "Wallet not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (!sessionInfo.btcAddress || !sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet doesn't have Bitcoin addresses. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (!account || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Wallet may not be unlocked."
          );
        }

        const body = Buffer.from(opts.contentBase64, "base64");
        const inscription: InscriptionData = {
          contentType: opts.contentType,
          body,
        };

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const utxos = await mempoolApi.getUtxos(sessionInfo.btcAddress);
        if (utxos.length === 0) {
          throw new Error(
            `No UTXOs available for address ${sessionInfo.btcAddress}. Send some BTC first.`
          );
        }

        const commitResult = buildCommitTransaction({
          utxos,
          inscription,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderAddress: sessionInfo.btcAddress,
          network: NETWORK,
        });

        const commitSigned = signBtcTransaction(
          commitResult.tx,
          account.btcPrivateKey
        );
        const commitTxid = await mempoolApi.broadcastTransaction(
          commitSigned.txHex
        );
        const commitExplorerUrl = getMempoolTxUrl(commitTxid, NETWORK);

        printJson({
          status: "commit_broadcast",
          message:
            "Commit transaction broadcast successfully. " +
            "Wait for confirmation (typically 10-60 min), then call inscribe-reveal to complete.",
          commitTxid,
          commitExplorerUrl,
          revealAddress: commitResult.revealAddress,
          revealAmount: commitResult.revealAmount,
          commitFee: commitResult.fee,
          feeRate: actualFeeRate,
          contentType: opts.contentType,
          contentSize: body.length,
          nextStep:
            "After commit confirms, call: bun run ordinals/ordinals.ts inscribe-reveal " +
            "--commit-txid <commitTxid> --reveal-amount <revealAmount> " +
            "--content-type <contentType> --content-base64 <contentBase64>",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// inscribe-reveal (Step 2: reveal)
// ---------------------------------------------------------------------------

program
  .command("inscribe-reveal")
  .description(
    "Complete a Bitcoin inscription — STEP 2: Broadcast reveal transaction.\n\n" +
      "Call this AFTER the commit transaction from 'inscribe' has confirmed.\n" +
      "Provide the same contentType and contentBase64 used in the commit step.\n\n" +
      "Returns: inscriptionId ({revealTxid}i0) on success."
  )
  .requiredOption(
    "--commit-txid <txid>",
    "Transaction ID of the confirmed commit transaction (64 hex chars)"
  )
  .requiredOption(
    "--reveal-amount <satoshis>",
    "Amount in the commit output in satoshis (from inscribe response)"
  )
  .requiredOption(
    "--content-type <type>",
    "MIME type (must match the commit step)"
  )
  .requiredOption(
    "--content-base64 <base64>",
    "Content as base64-encoded string (must match the commit step)"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate for reveal tx: fast | medium | slow | number in sat/vB (default: medium)"
  )
  .action(
    async (opts: {
      commitTxid: string;
      revealAmount: string;
      contentType: string;
      contentBase64: string;
      feeRate?: string;
    }) => {
      try {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();

        if (!sessionInfo) {
          throw new Error(
            "Wallet not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (!sessionInfo.taprootAddress) {
          throw new Error(
            "Wallet doesn't have a Taproot address. Use a managed wallet."
          );
        }

        const account = walletManager.getAccount();
        if (!account || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Wallet may not be unlocked."
          );
        }

        const revealAmountSats = parseInt(opts.revealAmount, 10);
        if (isNaN(revealAmountSats) || revealAmountSats <= 0) {
          throw new Error("--reveal-amount must be a positive integer (satoshis)");
        }

        if (opts.commitTxid.length !== 64) {
          throw new Error("--commit-txid must be exactly 64 hex characters");
        }

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const body = Buffer.from(opts.contentBase64, "base64");
        const inscription: InscriptionData = {
          contentType: opts.contentType,
          body,
        };

        // Rebuild commit to get the reveal script (deterministic from inscription data)
        const dummyUtxos = [
          {
            txid: opts.commitTxid,
            vout: 0,
            value: revealAmountSats,
            status: {
              confirmed: true,
              block_height: 0,
              block_hash: "",
              block_time: 0,
            },
          },
        ];

        const commitResult = buildCommitTransaction({
          utxos: dummyUtxos,
          inscription,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderAddress: sessionInfo.btcAddress || "",
          network: NETWORK,
        });

        const revealResult = buildRevealTransaction({
          commitTxid: opts.commitTxid,
          commitVout: 0,
          commitAmount: revealAmountSats,
          revealScript: commitResult.revealScript,
          recipientAddress: sessionInfo.taprootAddress,
          feeRate: actualFeeRate,
          network: NETWORK,
        });

        const revealSigned = signBtcTransaction(
          revealResult.tx,
          account.btcPrivateKey
        );
        const revealTxid = await mempoolApi.broadcastTransaction(
          revealSigned.txHex
        );

        const inscriptionId = `${revealTxid}i0`;
        const revealExplorerUrl = getMempoolTxUrl(revealTxid, NETWORK);
        const commitExplorerUrl = getMempoolTxUrl(opts.commitTxid, NETWORK);

        printJson({
          status: "success",
          message: "Inscription created successfully!",
          inscriptionId,
          contentType: opts.contentType,
          contentSize: body.length,
          commit: {
            txid: opts.commitTxid,
            explorerUrl: commitExplorerUrl,
          },
          reveal: {
            txid: revealTxid,
            fee: revealResult.fee,
            explorerUrl: revealExplorerUrl,
          },
          recipientAddress: sessionInfo.taprootAddress,
          note: "Inscription will appear at the recipient address once the reveal transaction confirms.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-inscription
// ---------------------------------------------------------------------------

program
  .command("get-inscription")
  .description(
    "Get inscription content from a Bitcoin reveal transaction. " +
      "Fetches the transaction from mempool.space and parses inscription data from the witness. " +
      "Returns content type, body (as base64 and text if applicable), and metadata tags."
  )
  .requiredOption(
    "--txid <txid>",
    "Transaction ID of the reveal transaction containing the inscription (64 hex chars)"
  )
  .action(async (opts: { txid: string }) => {
    try {
      if (opts.txid.length !== 64) {
        throw new Error("--txid must be exactly 64 hex characters");
      }

      const parser = new InscriptionParser(NETWORK);
      const inscriptions = await parser.getInscriptionsFromTx(opts.txid);

      if (!inscriptions || inscriptions.length === 0) {
        printJson({
          txid: opts.txid,
          network: NETWORK,
          explorerUrl: getMempoolTxUrl(opts.txid, NETWORK),
          found: false,
          message: "No inscriptions found in this transaction",
        });
        return;
      }

      const formattedInscriptions = inscriptions.map((ins, index) => ({
        index,
        contentType: ins.contentType || "unknown",
        size: ins.body.length,
        bodyBase64: ins.bodyBase64,
        bodyText:
          ins.bodyText && ins.bodyText.length <= 1000
            ? ins.bodyText
            : ins.bodyText
              ? `${ins.bodyText.slice(0, 1000)}... (truncated)`
              : undefined,
        cursed: ins.cursed || false,
        metadata: {
          pointer: ins.pointer?.toString(),
          metaprotocol: ins.metaprotocol,
          contentEncoding: ins.contentEncoding,
          rune: ins.rune?.toString(),
          note: ins.note,
          hasMetadata: !!ins.metadata,
        },
      }));

      printJson({
        txid: opts.txid,
        network: NETWORK,
        explorerUrl: getMempoolTxUrl(opts.txid, NETWORK),
        found: true,
        count: inscriptions.length,
        inscriptions: formattedInscriptions,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
