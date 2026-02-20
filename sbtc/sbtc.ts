#!/usr/bin/env bun
/**
 * sBTC skill CLI
 * sBTC token operations on Stacks L2: balances, transfers, deposits, and status
 *
 * Usage: bun run sbtc/sbtc.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getSbtcService } from "../src/lib/services/sbtc.service.js";
import { getSbtcDepositService } from "../src/lib/services/sbtc-deposit.service.js";
import { MempoolApi, getMempoolTxUrl } from "../src/lib/services/mempool-api.js";
import { resolveFee } from "../src/lib/utils/fee.js";

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
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("sbtc")
  .description(
    "sBTC operations: check balances, transfer, get deposit info, check peg stats, deposit BTC, and track deposit status"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-balance
// ---------------------------------------------------------------------------

program
  .command("get-balance")
  .description("Get the sBTC balance for a Stacks address.")
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const sbtcService = getSbtcService(NETWORK);
      let walletAddress: string;

      if (opts.address) {
        walletAddress = opts.address;
      } else {
        walletAddress = await getWalletAddress();
      }

      const balance = await sbtcService.getBalance(walletAddress);

      printJson({
        address: walletAddress,
        network: NETWORK,
        balance: {
          sats: balance.balanceSats,
          btc: balance.balanceBtc + " sBTC",
        },
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
    "Transfer sBTC to a recipient. Requires an unlocked wallet. " +
      "sBTC uses 8 decimals — specify amount in satoshis (1 sBTC = 100,000,000 satoshis)."
  )
  .requiredOption(
    "--recipient <address>",
    "Stacks address to send to"
  )
  .requiredOption(
    "--amount <sats>",
    "Amount in satoshis (e.g., '100000' for 0.001 sBTC)"
  )
  .option(
    "--memo <text>",
    "Optional memo message"
  )
  .option(
    "--fee <fee>",
    "Fee preset (low|medium|high) or micro-STX amount; auto-estimated if omitted"
  )
  .option(
    "--sponsored",
    "Use fee sponsorship if available",
    false
  )
  .action(
    async (opts: {
      recipient: string;
      amount: string;
      memo?: string;
      fee?: string;
      sponsored: boolean;
    }) => {
      try {
        const sbtcService = getSbtcService(NETWORK);
        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await sbtcService.transfer(
          account,
          opts.recipient,
          BigInt(opts.amount),
          opts.memo,
          resolvedFee,
          opts.sponsored
        );

        const btcAmount = (BigInt(opts.amount) / BigInt(100_000_000)).toString();

        printJson({
          success: true,
          txid: result.txid,
          from: account.address,
          recipient: opts.recipient,
          amount: btcAmount + " sBTC",
          amountSats: opts.amount,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-deposit-info
// ---------------------------------------------------------------------------

program
  .command("get-deposit-info")
  .description(
    "Get information about how to deposit BTC to receive sBTC. " +
      "If a wallet with Taproot keys is unlocked, returns a personalized deposit address."
  )
  .action(async () => {
    try {
      // Try to get wallet account (don't throw if not unlocked)
      const walletManager = getWalletManager();
      let account;
      try {
        account = walletManager.getActiveAccount();
      } catch {
        // Wallet not unlocked - return generic instructions
        account = null;
      }

      // If wallet is unlocked and has Taproot keys, generate real deposit address
      if (account?.taprootPublicKey) {
        const depositService = getSbtcDepositService(NETWORK);
        const reclaimPublicKey = Buffer.from(account.taprootPublicKey).toString("hex");

        const depositAddressInfo = await depositService.buildDepositAddress(
          account.address,
          reclaimPublicKey,
          80000, // Default max signer fee
          950    // Default reclaim lock time (blocks)
        );

        printJson({
          network: NETWORK,
          depositAddress: depositAddressInfo.depositAddress,
          maxSignerFee: `${depositAddressInfo.maxFee} satoshis`,
          reclaimLockTime: `${depositAddressInfo.lockTime} blocks`,
          stacksAddress: account.address,
          instructions: [
            "1. Send BTC to the deposit address above",
            "2. Wait for Bitcoin block confirmations",
            "3. sBTC tokens will be minted to your Stacks address",
            "4. If the deposit fails, you can reclaim your BTC after the lock time expires",
            "Alternatively, use the 'deposit' subcommand to build and broadcast the transaction automatically.",
          ],
        });
        return;
      }

      // Wallet not unlocked — return generic instructions
      const sbtcService = getSbtcService(NETWORK);
      const depositInfo = await sbtcService.getDepositInfo();

      printJson({
        network: NETWORK,
        ...depositInfo,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-peg-info
// ---------------------------------------------------------------------------

program
  .command("get-peg-info")
  .description("Get sBTC peg information including total supply and peg ratio.")
  .action(async () => {
    try {
      const sbtcService = getSbtcService(NETWORK);
      const pegInfo = await sbtcService.getPegInfo();

      printJson({
        network: NETWORK,
        totalSupply: {
          sats: pegInfo.totalSupplySats,
          btc: pegInfo.totalSupplyBtc + " sBTC",
        },
        pegRatio: pegInfo.pegRatio,
      });
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
    "Deposit BTC to receive sBTC on Stacks L2. " +
      "Builds, signs, and broadcasts a Bitcoin transaction to the sBTC deposit address. " +
      "After confirmation, sBTC tokens are minted to your Stacks address. " +
      "Requires an unlocked wallet with Bitcoin and Taproot keys."
  )
  .requiredOption(
    "--amount <sats>",
    "Amount to deposit in satoshis (1 BTC = 100,000,000 satoshis)"
  )
  .option(
    "--fee-rate <rate>",
    "Fee rate: fast (~10 min), medium (~30 min), slow (~1 hr), or number in sat/vB (default: medium)",
    "medium"
  )
  .option(
    "--max-signer-fee <sats>",
    "Max fee the sBTC system can charge in satoshis (default: 80000)",
    "80000"
  )
  .option(
    "--reclaim-lock-time <blocks>",
    "Block height when reclaim becomes available if deposit fails (default: 950)",
    "950"
  )
  .option(
    "--include-ordinals",
    "Include ordinal UTXOs (WARNING: may destroy valuable inscriptions!)",
    false
  )
  .action(
    async (opts: {
      amount: string;
      feeRate: string;
      maxSignerFee: string;
      reclaimLockTime: string;
      includeOrdinals: boolean;
    }) => {
      try {
        const walletManager = getWalletManager();
        const account = walletManager.getActiveAccount();

        if (!account) {
          throw new Error(
            "Wallet is not unlocked. Use wallet/wallet.ts unlock first to enable transactions."
          );
        }

        if (!account.btcAddress || !account.taprootAddress || !account.taprootPublicKey) {
          throw new Error(
            "Bitcoin or Taproot keys not available. Please unlock your wallet again."
          );
        }

        const amountSats = parseInt(opts.amount, 10);
        if (isNaN(amountSats) || amountSats <= 0) {
          throw new Error("--amount must be a positive integer (satoshis)");
        }

        const maxSignerFee = parseInt(opts.maxSignerFee, 10);
        const reclaimLockTime = parseInt(opts.reclaimLockTime, 10);

        // Resolve fee rate
        let resolvedFeeRate: number;
        if (opts.feeRate === "fast" || opts.feeRate === "medium" || opts.feeRate === "slow") {
          const api = new MempoolApi(NETWORK);
          const feeTiers = await api.getFeeTiers();
          switch (opts.feeRate) {
            case "fast":
              resolvedFeeRate = feeTiers.fast;
              break;
            case "slow":
              resolvedFeeRate = feeTiers.slow;
              break;
            case "medium":
            default:
              resolvedFeeRate = feeTiers.medium;
              break;
          }
        } else {
          resolvedFeeRate = parseInt(opts.feeRate, 10);
          if (isNaN(resolvedFeeRate) || resolvedFeeRate <= 0) {
            throw new Error(
              "--fee-rate must be 'fast', 'medium', 'slow', or a positive integer (sat/vB)"
            );
          }
        }

        const depositService = getSbtcDepositService(NETWORK);
        const reclaimPublicKey = Buffer.from(account.taprootPublicKey).toString("hex");

        const depositResult = await depositService.buildDepositTransaction(
          amountSats,
          account.address,
          account.btcAddress,
          reclaimPublicKey,
          resolvedFeeRate,
          maxSignerFee,
          reclaimLockTime,
          account.btcPrivateKey,
          opts.includeOrdinals
        );

        const result = await depositService.broadcastAndNotify(
          depositResult.txHex,
          depositResult.depositScript,
          depositResult.reclaimScript,
          depositResult.vout
        );

        const btcAmount = (amountSats / 100_000_000).toFixed(8);

        printJson({
          success: true,
          txid: result.txid,
          explorerUrl: getMempoolTxUrl(result.txid, NETWORK),
          deposit: {
            amount: btcAmount + " BTC",
            amountSats,
            recipient: account.address,
            bitcoinAddress: account.btcAddress,
            taprootAddress: account.taprootAddress,
            maxSignerFee: maxSignerFee + " sats",
            reclaimLockTime: reclaimLockTime + " blocks",
            feeRate: `${resolvedFeeRate} sat/vB`,
          },
          network: NETWORK,
          note: "sBTC tokens will be minted to your Stacks address after Bitcoin transaction confirms.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// deposit-status
// ---------------------------------------------------------------------------

program
  .command("deposit-status")
  .description("Check the status of an sBTC deposit transaction via the Emily API.")
  .requiredOption(
    "--txid <txid>",
    "Bitcoin transaction ID of the deposit"
  )
  .option(
    "--vout <index>",
    "Output index of the deposit (default: 0)",
    "0"
  )
  .action(async (opts: { txid: string; vout: string }) => {
    try {
      const vout = parseInt(opts.vout, 10);
      const depositService = getSbtcDepositService(NETWORK);

      try {
        const status = await depositService.getDepositStatus(opts.txid, vout);

        printJson({
          txid: opts.txid,
          vout,
          status,
          explorerUrl: getMempoolTxUrl(opts.txid, NETWORK),
          network: NETWORK,
        });
      } catch (error) {
        // Handle 404 (deposit not found) gracefully
        if (error instanceof Error && error.message.includes("404")) {
          printJson({
            txid: opts.txid,
            vout,
            status: "not_found",
            message:
              "Deposit not found in Emily API. It may not be indexed yet, or the transaction may not be a valid sBTC deposit.",
            explorerUrl: getMempoolTxUrl(opts.txid, NETWORK),
            network: NETWORK,
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
