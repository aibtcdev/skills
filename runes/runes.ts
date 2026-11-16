#!/usr/bin/env bun
/**
 * Runes skill CLI
 * Bitcoin rune operations: check balances, list UTXOs, transfer runes
 *
 * Usage: bun run runes/runes.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "@aibtc/skills/src/lib/config/networks.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import {
  MempoolApi,
  getMempoolTxUrl,
  getMempoolAddressUrl,
} from "@aibtc/skills/src/lib/services/mempool-api.js";
import { UnisatIndexer } from "@aibtc/skills/src/lib/services/unisat-indexer.js";
import { buildRuneTransfer, signRuneTransfer } from "@aibtc/skills/src/lib/transactions/rune-transfer-builder.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

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
  const named = ["fast", "medium", "slow", undefined];
  if (named.includes(feeRateInput)) {
    const fees = await api.getFeeEstimates();
    if (!feeRateInput || feeRateInput === "medium") return fees.halfHourFee;
    if (feeRateInput === "fast") return fees.fastestFee;
    return fees.hourFee;
  }

  const numeric = parseFloat(feeRateInput!);
  if (isNaN(numeric) || numeric <= 0) {
    throw new Error(
      "--fee-rate must be 'fast', 'medium', 'slow', or a positive number (sat/vB)"
    );
  }
  return numeric;
}

/**
 * Format a rune amount with its divisibility.
 */
function formatRuneAmount(amount: string, divisibility: number, symbol: string): string {
  if (divisibility === 0) return `${amount} ${symbol}`;
  const num = BigInt(amount);
  const divisor = 10n ** BigInt(divisibility);
  const whole = num / divisor;
  const frac = num % divisor;
  const fracStr = frac.toString().padStart(divisibility, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr} ${symbol}` : `${whole} ${symbol}`;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("runes")
  .description(
    "Bitcoin rune operations: check rune balances, list rune UTXOs, and transfer runes."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

program
  .command("balance")
  .description(
    "Get rune balances for a Bitcoin address. " +
      "Returns all rune token balances held by the address."
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet's Taproot address if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      let address = opts.address;

      if (!address) {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();
        if (!sessionInfo?.taprootAddress) {
          throw new Error(
            "No address provided and wallet is not unlocked. " +
              "Either provide --address or unlock your wallet first."
          );
        }
        address = sessionInfo.taprootAddress;
      }

      const indexer = new UnisatIndexer(NETWORK);
      const balances = await indexer.getRuneBalances(address);

      const formattedBalances = balances.map((b) => ({
        rune: b.rune,
        runeId: b.runeid,
        spacedRune: b.spacedRune,
        amount: b.amount,
        formatted: formatRuneAmount(b.amount, b.divisibility, b.symbol),
        symbol: b.symbol,
        divisibility: b.divisibility,
      }));

      printJson({
        address,
        network: NETWORK,
        balances: formattedBalances,
        summary: {
          runeCount: balances.length,
        },
        explorerUrl: getMempoolAddressUrl(address, NETWORK),
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
    "List rune-bearing UTXOs for a specific rune on a Bitcoin address."
  )
  .requiredOption(
    "--rune-id <id>",
    "Rune ID (e.g., '840000:1')"
  )
  .option(
    "--address <address>",
    "Bitcoin address to check (uses active wallet's Taproot address if omitted)"
  )
  .action(async (opts: { runeId: string; address?: string }) => {
    try {
      let address = opts.address;

      if (!address) {
        const walletManager = getWalletManager();
        const sessionInfo = walletManager.getSessionInfo();
        if (!sessionInfo?.taprootAddress) {
          throw new Error(
            "No address provided and wallet is not unlocked. " +
              "Either provide --address or unlock your wallet first."
          );
        }
        address = sessionInfo.taprootAddress;
      }

      const indexer = new UnisatIndexer(NETWORK);
      const utxos = await indexer.getRuneUtxos(address, opts.runeId);

      const formattedUtxos = utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshi,
        address: u.address,
        runes: u.runes.map((r) => ({
          runeId: r.runeid,
          spacedRune: r.spacedRune,
          amount: r.amount,
          formatted: formatRuneAmount(r.amount, r.divisibility, r.symbol),
          symbol: r.symbol,
        })),
      }));

      printJson({
        address,
        network: NETWORK,
        runeId: opts.runeId,
        utxos: formattedUtxos,
        summary: {
          utxoCount: utxos.length,
          totalSatoshis: utxos.reduce((sum, u) => sum + u.satoshi, 0),
        },
        explorerUrl: getMempoolAddressUrl(address, NETWORK),
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
    "Transfer runes to a recipient address. " +
      "Builds a transaction with a Runestone OP_RETURN, sends runes to the recipient, " +
      "and returns remaining runes to the sender. Always includes an explicit change " +
      "pointer to avoid burning remaining runes."
  )
  .requiredOption(
    "--rune-id <id>",
    "Rune ID (e.g., '840000:1')"
  )
  .requiredOption(
    "--amount <amount>",
    "Amount of runes to transfer (in smallest unit)"
  )
  .requiredOption(
    "--recipient <address>",
    "Recipient address"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast | medium | slow | number in sat/vB (default: medium)"
  )
  .action(
    async (opts: {
      runeId: string;
      amount: string;
      recipient: string;
      feeRate?: string;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();

        if (!account) {
          throw new Error(
            "Wallet is not unlocked. Use wallet/wallet.ts unlock first."
          );
        }

        if (
          !account.btcAddress ||
          !account.btcPrivateKey ||
          !account.btcPublicKey ||
          !account.taprootPrivateKey ||
          !account.taprootPublicKey ||
          !account.taprootAddress
        ) {
          throw new Error(
            "Bitcoin and Taproot keys not available. Please unlock your wallet again."
          );
        }

        const transferAmount = BigInt(opts.amount);
        if (transferAmount <= 0n) {
          throw new Error("--amount must be a positive integer");
        }

        const indexer = new UnisatIndexer(NETWORK);

        // Get rune UTXOs for this specific rune
        const runeUtxos = await indexer.getRuneUtxos(
          account.taprootAddress,
          opts.runeId
        );

        if (runeUtxos.length === 0) {
          throw new Error(
            `No UTXOs found for rune ${opts.runeId} at address ${account.taprootAddress}`
          );
        }

        // Compute total rune balance across all UTXOs for partial-transfer burn guard
        const totalRuneAmount = runeUtxos.reduce((sum, u) => {
          const runeEntry = u.runes.find((r) => r.runeid === opts.runeId);
          return sum + (runeEntry ? BigInt(runeEntry.amount) : 0n);
        }, 0n);

        // Convert Unisat rune UTXOs to mempool UTXO format for the builder
        const runeUtxosFormatted = runeUtxos.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.satoshi,
          status: {
            confirmed: true,
            block_height: u.height,
            block_hash: "",
            block_time: 0,
          },
        }));

        // Get cardinal UTXOs for fees
        const cardinalUtxos = await indexer.getCardinalUtxos(account.btcAddress);
        if (cardinalUtxos.length === 0) {
          throw new Error(
            `No cardinal UTXOs available at ${account.btcAddress} to pay fees. ` +
              `Send some BTC to your SegWit address first.`
          );
        }

        const mempoolApi = new MempoolApi(NETWORK);
        const actualFeeRate = await resolveFeeRate(opts.feeRate, mempoolApi);

        const transferResult = buildRuneTransfer({
          runeId: opts.runeId,
          amount: transferAmount,
          runeUtxos: runeUtxosFormatted,
          feeUtxos: cardinalUtxos,
          recipientAddress: opts.recipient,
          feeRate: actualFeeRate,
          senderPubKey: account.btcPublicKey,
          senderTaprootPubKey: account.taprootPublicKey,
          senderAddress: account.btcAddress,
          senderTaprootAddress: account.taprootAddress,
          network: NETWORK,
          totalRuneAmount,
        });

        const signed = signRuneTransfer(
          transferResult.tx,
          account.taprootPrivateKey,
          account.btcPrivateKey,
          transferResult.taprootInputIndices,
          transferResult.feeInputIndices
        );

        const txid = await mempoolApi.broadcastTransaction(signed.txHex);

        printJson({
          success: true,
          txid,
          explorerUrl: getMempoolTxUrl(txid, NETWORK),
          rune: {
            runeId: opts.runeId,
            amount: opts.amount,
          },
          recipient: opts.recipient,
          fee: {
            satoshis: transferResult.fee,
            rateUsed: `${actualFeeRate} sat/vB`,
          },
          btcChange: {
            satoshis: transferResult.btcChange,
          },
          network: NETWORK,
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
