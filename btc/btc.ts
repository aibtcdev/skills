#!/usr/bin/env bun
/**
 * BTC skill CLI
 * Bitcoin L1 operations: balances, fees, UTXOs, transfers, ordinal UTXO classification
 *
 * Usage: bun run btc/btc.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import {
  MempoolApi,
  getMempoolAddressUrl,
  getMempoolTxUrl,
  type UTXO,
} from "../src/lib/services/mempool-api.js";
import { OrdinalIndexer } from "../src/lib/services/ordinal-indexer.js";
import { buildAndSignBtcTransaction } from "../src/lib/transactions/bitcoin-builder.js";

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
// BTC helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Bitcoin address: prefer explicit arg, fall back to wallet session.
 */
async function getBtcAddress(address?: string): Promise<string> {
  if (address) {
    return address;
  }

  const walletManager = getWalletManager();
  const sessionInfo = walletManager.getSessionInfo();

  if (sessionInfo?.btcAddress) {
    return sessionInfo.btcAddress;
  }

  throw new Error(
    "No Bitcoin address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

/**
 * Format satoshis as a human-readable BTC string.
 */
function formatBtc(satoshis: number): string {
  const btc = satoshis / 100_000_000;
  return btc.toFixed(8).replace(/\.?0+$/, "") + " BTC";
}

/**
 * Format a single UTXO for output.
 */
function formatUtxo(utxo: UTXO) {
  return {
    txid: utxo.txid,
    vout: utxo.vout,
    value: {
      satoshis: utxo.value,
      btc: formatBtc(utxo.value),
    },
    confirmed: utxo.status.confirmed,
    blockHeight: utxo.status.block_height,
    blockTime: utxo.status.block_time
      ? new Date(utxo.status.block_time * 1000).toISOString()
      : undefined,
  };
}

/**
 * Summarize a list of UTXOs (count, total value, confirmed/unconfirmed counts).
 */
function summarizeUtxos(utxos: UTXO[]) {
  const totalValue = utxos.reduce((sum, u) => sum + u.value, 0);
  return {
    count: utxos.length,
    totalValue: {
      satoshis: totalValue,
      btc: formatBtc(totalValue),
    },
    confirmedCount: utxos.filter((u) => u.status.confirmed).length,
    unconfirmedCount: utxos.filter((u) => !u.status.confirmed).length,
  };
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("btc")
  .description(
    "Bitcoin L1 operations: balances, fees, UTXOs, transfers, and ordinal UTXO classification"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

program
  .command("balance")
  .description(
    "Get the BTC balance for a Bitcoin address. Returns total, confirmed, and unconfirmed balances."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const btcAddress = await getBtcAddress(opts.address);
      const api = new MempoolApi(NETWORK);
      const utxos = await api.getUtxos(btcAddress);

      let totalSatoshis = 0;
      let confirmedSatoshis = 0;

      for (const utxo of utxos) {
        totalSatoshis += utxo.value;
        if (utxo.status.confirmed) {
          confirmedSatoshis += utxo.value;
        }
      }

      const unconfirmedSatoshis = totalSatoshis - confirmedSatoshis;

      printJson({
        address: btcAddress,
        network: NETWORK,
        balance: {
          satoshis: totalSatoshis,
          btc: formatBtc(totalSatoshis),
        },
        confirmed: {
          satoshis: confirmedSatoshis,
          btc: formatBtc(confirmedSatoshis),
        },
        unconfirmed: {
          satoshis: unconfirmedSatoshis,
          btc: formatBtc(unconfirmedSatoshis),
        },
        utxoCount: utxos.length,
        explorerUrl: getMempoolAddressUrl(btcAddress, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------

program
  .command("fees")
  .description(
    "Get current Bitcoin fee estimates. Returns fast (~10 min), medium (~30 min), slow (~1 hr), economy (~24 hr), and minimum relay rates in sat/vB."
  )
  .action(async () => {
    try {
      const api = new MempoolApi(NETWORK);
      const tiers = await api.getFeeTiers();
      const fullEstimates = await api.getFeeEstimates();

      printJson({
        network: NETWORK,
        fees: {
          fast: {
            satPerVb: tiers.fast,
            target: "~10 minutes (next block)",
          },
          medium: {
            satPerVb: tiers.medium,
            target: "~30 minutes",
          },
          slow: {
            satPerVb: tiers.slow,
            target: "~1 hour",
          },
        },
        economy: {
          satPerVb: fullEstimates.economyFee,
          target: "~24 hours",
        },
        minimum: {
          satPerVb: fullEstimates.minimumFee,
          target: "minimum relay fee",
        },
        unit: "sat/vB",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// utxos
// ---------------------------------------------------------------------------

program
  .command("utxos")
  .description(
    "List all UTXOs (Unspent Transaction Outputs) for a Bitcoin address."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet if omitted)"
  )
  .option(
    "--confirmed-only",
    "Only return confirmed UTXOs",
    false
  )
  .action(async (opts: { address?: string; confirmedOnly: boolean }) => {
    try {
      const btcAddress = await getBtcAddress(opts.address);
      const api = new MempoolApi(NETWORK);
      let utxos = await api.getUtxos(btcAddress);

      if (opts.confirmedOnly) {
        utxos = utxos.filter((u) => u.status.confirmed);
      }

      printJson({
        address: btcAddress,
        network: NETWORK,
        utxos: utxos.map(formatUtxo),
        summary: summarizeUtxos(utxos),
        explorerUrl: getMempoolAddressUrl(btcAddress, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description(
    "Transfer BTC to a recipient address. " +
      "Builds, signs, and broadcasts a Bitcoin transaction. Requires an unlocked wallet. " +
      "By default only uses cardinal UTXOs (safe to spend — no inscriptions). " +
      "Set --include-ordinals to allow spending ordinal UTXOs (advanced users only)."
  )
  .requiredOption(
    "--recipient <address>",
    "Bitcoin address to send to (bc1... for mainnet, tb1... for testnet)"
  )
  .requiredOption(
    "--amount <satoshis>",
    "Amount to send in satoshis (1 BTC = 100,000,000 satoshis)"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast | medium | slow | number in sat/vB (default: medium)",
    "medium"
  )
  .option(
    "--include-ordinals",
    "Include ordinal UTXOs (WARNING: may destroy valuable inscriptions!)",
    false
  )
  .action(
    async (opts: {
      recipient: string;
      amount: string;
      feeRate: string;
      includeOrdinals: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();

        if (!account) {
          throw new Error(
            "Wallet is not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (!account.btcAddress || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Please unlock your wallet again."
          );
        }

        const amountSats = parseInt(opts.amount, 10);
        if (isNaN(amountSats) || amountSats <= 0) {
          throw new Error("--amount must be a positive integer (satoshis)");
        }

        const api = new MempoolApi(NETWORK);

        // Fetch UTXOs — cardinal only by default for safety
        let utxos: UTXO[];
        let testnetWarning = "";

        if (opts.includeOrdinals) {
          utxos = await api.getUtxos(account.btcAddress);
        } else {
          if (NETWORK === "testnet") {
            utxos = await api.getUtxos(account.btcAddress);
            testnetWarning =
              "Note: Ordinal protection is not available on testnet. All UTXOs were used.";
          } else {
            const indexer = new OrdinalIndexer(NETWORK);
            utxos = await indexer.getCardinalUtxos(account.btcAddress);
          }
        }

        if (utxos.length === 0) {
          const errorMsg = opts.includeOrdinals
            ? `No UTXOs found for address ${account.btcAddress}`
            : `No cardinal UTXOs available for address ${account.btcAddress}. ` +
              `You may have ordinal UTXOs (containing inscriptions). ` +
              `Set --include-ordinals to spend them (WARNING: may destroy inscriptions).`;
          throw new Error(errorMsg);
        }

        // Resolve fee rate
        let resolvedFeeRate: number;
        const feeRateInput = opts.feeRate;

        if (feeRateInput === "fast" || feeRateInput === "medium" || feeRateInput === "slow") {
          const feeTiers = await api.getFeeTiers();
          switch (feeRateInput) {
            case "fast":
              resolvedFeeRate = feeTiers.fast;
              break;
            case "slow":
              resolvedFeeRate = feeTiers.slow;
              break;
            default:
              resolvedFeeRate = feeTiers.medium;
          }
        } else {
          resolvedFeeRate = parseInt(feeRateInput, 10);
          if (isNaN(resolvedFeeRate) || resolvedFeeRate <= 0) {
            throw new Error(
              "--fee-rate must be 'fast', 'medium', 'slow', or a positive integer (sat/vB)"
            );
          }
        }

        const txResult = buildAndSignBtcTransaction(
          {
            utxos,
            recipient: opts.recipient,
            amount: amountSats,
            feeRate: resolvedFeeRate,
            senderPubKey: account.btcPublicKey,
            senderAddress: account.btcAddress,
            network: NETWORK,
          },
          account.btcPrivateKey
        );

        const txid = await api.broadcastTransaction(txResult.txHex);

        const response: Record<string, unknown> = {
          success: true,
          txid,
          explorerUrl: getMempoolTxUrl(txid, NETWORK),
          transaction: {
            recipient: opts.recipient,
            amount: {
              satoshis: amountSats,
              btc: formatBtc(amountSats),
            },
            fee: {
              satoshis: txResult.fee,
              btc: formatBtc(txResult.fee),
              rateUsed: `${resolvedFeeRate} sat/vB`,
            },
            change: {
              satoshis: txResult.change,
              btc: formatBtc(txResult.change),
            },
            vsize: txResult.vsize,
            utxoType: opts.includeOrdinals ? "all" : "cardinal-only",
          },
          sender: account.btcAddress,
          network: NETWORK,
        };

        if (testnetWarning) {
          response.warning = testnetWarning;
        }

        printJson(response);
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-cardinal-utxos
// ---------------------------------------------------------------------------

program
  .command("get-cardinal-utxos")
  .description(
    "Get cardinal UTXOs (safe to spend — no inscriptions). " +
      "Cardinal UTXOs do not contain ordinal inscriptions and can be safely spent. " +
      "Only available on mainnet (Hiro Ordinals API does not index testnet)."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet if omitted)"
  )
  .option(
    "--confirmed-only",
    "Only return confirmed UTXOs",
    false
  )
  .action(async (opts: { address?: string; confirmedOnly: boolean }) => {
    try {
      const btcAddress = await getBtcAddress(opts.address);
      const indexer = new OrdinalIndexer(NETWORK);
      let utxos = await indexer.getCardinalUtxos(btcAddress);

      if (opts.confirmedOnly) {
        utxos = utxos.filter((u) => u.status.confirmed);
      }

      const response: Record<string, unknown> = {
        address: btcAddress,
        network: NETWORK,
        type: "cardinal",
        utxos: utxos.map(formatUtxo),
        summary: summarizeUtxos(utxos),
        explorerUrl: getMempoolAddressUrl(btcAddress, NETWORK),
      };

      if (NETWORK === "testnet") {
        response.warning =
          "Ordinal indexing not available on testnet. All UTXOs shown as cardinal.";
      }

      printJson(response);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-ordinal-utxos
// ---------------------------------------------------------------------------

program
  .command("get-ordinal-utxos")
  .description(
    "Get ordinal UTXOs (contain inscriptions — do not spend). " +
      "These UTXOs carry ordinal data and should not be used in regular transfers. " +
      "Only available on mainnet (Hiro Ordinals API does not index testnet)."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet if omitted)"
  )
  .option(
    "--confirmed-only",
    "Only return confirmed UTXOs",
    false
  )
  .action(async (opts: { address?: string; confirmedOnly: boolean }) => {
    try {
      const btcAddress = await getBtcAddress(opts.address);
      const indexer = new OrdinalIndexer(NETWORK);
      let utxos = await indexer.getOrdinalUtxos(btcAddress);

      if (opts.confirmedOnly) {
        utxos = utxos.filter((u) => u.status.confirmed);
      }

      const response: Record<string, unknown> = {
        address: btcAddress,
        network: NETWORK,
        type: "ordinal",
        utxos: utxos.map(formatUtxo),
        summary: summarizeUtxos(utxos),
        explorerUrl: getMempoolAddressUrl(btcAddress, NETWORK),
      };

      if (NETWORK === "testnet") {
        response.warning =
          "Ordinal indexing not available on testnet. No inscriptions can be detected.";
      }

      printJson(response);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-inscriptions
// ---------------------------------------------------------------------------

program
  .command("get-inscriptions")
  .description(
    "Get all inscriptions owned by a Bitcoin address. " +
      "Returns inscription IDs, content types, and metadata. " +
      "Only available on mainnet (Hiro Ordinals API does not index testnet)."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const btcAddress = await getBtcAddress(opts.address);
      const indexer = new OrdinalIndexer(NETWORK);
      const inscriptions = await indexer.getInscriptionsForAddress(btcAddress);

      const formattedInscriptions = inscriptions.map((ins) => ({
        id: ins.id,
        number: ins.number,
        contentType: ins.content_type,
        contentLength: ins.content_length,
        output: ins.output,
        location: ins.location,
        offset: ins.offset,
        genesis: {
          txid: ins.genesis_tx_id,
          blockHeight: ins.genesis_block_height,
          blockHash: ins.genesis_block_hash,
          timestamp: new Date(ins.genesis_timestamp).toISOString(),
        },
      }));

      printJson({
        address: btcAddress,
        network: NETWORK,
        inscriptions: formattedInscriptions,
        summary: {
          count: inscriptions.length,
          contentTypes: [
            ...new Set(inscriptions.map((i) => i.content_type)),
          ].sort(),
        },
        explorerUrl: getMempoolAddressUrl(btcAddress, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
