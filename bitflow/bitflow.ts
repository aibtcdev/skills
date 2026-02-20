#!/usr/bin/env bun
/**
 * Bitflow DEX skill CLI
 * Token swaps, market data, routing, and Keeper automation on Bitflow (mainnet-only)
 *
 * Usage: bun run bitflow/bitflow.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getBitflowService } from "../src/lib/services/bitflow.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const HIGH_IMPACT_THRESHOLD = 0.05; // 5%

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("bitflow")
  .description(
    "Bitflow DEX: token swaps, market data, routing, and Keeper automation on Stacks. Mainnet-only. " +
      "No API key required — uses public endpoints (500 req/min)."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// get-ticker
// ---------------------------------------------------------------------------

program
  .command("get-ticker")
  .description(
    "Get market ticker data from Bitflow DEX. Returns price, volume, and liquidity data for all trading pairs. " +
      "No API key required. Mainnet-only."
  )
  .option(
    "--base-currency <contractId>",
    "Optional: filter by base currency contract ID"
  )
  .option(
    "--target-currency <contractId>",
    "Optional: filter by target currency contract ID"
  )
  .action(
    async (opts: { baseCurrency?: string; targetCurrency?: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);

        if (opts.baseCurrency && opts.targetCurrency) {
          const ticker = await bitflowService.getTickerByPair(
            opts.baseCurrency,
            opts.targetCurrency
          );
          if (!ticker) {
            printJson({
              error: "Trading pair not found",
              baseCurrency: opts.baseCurrency,
              targetCurrency: opts.targetCurrency,
            });
            return;
          }
          printJson({ network: NETWORK, ticker });
          return;
        }

        const tickers = await bitflowService.getTicker();
        printJson({
          network: NETWORK,
          pairCount: tickers.length,
          tickers: tickers.slice(0, 50),
          note:
            tickers.length > 50
              ? `Showing 50 of ${tickers.length} pairs`
              : undefined,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-tokens
// ---------------------------------------------------------------------------

program
  .command("get-tokens")
  .description(
    "Get all available tokens for swapping on Bitflow. " +
      "No API key required — uses public endpoints (500 req/min). Mainnet-only."
  )
  .action(async () => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const tokens = await bitflowService.getAvailableTokens();

      printJson({
        network: NETWORK,
        tokenCount: tokens.length,
        tokens,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-swap-targets
// ---------------------------------------------------------------------------

program
  .command("get-swap-targets")
  .description(
    "Get possible swap target tokens for a given input token on Bitflow. " +
      "Returns all tokens that can be received when swapping from the specified token. Mainnet-only."
  )
  .requiredOption(
    "--token-id <contractId>",
    "The input token ID (contract address)"
  )
  .action(async (opts: { tokenId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const targets = await bitflowService.getPossibleSwapTargets(opts.tokenId);

      printJson({
        network: NETWORK,
        inputToken: opts.tokenId,
        targetCount: targets.length,
        targets,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-quote
// ---------------------------------------------------------------------------

program
  .command("get-quote")
  .description(
    "Get a swap quote from Bitflow DEX. Returns expected output amount, best route, and price impact. Mainnet-only."
  )
  .requiredOption(
    "--token-x <tokenId>",
    "Input token ID (e.g. 'token-stx', 'token-sbtc')"
  )
  .requiredOption(
    "--token-y <tokenId>",
    "Output token ID (e.g. 'token-sbtc', 'token-aeusdc')"
  )
  .requiredOption(
    "--amount-in <units>",
    "Amount of input token (in smallest units)"
  )
  .action(
    async (opts: { tokenX: string; tokenY: string; amountIn: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const quote = await bitflowService.getSwapQuote(
          opts.tokenX,
          opts.tokenY,
          Number(opts.amountIn)
        );

        const priceImpact = quote.priceImpact;
        const highImpactWarning =
          priceImpact && priceImpact.combinedImpact > HIGH_IMPACT_THRESHOLD
            ? `High price impact detected (${priceImpact.combinedImpactPct}). Consider reducing trade size.`
            : undefined;

        printJson({
          network: NETWORK,
          quote,
          priceImpact,
          highImpactWarning,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-routes
// ---------------------------------------------------------------------------

program
  .command("get-routes")
  .description(
    "Get all possible swap routes between two tokens on Bitflow. " +
      "Includes multi-hop routes through intermediate tokens. Mainnet-only."
  )
  .requiredOption(
    "--token-x <tokenId>",
    "Input token ID (e.g. 'token-stx', 'token-sbtc')"
  )
  .requiredOption(
    "--token-y <tokenId>",
    "Output token ID (e.g. 'token-sbtc', 'token-aeusdc')"
  )
  .action(async (opts: { tokenX: string; tokenY: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const routes = await bitflowService.getAllRoutes(
        opts.tokenX,
        opts.tokenY
      );

      printJson({
        network: NETWORK,
        tokenX: opts.tokenX,
        tokenY: opts.tokenY,
        routeCount: routes.length,
        routes: routes.map((r) => ({
          tokenPath: r.token_path,
          dexPath: r.dex_path,
        })),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// swap
// ---------------------------------------------------------------------------

program
  .command("swap")
  .description(
    "Execute a token swap on Bitflow DEX. Automatically finds the best route across all Bitflow pools. " +
      "Requires an unlocked wallet with sufficient token balance. Mainnet-only."
  )
  .requiredOption(
    "--token-x <tokenId>",
    "Input token ID (contract address)"
  )
  .requiredOption(
    "--token-y <tokenId>",
    "Output token ID (contract address)"
  )
  .requiredOption(
    "--amount-in <units>",
    "Amount of input token (in smallest units)"
  )
  .option(
    "--slippage-tolerance <decimal>",
    "Slippage tolerance as decimal (default 0.01 = 1%)",
    "0.01"
  )
  .option(
    "--fee <value>",
    "Optional fee: 'low' | 'medium' | 'high' preset or micro-STX amount. If omitted, auto-estimated."
  )
  .option(
    "--confirm-high-impact",
    "Set to execute swaps with price impact above 5%"
  )
  .action(
    async (opts: {
      tokenX: string;
      tokenY: string;
      amountIn: string;
      slippageTolerance: string;
      fee?: string;
      confirmHighImpact?: boolean;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const slippage = parseFloat(opts.slippageTolerance);

        // Safety check: require explicit confirmation for high-impact swaps
        const quote = await bitflowService.getSwapQuote(
          opts.tokenX,
          opts.tokenY,
          Number(opts.amountIn)
        );
        const impact = quote.priceImpact;
        if (
          impact &&
          impact.combinedImpact > HIGH_IMPACT_THRESHOLD &&
          !opts.confirmHighImpact
        ) {
          printJson({
            error: "High price impact swap requires explicit confirmation",
            message: `This swap has ${impact.combinedImpactPct} price impact (${impact.severity}). Use --confirm-high-impact to proceed.`,
            quote,
            threshold: `${(HIGH_IMPACT_THRESHOLD * 100).toFixed(0)}%`,
            requiredFlag: "--confirm-high-impact",
          });
          return;
        }

        const account = await getAccount();
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await bitflowService.swap(
          account,
          opts.tokenX,
          opts.tokenY,
          Number(opts.amountIn),
          slippage,
          resolvedFee
        );

        printJson({
          success: true,
          txid: result.txid,
          swap: {
            tokenIn: opts.tokenX,
            tokenOut: opts.tokenY,
            amountIn: opts.amountIn,
            slippageTolerance: slippage,
            priceImpact: impact,
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
// get-keeper-contract
// ---------------------------------------------------------------------------

program
  .command("get-keeper-contract")
  .description(
    "Get or create a Bitflow Keeper contract for automated swaps. " +
      "Keeper contracts enable scheduled/automated token swaps. Mainnet-only."
  )
  .option(
    "--address <stacksAddress>",
    "Stacks address (uses wallet if not specified)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const address = opts.address || (await getWalletAddress());
      const result = await bitflowService.getOrCreateKeeperContract(address);

      printJson({
        network: NETWORK,
        address,
        contractIdentifier: result.contractIdentifier,
        status: result.status,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// create-order
// ---------------------------------------------------------------------------

program
  .command("create-order")
  .description(
    "Create an automated swap order via Bitflow Keeper. Creates a pending order executed by the Keeper service. Mainnet-only."
  )
  .requiredOption(
    "--contract-identifier <id>",
    "Keeper contract identifier"
  )
  .requiredOption(
    "--action-type <type>",
    "Action type (e.g., 'SWAP_XYK_SWAP_HELPER')"
  )
  .requiredOption(
    "--funding-tokens <json>",
    "JSON map of token IDs to amounts for funding (e.g., '{\"token-stx\":\"1000000\"}')"
  )
  .requiredOption(
    "--action-amount <units>",
    "Amount for the action"
  )
  .option(
    "--min-received-amount <units>",
    "Minimum amount to receive (slippage protection)"
  )
  .option(
    "--auto-adjust",
    "Auto-adjust minimum received based on market (default true)"
  )
  .action(
    async (opts: {
      contractIdentifier: string;
      actionType: string;
      fundingTokens: string;
      actionAmount: string;
      minReceivedAmount?: string;
      autoAdjust?: boolean;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        let fundingTokens: Record<string, string>;
        try {
          fundingTokens = JSON.parse(opts.fundingTokens);
        } catch {
          throw new Error("--funding-tokens must be a valid JSON object");
        }

        const bitflowService = getBitflowService(NETWORK);
        const address = await getWalletAddress();
        const result = await bitflowService.createKeeperOrder({
          contractIdentifier: opts.contractIdentifier,
          stacksAddress: address,
          actionType: opts.actionType,
          fundingTokens,
          actionAmount: opts.actionAmount,
          minReceived: opts.minReceivedAmount
            ? {
                amount: opts.minReceivedAmount,
                autoAdjust: opts.autoAdjust ?? true,
              }
            : undefined,
        });

        printJson({
          success: true,
          network: NETWORK,
          orderId: result.orderId,
          status: result.status,
          order: {
            contractIdentifier: opts.contractIdentifier,
            actionType: opts.actionType,
            fundingTokens,
            actionAmount: opts.actionAmount,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-order
// ---------------------------------------------------------------------------

program
  .command("get-order")
  .description(
    "Get details of a Bitflow Keeper order. Retrieves the status and details of a specific order. Mainnet-only."
  )
  .requiredOption("--order-id <id>", "The order ID to retrieve")
  .action(async (opts: { orderId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const order = await bitflowService.getKeeperOrder(opts.orderId);

      printJson({ network: NETWORK, order });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// cancel-order
// ---------------------------------------------------------------------------

program
  .command("cancel-order")
  .description(
    "Cancel a Bitflow Keeper order. Cancels a pending order before execution. Mainnet-only."
  )
  .requiredOption("--order-id <id>", "The order ID to cancel")
  .action(async (opts: { orderId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const result = await bitflowService.cancelKeeperOrder(opts.orderId);

      printJson({
        network: NETWORK,
        orderId: opts.orderId,
        cancelled: result.success,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-keeper-user
// ---------------------------------------------------------------------------

program
  .command("get-keeper-user")
  .description(
    "Get Bitflow Keeper user info and orders. Retrieves user's keeper contracts and order history. Mainnet-only."
  )
  .option(
    "--address <stacksAddress>",
    "Stacks address (uses wallet if not specified)"
  )
  .action(async (opts: { address?: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const address = opts.address || (await getWalletAddress());
      const userInfo = await bitflowService.getKeeperUser(address);

      printJson({ network: NETWORK, userInfo });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
