import axios, { type AxiosInstance } from "axios";
import {
  makeSTXTokenTransfer,
  makeContractCall,
  uintCV,
  principalCV,
  noneCV,
  PostConditionMode,
} from "@stacks/transactions";
import {
  decodePaymentRequired,
  encodePaymentPayload,
  X402_HEADERS,
} from "../utils/x402-protocol.js";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { NETWORK, API_URL, getStacksNetwork, type Network } from "../config/networks.js";
import { getNetworkFromStacksChainId } from "../config/caip.js";
import type { Account } from "../transactions/builder.js";
import { getWalletManager } from "./wallet-manager.js";
import { formatStx, formatSbtc } from "../utils/formatting.js";
import { getSbtcService } from "./sbtc.service.js";
import { getHiroApi } from "./hiro-api.js";
import { createHash } from "crypto";
import { InsufficientBalanceError } from "../utils/errors.js";
import { getContracts, parseContractId } from "../config/contracts.js";

// Track payment attempts per client instance (auto-cleanup via WeakMap)
const paymentAttempts: WeakMap<AxiosInstance, number> = new WeakMap();

// Transaction deduplication cache: {dedupKey -> {txid, timestamp}}
const dedupCache: Map<string, { txid: string; timestamp: number }> = new Map();

// Cleanup expired dedup entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of dedupCache) {
    if (now - value.timestamp > 60000) {
      dedupCache.delete(key);
    }
  }
}, 300000).unref();

/**
 * Safe JSON transform - parses string responses without throwing
 */
function safeJsonTransform(data: unknown): unknown {
  if (typeof data !== "string") {
    return data;
  }
  const trimmed = data.trim();
  if (!trimmed) {
    return data;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return data;
  }
}

/**
 * Create a plain axios instance with JSON parsing for both success and error responses.
 * Used as the base for both payment-wrapped clients and probe requests.
 * Timeout is 120 seconds to accommodate sBTC contract-call settlements which can take 60+ seconds.
 */
function createBaseAxiosInstance(baseURL?: string): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 120000,
    transformResponse: [safeJsonTransform],
  });

  // Ensure error response bodies (especially 402 payloads) are also parsed as JSON
  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error?.response?.data) {
        error.response.data = safeJsonTransform(error.response.data);
      }
      return Promise.reject(error);
    }
  );

  return instance;
}

/**
 * Convert mnemonic to account
 */
export async function mnemonicToAccount(
  mnemonic: string,
  network: Network
): Promise<Account> {
  const wallet = await generateWallet({
    secretKey: mnemonic,
    password: "",
  });

  const account = wallet.accounts[0];
  const address = getStxAddress(account, network);

  return {
    address,
    privateKey: account.stxPrivateKey,
    network,
  };
}

/**
 * Create an API client with x402 payment interceptor.
 * Creates a fresh client instance per call with max-1-payment-attempt guard.
 */
export async function createApiClient(baseUrl?: string): Promise<AxiosInstance> {
  const url = baseUrl || API_URL;

  // Get account (from managed wallet or env mnemonic)
  const account = await getAccount();
  const axiosInstance = createBaseAxiosInstance(url);

  // Interceptor 1 (FIFO): max-1-payment-attempt guard.
  // On the first 402, increments the counter and re-rejects so Interceptor 2 can handle it.
  // On a second 402 (would-be retry loop), rejects with a user-facing error.
  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      // Only intercept 402 payment errors
      if (error.response?.status !== 402) {
        return Promise.reject(error);
      }

      // Check attempt counter
      const attempts = paymentAttempts.get(axiosInstance) || 0;

      if (attempts >= 1) {
        // Reject retry - payment already attempted once
        return Promise.reject(
          new Error(
            "Payment retry limit exceeded (max 1 attempt). This endpoint may have payment/settlement issues. Check balance and try again."
          )
        );
      }

      // Increment counter and pass through to the native payment interceptor
      paymentAttempts.set(axiosInstance, attempts + 1);
      return Promise.reject(error);
    }
  );

  // Interceptor 2 (FIFO): native x402 payment handler.
  // Decodes payment requirements, builds a sponsored signed transaction, encodes the
  // PaymentPayloadV2 into the payment-signature header, and retries the original request.
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status !== 402) {
        return Promise.reject(error);
      }

      try {
        // Decode payment requirements from header
        const headerValue = error.response?.headers?.[X402_HEADERS.PAYMENT_REQUIRED];
        const paymentRequired = decodePaymentRequired(headerValue);

        if (!paymentRequired || !paymentRequired.accepts || paymentRequired.accepts.length === 0) {
          return Promise.reject(
            new Error("Invalid x402 402 response: missing or empty payment-required header")
          );
        }

        // Select first Stacks-compatible payment option
        const selectedOption = paymentRequired.accepts.find(
          (opt) => opt.network?.startsWith("stacks:")
        );

        if (!selectedOption) {
          const networks = paymentRequired.accepts.map((a) => a.network).join(", ");
          return Promise.reject(
            new Error(`No compatible Stacks payment option found. Available networks: ${networks}`)
          );
        }

        // Verify the payment network matches our configured network
        const paymentNetwork = getNetworkFromStacksChainId(selectedOption.network);
        if (paymentNetwork && paymentNetwork !== account.network) {
          return Promise.reject(
            new Error(
              `Network mismatch: endpoint requires ${paymentNetwork} but wallet is configured for ${account.network}. ` +
              `Switch to a ${paymentNetwork} wallet or use a ${account.network} endpoint.`
            )
          );
        }

        // Build a sponsored signed transaction (relay pays gas; fee: 0n)
        const tokenType = detectTokenType(selectedOption.asset);
        const amount = BigInt(selectedOption.amount);
        const networkName = getStacksNetwork(account.network);

        let transaction;
        if (tokenType === "sBTC") {
          const contracts = getContracts(account.network);
          const { address: contractAddress, name: contractName } = parseContractId(
            contracts.SBTC_TOKEN
          );

          transaction = await makeContractCall({
            contractAddress,
            contractName,
            functionName: "transfer",
            functionArgs: [
              uintCV(amount),
              principalCV(account.address),
              principalCV(selectedOption.payTo),
              noneCV(),
            ],
            senderKey: account.privateKey,
            network: networkName,
            postConditionMode: PostConditionMode.Allow,
            sponsored: true,
            fee: 0n,
          });
        } else {
          transaction = await makeSTXTokenTransfer({
            recipient: selectedOption.payTo,
            amount,
            senderKey: account.privateKey,
            network: networkName,
            memo: "",
            sponsored: true,
            fee: 0n,
          });
        }

        const txHex = "0x" + transaction.serialize();

        // Encode PaymentPayloadV2 into payment-signature header
        const encodedPayload = encodePaymentPayload({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted: selectedOption,
          payload: { transaction: txHex },
        });

        // Retry the original request with the payment header
        const originalRequest = error.config;
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers[X402_HEADERS.PAYMENT_SIGNATURE] = encodedPayload;

        return axiosInstance.request(originalRequest);
      } catch (paymentError) {
        return Promise.reject(
          new Error(
            `x402 payment failed: ${paymentError instanceof Error ? paymentError.message : String(paymentError)}`
          )
        );
      }
    }
  );

  return axiosInstance;
}

/**
 * Create a plain axios client without payment interceptor.
 * Used for known-free endpoints where 402 responses should fail, not auto-pay.
 */
export function createPlainClient(baseUrl?: string): AxiosInstance {
  return createBaseAxiosInstance(baseUrl);
}

/**
 * Get wallet address - checks managed wallet first, then env mnemonic
 */
export async function getWalletAddress(): Promise<string> {
  const account = await getAccount();
  return account.address;
}

/**
 * Get account - checks managed wallet first, then env mnemonic
 */
export async function getAccount(): Promise<Account> {
  // Check managed wallet session first
  const walletManager = getWalletManager();
  const sessionAccount = walletManager.getActiveAccount();

  if (sessionAccount) {
    return sessionAccount;
  }

  // Fall back to environment mnemonic
  const mnemonic = process.env.CLIENT_MNEMONIC || "";
  if (!mnemonic) {
    throw new Error(
      "No wallet available. Either unlock a managed wallet (wallet_unlock) " +
        "or set CLIENT_MNEMONIC environment variable."
    );
  }
  return mnemonicToAccount(mnemonic, NETWORK);
}

/**
 * Probe result types
 */
export type ProbeResultFree = {
  type: 'free';
  data: unknown;
};

export type ProbeResultPaymentRequired = {
  type: 'payment_required';
  amount: string;
  asset: string;
  recipient: string;
  network: string;
  endpoint: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  maxTimeoutSeconds?: number;
};

export type ProbeResult = ProbeResultFree | ProbeResultPaymentRequired;

/**
 * Detect token type from asset identifier
 * @param asset - Full contract identifier or token name
 * @returns 'STX' for native STX, 'sBTC' for sBTC token
 */
export function detectTokenType(asset: string): 'STX' | 'sBTC' {
  const assetLower = asset.trim().toLowerCase();
  // Treat as sBTC only if the asset is exactly "sbtc" (token name)
  // or a full contract identifier ending with "::token-sbtc"
  if (assetLower === 'sbtc' || assetLower.endsWith('::token-sbtc')) {
    return 'sBTC';
  }
  return 'STX';
}

/**
 * Format payment amount into human-readable string with token symbol
 * @param amount - Raw amount string (microSTX or satoshis)
 * @param asset - Token asset identifier
 * @returns Formatted string like "0.000001 sBTC" or "0.001 STX"
 */
export function formatPaymentAmount(amount: string, asset: string): string {
  const tokenType = detectTokenType(asset);
  if (tokenType === 'sBTC') {
    return formatSbtc(amount);
  }
  return formatStx(amount);
}

/**
 * Probe an endpoint without payment interceptor
 * Returns either free response data or payment requirements
 */
export async function probeEndpoint(options: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  params?: Record<string, string>;
  data?: Record<string, unknown>;
}): Promise<ProbeResult> {
  const { method, url, params, data } = options;
  const axiosInstance = createBaseAxiosInstance();

  try {
    const response = await axiosInstance.request({ method, url, params, data });

    // 200 response - free endpoint
    return {
      type: 'free',
      data: response.data,
    };
  } catch (error) {
    const axiosError = error as { response?: { status?: number; data?: unknown; headers?: Record<string, string> } };

    // 402 Payment Required - parse payment info
    if (axiosError.response?.status === 402) {
      // Try to parse v2 payment-required header first
      const headerValue = axiosError.response.headers?.[X402_HEADERS.PAYMENT_REQUIRED];
      const paymentRequired = decodePaymentRequired(headerValue);

      // If v2 header is successfully parsed, use it
      if (paymentRequired?.accepts?.length) {
        const acceptedPayment = paymentRequired.accepts[0];

        // Convert CAIP-2 network identifier to human-readable format
        const network = getNetworkFromStacksChainId(acceptedPayment.network) ?? NETWORK;

        return {
          type: 'payment_required',
          amount: acceptedPayment.amount,
          asset: acceptedPayment.asset,
          recipient: acceptedPayment.payTo,
          network,
          endpoint: url,
          resource: paymentRequired.resource,
          maxTimeoutSeconds: acceptedPayment.maxTimeoutSeconds,
        };
      }

      // Fall back to v1 body parsing
      const paymentData = axiosError.response.data as {
        amount?: string;
        asset?: string;
        recipient?: string;
        network?: string;
      };

      if (!paymentData.amount || !paymentData.asset || !paymentData.recipient || !paymentData.network) {
        const headerDebug = headerValue !== undefined && headerValue !== null
          ? `present (length=${String(headerValue).length})`
          : 'missing';
        throw new Error(
          `Invalid 402 response from ${url}: missing payment fields in both v2 header and v1 body. ` +
          `v2 header: ${headerDebug}; v1 body keys: ${Object.keys(paymentData as object).join(', ') || 'none'}`
        );
      }

      return {
        type: 'payment_required',
        amount: paymentData.amount,
        asset: paymentData.asset,
        recipient: paymentData.recipient,
        network: paymentData.network,
        endpoint: url,
      };
    }

    // Other errors - propagate
    if (axiosError.response) {
      throw new Error(
        `HTTP ${axiosError.response.status} from ${url}: ${JSON.stringify(axiosError.response.data)}`
      );
    }

    throw error;
  }
}

/**
 * Generate a stable deduplication key for a request
 */
export function generateDedupKey(
  method: string,
  url: string,
  params?: Record<string, string>,
  data?: Record<string, unknown>
): string {
  const payload = JSON.stringify({ method, url, params, data });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Check if a request was recently processed (within 60s)
 * @returns txid if duplicate found, null otherwise
 */
export function checkDedupCache(key: string): string | null {
  const cached = dedupCache.get(key);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (now - cached.timestamp > 60000) {
    dedupCache.delete(key);
    return null;
  }
  return cached.txid;
}

/**
 * Record a transaction in the dedup cache
 */
export function recordTransaction(key: string, txid: string): void {
  dedupCache.set(key, { txid, timestamp: Date.now() });
}

/**
 * Check if account has sufficient balance to pay for x402 endpoint.
 * @throws InsufficientBalanceError if balance is too low
 */
export async function checkSufficientBalance(
  account: Account,
  amount: string,
  asset: string
): Promise<void> {
  const tokenType = detectTokenType(asset);
  const requiredAmount = BigInt(amount);

  if (tokenType === 'sBTC') {
    const sbtcService = getSbtcService(account.network);
    const balanceInfo = await sbtcService.getBalance(account.address);
    const balance = BigInt(balanceInfo.balance);

    if (balance < requiredAmount) {
      const shortfall = requiredAmount - balance;
      throw new InsufficientBalanceError(
        `Insufficient sBTC balance: need ${formatSbtc(amount)}, have ${formatSbtc(balanceInfo.balance)} (shortfall: ${formatSbtc(shortfall.toString())}). ` +
        `Deposit more sBTC via the bridge at https://bridge.stx.eco or use a different wallet.`,
        'sBTC',
        balanceInfo.balance,
        amount,
        shortfall.toString()
      );
    }

    // sBTC transfers are contract calls that also require STX for gas fees
    const hiroApiForSbtc = getHiroApi(account.network);
    const stxInfoForSbtc = await hiroApiForSbtc.getStxBalance(account.address);
    const stxBalanceForSbtc = BigInt(stxInfoForSbtc.balance);
    const sbtcFees = await hiroApiForSbtc.getMempoolFees();
    const estimatedSbtcFee = BigInt(sbtcFees.contract_call.high_priority);

    if (stxBalanceForSbtc < estimatedSbtcFee) {
      const stxShortfall = estimatedSbtcFee - stxBalanceForSbtc;
      throw new InsufficientBalanceError(
        `Insufficient STX balance to cover sBTC transfer fee: need ${formatStx(estimatedSbtcFee.toString())} estimated fee, ` +
        `have ${formatStx(stxInfoForSbtc.balance)} (shortfall: ${formatStx(stxShortfall.toString())}). ` +
        `Deposit more STX or use a different wallet.`,
        'STX',
        stxInfoForSbtc.balance,
        estimatedSbtcFee.toString(),
        stxShortfall.toString()
      );
    }

    return;
  }

  // STX: include estimated fee in the required amount
  const hiroApi = getHiroApi(account.network);
  const balanceInfo = await hiroApi.getStxBalance(account.address);
  const balance = BigInt(balanceInfo.balance);

  const mempoolFees = await hiroApi.getMempoolFees();
  const estimatedFee = BigInt(mempoolFees.contract_call.high_priority);
  const totalRequired = requiredAmount + estimatedFee;

  if (balance >= totalRequired) return;

  const shortfall = totalRequired - balance;
  throw new InsufficientBalanceError(
    `Insufficient STX balance: need ${formatStx(totalRequired.toString())} (${formatStx(amount)} payment + ${formatStx(estimatedFee.toString())} estimated fee), ` +
    `have ${formatStx(balanceInfo.balance)} (shortfall: ${formatStx(shortfall.toString())}). ` +
    `Deposit more STX or use a different wallet.`,
    'STX',
    balanceInfo.balance,
    totalRequired.toString(),
    shortfall.toString()
  );
}

export { NETWORK, API_URL };
