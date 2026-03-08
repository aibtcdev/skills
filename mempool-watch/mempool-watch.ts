#!/usr/bin/env bun
/**
 * Mempool Watch skill CLI
 * Bitcoin mempool monitoring via mempool.space
 *
 * Usage: bun run mempool-watch/mempool-watch.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  getMempoolApiUrl,
  getMempoolTxUrl,
  getMempoolAddressUrl,
} from "../src/lib/services/mempool-api.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const MEMPOOL_API = getMempoolApiUrl(NETWORK);

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("mempool-watch")
  .description(
    "Bitcoin mempool monitoring — transaction status, address history, and mempool stats via mempool.space"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// tx-status
// ---------------------------------------------------------------------------

program
  .command("tx-status")
  .description(
    "Check confirmation status of a Bitcoin transaction. Returns confirmed state, block height, and number of confirmations."
  )
  .requiredOption("--txid <txid>", "Bitcoin transaction ID (64 hex characters)")
  .action(async (opts: { txid: string }) => {
    try {
      const [statusRes, chainRes] = await Promise.all([
        fetch(`${MEMPOOL_API}/tx/${opts.txid}/status`),
        fetch(`${MEMPOOL_API}/blocks/tip/height`),
      ]);

      if (!statusRes.ok) {
        if (statusRes.status === 404) {
          throw new Error(
            `Transaction not found: ${opts.txid}. Verify the txid and network (current: ${NETWORK}).`
          );
        }
        throw new Error(
          `Failed to fetch tx status: ${statusRes.status} ${statusRes.statusText}`
        );
      }

      const status = await statusRes.json() as {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
      };

      const currentHeight = chainRes.ok
        ? parseInt(await chainRes.text(), 10)
        : null;

      const confirmations =
        status.confirmed && status.block_height != null && currentHeight != null
          ? currentHeight - status.block_height + 1
          : 0;

      printJson({
        txid: opts.txid,
        network: NETWORK,
        confirmed: status.confirmed,
        blockHeight: status.block_height ?? null,
        blockHash: status.block_hash ?? null,
        blockTime: status.block_time
          ? new Date(status.block_time * 1000).toISOString()
          : null,
        confirmations,
        explorerUrl: getMempoolTxUrl(opts.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// address-history
// ---------------------------------------------------------------------------

program
  .command("address-history")
  .description(
    "Retrieve recent transaction history for a Bitcoin address. Returns the most recent transactions first."
  )
  .requiredOption("--address <address>", "Bitcoin address to look up")
  .option("--limit <number>", "Number of transactions to return (1-25)", "10")
  .action(async (opts: { address: string; limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1 || limit > 25) {
        throw new Error("limit must be between 1 and 25");
      }

      const res = await fetch(`${MEMPOOL_API}/address/${opts.address}/txs`);

      if (!res.ok) {
        if (res.status === 400) {
          throw new Error(
            `Invalid address: ${opts.address}. Check format for ${NETWORK}.`
          );
        }
        throw new Error(
          `Failed to fetch address history: ${res.status} ${res.statusText}`
        );
      }

      const txs = await res.json() as Array<{
        txid: string;
        status: {
          confirmed: boolean;
          block_height?: number;
          block_time?: number;
        };
        fee: number;
        vin: Array<{ prevout?: { value: number } }>;
        vout: Array<{ value: number }>;
      }>;

      const sliced = txs.slice(0, limit);

      const transactions = sliced.map((tx) => {
        const valueIn = tx.vin.reduce(
          (sum, input) => sum + (input.prevout?.value ?? 0),
          0
        );
        const valueOut = tx.vout.reduce((sum, output) => sum + output.value, 0);

        return {
          txid: tx.txid,
          confirmed: tx.status.confirmed,
          blockHeight: tx.status.block_height ?? null,
          blockTime: tx.status.block_time
            ? new Date(tx.status.block_time * 1000).toISOString()
            : null,
          fee: tx.fee,
          valueIn,
          valueOut,
          explorerUrl: getMempoolTxUrl(tx.txid, NETWORK),
        };
      });

      printJson({
        address: opts.address,
        network: NETWORK,
        count: transactions.length,
        transactions,
        explorerUrl: getMempoolAddressUrl(opts.address, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// mempool-stats
// ---------------------------------------------------------------------------

program
  .command("mempool-stats")
  .description(
    "Get current Bitcoin mempool statistics: pending transaction count, backlog size, total fees, and recommended fee rates."
  )
  .action(async () => {
    try {
      const [mempoolRes, feesRes] = await Promise.all([
        fetch(`${MEMPOOL_API}/mempool`),
        fetch(`${MEMPOOL_API}/v1/fees/recommended`),
      ]);

      if (!mempoolRes.ok) {
        throw new Error(
          `Failed to fetch mempool stats: ${mempoolRes.status} ${mempoolRes.statusText}`
        );
      }
      if (!feesRes.ok) {
        throw new Error(
          `Failed to fetch fee estimates: ${feesRes.status} ${feesRes.statusText}`
        );
      }

      const mempool = await mempoolRes.json() as {
        count: number;
        vsize: number;
        total_fee: number;
        fee_histogram: Array<[number, number]>;
      };

      const fees = await feesRes.json() as {
        fastestFee: number;
        halfHourFee: number;
        hourFee: number;
        economyFee: number;
        minimumFee: number;
      };

      printJson({
        network: NETWORK,
        pendingTransactions: mempool.count,
        pendingVsize: mempool.vsize,
        totalFees: mempool.total_fee,
        recommendedFees: {
          fast: {
            satPerVb: fees.fastestFee,
            target: "~10 minutes (next block)",
          },
          medium: {
            satPerVb: fees.halfHourFee,
            target: "~30 minutes",
          },
          slow: {
            satPerVb: fees.hourFee,
            target: "~1 hour",
          },
          economy: {
            satPerVb: fees.economyFee,
            target: "~24 hours",
          },
          minimum: {
            satPerVb: fees.minimumFee,
            target: "minimum relay fee",
          },
        },
        feeHistogram: mempool.fee_histogram,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
