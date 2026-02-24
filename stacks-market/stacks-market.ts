#!/usr/bin/env bun
/**
 * Stacks Market skill CLI
 * Prediction market trading on stacksmarket.app — discover markets, quote LMSR prices,
 * buy/sell YES/NO shares, and redeem winnings via market-factory-v18-bias contract.
 *
 * Usage: bun run stacks-market/stacks-market.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import {
  getAccount,
  getWalletAddress,
} from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { callContract } from "../src/lib/transactions/builder.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import {
  uintCV,
  principalCV,
  PostConditionMode,
  ClarityValue,
  deserializeCV,
  cvToJSON,
} from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STACKS_MARKET_API = "https://api.stacksmarket.app";
const MARKET_CONTRACT_ADDRESS = "SP3N5CN0PE7YRRP29X7K9XG22BT861BRS5BN8HFFA";
const MARKET_CONTRACT_NAME = "market-factory-v18-bias";
const MARKET_CONTRACT_ID = `${MARKET_CONTRACT_ADDRESS}.${MARKET_CONTRACT_NAME}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch from the Stacks Market REST API and return parsed JSON.
 */
async function fetchMarketApi(
  path: string,
  params?: Record<string, string>
): Promise<unknown> {
  const url = new URL(`${STACKS_MARKET_API}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Stacks Market API error (${response.status}): ${await response.text()}`
    );
  }
  return response.json();
}

/**
 * Call a read-only function on the market contract.
 * Returns the parsed Clarity value as a JSON-friendly object.
 */
async function callReadOnly(
  functionName: string,
  args: ClarityValue[]
): Promise<unknown> {
  const hiro = getHiroApi(NETWORK);
  const senderAddress = MARKET_CONTRACT_ADDRESS;
  const result = await hiro.callReadOnlyFunction(
    MARKET_CONTRACT_ID,
    functionName,
    args,
    senderAddress
  );
  if (!result.okay) {
    throw new Error(
      `Read-only call failed: ${result.cause ?? "unknown error"}`
    );
  }
  if (!result.result) {
    return null;
  }
  // Deserialize hex-encoded Clarity value
  const hex = result.result.startsWith("0x")
    ? result.result.slice(2)
    : result.result;
  const cv = deserializeCV(Buffer.from(hex, "hex"));
  return cvToJSON(cv);
}

/**
 * Convert uSTX to human-readable STX string.
 */
function ustxToStx(ustx: number | bigint): string {
  const micro = BigInt(ustx);
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Parse a uint value from a Clarity JSON result.
 * Handles both {value: "123"} and raw number forms.
 */
function parseUintResult(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "object" && val !== null && "value" in val) {
    return Number((val as { value: string | number }).value);
  }
  return Number(val);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("stacks-market")
  .description(
    "Prediction market trading on stacksmarket.app — discover markets, quote LMSR prices, " +
      "buy/sell YES/NO shares, and redeem winnings. Mainnet-only."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-markets
// ---------------------------------------------------------------------------

program
  .command("list-markets")
  .description(
    "List prediction markets from stacksmarket.app. Returns markets sorted by most recent activity."
  )
  .option("--limit <n>", "Number of markets to return (default: 20)", "20")
  .option(
    "--status <status>",
    "Filter by status: active | ended | resolved"
  )
  .option("--category <category>", "Filter by category (e.g., Crypto, Politics)")
  .option("--featured", "Show only featured markets")
  .action(
    async (opts: {
      limit: string;
      status?: string;
      category?: string;
      featured?: boolean;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const params: Record<string, string> = {
          limit: opts.limit,
        };
        if (opts.status) params.status = opts.status;
        if (opts.category) params.category = opts.category;
        if (opts.featured) params.featured = "true";

        const data = (await fetchMarketApi("/api/polls", params)) as {
          polls?: unknown[];
        };
        const markets = data.polls ?? [];

        printJson({
          network: NETWORK,
          marketCount: markets.length,
          markets,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// search-markets
// ---------------------------------------------------------------------------

program
  .command("search-markets")
  .description(
    "Search prediction markets by keyword. Searches titles and descriptions."
  )
  .requiredOption("--query <keyword>", "Search keyword")
  .option("--limit <n>", "Maximum results (default: 10)", "10")
  .action(async (opts: { query: string; limit: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
        );
      }

      const data = (await fetchMarketApi("/api/polls", {
        search: opts.query,
        limit: opts.limit,
      })) as { polls?: unknown[] };
      const markets = data.polls ?? [];

      printJson({
        network: NETWORK,
        query: opts.query,
        resultCount: markets.length,
        markets,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-market
// ---------------------------------------------------------------------------

program
  .command("get-market")
  .description(
    "Get full details for a single prediction market including trade history and order book. " +
      "Use the MongoDB _id (not the numeric marketId)."
  )
  .requiredOption(
    "--market-id <mongoId>",
    "MongoDB _id of the market (e.g., 699c573ea7bb5ad25fee68a0)"
  )
  .action(async (opts: { marketId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
        );
      }

      const data = await fetchMarketApi(`/api/polls/${opts.marketId}`);

      printJson({
        network: NETWORK,
        market: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// quote-buy
// ---------------------------------------------------------------------------

program
  .command("quote-buy")
  .description(
    "Get a price quote for buying YES or NO shares via LMSR on-chain pricing. " +
      "Always quote before buying to verify cost and set max-cost for slippage protection."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp, e.g., 1771853629839)"
  )
  .requiredOption("--side <side>", "Side to buy: yes or no")
  .requiredOption("--amount <shares>", "Number of shares to buy (integer)")
  .action(
    async (opts: { marketId: string; side: string; amount: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const side = opts.side.toLowerCase();
        if (side !== "yes" && side !== "no") {
          throw new Error("--side must be 'yes' or 'no'");
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const marketId = BigInt(opts.marketId);
        const functionName =
          side === "yes" ? "quote-buy-yes" : "quote-buy-no";

        const result = (await callReadOnly(functionName, [
          uintCV(marketId),
          uintCV(BigInt(shares)),
        ])) as Record<string, unknown> | null;

        if (!result) {
          throw new Error(
            "Quote returned no data. Market may not exist or be invalid."
          );
        }

        // Extract values from the tuple result
        const totalCostUstx = parseUintResult(result.total ?? result.value);
        const protocolFeeUstx = parseUintResult(
          result.feeProtocol ?? result["fee-protocol"] ?? 0
        );
        const lpFeeUstx = parseUintResult(result.feeLP ?? result["fee-lp"] ?? 0);

        printJson({
          network: NETWORK,
          quote: {
            marketId: opts.marketId,
            side,
            shares,
            totalCostUstx,
            totalCostStx: ustxToStx(totalCostUstx),
            fees: {
              protocolUstx: protocolFeeUstx,
              lpUstx: lpFeeUstx,
            },
            rawResult: result,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// quote-sell
// ---------------------------------------------------------------------------

program
  .command("quote-sell")
  .description(
    "Get a price quote for selling YES or NO shares via LMSR on-chain pricing. " +
      "Always quote before selling to verify proceeds and set min-proceeds for slippage protection."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .requiredOption("--side <side>", "Side to sell: yes or no")
  .requiredOption("--amount <shares>", "Number of shares to sell (integer)")
  .action(
    async (opts: { marketId: string; side: string; amount: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const side = opts.side.toLowerCase();
        if (side !== "yes" && side !== "no") {
          throw new Error("--side must be 'yes' or 'no'");
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const marketId = BigInt(opts.marketId);
        const functionName =
          side === "yes" ? "quote-sell-yes" : "quote-sell-no";

        const result = (await callReadOnly(functionName, [
          uintCV(marketId),
          uintCV(BigInt(shares)),
        ])) as Record<string, unknown> | null;

        if (!result) {
          throw new Error(
            "Quote returned no data. Market may not exist or be invalid."
          );
        }

        const totalProceedsUstx = parseUintResult(result.total ?? result.value);
        const protocolFeeUstx = parseUintResult(
          result.feeProtocol ?? result["fee-protocol"] ?? 0
        );
        const lpFeeUstx = parseUintResult(result.feeLP ?? result["fee-lp"] ?? 0);

        printJson({
          network: NETWORK,
          quote: {
            marketId: opts.marketId,
            side,
            shares,
            totalProceedsUstx,
            totalProceedsStx: ustxToStx(totalProceedsUstx),
            fees: {
              protocolUstx: protocolFeeUstx,
              lpUstx: lpFeeUstx,
            },
            rawResult: result,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// buy-yes
// ---------------------------------------------------------------------------

program
  .command("buy-yes")
  .description(
    "Buy YES shares in a prediction market using buy-yes-auto with slippage protection. " +
      "Run quote-buy --side yes first to determine max-cost. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .requiredOption("--amount <shares>", "Number of YES shares to buy")
  .requiredOption(
    "--max-cost <ustx>",
    "Maximum total cost in uSTX (slippage protection). Use quote-buy to determine this value."
  )
  .action(
    async (opts: { marketId: string; amount: string; maxCost: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const maxCost = BigInt(opts.maxCost);
        const marketId = BigInt(opts.marketId);
        const account = await getAccount();

        const result = await callContract(account, {
          contractAddress: MARKET_CONTRACT_ADDRESS,
          contractName: MARKET_CONTRACT_NAME,
          functionName: "buy-yes-auto",
          functionArgs: [
            uintCV(marketId),
            uintCV(BigInt(shares)),
            uintCV(maxCost), // target-cap
            uintCV(maxCost), // max-cost
          ],
          postConditionMode: PostConditionMode.Allow,
        });

        printJson({
          success: true,
          txid: result.txid,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
          trade: {
            marketId: opts.marketId,
            side: "yes",
            shares,
            maxCostUstx: opts.maxCost,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// buy-no
// ---------------------------------------------------------------------------

program
  .command("buy-no")
  .description(
    "Buy NO shares in a prediction market using buy-no-auto with slippage protection. " +
      "Run quote-buy --side no first to determine max-cost. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .requiredOption("--amount <shares>", "Number of NO shares to buy")
  .requiredOption(
    "--max-cost <ustx>",
    "Maximum total cost in uSTX (slippage protection). Use quote-buy to determine this value."
  )
  .action(
    async (opts: { marketId: string; amount: string; maxCost: string }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const maxCost = BigInt(opts.maxCost);
        const marketId = BigInt(opts.marketId);
        const account = await getAccount();

        const result = await callContract(account, {
          contractAddress: MARKET_CONTRACT_ADDRESS,
          contractName: MARKET_CONTRACT_NAME,
          functionName: "buy-no-auto",
          functionArgs: [
            uintCV(marketId),
            uintCV(BigInt(shares)),
            uintCV(maxCost), // target-cap
            uintCV(maxCost), // max-cost
          ],
          postConditionMode: PostConditionMode.Allow,
        });

        printJson({
          success: true,
          txid: result.txid,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
          trade: {
            marketId: opts.marketId,
            side: "no",
            shares,
            maxCostUstx: opts.maxCost,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// sell-yes
// ---------------------------------------------------------------------------

program
  .command("sell-yes")
  .description(
    "Sell YES shares before market resolution using sell-yes-auto with minimum proceeds guard. " +
      "Run quote-sell --side yes first to determine min-proceeds. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .requiredOption("--amount <shares>", "Number of YES shares to sell")
  .requiredOption(
    "--min-proceeds <ustx>",
    "Minimum acceptable proceeds in uSTX (slippage protection). Use quote-sell to determine this value."
  )
  .action(
    async (opts: {
      marketId: string;
      amount: string;
      minProceeds: string;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const marketId = BigInt(opts.marketId);
        const minProceeds = BigInt(opts.minProceeds);
        const account = await getAccount();

        const result = await callContract(account, {
          contractAddress: MARKET_CONTRACT_ADDRESS,
          contractName: MARKET_CONTRACT_NAME,
          functionName: "sell-yes-auto",
          functionArgs: [
            uintCV(marketId),
            uintCV(BigInt(shares)),
            uintCV(minProceeds),
          ],
          postConditionMode: PostConditionMode.Allow,
        });

        printJson({
          success: true,
          txid: result.txid,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
          trade: {
            marketId: opts.marketId,
            side: "yes",
            shares,
            minProceedsUstx: opts.minProceeds,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// sell-no
// ---------------------------------------------------------------------------

program
  .command("sell-no")
  .description(
    "Sell NO shares before market resolution using sell-no-auto with minimum proceeds guard. " +
      "Run quote-sell --side no first to determine min-proceeds. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .requiredOption("--amount <shares>", "Number of NO shares to sell")
  .requiredOption(
    "--min-proceeds <ustx>",
    "Minimum acceptable proceeds in uSTX (slippage protection). Use quote-sell to determine this value."
  )
  .action(
    async (opts: {
      marketId: string;
      amount: string;
      minProceeds: string;
    }) => {
      try {
        if (NETWORK !== "mainnet") {
          throw new Error(
            "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
          );
        }

        const shares = parseInt(opts.amount, 10);
        if (isNaN(shares) || shares <= 0) {
          throw new Error("--amount must be a positive integer");
        }

        const marketId = BigInt(opts.marketId);
        const minProceeds = BigInt(opts.minProceeds);
        const account = await getAccount();

        const result = await callContract(account, {
          contractAddress: MARKET_CONTRACT_ADDRESS,
          contractName: MARKET_CONTRACT_NAME,
          functionName: "sell-no-auto",
          functionArgs: [
            uintCV(marketId),
            uintCV(BigInt(shares)),
            uintCV(minProceeds),
          ],
          postConditionMode: PostConditionMode.Allow,
        });

        printJson({
          success: true,
          txid: result.txid,
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
          trade: {
            marketId: opts.marketId,
            side: "no",
            shares,
            minProceedsUstx: opts.minProceeds,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// redeem
// ---------------------------------------------------------------------------

program
  .command("redeem")
  .description(
    "Redeem winning shares after market resolution. Winning shares pay 1 STX each. " +
      "Losing shares pay nothing. Requires an unlocked wallet. Mainnet-only."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .action(async (opts: { marketId: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
        );
      }

      const marketId = BigInt(opts.marketId);
      const account = await getAccount();

      const result = await callContract(account, {
        contractAddress: MARKET_CONTRACT_ADDRESS,
        contractName: MARKET_CONTRACT_NAME,
        functionName: "redeem",
        functionArgs: [uintCV(marketId)],
        postConditionMode: PostConditionMode.Allow,
      });

      printJson({
        success: true,
        txid: result.txid,
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        marketId: opts.marketId,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-position
// ---------------------------------------------------------------------------

program
  .command("get-position")
  .description(
    "Get YES and NO share balances for an address in a market. " +
      "Uses the active wallet address if --address is not specified."
  )
  .requiredOption(
    "--market-id <id>",
    "Market ID (epoch millisecond timestamp)"
  )
  .option(
    "--address <stacksAddress>",
    "Stacks address to check (uses active wallet if omitted)"
  )
  .action(async (opts: { marketId: string; address?: string }) => {
    try {
      if (NETWORK !== "mainnet") {
        throw new Error(
          "stacks-market skill is mainnet-only. Set NETWORK=mainnet to use this skill."
        );
      }

      const address = opts.address || (await getWalletAddress());
      const marketId = BigInt(opts.marketId);

      const [yesResult, noResult] = await Promise.all([
        callReadOnly("get-yes-balance", [
          uintCV(marketId),
          principalCV(address),
        ]),
        callReadOnly("get-no-balance", [
          uintCV(marketId),
          principalCV(address),
        ]),
      ]);

      const yesShares = parseUintResult(yesResult);
      const noShares = parseUintResult(noResult);

      printJson({
        network: NETWORK,
        address,
        marketId: opts.marketId,
        position: {
          yesShares,
          noShares,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
