#!/usr/bin/env bun
/**
 * Styx BTC→sBTC deposit skill CLI
 *
 * Headless BTC→sBTC conversion via Styx protocol (btc2sbtc.com).
 * Uses @faktoryfun/styx-sdk for deposit reservation and tracking,
 * @scure/btc-signer for PSBT construction and signing,
 * mempool.space for broadcast.
 *
 * Usage: bun run styx/styx.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  styxSDK,
  MIN_DEPOSIT_SATS,
} from "@faktoryfun/styx-sdk";
import type {
  FeePriority,
  PoolStatus,
  FeeEstimates,
  Deposit,
  PoolConfig,
} from "@faktoryfun/styx-sdk";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { NETWORK } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { MempoolApi, getMempoolTxUrl } from "../src/lib/services/mempool-api.js";
import { OrdinalIndexer } from "../src/lib/services/ordinal-indexer.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const FEE_PRIORITIES = ["low", "medium", "high"] as const;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("styx")
  .description(
    "BTC→sBTC conversion via Styx protocol (btc2sbtc.com): pool status, fees, deposit, and tracking"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// pool-status
// ---------------------------------------------------------------------------

program
  .command("pool-status")
  .description("Get current pool status and available liquidity.")
  .option("--pool <id>", "Pool ID (main or aibtc)", "main")
  .action(async (opts: { pool: string }) => {
    try {
      const status: PoolStatus = await styxSDK.getPoolStatus(opts.pool);
      printJson({
        pool: opts.pool,
        realAvailable: status.realAvailable,
        estimatedAvailable: status.estimatedAvailable,
        lastUpdated: status.lastUpdated,
        network: NETWORK,
        note: `Available: ~${status.estimatedAvailable} BTC (${Math.round(status.estimatedAvailable * 1e8)} sats)`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// pools
// ---------------------------------------------------------------------------

program
  .command("pools")
  .description("List all available Styx pools.")
  .action(async () => {
    try {
      const pools: PoolConfig[] = await styxSDK.getAvailablePools();
      printJson({ pools, network: NETWORK });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// fees
// ---------------------------------------------------------------------------

program
  .command("fees")
  .description("Get current Bitcoin network fee estimates (sat/vB).")
  .action(async () => {
    try {
      const fees: FeeEstimates = await styxSDK.getFeeEstimates();
      printJson({ ...fees, network: NETWORK });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// price
// ---------------------------------------------------------------------------

program
  .command("price")
  .description("Get current BTC price in USD.")
  .action(async () => {
    try {
      const price = await styxSDK.getBTCPrice();
      printJson({ priceUsd: price, network: NETWORK });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

program
  .command("deposit")
  .description(
    "Full headless BTC→sBTC deposit: reserve → build PSBT → sign → broadcast → update status. " +
      "Requires an unlocked wallet with BTC balance."
  )
  .requiredOption(
    "--amount <sats>",
    "Amount to deposit in satoshis (min 10000, max varies by pool)"
  )
  .option(
    "--stx-receiver <addr>",
    "Stacks address to receive sBTC (uses active wallet if omitted)"
  )
  .option(
    "--btc-sender <addr>",
    "BTC address sending funds (uses active wallet if omitted)"
  )
  .option("--pool <id>", "Pool ID (main or aibtc)", "main")
  .option("--fee <priority>", "Fee priority: low, medium, high", "medium")
  .action(
    async (opts: {
      amount: string;
      stxReceiver?: string;
      btcSender?: string;
      pool: string;
      fee: string;
    }) => {
      let depositId: string | undefined;
      let broadcastTxid: string | undefined;
      try {
        const amountSats = parseInt(opts.amount, 10);
        if (isNaN(amountSats) || amountSats <= 0) {
          throw new Error("--amount must be a positive integer (satoshis)");
        }
        if (amountSats < MIN_DEPOSIT_SATS) {
          throw new Error(
            `Amount ${amountSats} below minimum deposit (${MIN_DEPOSIT_SATS} sats)`
          );
        }

        // Get wallet account
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error(
            "Wallet is not unlocked. Use wallet/wallet.ts unlock first."
          );
        }
        if (!account.btcAddress || !account.btcPrivateKey || !account.btcPublicKey) {
          throw new Error(
            "Bitcoin keys not available. Unlock your wallet again."
          );
        }

        const stxReceiver = opts.stxReceiver || account.address;

        // Ensure btcSender matches the active wallet — signing uses the wallet's keys
        if (opts.btcSender && opts.btcSender !== account.btcAddress) {
          throw new Error(
            `--btc-sender must match the active wallet BTC address (${account.btcAddress}). ` +
              "This CLI signs with the active wallet's keys."
          );
        }
        const btcSender = account.btcAddress;

        // Validate fee priority
        const feePriority = opts.fee as FeePriority;
        if (!FEE_PRIORITIES.includes(feePriority)) {
          throw new Error(
            `Invalid --fee value "${opts.fee}". Must be one of: ${FEE_PRIORITIES.join(", ")}`
          );
        }

        // Step 1: Check pool liquidity
        const poolStatus = await styxSDK.getPoolStatus(opts.pool);
        const availableSats = Math.round(poolStatus.estimatedAvailable * 1e8);
        if (amountSats > availableSats) {
          throw new Error(
            `Insufficient pool liquidity: need ${amountSats} sats, pool has ~${availableSats} sats`
          );
        }

        // Step 2: Create deposit reservation
        const btcAmount = (amountSats / 1e8).toFixed(8);
        depositId = await styxSDK.createDeposit({
          btcAmount: parseFloat(btcAmount),
          stxReceiver,
          btcSender,
          poolId: opts.pool,
        });

        // Step 3: Prepare transaction (get UTXOs, deposit address, OP_RETURN)
        const prepared = await styxSDK.prepareTransaction({
          amount: btcAmount,
          userAddress: stxReceiver,
          btcAddress: btcSender,
          feePriority,
          walletProvider: null,
          poolId: opts.pool,
        });

        // Step 4: Filter out ordinal UTXOs to prevent destroying inscriptions
        // On mainnet, cross-reference SDK UTXOs against Hiro Ordinals API
        let safeUtxos = prepared.utxos;
        if (NETWORK === "mainnet") {
          const indexer = new OrdinalIndexer(NETWORK);
          const cardinalUtxos = await indexer.getCardinalUtxos(btcSender);
          const cardinalSet = new Set(
            cardinalUtxos.map((u) => `${u.txid}:${u.vout}`)
          );
          const filtered = prepared.utxos.filter((u) =>
            cardinalSet.has(`${u.txid}:${u.vout}`)
          );
          if (filtered.length < prepared.utxos.length) {
            const removed = prepared.utxos.length - filtered.length;
            if (filtered.length === 0) {
              throw new Error(
                `All ${removed} UTXO(s) selected by Styx contain inscriptions. ` +
                  "Cannot deposit without risking inscription loss."
              );
            }
            // Recompute change to keep the transaction balanced after removing inputs
            const originalTotal = prepared.utxos.reduce((sum, u) => sum + u.value, 0);
            const filteredTotal = filtered.reduce((sum, u) => sum + u.value, 0);
            const originalFee = originalTotal - prepared.amountInSatoshis - prepared.changeAmount;
            if (originalFee < 0) {
              throw new Error("Invalid SDK transaction preparation: negative implied fee.");
            }
            const requiredTotal = prepared.amountInSatoshis + originalFee;
            if (filteredTotal < requiredTotal) {
              throw new Error(
                `After removing ${removed} ordinal UTXO(s), remaining cardinal balance ` +
                  `(${filteredTotal} sats) is insufficient for deposit (${amountSats} sats) ` +
                  `and fee (${originalFee} sats).`
              );
            }
            prepared.changeAmount = filteredTotal - prepared.amountInSatoshis - originalFee;
          }
          safeUtxos = filtered;
        }

        // Step 5: Build PSBT locally with @scure/btc-signer
        const btcNetwork =
          NETWORK === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
        const tx = new btc.Transaction({ allowUnknownOutputs: true });
        const senderP2wpkh = btc.p2wpkh(account.btcPublicKey, btcNetwork);

        // Add inputs from safe UTXOs (ordinals filtered out on mainnet)
        for (const utxo of safeUtxos) {
          tx.addInput({
            txid: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: senderP2wpkh.script,
              amount: BigInt(utxo.value),
            },
          });
        }

        // Add deposit output (to Styx deposit address)
        tx.addOutputAddress(
          prepared.depositAddress,
          BigInt(prepared.amountInSatoshis),
          btcNetwork
        );

        // Add OP_RETURN output if present
        // opReturnData from Styx SDK is a full script hex (starts with 6a = OP_RETURN)
        if (prepared.opReturnData) {
          const opReturnScript = hex.decode(prepared.opReturnData);
          tx.addOutput({
            script: opReturnScript,
            amount: BigInt(0),
          });
        }

        // Add change output if there's change
        if (prepared.changeAmount > 0) {
          tx.addOutputAddress(
            btcSender,
            BigInt(prepared.changeAmount),
            btcNetwork
          );
        }

        // Step 6: Sign all inputs
        tx.sign(account.btcPrivateKey);
        tx.finalize();

        const txHex = tx.hex;

        // Step 7: Broadcast to mempool.space
        const mempoolApi = new MempoolApi(NETWORK);
        broadcastTxid = await mempoolApi.broadcastTransaction(txHex);

        // Step 8: Update deposit status (retry once on failure to avoid locking pool liquidity)
        let statusUpdateWarning: string | undefined;
        try {
          await styxSDK.updateDepositStatus({
            id: depositId,
            data: {
              btcTxId: broadcastTxid,
              status: "broadcast",
            },
          });
        } catch (statusError) {
          // Retry once — failing to update leaves pool liquidity locked
          try {
            await styxSDK.updateDepositStatus({
              id: depositId,
              data: {
                btcTxId: broadcastTxid,
                status: "broadcast",
              },
            });
          } catch {
            statusUpdateWarning =
              "Deposit broadcast succeeded but status update failed after retry. " +
              "Save depositId and txid for manual recovery. " +
              (statusError instanceof Error ? statusError.message : String(statusError));
          }
        }

        printJson({
          success: true,
          depositId,
          txid: broadcastTxid,
          explorerUrl: getMempoolTxUrl(broadcastTxid, NETWORK),
          amount: {
            sats: amountSats,
            btc: btcAmount,
          },
          pool: opts.pool,
          depositAddress: prepared.depositAddress,
          fee: prepared.fee,
          feeRate: prepared.feeRate,
          status: "broadcast",
          network: NETWORK,
          note: "sBTC will be credited to your Stacks address after Bitcoin confirmation.",
          ...(statusUpdateWarning ? { warning: statusUpdateWarning } : {}),
        });
      } catch (error) {
        // Best-effort cleanup: cancel reservation if we never broadcast
        if (depositId && !broadcastTxid) {
          try {
            await styxSDK.updateDepositStatus({
              id: depositId,
              data: { status: "canceled" },
            });
          } catch {
            // Reservation will expire server-side; don't mask original error
          }
        }
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Check deposit status by deposit ID or Bitcoin transaction ID.")
  .option("--id <depositId>", "Styx deposit ID")
  .option("--txid <btcTxId>", "Bitcoin transaction ID")
  .action(async (opts: { id?: string; txid?: string }) => {
    try {
      let deposit: Deposit;
      if (opts.id) {
        deposit = await styxSDK.getDepositStatus(opts.id);
      } else if (opts.txid) {
        deposit = await styxSDK.getDepositStatusByTxId(opts.txid);
      } else {
        throw new Error("Provide either --id <depositId> or --txid <btcTxId>");
      }

      printJson({
        id: deposit.id,
        status: deposit.status,
        btcAmount: deposit.btcAmount,
        sbtcAmount: deposit.sbtcAmount,
        stxReceiver: deposit.stxReceiver,
        btcSender: deposit.btcSender,
        btcTxId: deposit.btcTxId,
        stxTxId: deposit.stxTxId,
        createdAt: deposit.createdAt,
        updatedAt: deposit.updatedAt,
        network: NETWORK,
        explorerUrl: deposit.btcTxId
          ? getMempoolTxUrl(deposit.btcTxId, NETWORK)
          : null,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

program
  .command("history")
  .description("Get deposit history for a Stacks address.")
  .option(
    "--address <addr>",
    "Stacks address (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      let address = opts.address;
      if (!address) {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();
        if (!account) {
          throw new Error(
            "No --address provided and wallet is not unlocked."
          );
        }
        address = account.address;
      }

      const deposits: Deposit[] = await styxSDK.getDepositHistory(address);
      printJson({
        address,
        count: deposits.length,
        network: NETWORK,
        deposits: deposits.map((d) => ({
          id: d.id,
          status: d.status,
          btcAmount: d.btcAmount,
          sbtcAmount: d.sbtcAmount,
          btcTxId: d.btcTxId,
          createdAt: d.createdAt,
        })),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
