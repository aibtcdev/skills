#!/usr/bin/env bun
/**
 * Query skill CLI
 * Stacks network and blockchain query operations
 *
 * Usage: bun run query/query.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  getExplorerAddressUrl,
  getExplorerContractUrl,
  getExplorerTxUrl,
} from "../src/lib/config/networks.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";

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
// Address helpers
// ---------------------------------------------------------------------------

async function getStxAddress(address?: string): Promise<string> {
  if (address) {
    return address;
  }

  const walletManager = getWalletManager();
  const sessionInfo = walletManager.getSessionInfo();

  if (sessionInfo?.address) {
    return sessionInfo.address;
  }

  throw new Error(
    "No Stacks address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

/**
 * Format micro-STX to STX with appropriate decimal places.
 * Uses BigInt arithmetic to avoid floating-point precision loss.
 */
function formatStx(microStx: number | bigint | string): string {
  const micro =
    typeof microStx === "bigint"
      ? microStx
      : BigInt(Math.round(Number(microStx)));
  const whole = micro / 1_000_000n;
  const fraction = micro % 1_000_000n;
  const rawFractionStr = fraction.toString().padStart(6, "0");
  const trimmedFractionStr = rawFractionStr.replace(/0+$/, "");
  const stxStr =
    trimmedFractionStr.length > 0
      ? `${whole.toString()}.${trimmedFractionStr}`
      : whole.toString();
  return stxStr + " STX";
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("query")
  .description(
    "Stacks network and blockchain query operations: fees, accounts, blocks, mempool, contracts, and network status"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-stx-fees
// ---------------------------------------------------------------------------

program
  .command("get-stx-fees")
  .description(
    "Get current STX fee estimates for different priority levels. " +
      "Returns low, medium, and high fee tiers in micro-STX for token transfers, contract calls, and smart contracts."
  )
  .action(async () => {
    try {
      const hiro = getHiroApi(NETWORK);
      const fees = await hiro.getMempoolFees();
      const transferFees = fees.token_transfer;

      printJson({
        network: NETWORK,
        fees: {
          low: {
            microStx: transferFees.low_priority,
            stx: formatStx(transferFees.low_priority),
            description: "Lower fee, may take longer to confirm",
          },
          medium: {
            microStx: transferFees.medium_priority,
            stx: formatStx(transferFees.medium_priority),
            description: "Standard fee, typical confirmation time",
          },
          high: {
            microStx: transferFees.high_priority,
            stx: formatStx(transferFees.high_priority),
            description: "Higher fee, faster confirmation",
          },
        },
        byTransactionType: {
          tokenTransfer: {
            low: transferFees.low_priority,
            medium: transferFees.medium_priority,
            high: transferFees.high_priority,
          },
          contractCall: {
            low: fees.contract_call.low_priority,
            medium: fees.contract_call.medium_priority,
            high: fees.contract_call.high_priority,
          },
          smartContract: {
            low: fees.smart_contract.low_priority,
            medium: fees.smart_contract.medium_priority,
            high: fees.smart_contract.high_priority,
          },
        },
        unit: "micro-STX",
        note: "1 STX = 1,000,000 micro-STX. Fees are estimates based on current mempool conditions.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-account-info
// ---------------------------------------------------------------------------

program
  .command("get-account-info")
  .description(
    "Get detailed account information including nonce and STX balance."
  )
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      const hiro = getHiroApi(NETWORK);
      const address = await getStxAddress(opts.address);
      const info = await hiro.getAccountInfo(address);

      printJson({
        address,
        network: NETWORK,
        nonce: info.nonce,
        balance: {
          microStx: info.balance,
          stx: formatStx(info.balance),
        },
        explorerUrl: getExplorerAddressUrl(address, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-account-transactions
// ---------------------------------------------------------------------------

program
  .command("get-account-transactions")
  .description("Get transaction history for a Stacks account.")
  .option(
    "--address <address>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .option("--limit <number>", "Maximum number of results", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(
    async (opts: { address?: string; limit: string; offset: string }) => {
      try {
        const hiro = getHiroApi(NETWORK);
        const address = await getStxAddress(opts.address);
        const limit = parseInt(opts.limit, 10);
        const offset = parseInt(opts.offset, 10);
        const result = await hiro.getAccountTransactions(address, {
          limit,
          offset,
        });

        printJson({
          address,
          network: NETWORK,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          transactions: result.results.map((tx) => ({
            txId: tx.tx_id,
            type: tx.tx_type,
            status: tx.tx_status,
            sender: tx.sender_address,
            blockHeight: tx.block_height,
            fee: tx.fee_rate,
            explorerUrl: getExplorerTxUrl(tx.tx_id, NETWORK),
          })),
          explorerUrl: getExplorerAddressUrl(address, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-block-info
// ---------------------------------------------------------------------------

program
  .command("get-block-info")
  .description(
    "Get information about a specific Stacks block by height or hash."
  )
  .requiredOption(
    "--height-or-hash <value>",
    "Block height (integer) or block hash (0x-prefixed hex)"
  )
  .action(async (opts: { heightOrHash: string }) => {
    try {
      const hiro = getHiroApi(NETWORK);
      const isHeight = /^\d+$/.test(opts.heightOrHash);

      const block = isHeight
        ? await hiro.getBlockByHeight(parseInt(opts.heightOrHash, 10))
        : await hiro.getBlockByHash(opts.heightOrHash);

      printJson({
        network: NETWORK,
        hash: block.hash,
        height: block.height,
        canonical: block.canonical,
        burnBlockHeight: block.burn_block_height,
        burnBlockTime: block.burn_block_time,
        burnBlockTimeIso: new Date(block.burn_block_time * 1000).toISOString(),
        txCount: block.txs.length,
        txIds: block.txs,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-mempool-info
// ---------------------------------------------------------------------------

program
  .command("get-mempool-info")
  .description(
    "Get pending transactions in the Stacks mempool. Optionally filter by sender address."
  )
  .option("--sender-address <address>", "Filter by sender address")
  .option("--limit <number>", "Maximum number of results", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(
    async (opts: {
      senderAddress?: string;
      limit: string;
      offset: string;
    }) => {
      try {
        const hiro = getHiroApi(NETWORK);
        const limit = parseInt(opts.limit, 10);
        const offset = parseInt(opts.offset, 10);
        const result = await hiro.getMempoolTransactions({
          sender_address: opts.senderAddress,
          limit,
          offset,
        });

        printJson({
          network: NETWORK,
          total: result.total,
          limit,
          offset,
          transactions: result.results.map((tx) => ({
            txId: tx.tx_id,
            type: tx.tx_type,
            sender: tx.sender_address,
            fee: tx.fee_rate,
            nonce: tx.nonce,
            receiptTime: tx.receipt_time_iso,
            explorerUrl: getExplorerTxUrl(tx.tx_id, NETWORK),
          })),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-contract-info
// ---------------------------------------------------------------------------

program
  .command("get-contract-info")
  .description(
    "Get information about a smart contract including its ABI (functions, variables, maps, tokens)."
  )
  .requiredOption(
    "--contract-id <id>",
    "Contract ID in format: address.contract-name"
  )
  .action(async (opts: { contractId: string }) => {
    try {
      const hiro = getHiroApi(NETWORK);
      const [info, iface] = await Promise.all([
        hiro.getContractInfo(opts.contractId),
        hiro.getContractInterface(opts.contractId),
      ]);

      printJson({
        contractId: opts.contractId,
        network: NETWORK,
        txId: info.tx_id,
        blockHeight: info.block_height,
        functions: iface.functions.map((f) => ({
          name: f.name,
          access: f.access,
          args: f.args,
          outputs: f.outputs,
        })),
        variables: iface.variables,
        maps: iface.maps,
        fungibleTokens: iface.fungible_tokens,
        nonFungibleTokens: iface.non_fungible_tokens,
        explorerUrl: getExplorerContractUrl(opts.contractId, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-contract-events
// ---------------------------------------------------------------------------

program
  .command("get-contract-events")
  .description("Get events emitted by a smart contract.")
  .requiredOption(
    "--contract-id <id>",
    "Contract ID in format: address.contract-name"
  )
  .option("--limit <number>", "Maximum number of results", "20")
  .option("--offset <number>", "Offset for pagination", "0")
  .action(
    async (opts: { contractId: string; limit: string; offset: string }) => {
      try {
        const hiro = getHiroApi(NETWORK);
        const limit = parseInt(opts.limit, 10);
        const offset = parseInt(opts.offset, 10);
        const result = await hiro.getContractEvents(opts.contractId, {
          limit,
          offset,
        });

        printJson({
          contractId: opts.contractId,
          network: NETWORK,
          limit,
          offset,
          events: result.results,
          explorerUrl: getExplorerContractUrl(opts.contractId, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-network-status
// ---------------------------------------------------------------------------

program
  .command("get-network-status")
  .description(
    "Get the current status of the Stacks network including chain tip and burn block height."
  )
  .action(async () => {
    try {
      const hiro = getHiroApi(NETWORK);
      const [status, coreInfo] = await Promise.all([
        hiro.getNetworkStatus(),
        hiro.getCoreApiInfo(),
      ]);

      printJson({
        network: NETWORK,
        serverVersion: status.server_version,
        status: status.status,
        chainTip: status.chain_tip,
        coreInfo: {
          peerVersion: coreInfo.peer_version,
          stacksTipHeight: coreInfo.stacks_tip_height,
          burnBlockHeight: coreInfo.burn_block_height,
          networkId: coreInfo.network_id,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// call-read-only
// ---------------------------------------------------------------------------

program
  .command("call-read-only")
  .description(
    "Call a read-only function on a smart contract. " +
      "Accepts hex-encoded Clarity arguments as a JSON array string. " +
      "Example: --args '[\"0x0100000000000000000000000000000001\"]' for uint(1)"
  )
  .requiredOption(
    "--contract-id <id>",
    "Contract ID in format: address.contract-name"
  )
  .requiredOption("--function-name <name>", "Name of the read-only function")
  .option(
    "--args <json>",
    "JSON array of hex-encoded Clarity values (e.g., '[\"0x0100...\"]')",
    "[]"
  )
  .option(
    "--sender <address>",
    "Sender address for the read-only call (uses wallet or contract deployer if omitted)"
  )
  .action(
    async (opts: {
      contractId: string;
      functionName: string;
      args: string;
      sender?: string;
    }) => {
      try {
        const hiro = getHiroApi(NETWORK);

        // Parse hex-encoded Clarity args
        let hexArgs: string[] = [];
        try {
          hexArgs = JSON.parse(opts.args);
          if (!Array.isArray(hexArgs)) {
            throw new Error("--args must be a JSON array");
          }
        } catch (parseError) {
          throw new Error(
            `Invalid --args JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
          );
        }

        // Import hex->CV conversion
        const { hexToCV } = await import("@stacks/transactions");
        const clarityArgs = hexArgs.map((h: string) =>
          hexToCV(h.startsWith("0x") ? h.slice(2) : h)
        );

        // Resolve sender: use provided, wallet, or contract address
        let senderAddress = opts.sender;
        if (!senderAddress) {
          const walletManager = getWalletManager();
          const session = walletManager.getSessionInfo();
          if (session?.address) {
            senderAddress = session.address;
          } else {
            // Fall back to the contract's own address as sender
            senderAddress = opts.contractId.split(".")[0];
          }
        }

        const result = await hiro.callReadOnlyFunction(
          opts.contractId,
          opts.functionName,
          clarityArgs,
          senderAddress
        );

        printJson({
          contractId: opts.contractId,
          functionName: opts.functionName,
          network: NETWORK,
          okay: result.okay,
          result: result.result,
          cause: result.cause,
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
