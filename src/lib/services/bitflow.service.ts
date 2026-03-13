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
  contractPrincipalCV,
  intCV,
  listCV,
  noneCV,
  someCV,
  tupleCV,
  uintCV,
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
  rankedRoutes?: UnifiedBitflowRouteQuote[];
  selectedRoute?: UnifiedBitflowRouteQuote;
  bestExecutableRoute?: UnifiedBitflowRouteQuote;
  executionWarning?: string;
  priceImpact?: PriceImpactResult;
}

export interface UnifiedBitflowRouteQuote {
  source: "sdk" | "hodlmm";
  label: string;
  tokenPath: string[];
  poolIds: string[];
  poolContracts: string[];
  dexPath?: string[];
  amountOutAtomic: string;
  amountOutHuman: string;
  tokenOutDecimals: number;
  executable: boolean;
  routeData?: SelectedSwapRoute;
  hodlmmQuote?: HodlmmQuoteRoute;
  priceImpact?: PriceImpactResult;
}

interface HodlmmQuoteRoute {
  route_index: number;
  amount_out: string;
  min_amount_out: string;
  slippage_tolerance: number;
  route_path: string[];
  execution_path: Array<{
    pool_trait: string;
    pool_id?: string | null;
    function_name: string;
    x_token_trait?: string | null;
    y_token_trait?: string | null;
    expected_bin_id?: number | null;
    x_in?: string | null;
    y_in?: string | null;
    x_out?: string | null;
    y_out?: string | null;
  }>;
  price_impact_bps: number;
  input_token_decimals?: number | null;
  output_token_decimals?: number | null;
  execution_details?: {
    amm_type?: string;
    pool_id?: string;
    fee_amount?: string;
    price_impact_bps?: number;
    [key: string]: unknown;
  } | null;
}

interface HodlmmMultiQuoteResponse {
  success: boolean;
  routes: HodlmmQuoteRoute[];
  best_route_index?: number | null;
  error?: string | null;
}

interface HodlmmExecutionPlan {
  functionName: "swap-x-for-y" | "swap-y-for-x";
  poolTrait: string;
  xTokenTrait: string;
  yTokenTrait: string;
  expectedBinId: number;
  amountInAtomic: string;
}

export interface BitflowToken {
  id: string;
  name: string;
  symbol: string;
  contractId: string;
  decimals: number;
  aliases?: string[];
}

function normalizeBitflowToken(token: Token): BitflowToken {
  const normalized: BitflowToken = {
    id: token.tokenId,
    name: token.name,
    symbol: token.symbol,
    contractId: token.tokenContract || token.tokenId,
    decimals: token.tokenDecimals,
  };

  if (token.tokenId === "token-USDCx-auto") {
    normalized.aliases = ["USDC"];
  }

  return normalized;
}

export interface HodlmmPoolInfo {
  pool_id: string;
  amm_type: string;
  token_x: string;
  token_y: string;
  token_x_symbol?: string | null;
  token_y_symbol?: string | null;
  token_x_decimals?: number | null;
  token_y_decimals?: number | null;
  bin_step: number;
  active_bin: number;
  active: boolean;
  x_protocol_fee: number;
  x_provider_fee: number;
  x_variable_fee: number;
  y_protocol_fee: number;
  y_provider_fee: number;
  y_variable_fee: number;
  core_address?: string | null;
  pool_token?: string | null;
  pool_name?: string | null;
  pool_symbol?: string | null;
  suggested?: boolean | null;
  sbtc_incentives?: boolean | null;
}

export interface HodlmmBinData {
  pool_id: string;
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price?: string | null;
  liquidity?: string | null;
}

export interface HodlmmBinListResponse {
  success: boolean;
  pool_id: string;
  bins: HodlmmBinData[];
  total_bins: number;
  active_bin_id?: number | null;
  error?: string | null;
}

export interface HodlmmUserPositionBin {
  bin_id: number;
  price?: string | null;
  reserve_x?: string | null;
  reserve_y?: string | null;
  liquidity?: string | null;
  user_liquidity?: string | number | null;
  [key: string]: unknown;
}

export interface HodlmmUserPositionBinsResponse {
  success?: boolean;
  pool_id?: string;
  user_address?: string;
  bins: HodlmmUserPositionBin[];
  [key: string]: unknown;
}

interface HodlmmTokenInfo {
  contract_address: string;
  symbol: string;
  name: string;
  decimals: number;
  asset_name: string;
}

export interface HodlmmRelativeLiquidityBinInput {
  activeBinOffset: number;
  xAmount: string;
  yAmount: string;
}

export interface HodlmmActiveBinToleranceInput {
  expectedBinId: number;
  maxDeviation: string;
}

export interface HodlmmRelativeWithdrawalInput {
  activeBinOffset: number;
  amount: string;
  minXAmount: string;
  minYAmount: string;
}

interface PreparedRelativeLiquidityBin extends HodlmmRelativeLiquidityBinInput {
  binId: number;
  isActiveBin: boolean;
  binPrice: number;
  reserveX: number;
  reserveY: number;
  binShares: number;
}

interface PreparedRelativeWithdrawalBin extends HodlmmRelativeWithdrawalInput {
  binId: number;
}

const HODLMM_API_BASE = "https://bff.bitflowapis.finance";
const HODLMM_LIQUIDITY_ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1";
const HODLMM_CORE_CONTRACT = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const PRICE_SCALE_BPS = 1e8;
const FEE_SCALE_BPS = 1e4;
const MINIMUM_BIN_SHARES = 10000;
const MINIMUM_BURNT_SHARES = 1000;

function extractPoolContractsFromRoute(route: any): string[] {
  const xykPools = Object.values(route?.swapData?.parameters?.["xyk-pools"] || {}).filter(
    (value): value is string => typeof value === "string"
  );
  const univPool = route?.swapData?.parameters?.["univ2v2-pool"];
  return xykPools.concat(typeof univPool === "string" ? [univPool] : []);
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
  private hodlmmTokenCache: HodlmmTokenInfo[] | null = null;

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

  private getHodlmmApiHeaders(allowFallback?: boolean): HeadersInit {
    const apiKey = process.env.BITFLOW_HODLMM_API_KEY || process.env.BITFLOW_API_KEY;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }

    if (allowFallback !== undefined) {
      headers["X-Allow-Fallback"] = String(allowFallback);
    }

    return headers;
  }

  private getHodlmmApiBase(): string {
    return process.env.BITFLOW_HODLMM_API_HOST || HODLMM_API_BASE;
  }

  private async hodlmmRequest<T>(
    path: string,
    init?: RequestInit,
    options?: { allowFallback?: boolean }
  ): Promise<T> {
    this.ensureMainnet();

    const url = `${this.getHodlmmApiBase()}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        ...this.getHodlmmApiHeaders(options?.allowFallback),
        ...(init?.headers || {}),
      },
    });

    const text = await response.text();
    let data: any = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      throw new Error(
        `HODLMM API request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`
      );
    }

    if (data && typeof data === "object" && "error" in data && data.error) {
      throw new Error(`HODLMM API error: ${String(data.error)}`);
    }

    return data as T;
  }

  private parseContractId(contractId: string): { address: string; name: string } {
    const [address, name] = contractId.split(".");
    if (!address || !name) {
      throw new Error(`Invalid contract identifier: ${contractId}`);
    }
    return { address, name };
  }

  private toSafeNumber(value: string | number | bigint | null | undefined, label: string): number {
    if (value === null || value === undefined) return 0;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid numeric value for ${label}`);
    }
    return num;
  }

  private toBigIntString(value: string | number | bigint, label: string): string {
    try {
      return BigInt(value).toString();
    } catch {
      throw new Error(`Invalid integer value for ${label}`);
    }
  }

  private getSignedBinId(unsignedBinId: number): number {
    return unsignedBinId - 500;
  }

  private buildPoolQuery(filters?: {
    suggested?: boolean;
    sbtcIncentives?: boolean;
    limit?: number;
  }): string {
    const params = new URLSearchParams({ amm_type: "dlmm" });

    if (filters?.suggested !== undefined) {
      params.set("suggested", String(filters.suggested));
    }

    if (filters?.sbtcIncentives !== undefined) {
      params.set("sbtc_incentives", String(filters.sbtcIncentives));
    }

    if (filters?.limit !== undefined) {
      params.set("limit", String(filters.limit));
    }

    return params.toString();
  }

  private normalizePoolResponse(data: any): HodlmmPoolInfo {
    if (data?.pool_id) return data as HodlmmPoolInfo;
    if (data?.pool?.pool_id) return data.pool as HodlmmPoolInfo;
    if (data?.poolId) {
      return {
        pool_id: data.poolId,
        amm_type: "dlmm",
        token_x: data?.tokens?.tokenX?.contract,
        token_y: data?.tokens?.tokenY?.contract,
        token_x_symbol: data?.tokens?.tokenX?.symbol || null,
        token_y_symbol: data?.tokens?.tokenY?.symbol || null,
        token_x_decimals: Number(data?.tokens?.tokenX?.decimals ?? 0),
        token_y_decimals: Number(data?.tokens?.tokenY?.decimals ?? 0),
        bin_step: Number(data.binStep || 0),
        active_bin: Number(data.activeBin || 0),
        active: Boolean(data.poolStatus),
        x_protocol_fee: Number(data.xProtocolFee || 0),
        x_provider_fee: Number(data.xProviderFee || 0),
        x_variable_fee: Number(data.xVariableFee || 0),
        y_protocol_fee: Number(data.yProtocolFee || 0),
        y_provider_fee: Number(data.yProviderFee || 0),
        y_variable_fee: Number(data.yVariableFee || 0),
        core_address: null,
        pool_token: data.poolContract || null,
        pool_name: data?.tokens?.tokenX?.symbol && data?.tokens?.tokenY?.symbol
          ? `${data.tokens.tokenX.symbol}-${data.tokens.tokenY.symbol}`
          : null,
        pool_symbol: data?.tokens?.tokenX?.symbol && data?.tokens?.tokenY?.symbol
          ? `${data.tokens.tokenX.symbol}-${data.tokens.tokenY.symbol}`
          : null,
        suggested: data.suggested ?? null,
        sbtc_incentives: data.sbtcIncentives ?? null,
      };
    }
    throw new Error("Unexpected HODLMM pool response shape");
  }

  private normalizeUserPositionBinsResponse(data: any): HodlmmUserPositionBinsResponse {
    const bins = Array.isArray(data?.bins)
      ? data.bins
      : Array.isArray(data?.position_bins)
        ? data.position_bins
        : Array.isArray(data?.positions?.bins)
          ? data.positions.bins
          : [];

    return {
      ...(data && typeof data === "object" ? data : {}),
      bins,
    };
  }

  private prepareRelativeLiquidityBins(
    binsResponse: HodlmmBinListResponse,
    requestedBins: HodlmmRelativeLiquidityBinInput[]
  ): PreparedRelativeLiquidityBin[] {
    const activeBinId = binsResponse.active_bin_id;
    if (activeBinId === null || activeBinId === undefined) {
      throw new Error("Pool bins response is missing active_bin_id");
    }

    const poolBins = new Map(binsResponse.bins.map((bin) => [bin.bin_id, bin]));

    return requestedBins.map((bin, index) => {
      const binId = activeBinId + bin.activeBinOffset;
      const poolBin = poolBins.get(binId);

      if (!poolBin) {
        throw new Error(`Target bin not found for entry ${index + 1}: ${binId}`);
      }

      const xAmount = this.toSafeNumber(bin.xAmount, `bins[${index}].xAmount`);
      const yAmount = this.toSafeNumber(bin.yAmount, `bins[${index}].yAmount`);

      if (binId < activeBinId && xAmount > 0) {
        throw new Error(`Bin ${binId}: only y token can be added below the active bin`);
      }

      if (binId > activeBinId && yAmount > 0) {
        throw new Error(`Bin ${binId}: only x token can be added above the active bin`);
      }

      if (binId === activeBinId && xAmount === 0 && yAmount === 0) {
        throw new Error(`Bin ${binId}: active bin requires a non-zero xAmount or yAmount`);
      }

      return {
        activeBinOffset: bin.activeBinOffset,
        xAmount: this.toBigIntString(bin.xAmount, `bins[${index}].xAmount`),
        yAmount: this.toBigIntString(bin.yAmount, `bins[${index}].yAmount`),
        binId,
        isActiveBin: binId === activeBinId,
        binPrice: this.toSafeNumber(poolBin.price || 0, `pool bin ${binId} price`),
        reserveX: this.toSafeNumber(poolBin.reserve_x, `pool bin ${binId} reserve_x`),
        reserveY: this.toSafeNumber(poolBin.reserve_y, `pool bin ${binId} reserve_y`),
        binShares: this.toSafeNumber(poolBin.liquidity || 0, `pool bin ${binId} liquidity`),
      };
    });
  }

  private prepareRelativeWithdrawalBins(
    binsResponse: HodlmmBinListResponse,
    requestedBins: HodlmmRelativeWithdrawalInput[]
  ): PreparedRelativeWithdrawalBin[] {
    const activeBinId = binsResponse.active_bin_id;
    if (activeBinId === null || activeBinId === undefined) {
      throw new Error("Pool bins response is missing active_bin_id");
    }

    return requestedBins.map((bin, index) => {
      const binId = activeBinId + bin.activeBinOffset;
      return {
        activeBinOffset: bin.activeBinOffset,
        amount: this.toBigIntString(bin.amount, `positions[${index}].amount`),
        minXAmount: this.toBigIntString(bin.minXAmount, `positions[${index}].minXAmount`),
        minYAmount: this.toBigIntString(bin.minYAmount, `positions[${index}].minYAmount`),
        binId,
      };
    });
  }

  private calculateMinDlpForRelativeBin(
    bin: PreparedRelativeLiquidityBin,
    poolFees: {
      xProtocolFee: number;
      xProviderFee: number;
      xVariableFee: number;
      yProtocolFee: number;
      yProviderFee: number;
      yVariableFee: number;
    },
    slippageTolerance: number
  ): { minDlp: number; maxXLiquidityFee: number; maxYLiquidityFee: number } {
    const xAmount = this.toSafeNumber(bin.xAmount, "bin xAmount");
    const yAmount = this.toSafeNumber(bin.yAmount, "bin yAmount");
    const yAmountScaled = yAmount * PRICE_SCALE_BPS;
    const reserveYScaled = bin.reserveY * PRICE_SCALE_BPS;
    const addLiquidityValue = bin.binPrice * xAmount + yAmountScaled;
    const binLiquidityValue = bin.binPrice * bin.reserveX + reserveYScaled;

    const dlp =
      bin.binShares === 0 || binLiquidityValue === 0
        ? Math.sqrt(addLiquidityValue)
        : (addLiquidityValue * bin.binShares) / binLiquidityValue;

    let xFeesLiquidity = 0;
    let yFeesLiquidity = 0;

    if (bin.isActiveBin && dlp > 0) {
      const xLiquidityFee = poolFees.xProtocolFee + poolFees.xProviderFee + poolFees.xVariableFee;
      const yLiquidityFee = poolFees.yProtocolFee + poolFees.yProviderFee + poolFees.yVariableFee;
      const xWithdrawable = (dlp * (bin.reserveX + xAmount)) / (bin.binShares + dlp);
      const yWithdrawable = (dlp * (bin.reserveY + yAmount)) / (bin.binShares + dlp);

      if (yWithdrawable > yAmount && xAmount > xWithdrawable) {
        const max = ((xAmount - xWithdrawable) * xLiquidityFee) / FEE_SCALE_BPS;
        xFeesLiquidity = xAmount > max ? max : xAmount;
      }

      if (xWithdrawable > xAmount && yAmount > yWithdrawable) {
        const max = ((yAmount - yWithdrawable) * yLiquidityFee) / FEE_SCALE_BPS;
        yFeesLiquidity = yAmount > max ? max : yAmount;
      }
    }

    const xPostFees = xAmount - xFeesLiquidity;
    const yPostFees = yAmount - yFeesLiquidity;
    const yPostFeesScaled = yPostFees * PRICE_SCALE_BPS;
    const reserveXPostFees = bin.reserveX + xFeesLiquidity;
    const reserveYPostFeesScaled = (bin.reserveY + yFeesLiquidity) * PRICE_SCALE_BPS;
    const addLiquidityValuePostFees = bin.binPrice * xPostFees + yPostFeesScaled;
    const binLiquidityValuePostFees = bin.binPrice * reserveXPostFees + reserveYPostFeesScaled;

    let dlpPostFees: number;
    if (bin.binShares === 0) {
      const intendedDlp = Math.sqrt(addLiquidityValuePostFees);
      dlpPostFees = intendedDlp >= MINIMUM_BIN_SHARES ? intendedDlp - MINIMUM_BURNT_SHARES : 0;
    } else if (binLiquidityValuePostFees === 0) {
      dlpPostFees = Math.sqrt(addLiquidityValuePostFees);
    } else {
      dlpPostFees = (addLiquidityValuePostFees * bin.binShares) / binLiquidityValuePostFees;
    }

    const minDlp = Math.floor(dlpPostFees * (1 - slippageTolerance / 100));

    return {
      minDlp,
      maxXLiquidityFee: Math.ceil(xFeesLiquidity * (1 + slippageTolerance / 100)),
      maxYLiquidityFee: Math.ceil(yFeesLiquidity * (1 + slippageTolerance / 100)),
    };
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
    return this.tokenCache.map((t: Token) => normalizeBitflowToken(t));
  }

  private async ensureTokenCache(): Promise<Token[]> {
    if (!this.tokenCache) {
      const sdk = this.ensureSdk();
      this.tokenCache = await sdk.getAvailableTokens();
    }
    return this.tokenCache;
  }

  private async ensureHodlmmTokenCache(): Promise<HodlmmTokenInfo[]> {
    if (!this.hodlmmTokenCache) {
      const response = await this.hodlmmRequest<{ tokens?: HodlmmTokenInfo[] }>(
        "/api/quotes/v1/tokens?amm_type=dlmm"
      );
      this.hodlmmTokenCache = response.tokens || [];
    }
    return this.hodlmmTokenCache;
  }

  private async resolveTokenById(tokenId: string): Promise<Token> {
    const tokens = await this.ensureTokenCache();
    const token = tokens.find((item) => item.tokenId === tokenId);
    if (!token) {
      throw new Error(`Unknown Bitflow token id: ${tokenId}`);
    }
    return token;
  }

  private async resolveHodlmmTokenContract(token: Token): Promise<string> {
    if (token.tokenContract && token.tokenContract !== "null") {
      return token.tokenContract;
    }

    const hodlmmTokens = await this.ensureHodlmmTokenCache();
    const bySymbol = hodlmmTokens.find((item) => item.symbol === token.symbol);
    if (bySymbol) {
      return bySymbol.contract_address;
    }

    const wrapCandidates = Object.values(token.wrapTokens || {})
      .map((item: any) => item?.tokenContract)
      .filter((value): value is string => typeof value === "string");
    const byWrapped = hodlmmTokens.find((item) => wrapCandidates.includes(item.contract_address));
    if (byWrapped) {
      return byWrapped.contract_address;
    }

    throw new Error(`No HODLMM token contract found for ${token.tokenId}`);
  }

  private formatAtomicToHuman(amountAtomic: string, decimals: number): string {
    const negative = amountAtomic.startsWith("-");
    const digits = negative ? amountAtomic.slice(1) : amountAtomic;
    const padded = digits.padStart(decimals + 1, "0");
    const splitIndex = padded.length - decimals;
    const whole = padded.slice(0, splitIndex);
    const fraction = padded.slice(splitIndex).replace(/0+$/, "");
    const result = fraction ? `${whole}.${fraction}` : whole;
    return negative ? `-${result}` : result;
  }

  private humanToAtomic(amount: number, decimals: number): string {
    return BigInt(Math.round(amount * 10 ** decimals)).toString();
  }

  private buildHodlmmPriceImpact(route: HodlmmQuoteRoute): PriceImpactResult | undefined {
    const impactBps =
      route.execution_details?.price_impact_bps ?? route.price_impact_bps ?? 0;
    const combinedImpact = impactBps / 10000;
    const firstPool = route.execution_path[0]?.pool_trait || "HODLMM";

    return {
      combinedImpact,
      combinedImpactPct: `${(combinedImpact * 100).toFixed(2)}%`,
      severity: this.classifyImpact(combinedImpact),
      hops: [
        {
          pool: firstPool,
          tokenIn: route.route_path[0] || "input",
          tokenOut: route.route_path[route.route_path.length - 1] || "output",
          reserveIn: "0",
          reserveOut: "0",
          feeBps: 0,
          impact: combinedImpact,
        },
      ],
      totalFeeBps: 0,
    };
  }

  private getHodlmmExecutionPlan(route: HodlmmQuoteRoute): HodlmmExecutionPlan | null {
    if (!route.execution_path.length || route.route_path.length !== 2) {
      return null;
    }

    const first = route.execution_path[0];
    const samePool = route.execution_path.every(
      (step) =>
        step.pool_trait === first.pool_trait &&
        step.function_name === first.function_name
    );

    if (!samePool) {
      return null;
    }

    if (first.function_name !== "swap-x-for-y" && first.function_name !== "swap-y-for-x") {
      return null;
    }

    const amountInAtomic =
      first.function_name === "swap-x-for-y"
        ? first.x_in || "0"
        : first.y_in || "0";

    if (!amountInAtomic || amountInAtomic === "0") {
      return null;
    }

    return {
      functionName: first.function_name,
      poolTrait: first.pool_trait,
      xTokenTrait: first.x_token_trait || route.route_path[0],
      yTokenTrait: first.y_token_trait || route.route_path[1],
      expectedBinId: Number(first.expected_bin_id ?? route.execution_details?.active_bin ?? 0),
      amountInAtomic,
    };
  }

  private normalizeSdkRouteQuote(
    routeQuote: QuoteResult["allRoutes"][number],
    priceImpact?: PriceImpactResult | null
  ): UnifiedBitflowRouteQuote {
    const decimals = routeQuote.tokenYDecimals || 0;
    const amountOutAtomic = this.humanToAtomic(routeQuote.quote || 0, decimals);

    return {
      source: "sdk",
      label: routeQuote.dexPath?.join(" -> ") || "Bitflow SDK",
      tokenPath: routeQuote.tokenPath || [],
      poolIds: routeQuote.dexPath || [],
      poolContracts: extractPoolContractsFromRoute(routeQuote.route),
      dexPath: routeQuote.dexPath,
      amountOutAtomic,
      amountOutHuman: (routeQuote.quote || 0).toString(),
      tokenOutDecimals: decimals,
      executable: true,
      routeData: routeQuote.route,
      priceImpact: priceImpact || undefined,
    };
  }

  private normalizeHodlmmRouteQuote(
    route: HodlmmQuoteRoute,
    tokenPathOverride?: string[]
  ): UnifiedBitflowRouteQuote {
    const decimals = route.output_token_decimals || 0;
    const executionPoolIds = Array.from(
      new Set(
        route.execution_path
          .map((step) => step.pool_id || step.pool_trait)
          .filter(Boolean) as string[]
      )
    );
    const executionPoolContracts = Array.from(
      new Set(route.execution_path.map((step) => step.pool_trait))
    );

    const executionPlan = this.getHodlmmExecutionPlan(route);

    return {
      source: "hodlmm",
      label: route.execution_details?.amm_type?.toUpperCase() || "HODLMM",
      tokenPath: tokenPathOverride || route.route_path,
      poolIds: executionPoolIds,
      poolContracts: executionPoolContracts,
      dexPath: ["HODLMM_DLMM"],
      amountOutAtomic: route.amount_out,
      amountOutHuman: this.formatAtomicToHuman(route.amount_out, decimals),
      tokenOutDecimals: decimals,
      executable: executionPlan !== null,
      hodlmmQuote: route,
      priceImpact: this.buildHodlmmPriceImpact(route),
    };
  }

  async getUnifiedRouteQuotes(
    tokenXId: string,
    tokenYId: string,
    amount: number
  ): Promise<UnifiedBitflowRouteQuote[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const [tokenX, tokenY] = await Promise.all([
      this.resolveTokenById(tokenXId),
      this.resolveTokenById(tokenYId),
    ]);
    const [hodlmmTokenXContract, hodlmmTokenYContract] = await Promise.all([
      this.resolveHodlmmTokenContract(tokenX).catch(() => null),
      this.resolveHodlmmTokenContract(tokenY).catch(() => null),
    ]);

    const sdkQuoteResult: QuoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amount);
    const sdkRoutes = (sdkQuoteResult.allRoutes || [])
      .map((routeQuote, index) => {
        const priceImpact =
          index === 0 && sdkQuoteResult.bestRoute
            ? sdkQuoteResult.bestRoute.dexPath?.join("|") === routeQuote.dexPath?.join("|")
              ? null
              : null
            : null;
        return this.normalizeSdkRouteQuote(routeQuote, priceImpact);
      });

    let sdkBestImpact: PriceImpactResult | null = null;
    if (sdkQuoteResult.bestRoute) {
      sdkBestImpact = await this.calculatePriceImpact(sdkQuoteResult, amount);
      let bestSdkRoute = sdkRoutes[0];
      for (const route of sdkRoutes) {
        if (BigInt(route.amountOutAtomic) > BigInt(bestSdkRoute.amountOutAtomic)) {
          bestSdkRoute = route;
        }
      }
      bestSdkRoute.priceImpact = sdkBestImpact || undefined;
    }

    let hodlmmRoutes: UnifiedBitflowRouteQuote[] = [];
    try {
      if (hodlmmTokenXContract && hodlmmTokenYContract) {
        const hodlmmAmountIn = this.humanToAtomic(amount, tokenX.tokenDecimals);
        const hodlmmResponse = await this.hodlmmRequest<HodlmmMultiQuoteResponse>(
          "/api/quotes/v1/quote/multi",
          {
            method: "POST",
            body: JSON.stringify({
              input_token: hodlmmTokenXContract,
              output_token: hodlmmTokenYContract,
              amount_in: hodlmmAmountIn,
              amm_strategy: "best",
              slippage_tolerance: 3,
            }),
          }
        );

        hodlmmRoutes = (hodlmmResponse.routes || []).map((route) =>
          this.normalizeHodlmmRouteQuote(route, [tokenXId, tokenYId])
        );
      }
    } catch {
      hodlmmRoutes = [];
    }

    return [...sdkRoutes, ...hodlmmRoutes].sort((a, b) => {
      const aOut = BigInt(a.amountOutAtomic);
      const bOut = BigInt(b.amountOutAtomic);
      if (aOut === bOut) return 0;
      return aOut > bOut ? -1 : 1;
    });
  }

  async getHodlmmPools(filters?: {
    suggested?: boolean;
    sbtcIncentives?: boolean;
    limit?: number;
  }): Promise<HodlmmPoolInfo[]> {
    const query = this.buildPoolQuery(filters);
    const response = await this.hodlmmRequest<{ pools?: HodlmmPoolInfo[] }>(
      `/api/quotes/v1/pools${query ? `?${query}` : ""}`
    );
    return Array.isArray(response?.pools) ? response.pools : [];
  }

  async getHodlmmPool(poolId: string, allowFallback: boolean = true): Promise<HodlmmPoolInfo> {
    const response = await this.hodlmmRequest<any>(`/api/app/v1/pools/${poolId}`, undefined, {
      allowFallback,
    });
    return this.normalizePoolResponse(response);
  }

  async getHodlmmPoolBins(
    poolId: string,
    allowFallback: boolean = true
  ): Promise<HodlmmBinListResponse> {
    return this.hodlmmRequest<HodlmmBinListResponse>(`/api/quotes/v1/bins/${poolId}`, undefined, {
      allowFallback,
    });
  }

  async getHodlmmUserPositionBins(
    userAddress: string,
    poolId: string,
    options?: { fresh?: boolean; allowFallback?: boolean }
  ): Promise<HodlmmUserPositionBinsResponse> {
    const params = new URLSearchParams();
    if (options?.fresh) {
      params.set("fresh", "true");
    }

    const response = await this.hodlmmRequest<any>(
      `/api/app/v1/users/${userAddress}/positions/${poolId}/bins${params.size ? `?${params.toString()}` : ""}`,
      undefined,
      { allowFallback: options?.allowFallback }
    );

    return this.normalizeUserPositionBinsResponse(response);
  }

  async addHodlmmLiquiditySimple(params: {
    account: Account;
    poolId: string;
    bins: HodlmmRelativeLiquidityBinInput[];
    slippageTolerance?: number;
    activeBinTolerance?: HodlmmActiveBinToleranceInput;
    fee?: bigint;
    allowFallback?: boolean;
    poolContract?: string;
    xTokenContract?: string;
    yTokenContract?: string;
  }): Promise<TransferResult & { poolId: string; preparedBins: PreparedRelativeLiquidityBin[] }> {
    this.ensureMainnet();

    const pool = await this.getHodlmmPool(params.poolId, params.allowFallback ?? true);
    const binsResponse = await this.getHodlmmPoolBins(params.poolId, params.allowFallback ?? true);
    const preparedBins = this.prepareRelativeLiquidityBins(binsResponse, params.bins);

    const poolContractId = params.poolContract || pool.pool_token || pool.core_address;
    const xTokenContractId = params.xTokenContract || pool.token_x;
    const yTokenContractId = params.yTokenContract || pool.token_y;

    if (!poolContractId) {
      throw new Error("Pool contract not found in HODLMM pool metadata. Pass --pool-contract explicitly.");
    }

    const { address: routerAddress, name: routerName } = this.parseContractId(HODLMM_LIQUIDITY_ROUTER);
    const { address: poolAddress, name: poolName } = this.parseContractId(poolContractId);
    const { address: xTokenAddress, name: xTokenName } = this.parseContractId(xTokenContractId);
    const { address: yTokenAddress, name: yTokenName } = this.parseContractId(yTokenContractId);

    const slippageTolerance = params.slippageTolerance ?? 1;
    const poolFees = {
      xProtocolFee: pool.x_protocol_fee || 0,
      xProviderFee: pool.x_provider_fee || 0,
      xVariableFee: pool.x_variable_fee || 0,
      yProtocolFee: pool.y_protocol_fee || 0,
      yProviderFee: pool.y_provider_fee || 0,
      yVariableFee: pool.y_variable_fee || 0,
    };

    const binAddPositions = preparedBins.map((bin) => {
      const feeInfo = this.calculateMinDlpForRelativeBin(bin, poolFees, slippageTolerance);
      return tupleCV({
        "active-bin-id-offset": intCV(bin.activeBinOffset),
        "x-amount": uintCV(BigInt(bin.xAmount)),
        "y-amount": uintCV(BigInt(bin.yAmount)),
        "min-dlp": uintCV(BigInt(Math.max(feeInfo.minDlp, 0))),
        "max-x-liquidity-fee": uintCV(BigInt(Math.max(feeInfo.maxXLiquidityFee, 0))),
        "max-y-liquidity-fee": uintCV(BigInt(Math.max(feeInfo.maxYLiquidityFee, 0))),
      });
    });

    const activeBinToleranceCv = params.activeBinTolerance
      ? someCV(
          tupleCV({
            "max-deviation": uintCV(BigInt(params.activeBinTolerance.maxDeviation)),
            "expected-bin-id": intCV(this.getSignedBinId(params.activeBinTolerance.expectedBinId)),
          })
        )
      : noneCV();

    const network = this.network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

    const transaction = await makeContractCall({
      contractAddress: routerAddress,
      contractName: routerName,
      functionName: "add-relative-liquidity-same-multi",
      functionArgs: [
        listCV(binAddPositions),
        contractPrincipalCV(poolAddress, poolName),
        contractPrincipalCV(xTokenAddress, xTokenName),
        contractPrincipalCV(yTokenAddress, yTokenName),
        activeBinToleranceCv,
      ],
      senderKey: params.account.privateKey,
      network,
      postConditions: [],
      postConditionMode: PostConditionMode.Allow,
      ...(params.fee !== undefined && { fee: params.fee }),
    });

    const broadcastResult = await broadcastTransaction({ transaction, network });

    if ("error" in broadcastResult) {
      throw new Error(`Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason}`);
    }

    return {
      txid: broadcastResult.txid,
      rawTx: transaction.serialize(),
      poolId: params.poolId,
      preparedBins,
    };
  }

  async withdrawHodlmmLiquiditySimple(params: {
    account: Account;
    poolId: string;
    positions: HodlmmRelativeWithdrawalInput[];
    fee?: bigint;
    allowFallback?: boolean;
    poolContract?: string;
    xTokenContract?: string;
    yTokenContract?: string;
  }): Promise<TransferResult & { poolId: string; preparedPositions: PreparedRelativeWithdrawalBin[] }> {
    this.ensureMainnet();

    const pool = await this.getHodlmmPool(params.poolId, params.allowFallback ?? true);
    const binsResponse = await this.getHodlmmPoolBins(params.poolId, params.allowFallback ?? true);
    const preparedPositions = this.prepareRelativeWithdrawalBins(binsResponse, params.positions);

    const poolContractId = params.poolContract || pool.pool_token || pool.core_address;
    const xTokenContractId = params.xTokenContract || pool.token_x;
    const yTokenContractId = params.yTokenContract || pool.token_y;

    if (!poolContractId) {
      throw new Error("Pool contract not found in HODLMM pool metadata. Pass --pool-contract explicitly.");
    }

    const { address: routerAddress, name: routerName } = this.parseContractId(HODLMM_LIQUIDITY_ROUTER);
    const { address: poolAddress, name: poolName } = this.parseContractId(poolContractId);
    const { address: xTokenAddress, name: xTokenName } = this.parseContractId(xTokenContractId);
    const { address: yTokenAddress, name: yTokenName } = this.parseContractId(yTokenContractId);
    const network = this.network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;

    const withdrawPositions = preparedPositions.map((position) =>
      tupleCV({
        "active-bin-id-offset": intCV(position.activeBinOffset),
        amount: uintCV(BigInt(position.amount)),
        "min-x-amount": uintCV(BigInt(position.minXAmount)),
        "min-y-amount": uintCV(BigInt(position.minYAmount)),
        "pool-trait": contractPrincipalCV(poolAddress, poolName),
      })
    );

    const totalMinX = preparedPositions.reduce((sum, position) => sum + BigInt(position.minXAmount), 0n);
    const totalMinY = preparedPositions.reduce((sum, position) => sum + BigInt(position.minYAmount), 0n);

    const transaction = await makeContractCall({
      contractAddress: routerAddress,
      contractName: routerName,
      functionName: "withdraw-relative-liquidity-same-multi",
      functionArgs: [
        listCV(withdrawPositions),
        contractPrincipalCV(xTokenAddress, xTokenName),
        contractPrincipalCV(yTokenAddress, yTokenName),
        uintCV(totalMinX),
        uintCV(totalMinY),
      ],
      senderKey: params.account.privateKey,
      network,
      postConditions: [],
      postConditionMode: PostConditionMode.Allow,
      ...(params.fee !== undefined && { fee: params.fee }),
    });

    const broadcastResult = await broadcastTransaction({ transaction, network });

    if ("error" in broadcastResult) {
      throw new Error(`Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason}`);
    }

    return {
      txid: broadcastResult.txid,
      rawTx: transaction.serialize(),
      poolId: params.poolId,
      preparedPositions,
    };
  }

  private async executeHodlmmSwap(
    account: Account,
    route: UnifiedBitflowRouteQuote,
    fee?: bigint
  ): Promise<TransferResult> {
    const quote = route.hodlmmQuote;
    if (!quote) {
      throw new Error("Selected HODLMM route is missing quote data");
    }

    const plan = this.getHodlmmExecutionPlan(quote);
    if (!plan) {
      throw new Error(
        "Selected HODLMM route is not directly executable. Only direct single-pool HODLMM swaps are supported right now."
      );
    }

    const network = this.network === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
    const { address: coreAddress, name: coreName } = this.parseContractId(HODLMM_CORE_CONTRACT);
    const { address: poolAddress, name: poolName } = this.parseContractId(plan.poolTrait);
    const { address: xTokenAddress, name: xTokenName } = this.parseContractId(plan.xTokenTrait);
    const { address: yTokenAddress, name: yTokenName } = this.parseContractId(plan.yTokenTrait);

    const functionArgs = [
      contractPrincipalCV(poolAddress, poolName),
      contractPrincipalCV(xTokenAddress, xTokenName),
      contractPrincipalCV(yTokenAddress, yTokenName),
      intCV(plan.expectedBinId),
      uintCV(BigInt(plan.amountInAtomic)),
    ];

    const transaction = await makeContractCall({
      contractAddress: coreAddress,
      contractName: coreName,
      functionName: plan.functionName,
      functionArgs,
      senderKey: account.privateKey,
      network,
      postConditions: [],
      postConditionMode: PostConditionMode.Allow,
      ...(fee !== undefined && { fee }),
    });

    const broadcastResult = await broadcastTransaction({ transaction, network });

    if ("error" in broadcastResult) {
      throw new Error(`Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason}`);
    }

    return {
      txid: broadcastResult.txid,
      rawTx: transaction.serialize(),
    };
  }

  async getPossibleSwapTargets(tokenXId: string): Promise<string[]> {
    this.ensureMainnet();
    const sdk = this.ensureSdk();
    const targets = await sdk.getAllPossibleTokenY(tokenXId);
    return targets;
  }

  async getAllRoutes(
    tokenXId: string,
    tokenYId: string,
    amount?: number
  ): Promise<UnifiedBitflowRouteQuote[]> {
    this.ensureMainnet();
    if (amount !== undefined) {
      return this.getUnifiedRouteQuotes(tokenXId, tokenYId, amount);
    }

    const sdk = this.ensureSdk();
    const routes = await sdk.getAllPossibleTokenYRoutes(tokenXId, tokenYId);

    let hodlmmRoutes: UnifiedBitflowRouteQuote[] = [];
    try {
      const [tokenX, tokenY] = await Promise.all([
        this.resolveTokenById(tokenXId),
        this.resolveTokenById(tokenYId),
      ]);
      const [hodlmmTokenXContract, hodlmmTokenYContract] = await Promise.all([
        this.resolveHodlmmTokenContract(tokenX).catch(() => null),
        this.resolveHodlmmTokenContract(tokenY).catch(() => null),
      ]);
      const pools = await this.getHodlmmPools();
      hodlmmRoutes = pools
        .filter(
          (pool) =>
            hodlmmTokenXContract &&
            hodlmmTokenYContract &&
            ((pool.token_x === hodlmmTokenXContract && pool.token_y === hodlmmTokenYContract) ||
              (pool.token_x === hodlmmTokenYContract && pool.token_y === hodlmmTokenXContract))
        )
        .map((pool) => ({
          source: "hodlmm" as const,
          label: "HODLMM",
          tokenPath: [tokenXId, tokenYId],
          poolIds: [pool.pool_id],
          poolContracts: [pool.pool_token || pool.core_address || pool.pool_id],
          dexPath: ["HODLMM_DLMM"],
        amountOutAtomic: "0",
        amountOutHuman: "0",
        tokenOutDecimals: tokenY.tokenDecimals,
        executable: false,
      }));
    } catch {
      hodlmmRoutes = [];
    }

    return [
      ...routes.map((route) => ({
        source: "sdk" as const,
        label: route.dex_path?.join(" -> ") || "Bitflow SDK",
        tokenPath: route.token_path || [],
        poolIds: route.dex_path || [],
        poolContracts: extractPoolContractsFromRoute(route),
        dexPath: route.dex_path,
        amountOutAtomic: "0",
        amountOutHuman: "0",
        tokenOutDecimals: 0,
        executable: true,
        routeData: route,
      })),
      ...hodlmmRoutes,
    ];
  }

  /**
   * Get swap quote with price impact calculation.
   */
  async getSwapQuote(
    tokenXId: string,
    tokenYId: string,
    amount: number
  ): Promise<BitflowSwapQuote> {
    const rankedRoutes = await this.getUnifiedRouteQuotes(tokenXId, tokenYId, amount);
    const bestRoute = rankedRoutes[0];
    let bestExecutableRoute = rankedRoutes.find((route) => route.executable);

    if (!bestRoute) {
      throw new Error(`No route found for ${tokenXId} -> ${tokenYId}`);
    }

    if (bestExecutableRoute?.source === "sdk" && !bestExecutableRoute.priceImpact) {
      try {
        const sdk = this.ensureSdk();
        const sdkQuoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amount);
        const executableImpact = await this.calculatePriceImpact(sdkQuoteResult, amount);
        bestExecutableRoute = {
          ...bestExecutableRoute,
          priceImpact: executableImpact || undefined,
        };
      } catch {
        // Keep the route summary even if price-impact enrichment fails.
      }
    }

    let executionWarning: string | undefined;
    if (
      bestRoute.source === "hodlmm" &&
      bestExecutableRoute &&
      (bestExecutableRoute.source !== bestRoute.source ||
        bestExecutableRoute.amountOutAtomic !== bestRoute.amountOutAtomic ||
        bestExecutableRoute.poolIds.join("|") !== bestRoute.poolIds.join("|"))
    ) {
      executionWarning =
        `Best quoted route uses HODLMM (${bestRoute.amountOutHuman}), but this route is not directly executable. ` +
        `The best executable route is ${bestExecutableRoute.label} (${bestExecutableRoute.amountOutHuman}).`;
    }

    return {
      tokenIn: tokenXId,
      tokenOut: tokenYId,
      amountIn: amount.toString(),
      expectedAmountOut: bestRoute.amountOutHuman,
      route: bestRoute.tokenPath,
      selectedRoute: bestRoute,
      bestExecutableRoute,
      executionWarning,
      rankedRoutes,
      priceImpact: (bestExecutableRoute || bestRoute).priceImpact,
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
    const quote = await this.getSwapQuote(tokenXId, tokenYId, amountIn);
    const executableRoute = quote.bestExecutableRoute;

    if (!executableRoute) {
      throw new Error(`No route found for ${tokenXId} -> ${tokenYId}`);
    }

    if (executableRoute.source === "hodlmm") {
      return this.executeHodlmmSwap(account, executableRoute, fee);
    }

    const sdk = this.ensureSdk();
    const quoteResult = await sdk.getQuoteForRoute(tokenXId, tokenYId, amountIn);
    if (!quoteResult.bestRoute) {
      throw new Error(`No SDK route found for ${tokenXId} -> ${tokenYId}`);
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
