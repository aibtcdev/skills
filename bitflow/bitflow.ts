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
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import {
  getBitflowService,
  type BitflowToken,
  type HodlmmActiveBinToleranceInput,
  type HodlmmRelativeLiquidityBinInput,
  type HodlmmRelativeWithdrawalInput,
  type UnifiedBitflowRouteQuote,
} from "../src/lib/services/bitflow.service.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const HIGH_IMPACT_THRESHOLD = 0.05; // 5%

function parseJsonOption<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function normalizeRelativeLiquidityBins(rawBins: unknown): HodlmmRelativeLiquidityBinInput[] {
  if (!Array.isArray(rawBins) || rawBins.length === 0) {
    throw new Error("--bins must be a non-empty JSON array");
  }

  return rawBins.map((bin, index) => {
    if (!bin || typeof bin !== "object") {
      throw new Error(`bins[${index}] must be an object`);
    }

    const value = bin as Record<string, unknown>;
    const activeBinOffset = value.activeBinOffset ?? value.active_bin_offset;
    const xAmount = value.xAmount ?? value.x_amount ?? 0;
    const yAmount = value.yAmount ?? value.y_amount ?? 0;

    if (typeof activeBinOffset !== "number") {
      throw new Error(`bins[${index}].activeBinOffset must be a number`);
    }

    return {
      activeBinOffset,
      xAmount: String(xAmount),
      yAmount: String(yAmount),
    };
  });
}

function normalizeRelativeWithdrawalPositions(rawPositions: unknown): HodlmmRelativeWithdrawalInput[] {
  if (!Array.isArray(rawPositions) || rawPositions.length === 0) {
    throw new Error("--positions must be a non-empty JSON array");
  }

  return rawPositions.map((position, index) => {
    if (!position || typeof position !== "object") {
      throw new Error(`positions[${index}] must be an object`);
    }

    const value = position as Record<string, unknown>;
    const activeBinOffset = value.activeBinOffset ?? value.active_bin_offset;
    const amount = value.amount;
    const minXAmount = value.minXAmount ?? value.min_x_amount ?? 0;
    const minYAmount = value.minYAmount ?? value.min_y_amount ?? 0;

    if (typeof activeBinOffset !== "number") {
      throw new Error(`positions[${index}].activeBinOffset must be a number`);
    }

    if (amount === undefined || amount === null) {
      throw new Error(`positions[${index}].amount is required`);
    }

    return {
      activeBinOffset,
      amount: String(amount),
      minXAmount: String(minXAmount),
      minYAmount: String(minYAmount),
    };
  });
}

function normalizeActiveBinTolerance(raw: unknown): HodlmmActiveBinToleranceInput {
  if (!raw || typeof raw !== "object") {
    throw new Error("--active-bin-tolerance must be a JSON object");
  }

  const value = raw as Record<string, unknown>;
  const expectedBinId = value.expectedBinId ?? value.expected_bin_id;
  const maxDeviation = value.maxDeviation ?? value.max_deviation;

  if (typeof expectedBinId !== "number") {
    throw new Error("activeBinTolerance.expectedBinId must be a number");
  }

  if (maxDeviation === undefined || maxDeviation === null) {
    throw new Error("activeBinTolerance.maxDeviation is required");
  }

  return {
    expectedBinId,
    maxDeviation: String(maxDeviation),
  };
}

function summarizeUnifiedRoute(route: UnifiedBitflowRouteQuote) {
  return {
    source: route.source,
    label: route.label,
    executable: route.executable,
    tokenPath: route.tokenPath,
    dexPath: route.dexPath,
    poolIds: route.poolIds,
    poolContracts: route.poolContracts,
    expectedAmountOut: route.amountOutHuman,
    amountOutAtomic: route.amountOutAtomic,
    priceImpact: route.priceImpact,
  };
}

function summarizeQuoteOutput(quote: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  route: string[];
}) {
  return {
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn,
    expectedAmountOut: quote.expectedAmountOut,
    route: quote.route,
  };
}

async function getWriteAccount(walletPassword?: string) {
  if (walletPassword) {
    const walletManager = getWalletManager();
    const walletId = await walletManager.getActiveWalletId();
    if (!walletId) {
      throw new Error("No active wallet configured. Create or switch to a wallet first.");
    }
    return walletManager.unlock(walletId, walletPassword);
  }

  return getAccount();
}

function formatScaledInteger(value: string | number, scale: number): string {
  const negative = String(value).startsWith("-");
  const digits = String(value).replace("-", "").replace(/^0+/, "") || "0";
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, padded.length - scale);
  const fraction = padded.slice(padded.length - scale).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

function invertDecimalString(value: string, decimals: number = 8): string | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return null;
  return (1 / num).toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function createTokenSymbolLookup(tokens: BitflowToken[]) {
  const lookup = new Map<string, string>();
  for (const token of tokens) {
    lookup.set(token.id, token.symbol);
    lookup.set(token.contractId, token.symbol);
  }
  lookup.set("Stacks", "STX");
  return lookup;
}

function resolveTokenLabel(tokenId: string, lookup: Map<string, string>): string {
  return lookup.get(tokenId) || tokenId;
}

function matchesTickerSelector(
  selector: string | undefined,
  rawValue: string,
  symbol: string
): boolean {
  if (!selector) return true;
  const normalizedSelector = selector.toLowerCase();
  const selectorAliases = new Set([normalizedSelector]);
  if (normalizedSelector.startsWith("token-")) {
    selectorAliases.add(normalizedSelector.replace(/^token-/, ""));
  }
  if (normalizedSelector === "token-stx") {
    selectorAliases.add("stacks");
    selectorAliases.add("stx");
  }

  return (
    Array.from(selectorAliases).some(
      (candidate) =>
        rawValue.toLowerCase() === candidate ||
        symbol.toLowerCase() === candidate ||
        rawValue.toLowerCase().includes(candidate)
    )
  );
}

function summarizeTickerEntry(
  ticker: Record<string, string>,
  symbolLookup: Map<string, string>
) {
  const baseSymbol = resolveTokenLabel(ticker.base_currency, symbolLookup);
  const targetSymbol = resolveTokenLabel(ticker.target_currency, symbolLookup);
  return {
    pair: `${baseSymbol}/${targetSymbol}`,
    baseSymbol,
    targetSymbol,
    lastPrice: ticker.last_price,
    bid: ticker.bid,
    ask: ticker.ask,
    high: ticker.high,
    low: ticker.low,
    baseVolume: ticker.base_volume,
    targetVolume: ticker.target_volume,
    liquidityUsd: ticker.liquidity_in_usd,
  };
}

function summarizeHodlmmPool(pool: {
  pool_id: string;
  token_x: string;
  token_y: string;
  token_x_symbol?: string | null;
  token_y_symbol?: string | null;
  pool_name?: string | null;
  bin_step: number;
  active_bin: number;
  pool_token?: string | null;
  suggested?: boolean | null;
  sbtc_incentives?: boolean | null;
}) {
  const tokenXSymbol = pool.token_x_symbol || pool.token_x;
  const tokenYSymbol = pool.token_y_symbol || pool.token_y;
  return {
    poolId: pool.pool_id,
    pair: `${tokenXSymbol}/${tokenYSymbol}`,
    tokenXSymbol,
    tokenYSymbol,
    binStepBps: pool.bin_step,
    activeBinId: pool.active_bin,
    poolContract: pool.pool_token,
    suggested: pool.suggested,
    sbtcIncentives: pool.sbtc_incentives,
  };
}

function summarizeHodlmmBin(
  bin: {
    bin_id: number;
    reserve_x: string;
    reserve_y: string;
    price?: string | null;
    liquidity?: string | null;
  },
  pool: {
    token_x_symbol?: string | null;
    token_y_symbol?: string | null;
    token_x_decimals?: number | null;
    token_y_decimals?: number | null;
  }
) {
  const tokenXSymbol = pool.token_x_symbol || "tokenX";
  const tokenYSymbol = pool.token_y_symbol || "tokenY";
  const tokenXDecimals = pool.token_x_decimals ?? 6;
  const tokenYDecimals = pool.token_y_decimals ?? 6;
  const rawPrice = bin.price || "0";
  const quotePerBase = formatScaledInteger(rawPrice, tokenYDecimals + 2);
  const basePerQuote = invertDecimalString(quotePerBase);

  return {
    binId: bin.bin_id,
    reserveX: formatScaledInteger(bin.reserve_x, tokenXDecimals),
    reserveY: formatScaledInteger(bin.reserve_y, tokenYDecimals),
    reserveXSymbol: tokenXSymbol,
    reserveYSymbol: tokenYSymbol,
    rawPrice,
    approxPrice: {
      quotePerBase,
      quotePerBasePair: `${tokenYSymbol} per ${tokenXSymbol}`,
      basePerQuote,
      basePerQuotePair: `${tokenXSymbol} per ${tokenYSymbol}`,
      note: `bin.price is raw atomic price. Approx ${tokenYSymbol}/${tokenXSymbol} = rawPrice / 10^(${tokenYDecimals} + 2)`,
    },
    rawLiquidity: bin.liquidity || "0",
  };
}

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
        const symbolLookup = createTokenSymbolLookup(await bitflowService.getAvailableTokens());

        const tickers = await bitflowService.getTicker();

        if (opts.baseCurrency || opts.targetCurrency) {
          const filtered = tickers
            .filter((ticker) => {
              const baseSymbol = resolveTokenLabel(String(ticker.base_currency), symbolLookup);
              const targetSymbol = resolveTokenLabel(String(ticker.target_currency), symbolLookup);
              return (
                matchesTickerSelector(opts.baseCurrency, String(ticker.base_currency), baseSymbol) &&
                matchesTickerSelector(opts.targetCurrency, String(ticker.target_currency), targetSymbol)
              );
            })
            .map((ticker) => summarizeTickerEntry(ticker as Record<string, string>, symbolLookup));

          if (filtered.length === 0) {
            printJson({
              error: "Trading pair not found",
              baseCurrency: opts.baseCurrency,
              targetCurrency: opts.targetCurrency,
            });
            return;
          }

          printJson({
            network: NETWORK,
            pairCount: filtered.length,
            tickers: filtered,
          });
          return;
        }

        const summarizedTickers = tickers.map((ticker) =>
          summarizeTickerEntry(ticker as Record<string, string>, symbolLookup)
        );

        printJson({
          network: NETWORK,
          pairCount: tickers.length,
          tickers: summarizedTickers.slice(0, 50),
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
// get-hodlmm-pools
// ---------------------------------------------------------------------------

program
  .command("get-hodlmm-pools")
  .description(
    "Get HODLMM pools from the Bitflow BFF API. Returns DLMM pool metadata for picking pool IDs before bin operations. Mainnet-only."
  )
  .option("--suggested", "Filter to suggested HODLMM pools")
  .option("--sbtc-incentives", "Filter to pools with sBTC incentives")
  .option("--limit <number>", "Maximum pools to return", "20")
  .action(
    async (opts: { suggested?: boolean; sbtcIncentives?: boolean; limit: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const pools = await bitflowService.getHodlmmPools({
          suggested: opts.suggested,
          sbtcIncentives: opts.sbtcIncentives,
          limit: Number(opts.limit),
        });

        printJson({
          network: NETWORK,
          poolCount: pools.length,
          pools: pools.map(summarizeHodlmmPool),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-hodlmm-bins
// ---------------------------------------------------------------------------

program
  .command("get-hodlmm-bins")
  .description(
    "Get all HODLMM bins for a pool from the Bitflow BFF API. Useful for selecting relative bin offsets before adding liquidity. Mainnet-only."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .option("--allow-fallback", "Enable on-chain fallback if indexed data is stale")
  .action(async (opts: { poolId: string; allowFallback?: boolean }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const [bins, pool] = await Promise.all([
        bitflowService.getHodlmmPoolBins(opts.poolId, opts.allowFallback),
        bitflowService.getHodlmmPool(opts.poolId, opts.allowFallback),
      ]);

      printJson({
        network: NETWORK,
        pool: summarizeHodlmmPool(pool),
        units: {
          reserveX: `${pool.token_x_symbol || "tokenX"} in atomic base units on-chain, shown here in human units`,
          reserveY: `${pool.token_y_symbol || "tokenY"} in atomic base units on-chain, shown here in human units`,
          rawPrice: `Raw HODLMM bin price from API`,
          approxPrice: `${pool.token_y_symbol || "tokenY"} per ${pool.token_x_symbol || "tokenX"} derived from rawPrice / 10^(${pool.token_y_decimals ?? 6} + 2)`,
        },
        activeBinId: bins.active_bin_id,
        activeBin: bins.bins
          .filter((bin) => bin.bin_id === bins.active_bin_id)
          .map((bin) => summarizeHodlmmBin(bin, pool))[0],
        nearbyBins: bins.bins
          .filter((bin) =>
            bins.active_bin_id === undefined || bins.active_bin_id === null
              ? bin.bin_id < 7
              : Math.abs(bin.bin_id - bins.active_bin_id) <= 3
          )
          .map((bin) => summarizeHodlmmBin(bin, pool)),
        totalBinCount: bins.total_bins,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-hodlmm-position-bins
// ---------------------------------------------------------------------------

program
  .command("get-hodlmm-position-bins")
  .description(
    "Get your HODLMM position bins for a pool from the Bitflow BFF API. Mainnet-only."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .option("--address <stacksAddress>", "Stacks address (uses active wallet if not specified)")
  .option("--fresh", "Bypass cache and fetch fresh position data")
  .option("--allow-fallback", "Enable on-chain fallback if indexed data is stale")
  .action(
    async (opts: {
      poolId: string;
      address?: string;
      fresh?: boolean;
      allowFallback?: boolean;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const address = opts.address || (await getWalletAddress());
        const [positions, pool] = await Promise.all([
          bitflowService.getHodlmmUserPositionBins(address, opts.poolId, {
            fresh: opts.fresh,
            allowFallback: opts.allowFallback,
          }),
          bitflowService.getHodlmmPool(opts.poolId, opts.allowFallback),
        ]);

        printJson({
          network: NETWORK,
          address,
          poolId: opts.poolId,
          pool: summarizeHodlmmPool(pool),
          positions: positions.bins.map((bin) => {
            const summary = summarizeHodlmmBin(
              {
                bin_id: bin.bin_id,
                reserve_x: String(bin.reserve_x ?? "0"),
                reserve_y: String(bin.reserve_y ?? "0"),
                price: String(bin.price ?? "0"),
                liquidity: String(bin.liquidity ?? "0"),
              },
              pool
            );

            return {
              binId: bin.bin_id,
              userLiquidity: String(bin.user_liquidity ?? "0"),
              price: summary.approxPrice,
              reserveX: summary.reserveX,
              reserveY: summary.reserveY,
              raw: bin,
            };
          }),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

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
    "Output token ID (e.g. 'token-sbtc', 'token-USDCx-auto'; use 'token-aeusdc' only for explicit aeUSDC requests)"
  )
  .requiredOption(
    "--amount-in <decimal>",
    "Amount in human-readable decimal (e.g. 0.00015 for 15k sats sBTC, 21.0 for 21 STX)"
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
          quote: summarizeQuoteOutput(quote),
          selectedRoute: quote.selectedRoute ? summarizeUnifiedRoute(quote.selectedRoute) : undefined,
          bestExecutableRoute: quote.bestExecutableRoute
            ? summarizeUnifiedRoute(quote.bestExecutableRoute)
            : undefined,
          rankedRoutes: quote.rankedRoutes?.map(summarizeUnifiedRoute),
          priceImpact,
          executionWarning: quote.executionWarning,
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
    "Output token ID (e.g. 'token-sbtc', 'token-USDCx-auto'; use 'token-aeusdc' only for explicit aeUSDC requests)"
  )
  .option(
    "--amount-in <decimal>",
    "Optional amount in human-readable decimal to rank routes by expected output"
  )
  .action(async (opts: { tokenX: string; tokenY: string; amountIn?: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
        return;
      }

      const bitflowService = getBitflowService(NETWORK);
      const routes = await bitflowService.getAllRoutes(opts.tokenX, opts.tokenY, opts.amountIn ? Number(opts.amountIn) : undefined);
      const unifiedRoutes = routes as UnifiedBitflowRouteQuote[];

      printJson({
        network: NETWORK,
        tokenX: opts.tokenX,
        tokenY: opts.tokenY,
        amountIn: opts.amountIn,
        routeCount: unifiedRoutes.length,
        routes: unifiedRoutes.map((r) => {
          const summary = summarizeUnifiedRoute(r);
          if (opts.amountIn) return summary;
          const { expectedAmountOut, amountOutAtomic, priceImpact, ...rest } = summary;
          return rest;
        }),
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
    "--amount-in <decimal>",
    "Amount in human-readable decimal (e.g. 0.00015 for 15k sats sBTC, 21.0 for 21 STX)"
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
    "--wallet-password <password>",
    "Optional wallet password to unlock the active managed wallet for this command"
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
      walletPassword?: string;
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

        const account = await getWriteAccount(opts.walletPassword);
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
            quotedBestRoute: quote.selectedRoute ? summarizeUnifiedRoute(quote.selectedRoute) : undefined,
            executedRoute: quote.bestExecutableRoute
              ? summarizeUnifiedRoute(quote.bestExecutableRoute)
              : undefined,
          },
          executionWarning: quote.executionWarning,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// add-liquidity-simple
// ---------------------------------------------------------------------------

program
  .command("add-liquidity-simple")
  .description(
    "Add liquidity to HODLMM bins using relative offsets from the active bin. Uses Bitflow's simple mode so the transaction is more tolerant of active-bin movement. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_1)")
  .requiredOption(
    "--bins <json>",
    "JSON array of bins to add, e.g. '[{\"activeBinOffset\":0,\"xAmount\":\"0\",\"yAmount\":\"100000\"},{\"activeBinOffset\":1,\"xAmount\":\"100000\",\"yAmount\":\"0\"}]'"
  )
  .option(
    "--active-bin-tolerance <json>",
    "Optional JSON object like '{\"expectedBinId\":500,\"maxDeviation\":\"2\"}'"
  )
  .option(
    "--slippage-tolerance <percent>",
    "Slippage tolerance percentage used for min DLP and liquidity fee bounds (default 1)",
    "1"
  )
  .option(
    "--pool-contract <contractId>",
    "Override pool core contract identifier if the API response is missing it"
  )
  .option(
    "--x-token-contract <contractId>",
    "Override token X contract identifier if needed"
  )
  .option(
    "--y-token-contract <contractId>",
    "Override token Y contract identifier if needed"
  )
  .option("--allow-fallback", "Enable on-chain fallback when reading pool/bin metadata")
  .option(
    "--fee <value>",
    "Optional STX fee: 'low' | 'medium' | 'high' preset or micro-STX amount"
  )
  .option(
    "--wallet-password <password>",
    "Optional wallet password to unlock the active managed wallet for this command"
  )
  .action(
    async (opts: {
      poolId: string;
      bins: string;
      activeBinTolerance?: string;
      slippageTolerance: string;
      poolContract?: string;
      xTokenContract?: string;
      yTokenContract?: string;
      allowFallback?: boolean;
      fee?: string;
      walletPassword?: string;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const account = await getWriteAccount(opts.walletPassword);
        const bins = normalizeRelativeLiquidityBins(
          parseJsonOption<unknown>(opts.bins, "--bins")
        );
        const activeBinTolerance = opts.activeBinTolerance
          ? normalizeActiveBinTolerance(
              parseJsonOption<unknown>(opts.activeBinTolerance, "--active-bin-tolerance")
            )
          : undefined;
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await bitflowService.addHodlmmLiquiditySimple({
          account,
          poolId: opts.poolId,
          bins,
          activeBinTolerance,
          slippageTolerance: Number(opts.slippageTolerance),
          allowFallback: opts.allowFallback,
          fee: resolvedFee,
          poolContract: opts.poolContract,
          xTokenContract: opts.xTokenContract,
          yTokenContract: opts.yTokenContract,
        });

        printJson({
          success: true,
          network: NETWORK,
          txid: result.txid,
          poolId: result.poolId,
          preparedBins: result.preparedBins,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// withdraw-liquidity-simple
// ---------------------------------------------------------------------------

program
  .command("withdraw-liquidity-simple")
  .description(
    "Withdraw HODLMM liquidity using relative offsets from the current active bin. Use get-hodlmm-position-bins and get-hodlmm-bins first to calculate the current offset for your position. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption("--pool-id <poolId>", "HODLMM pool ID (e.g. dlmm_6)")
  .requiredOption(
    "--positions <json>",
    "JSON array of positions to withdraw, e.g. '[{\"activeBinOffset\":5,\"amount\":\"392854\",\"minXAmount\":\"1999000\",\"minYAmount\":\"0\"}]'"
  )
  .option(
    "--pool-contract <contractId>",
    "Override pool contract identifier if needed"
  )
  .option(
    "--x-token-contract <contractId>",
    "Override token X contract identifier if needed"
  )
  .option(
    "--y-token-contract <contractId>",
    "Override token Y contract identifier if needed"
  )
  .option("--allow-fallback", "Enable on-chain fallback when reading pool/bin metadata")
  .option(
    "--fee <value>",
    "Optional STX fee: 'low' | 'medium' | 'high' preset or micro-STX amount"
  )
  .option(
    "--wallet-password <password>",
    "Optional wallet password to unlock the active managed wallet for this command"
  )
  .action(
    async (opts: {
      poolId: string;
      positions: string;
      poolContract?: string;
      xTokenContract?: string;
      yTokenContract?: string;
      allowFallback?: boolean;
      fee?: string;
      walletPassword?: string;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          printJson({ error: "Bitflow is only available on mainnet", network: NETWORK });
          return;
        }

        const bitflowService = getBitflowService(NETWORK);
        const account = await getWriteAccount(opts.walletPassword);
        const positions = normalizeRelativeWithdrawalPositions(
          parseJsonOption<unknown>(opts.positions, "--positions")
        );
        const resolvedFee = await resolveFee(opts.fee, NETWORK, "contract_call");
        const result = await bitflowService.withdrawHodlmmLiquiditySimple({
          account,
          poolId: opts.poolId,
          positions,
          allowFallback: opts.allowFallback,
          fee: resolvedFee,
          poolContract: opts.poolContract,
          xTokenContract: opts.xTokenContract,
          yTokenContract: opts.yTokenContract,
        });

        printJson({
          success: true,
          network: NETWORK,
          txid: result.txid,
          poolId: result.poolId,
          preparedPositions: result.preparedPositions,
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
  .option(
    "--wallet-password <password>",
    "Optional wallet password to unlock the active managed wallet for this command"
  )
  .action(
    async (opts: {
      contractIdentifier: string;
      actionType: string;
      fundingTokens: string;
      actionAmount: string;
      minReceivedAmount?: string;
      autoAdjust?: boolean;
      walletPassword?: string;
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
        const address = (await getWriteAccount(opts.walletPassword)).address;
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
