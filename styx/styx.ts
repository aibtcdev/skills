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
  MAX_DEPOSIT_SATS,
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
import { printJson, handleError } from "../src/lib/utils/cli.js";

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
        note: `Available: ~${status.estimatedAvailable} BTC (${Math.floor(status.estimatedAvailable * 1e8)} sats)`,
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
      printJson({ pools });
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
      printJson(fees);
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
      printJson({ priceUsd: price });
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
        const btcSender = opts.btcSender || account.btcAddress;

        // Step 1: Check pool liquidity
        const poolStatus = await styxSDK.getPoolStatus(opts.pool);
        const availableSats = Math.floor(poolStatus.estimatedAvailable * 1e8);
        if (amountSats > availableSats) {
          throw new Error(
            `Insufficient pool liquidity: need ${amountSats} sats, pool has ~${availableSats} sats`
          );
        }

        // Step 2: Create deposit reservation
        const depositId = await styxSDK.createDeposit({
          btcAmount: amountSats / 1e8,
          stxReceiver,
          btcSender,
          poolId: opts.pool,
        });

        // Step 3: Prepare transaction (get UTXOs, deposit address, OP_RETURN)
        const feePriority = opts.fee as FeePriority;
        const prepared = await styxSDK.prepareTransaction({
          amount: (amountSats / 1e8).toFixed(8),
          userAddress: stxReceiver,
          btcAddress: btcSender,
          feePriority,
          walletProvider: null,
          poolId: opts.pool,
        });

        // Step 4: Build PSBT locally with @scure/btc-signer
        const btcNetwork =
          NETWORK === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
        const tx = new btc.Transaction({ allowUnknownOutputs: true });
        const senderP2wpkh = btc.p2wpkh(account.btcPublicKey, btcNetwork);

        // Add inputs from prepared UTXOs
        for (const utxo of prepared.utxos) {
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

        // Step 5: Sign all inputs
        tx.sign(account.btcPrivateKey);
        tx.finalize();

        const txHex = tx.hex;
        const txid = tx.id;

        // Step 6: Broadcast to mempool.space
        const mempoolApi = new MempoolApi(NETWORK);
        const broadcastTxid = await mempoolApi.broadcastTransaction(txHex);

        // Step 7: Update deposit status
        await styxSDK.updateDepositStatus({
          id: depositId,
          data: {
            btcTxId: broadcastTxid,
            status: "broadcast",
          },
        });

        const btcAmount = (amountSats / 1e8).toFixed(8);

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
        });
      } catch (error) {
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
      if (!opts.id && !opts.txid) {
        throw new Error("Provide either --id <depositId> or --txid <btcTxId>");
      }

      let deposit: Deposit;
      if (opts.id) {
        deposit = await styxSDK.getDepositStatus(opts.id);
      } else {
        deposit = await styxSDK.getDepositStatusByTxId(opts.txid!);
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
        try {
          const account = walletManager.getActiveAccount();
          address = account.address;
        } catch {
          throw new Error(
            "No --address provided and wallet is not unlocked."
          );
        }
      }

      const deposits: Deposit[] = await styxSDK.getDepositHistory(address);
      printJson({
        address,
        count: deposits.length,
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
