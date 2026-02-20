import axios from "axios";
import {
  BitflowSDK,
  type Token,
  type QuoteResult,
  type SwapExecutionData,
  type SelectedSwapRoute,
  KeeperType,
  type CreateOrderParams,
  type GetKeeperContractParams,
} from "@bitflowlabs/core-sdk";
import {
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  hexToCV,
  cvToJSON,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";
import {
  getBitflowConfig,
  BITFLOW_PUBLIC_API,
  type Network,
} from "../config/index.js";
import type { Account, TransferResult } from "../transactions/builder.js";

// ============================================================================
// Types
// ============================================================================

export interface BitflowTicker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  liquidity_in_usd: string;
}

export interface PriceImpactHop {
  pool: string;
  tokenIn: string;
  tokenOut: string;
  reserveIn: string;
  reserveOut: string;
  feeBps: number;
  impact: number; // 0-1 decimal (fee-excluded)
}

export type ImpactSeverity = "low" | "medium" | "high" | "severe";

export interface PriceImpactResult {
  /** Combined pure price impact across all hops (0-1 decimal, fee-excluded) */
  combinedImpact: number;
  /** Human-readable percentage string e.g. "2.34%" */
  combinedImpactPct: string;
  /** Severity tier */
  severity: ImpactSeverity;
  /** Per-hop breakdown */
  hops: PriceImpactHop[];
  /** Total fee across all hops in basis points (approximate) */
  totalFeeBps: number;
}

export interface BitflowSwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  route: string[];
  priceImpact?: PriceImpactResult;
}

export interface BitflowToken {
  id: string;
  name: string;
  symbol: string;
  contractId: string;
  decimals: number;
}

// ============================================================================
// Bitflow Service
// ============================================================================

/**
 * Bitflow Service
 *
 * As of @bitflowlabs/core-sdk v2.4.2, all API keys are optional.
 * The SDK works out of the box with public rate limits (500 req/min per IP).
 *
 * Optional env vars for higher rate limits:
 *   - BITFLOW_API_KEY: Core API (tokens, quotes, routes)
 *   - BITFLOW_API_HOST: Override API host
 *   - BITFLOW_KEEPER_API_KEY: Keeper automation features
 *   - BITFLOW_KEEPER_API_HOST: Override Keeper API host
 *   - BITFLOW_READONLY_API_HOST: Override Stacks read-only node
 *
 * Request higher limits: help@bitflow.finance
 */
export class BitflowService {
  private sdk: BitflowSDK | null = null;
  private sdkInitialized = false;
  private tokenCache: Token[] | null = null;

  constructor(private network: Network) {
    this.initializeSdk();
  }

  /**
   * Initialize the Bitflow SDK.
   * API keys are optional — public endpoints work without them.
   */
  private initializeSdk(): void {
    if (this.sdkInitialized) return;
    this.sdkInitialized = true;

    const config = getBitflowConfig();

    try {
      this.sdk = new BitflowSDK({
        BITFLOW_API_HOST: config.apiHost,
        ...(config.apiKey && { BITFLOW_API_KEY: config.apiKey }),
        READONLY_CALL_API_HOST: config.readOnlyCallApiHost,
        BITFLOW_PROVIDER_ADDRESS: "",
        READONLY_CALL_API_KEY: "",
        KEEPER_API_HOST: config.keeperApiHost || "",
        ...(config.keeperApiKey && { KEEPER_API_KEY: config.keeperApiKey }),
      });
    } catch (error) {
      console.error("Failed to initialize Bitflow SDK:", error);
      this.sdk = null;
    }
  }

  private ensureMainnet(): void {
    if (this.network !== "mainnet") {
      throw new Error("Bitflow is only available on mainnet");
    }
  }

  private ensureSdk(): BitflowSDK {
    if (!this.sdk) {
      throw new Error(
        "Bitflow SDK failed to initialize. Check BITFLOW_API_HOST / BITFLOW_READONLY_API_HOST configuration and server logs."
      );
    }
    return this.sdk;
  }

  // ==========================================================================
  // Public API (No API Key Required)
  // ==========================================================================

  async getTicker(): Promise<BitflowTicker[]> {
    this.ensureMainnet();
    const response = await axios.get<BitflowTicker[]>(`${BITFLOW_PUBLIC_API}/ticker`);
    return response.data;
  }

  async getTickerByPair(baseCurrency: string, targetCurrency: string): Promise<BitflowTicker | null> {
    const tickers = await this.getTicker();
    const tickerId = `${baseCurrency}_${targetCurrency}`;
    return tickers.find((t) => t.ticker_id === tickerId) || null;
  }

  // ==========================================================================
  // SDK Functions (API key optional, public rate limits apply without key)
  // ==========================================================================

  async getAvailableTokens(): Promise<BitflowToken[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    if (!this.tokenCache) {
      this.tokenCache = await sdk.getAvailableTokens();
    }
    return this.tokenCache.map((t: Token) => ({
      id: t.tokenId,
      name: t.name,
      symbol: t.symbol,
      contractId: t.tokenId,
      decimals: t.tokenDecimals,
    }));
  }

  async getPossibleSwapTargets(tokenXId: string): Promise<string[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const targets = await sdk.getAllPossibleTokenY(tokenXId);
    return targets;
  }

  async getAllRoutes(tokenXId: string, tokenYId: string): Promise<SelectedSwapRoute[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const routes = await sdk.getAllPossibleTokenYRoutes(tokenXId, tokenYId);
    return routes;
  }

  /**
   * Get swap quote with price impact calculation.
   */
  async getSwapQuote(
    tokenXId: string,
    tokenYId: string,
    amount: number
  ): Promise<BitflowSwapQuote> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const quoteResult: QuoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amount);
    if (!quoteResult.bestRoute) {
      throw new Error(`No route found for ${tokenXId} -> ${tokenYId}`);
    }
    const priceImpact = await this.calculatePriceImpact(quoteResult, amount);
    return {
      tokenIn: tokenXId,
      tokenOut: tokenYId,
      amountIn: amount.toString(),
      expectedAmountOut: quoteResult.bestRoute.quote?.toString() || "0",
      route: quoteResult.bestRoute.tokenPath,
      priceImpact: priceImpact ?? undefined,
    };
  }

  // ==========================================================================
  // Price Impact Calculation
  // ==========================================================================

  private classifyImpact(impact: number): ImpactSeverity {
    if (impact < 0.01) return "low";
    if (impact < 0.03) return "medium";
    if (impact < 0.10) return "high";
    return "severe";
  }

  /**
   * Call a read-only contract function on the Stacks node used by Bitflow.
   * Includes a 5-second timeout to avoid blocking indefinitely.
   */
  private async callReadOnly(
    contractAddress: string,
    contractName: string,
    functionName: string,
    args: string[] = []
  ): Promise<any> {
    const config = getBitflowConfig();
    const host = config?.readOnlyCallApiHost || process.env.BITFLOW_READONLY_API_HOST || "https://node.bitflowapis.finance";
    const url = `${host}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: "SP000000000000000000002Q6VF78",
          arguments: args,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Read-only call to ${contractAddress}.${contractName}::${functionName} failed: HTTP ${res.status} ${res.statusText}${text ? " - " + text : ""}`
        );
      }

      const json = await res.json();
      if (!json.okay) {
        throw new Error(`Contract call failed: ${JSON.stringify(json)}`);
      }
      return cvToJSON(hexToCV(json.result));
    } finally {
      clearTimeout(timeout);
    }
  }

  private getStringFromPool(pool: any, key: string): string | null {
    const val = pool?.value?.value?.[key]?.value;
    return typeof val === "string" ? val : null;
  }

  private getUintFromPool(pool: any, key: string): bigint | null {
    const val = pool?.value?.value?.[key]?.value;
    return val !== undefined ? BigInt(val) : null;
  }

  /**
   * Calculate price impact for a swap route.
   *
   * Uses the XYK constant-product formula: impact = dx / (x + dx)
   * For multi-hop: combined = 1 - (1-i1) * (1-i2) * ...
   *
   * For each hop, reads pool token-x-name/token-y-name to determine
   * swap direction and select the correct reserves and fee fields.
   *
   * @param quoteResult The SDK quote result containing route and swap data
   * @param amountIn The input amount as passed to the SDK (smallest units)
   * @returns PriceImpactResult or null if route has no XYK pools
   */
  async calculatePriceImpact(
    quoteResult: QuoteResult,
    amountIn: number
  ): Promise<PriceImpactResult | null> {
    const bestRoute = quoteResult.bestRoute;
    if (!bestRoute) return null;

    const swapData = bestRoute.swapData;
    if (!swapData?.parameters) return null;

    const xykPools: Record<string, string> | undefined = swapData.parameters["xyk-pools"];
    if (!xykPools) return null;

    const poolKeys = Object.keys(xykPools).sort();
    if (poolKeys.length === 0) return null;

    const tokenPath: string[] = bestRoute.tokenPath || [];
    const hops: PriceImpactHop[] = [];
    let currentAmountRaw: bigint | null = null;

    const poolFetches = poolKeys.map(async (key) => {
      const poolContractId = xykPools[key];
      const dotIdx = poolContractId.indexOf(".");
      if (dotIdx === -1) return null;
      const poolAddr = poolContractId.substring(0, dotIdx);
      const poolName = poolContractId.substring(dotIdx + 1);
      try {
        const pool = await this.callReadOnly(poolAddr, poolName, "get-pool");
        return { key, poolContractId, pool };
      } catch {
        return null;
      }
    });

    const poolResults = await Promise.all(poolFetches);

    // If any hop in a multi-hop route failed, abort to avoid incomplete data
    const hasFailedHop = poolResults.some((r) => r === null);
    if (hasFailedHop && poolResults.length > 1) {
      return null;
    }

    for (let i = 0; i < poolResults.length; i++) {
      const result = poolResults[i];
      if (!result) continue;

      const { poolContractId, pool } = result;

      const xBalance = this.getUintFromPool(pool, "x-balance");
      const yBalance = this.getUintFromPool(pool, "y-balance");
      if (!xBalance || !yBalance) continue;

      // Determine swap direction from pool token identifiers
      const tokenYName = this.getStringFromPool(pool, "token-y-name");
      const hopTokenIn = tokenPath[i];
      const isYtoX = tokenYName !== null && hopTokenIn === tokenYName;

      const reserveIn = isYtoX ? yBalance : xBalance;
      const reserveOut = isYtoX ? xBalance : yBalance;

      // Read fee fields for the correct input direction
      const protocolFeeKey = isYtoX ? "y-protocol-fee" : "x-protocol-fee";
      const providerFeeKey = isYtoX ? "y-provider-fee" : "x-provider-fee";
      const protocolFee = this.getUintFromPool(pool, protocolFeeKey) || 0n;
      const providerFee = this.getUintFromPool(pool, providerFeeKey) || 0n;
      const feeBps = Number(protocolFee + providerFee);

      let dxRaw: bigint;
      if (i === 0) {
        // amountIn is already in smallest units from the tool layer
        dxRaw = BigInt(Math.round(amountIn));
      } else if (currentAmountRaw !== null) {
        dxRaw = currentAmountRaw;
      } else {
        continue;
      }

      // Bigint-safe impact: dx / (x + dx)
      const IMPACT_SCALE = 1_000_000n;
      const impactScaled = (dxRaw * IMPACT_SCALE) / (reserveIn + dxRaw);
      const impact = Number(impactScaled) / Number(IMPACT_SCALE);

      // Calculate output with fee for the next hop
      const feeNumer = 10000n - BigInt(feeBps);
      const dxWithFee = dxRaw * feeNumer;
      const numerator = dxWithFee * reserveOut;
      const denominator = reserveIn * 10000n + dxWithFee;
      currentAmountRaw = numerator / denominator;

      hops.push({
        pool: poolContractId,
        tokenIn: tokenPath[i] || `hop${i}-in`,
        tokenOut: tokenPath[i + 1] || `hop${i}-out`,
        reserveIn: reserveIn.toString(),
        reserveOut: reserveOut.toString(),
        feeBps,
        impact,
      });
    }

    if (hops.length === 0) return null;

    const combinedImpact = 1 - hops.reduce((acc, h) => acc * (1 - h.impact), 1);
    const combinedImpactPct = (combinedImpact * 100).toFixed(2) + "%";
    const totalFeeBps = hops.reduce((sum, h) => sum + h.feeBps, 0);

    return {
      combinedImpact,
      combinedImpactPct,
      severity: this.classifyImpact(combinedImpact),
      hops,
      totalFeeBps,
    };
  }

  /**
   * Execute a swap
   * @param fee Optional fee in micro-STX. If omitted, fee is auto-estimated.
   */
  async swap(
    account: Account,
    tokenXId: string,
    tokenYId: string,
    amountIn: number,
    slippageTolerance: number = 0.01,
    fee?: bigint
  ): Promise<TransferResult> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    const quoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amountIn);
    if (!quoteResult.bestRoute) {
      throw new Error(`No route found for ${tokenXId} -> ${tokenYId}`);
    }

    const swapExecutionData: SwapExecutionData = {
      route: quoteResult.bestRoute.route,
      amount: amountIn,
      tokenXDecimals: quoteResult.bestRoute.tokenXDecimals,
      tokenYDecimals: quoteResult.bestRoute.tokenYDecimals,
    };

    const swapParams = await sdk.getSwapParams(
      swapExecutionData,
      account.address,
      slippageTolerance
    );

    const network = this.network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

    const transaction = await makeContractCall({
      contractAddress: swapParams.contractAddress,
      contractName: swapParams.contractName,
      functionName: swapParams.functionName,
      functionArgs: swapParams.functionArgs,
      postConditions: swapParams.postConditions,
      senderKey: account.privateKey,
      network,
      postConditionMode: PostConditionMode.Deny,
      ...(fee !== undefined && { fee }),
    });

    const broadcastResult = await broadcastTransaction({
      transaction,
      network,
    });

    if ("error" in broadcastResult) {
      throw new Error(`Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason}`);
    }

    return {
      txid: broadcastResult.txid,
      rawTx: transaction.serialize(),
    };
  }

  // ==========================================================================
  // Keeper Functions (public endpoints)
  // ==========================================================================

  async getOrCreateKeeperContract(
    stacksAddress: string,
    keeperType: KeeperType = KeeperType.MULTI_ACTION_V1
  ): Promise<{ contractIdentifier: string; status: string }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const params: GetKeeperContractParams = { stacksAddress, keeperType };
    const result = await sdk.getOrCreateKeeperContract(params);
    return {
      contractIdentifier: result.keeperContract.contractIdentifier,
      status: result.keeperContract.contractStatus,
    };
  }

  async createKeeperOrder(params: {
    contractIdentifier: string;
    stacksAddress: string;
    actionType: string;
    fundingTokens: Record<string, string>;
    actionAmount: string;
    minReceived?: { amount: string; autoAdjust: boolean };
  }): Promise<{ orderId: string; status: string }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const orderParams: CreateOrderParams = {
      contractIdentifier: params.contractIdentifier,
      stacksAddress: params.stacksAddress,
      keeperType: KeeperType.MULTI_ACTION_V1,
      actionType: params.actionType,
      fundingTokens: params.fundingTokens,
      actionAmount: params.actionAmount,
      minReceived: params.minReceived,
      bitcoinTxId: "",
    };
    const result = await sdk.createOrder(orderParams);
    return {
      orderId: result.keeperOrder.orderId,
      status: result.keeperOrder.orderStatus,
    };
  }

  async getKeeperOrder(orderId: string): Promise<{
    orderId: string;
    status: string;
    actionType: string;
    actionAmount: string;
  }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const result = await sdk.getOrder(orderId);
    return {
      orderId: result.order.orderId,
      status: result.order.orderStatus,
      actionType: result.order.actionType,
      actionAmount: result.order.actionAmount,
    };
  }

  async cancelKeeperOrder(orderId: string): Promise<{ success: boolean }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const result = await sdk.cancelOrder(orderId);
    return { success: result.success };
  }

  async getKeeperUser(stacksAddress: string): Promise<{
    stacksAddress: string;
    contracts: Array<{ identifier: string; status: string }>;
    orders: Array<{ orderId: string; status: string }>;
  }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const result = await sdk.getUser(stacksAddress);
    const contracts = Object.values(result.user.keeperContracts).map((c) => ({
      identifier: c.contractIdentifier,
      status: c.contractStatus,
    }));
    const orders = Object.values(result.user.keeperOrders).map((o) => ({
      orderId: o.orderId,
      status: o.orderStatus,
    }));
    return {
      stacksAddress: result.user.stacksAddress,
      contracts,
      orders,
    };
  }
}

// ============================================================================
// Service Singleton
// ============================================================================

let _bitflowServiceInstance: BitflowService | null = null;

export function getBitflowService(network: Network): BitflowService {
  if (!_bitflowServiceInstance || _bitflowServiceInstance["network"] !== network) {
    _bitflowServiceInstance = new BitflowService(network);
  }
  return _bitflowServiceInstance;
}
