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

export interface BitflowSwapQuote {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  route: string[];
  priceImpact?: string;
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
 * TODO: Bitflow API Key Integration
 *
 * Current status: Bitflow SDK features require API key from Bitflow team.
 *
 * To enable full Bitflow features:
 * 1. Contact Bitflow team via Discord to request API keys
 * 2. Set environment variables:
 *    - BITFLOW_API_KEY: Required for SDK features (quotes, swaps, tokens)
 *    - BITFLOW_API_HOST: API host URL (provided by Bitflow)
 *    - BITFLOW_KEEPER_API_KEY: Optional, for Keeper automation features
 *    - BITFLOW_KEEPER_API_HOST: Optional, Keeper API host
 *
 * Without API key: Only public ticker endpoint works (bitflow_get_ticker)
 *
 * Future: Move API keys to Cloudflare Worker proxy so npm users don't need their own keys
 */
export class BitflowService {
  private sdk: BitflowSDK | null = null;
  private sdkInitialized = false;
  private tokenCache: Token[] | null = null;

  constructor(private network: Network) {
    this.initializeSdk();
  }

  /**
   * Initialize the Bitflow SDK if API key is configured
   */
  private initializeSdk(): void {
    if (this.sdkInitialized) return;
    this.sdkInitialized = true;

    const config = getBitflowConfig();
    if (!config || !config.apiKey) {
      console.log("Bitflow SDK not configured - API key missing. Using public API only.");
      return;
    }

    try {
      this.sdk = new BitflowSDK({
        BITFLOW_API_HOST: config.apiHost,
        BITFLOW_API_KEY: config.apiKey,
        READONLY_CALL_API_HOST: config.readOnlyCallApiHost,
        BITFLOW_PROVIDER_ADDRESS: "", // Not needed for our use case
        READONLY_CALL_API_KEY: "", // Optional
        KEEPER_API_HOST: config.keeperApiHost || "",
        KEEPER_API_KEY: config.keeperApiKey || "",
      });
    } catch (error) {
      console.error("Failed to initialize Bitflow SDK:", error);
      this.sdk = null;
    }
  }

  /**
   * Check if SDK is available
   */
  public isSdkAvailable(): boolean {
    return this.sdk !== null;
  }

  /**
   * Ensure mainnet for Bitflow operations
   */
  private ensureMainnet(): void {
    if (this.network !== "mainnet") {
      throw new Error("Bitflow is only available on mainnet");
    }
  }

  /**
   * Ensure SDK is available
   */
  private ensureSdk(): BitflowSDK {
    if (!this.sdk) {
      throw new Error(
        "Bitflow SDK not configured. Set BITFLOW_API_KEY environment variable to enable full Bitflow features."
      );
    }
    return this.sdk;
  }

  // ==========================================================================
  // Public API (No API Key Required)
  // ==========================================================================

  /**
   * Get ticker data from public API (no API key required)
   */
  async getTicker(): Promise<BitflowTicker[]> {
    this.ensureMainnet();

    const response = await axios.get<BitflowTicker[]>(`${BITFLOW_PUBLIC_API}/ticker`);
    return response.data;
  }

  /**
   * Get ticker for a specific pair
   */
  async getTickerByPair(baseCurrency: string, targetCurrency: string): Promise<BitflowTicker | null> {
    const tickers = await this.getTicker();
    const tickerId = `${baseCurrency}_${targetCurrency}`;
    return tickers.find((t) => t.ticker_id === tickerId) || null;
  }

  // ==========================================================================
  // SDK Functions (Requires API Key)
  // ==========================================================================

  /**
   * Get all available tokens for swapping
   */
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

  /**
   * Get possible swap targets for a given token
   * Returns token IDs that can be swapped to from tokenX
   */
  async getPossibleSwapTargets(tokenXId: string): Promise<string[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    // getAllPossibleTokenY returns string[]
    const targets = await sdk.getAllPossibleTokenY(tokenXId);
    return targets;
  }

  /**
   * Get all possible routes between two tokens
   */
  async getAllRoutes(tokenXId: string, tokenYId: string): Promise<SelectedSwapRoute[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    const routes = await sdk.getAllPossibleTokenYRoutes(tokenXId, tokenYId);
    return routes;
  }

  /**
   * Get swap quote
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

    return {
      tokenIn: tokenXId,
      tokenOut: tokenYId,
      amountIn: amount.toString(),
      expectedAmountOut: quoteResult.bestRoute.quote?.toString() || "0",
      route: quoteResult.bestRoute.tokenPath,
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

    // Get quote first to build swap execution data
    const quoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amountIn);

    if (!quoteResult.bestRoute) {
      throw new Error(`No route found for ${tokenXId} -> ${tokenYId}`);
    }

    // Build swap execution data
    const swapExecutionData: SwapExecutionData = {
      route: quoteResult.bestRoute.route,
      amount: amountIn,
      tokenXDecimals: quoteResult.bestRoute.tokenXDecimals,
      tokenYDecimals: quoteResult.bestRoute.tokenYDecimals,
    };

    // Get swap parameters
    const swapParams = await sdk.getSwapParams(
      swapExecutionData,
      account.address,
      slippageTolerance
    );

    // Build and sign the transaction
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
  // Keeper Functions (Requires Keeper API Key)
  // ==========================================================================

  /**
   * Check if Keeper features are available
   */
  public isKeeperAvailable(): boolean {
    const config = getBitflowConfig();
    return this.sdk !== null && !!config?.keeperApiKey;
  }

  /**
   * Get or create keeper contract for user
   */
  async getOrCreateKeeperContract(
    stacksAddress: string,
    keeperType: KeeperType = KeeperType.MULTI_ACTION_V1
  ): Promise<{ contractIdentifier: string; status: string }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    if (!this.isKeeperAvailable()) {
      throw new Error("Keeper features not configured. Set BITFLOW_KEEPER_API_KEY to enable.");
    }

    const params: GetKeeperContractParams = {
      stacksAddress,
      keeperType,
    };

    const result = await sdk.getOrCreateKeeperContract(params);

    return {
      contractIdentifier: result.keeperContract.contractIdentifier,
      status: result.keeperContract.contractStatus,
    };
  }

  /**
   * Create a swap order via Keeper
   */
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

    if (!this.isKeeperAvailable()) {
      throw new Error("Keeper features not configured. Set BITFLOW_KEEPER_API_KEY to enable.");
    }

    const orderParams: CreateOrderParams = {
      contractIdentifier: params.contractIdentifier,
      stacksAddress: params.stacksAddress,
      keeperType: KeeperType.MULTI_ACTION_V1,
      actionType: params.actionType,
      fundingTokens: params.fundingTokens,
      actionAmount: params.actionAmount,
      minReceived: params.minReceived,
      bitcoinTxId: "", // Required field but not always used
    };

    const result = await sdk.createOrder(orderParams);

    return {
      orderId: result.keeperOrder.orderId,
      status: result.keeperOrder.orderStatus,
    };
  }

  /**
   * Get order details
   */
  async getKeeperOrder(orderId: string): Promise<{
    orderId: string;
    status: string;
    actionType: string;
    actionAmount: string;
  }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    if (!this.isKeeperAvailable()) {
      throw new Error("Keeper features not configured. Set BITFLOW_KEEPER_API_KEY to enable.");
    }

    const result = await sdk.getOrder(orderId);

    return {
      orderId: result.order.orderId,
      status: result.order.orderStatus,
      actionType: result.order.actionType,
      actionAmount: result.order.actionAmount,
    };
  }

  /**
   * Cancel a keeper order
   */
  async cancelKeeperOrder(orderId: string): Promise<{ success: boolean }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    if (!this.isKeeperAvailable()) {
      throw new Error("Keeper features not configured. Set BITFLOW_KEEPER_API_KEY to enable.");
    }

    const result = await sdk.cancelOrder(orderId);
    return { success: result.success };
  }

  /**
   * Get user's keeper info and orders
   */
  async getKeeperUser(stacksAddress: string): Promise<{
    stacksAddress: string;
    contracts: Array<{ identifier: string; status: string }>;
    orders: Array<{ orderId: string; status: string }>;
  }> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();

    if (!this.isKeeperAvailable()) {
      throw new Error("Keeper features not configured. Set BITFLOW_KEEPER_API_KEY to enable.");
    }

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
