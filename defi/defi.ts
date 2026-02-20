#!/usr/bin/env bun
/**
 * DeFi skill CLI
 * ALEX DEX token swaps and Zest Protocol lending operations on Stacks (mainnet-only)
 *
 * Usage: bun run defi/defi.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import {
  getAlexDexService,
  getZestProtocolService,
} from "../src/lib/services/defi.service.js";

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
  .name("defi")
  .description(
    "DeFi operations: ALEX DEX token swaps and pool queries, Zest Protocol lending (supply, withdraw, borrow, repay, claim rewards). Mainnet-only."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// alex-get-swap-quote
// ---------------------------------------------------------------------------

program
  .command("alex-get-swap-quote")
  .description(
    "Get a swap quote from ALEX DEX. Returns the expected output amount for swapping tokenX to tokenY. " +
      "Accepts full contract IDs or token symbols (e.g., 'STX', 'ALEX'). Mainnet-only."
  )
  .requiredOption(
    "--token-x <contractId>",
    "Input token: contract ID (e.g., SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wstx-v2) or symbol (e.g., STX)"
  )
  .requiredOption(
    "--token-y <contractId>",
    "Output token: contract ID or symbol"
  )
  .requiredOption(
    "--amount-in <units>",
    "Amount of tokenX to swap (in smallest units)"
  )
  .action(
    async (opts: { tokenX: string; tokenY: string; amountIn: string }) => {
      try {
        const alexService = getAlexDexService(NETWORK);
        const walletAddress = await getWalletAddress();
        const quote = await alexService.getSwapQuote(
          opts.tokenX,
          opts.tokenY,
          BigInt(opts.amountIn),
          walletAddress
        );

        printJson({
          network: NETWORK,
          quote: {
            tokenIn: quote.tokenIn,
            tokenOut: quote.tokenOut,
            amountIn: quote.amountIn,
            expectedAmountOut: quote.amountOut,
            route: quote.route,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// alex-swap
// ---------------------------------------------------------------------------

program
  .command("alex-swap")
  .description(
    "Execute a token swap on ALEX DEX. Swaps tokenX for tokenY using the ALEX AMM. " +
      "Accepts full contract IDs or token symbols. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--token-x <contractId>",
    "Input token: contract ID or symbol"
  )
  .requiredOption(
    "--token-y <contractId>",
    "Output token: contract ID or symbol"
  )
  .requiredOption(
    "--amount-in <units>",
    "Amount of tokenX to swap (in smallest units)"
  )
  .option(
    "--min-amount-out <units>",
    "Minimum acceptable output amount for slippage protection (default: 0)",
    "0"
  )
  .action(
    async (opts: {
      tokenX: string;
      tokenY: string;
      amountIn: string;
      minAmountOut: string;
    }) => {
      try {
        const alexService = getAlexDexService(NETWORK);
        const account = await getAccount();
        const result = await alexService.swap(
          account,
          opts.tokenX,
          opts.tokenY,
          BigInt(opts.amountIn),
          BigInt(opts.minAmountOut)
        );

        printJson({
          success: true,
          txid: result.txid,
          swap: {
            tokenIn: opts.tokenX,
            tokenOut: opts.tokenY,
            amountIn: opts.amountIn,
            minAmountOut: opts.minAmountOut,
          },
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// alex-get-pool-info
// ---------------------------------------------------------------------------

program
  .command("alex-get-pool-info")
  .description(
    "Get liquidity pool information from ALEX DEX. Returns reserve balances and pool details for a token pair. Mainnet-only."
  )
  .requiredOption(
    "--token-x <contractId>",
    "First token: contract ID or symbol"
  )
  .requiredOption(
    "--token-y <contractId>",
    "Second token: contract ID or symbol"
  )
  .action(async (opts: { tokenX: string; tokenY: string }) => {
    try {
      const alexService = getAlexDexService(NETWORK);
      const walletAddress = await getWalletAddress();
      const poolInfo = await alexService.getPoolInfo(
        opts.tokenX,
        opts.tokenY,
        walletAddress
      );

      if (!poolInfo) {
        printJson({
          error: "Pool not found or no liquidity",
          tokenX: opts.tokenX,
          tokenY: opts.tokenY,
        });
        return;
      }

      printJson({
        network: NETWORK,
        pool: poolInfo,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// alex-list-pools
// ---------------------------------------------------------------------------

program
  .command("alex-list-pools")
  .description(
    "List all available trading pools on ALEX DEX. Returns pool ID, token pair, and factor for each pool. " +
      "Use this to discover which tokens can be swapped before calling alex-swap. Mainnet-only."
  )
  .option(
    "--limit <n>",
    "Maximum number of pools to return (default: 50)",
    "50"
  )
  .action(async (opts: { limit: string }) => {
    try {
      const alexService = getAlexDexService(NETWORK);
      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }

      const pools = await alexService.listPools(limit);

      printJson({
        network: NETWORK,
        poolCount: pools.length,
        pools: pools.map((p) => ({
          id: p.id,
          pair: `${p.tokenXSymbol}/${p.tokenYSymbol}`,
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          factor: p.factor,
        })),
        usage:
          "Use the tokenX and tokenY contract IDs with alex-get-swap-quote or alex-swap",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// zest-list-assets
// ---------------------------------------------------------------------------

program
  .command("zest-list-assets")
  .description(
    "List all supported assets on Zest Protocol. Returns assets that can be supplied, borrowed, or used as collateral. Mainnet-only."
  )
  .action(async () => {
    try {
      const zestService = getZestProtocolService(NETWORK);
      const assets = await zestService.getAssets();

      printJson({
        network: NETWORK,
        assetCount: assets.length,
        assets: assets.map((a) => ({
          symbol: a.symbol,
          name: a.name,
          contractId: a.contractId,
        })),
        usage:
          "Use the symbol (e.g., 'stSTX') or full contract ID in other zest-* commands",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// zest-get-position
// ---------------------------------------------------------------------------

program
  .command("zest-get-position")
  .description(
    "Get a user's lending position on Zest Protocol. Returns supplied and borrowed amounts for a specific asset. Mainnet-only."
  )
  .requiredOption(
    "--asset <symbolOrContractId>",
    "Asset symbol (e.g., 'stSTX', 'aeUSDC') or full contract ID"
  )
  .option(
    "--address <address>",
    "User address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { asset: string; address?: string }) => {
    try {
      const zestService = getZestProtocolService(NETWORK);
      const resolvedAsset = await zestService.resolveAsset(opts.asset);
      const userAddress = opts.address || (await getWalletAddress());
      const position = await zestService.getUserPosition(
        resolvedAsset,
        userAddress
      );

      if (!position) {
        printJson({
          address: userAddress,
          asset: resolvedAsset,
          position: null,
          message: "No position found for this asset",
        });
        return;
      }

      printJson({
        network: NETWORK,
        address: userAddress,
        position,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// zest-supply
// ---------------------------------------------------------------------------

program
  .command("zest-supply")
  .description(
    "Supply assets to the Zest Protocol lending pool to earn interest. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--asset <symbolOrContractId>",
    "Asset symbol (e.g., 'stSTX', 'aeUSDC') or full contract ID"
  )
  .requiredOption(
    "--amount <units>",
    "Amount to supply (in smallest units)"
  )
  .option(
    "--on-behalf-of <address>",
    "Supply on behalf of another address (uses wallet address if omitted)"
  )
  .action(
    async (opts: {
      asset: string;
      amount: string;
      onBehalfOf?: string;
    }) => {
      try {
        const zestService = getZestProtocolService(NETWORK);
        const resolvedAsset = await zestService.resolveAsset(opts.asset);
        const account = await getAccount();
        const result = await zestService.supply(
          account,
          resolvedAsset,
          BigInt(opts.amount),
          opts.onBehalfOf
        );

        printJson({
          success: true,
          txid: result.txid,
          action: "supply",
          asset: resolvedAsset,
          amount: opts.amount,
          onBehalfOf: opts.onBehalfOf || account.address,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// zest-withdraw
// ---------------------------------------------------------------------------

program
  .command("zest-withdraw")
  .description(
    "Withdraw assets from the Zest Protocol lending pool. Redeems supplied assets plus earned interest. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--asset <symbolOrContractId>",
    "Asset symbol (e.g., 'stSTX', 'aeUSDC') or full contract ID"
  )
  .requiredOption(
    "--amount <units>",
    "Amount to withdraw (in smallest units)"
  )
  .action(async (opts: { asset: string; amount: string }) => {
    try {
      const zestService = getZestProtocolService(NETWORK);
      const resolvedAsset = await zestService.resolveAsset(opts.asset);
      const account = await getAccount();
      const result = await zestService.withdraw(
        account,
        resolvedAsset,
        BigInt(opts.amount)
      );

      printJson({
        success: true,
        txid: result.txid,
        action: "withdraw",
        asset: resolvedAsset,
        amount: opts.amount,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// zest-borrow
// ---------------------------------------------------------------------------

program
  .command("zest-borrow")
  .description(
    "Borrow assets from Zest Protocol against supplied collateral. " +
      "Ensure you have sufficient collateral to maintain a healthy position. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--asset <symbolOrContractId>",
    "Asset symbol (e.g., 'stSTX', 'aeUSDC') or full contract ID"
  )
  .requiredOption(
    "--amount <units>",
    "Amount to borrow (in smallest units)"
  )
  .action(async (opts: { asset: string; amount: string }) => {
    try {
      const zestService = getZestProtocolService(NETWORK);
      const resolvedAsset = await zestService.resolveAsset(opts.asset);
      const account = await getAccount();
      const result = await zestService.borrow(
        account,
        resolvedAsset,
        BigInt(opts.amount)
      );

      printJson({
        success: true,
        txid: result.txid,
        action: "borrow",
        asset: resolvedAsset,
        amount: opts.amount,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// zest-repay
// ---------------------------------------------------------------------------

program
  .command("zest-repay")
  .description(
    "Repay borrowed assets to Zest Protocol. Repays borrowed assets plus accrued interest. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--asset <symbolOrContractId>",
    "Asset symbol (e.g., 'stSTX', 'aeUSDC') or full contract ID"
  )
  .requiredOption(
    "--amount <units>",
    "Amount to repay (in smallest units)"
  )
  .option(
    "--on-behalf-of <address>",
    "Repay on behalf of another address (uses wallet address if omitted)"
  )
  .action(
    async (opts: {
      asset: string;
      amount: string;
      onBehalfOf?: string;
    }) => {
      try {
        const zestService = getZestProtocolService(NETWORK);
        const resolvedAsset = await zestService.resolveAsset(opts.asset);
        const account = await getAccount();
        const result = await zestService.repay(
          account,
          resolvedAsset,
          BigInt(opts.amount),
          opts.onBehalfOf
        );

        printJson({
          success: true,
          txid: result.txid,
          action: "repay",
          asset: resolvedAsset,
          amount: opts.amount,
          onBehalfOf: opts.onBehalfOf || account.address,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// zest-claim-rewards
// ---------------------------------------------------------------------------

program
  .command("zest-claim-rewards")
  .description(
    "Claim accumulated rewards from the Zest Protocol incentives program. " +
      "sBTC suppliers earn wSTX rewards. Requires an unlocked wallet. Mainnet-only."
  )
  .option(
    "--asset <symbolOrContractId>",
    "Asset you supplied to earn rewards (default: sBTC)",
    "sBTC"
  )
  .action(async (opts: { asset: string }) => {
    try {
      const zestService = getZestProtocolService(NETWORK);
      const resolvedAsset = await zestService.resolveAsset(opts.asset);
      const account = await getAccount();
      const result = await zestService.claimRewards(account, resolvedAsset);

      printJson({
        success: true,
        txid: result.txid,
        action: "claim_rewards",
        asset: resolvedAsset,
        rewardAsset: "wSTX",
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        note: "Rewards will be sent to your wallet once the transaction confirms.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
