import { ClarityValue, serializeCV } from "@stacks/transactions";
import { getApiBaseUrl, type Network } from "../config/networks.js";
import { parseContractId } from "../config/contracts.js";
import { getHiroApiKey, getStacksApiUrl } from "../utils/storage.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Custom error for Hiro API rate limit responses (429)
 */
export class HiroApiRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = "HiroApiRateLimitError";
  }
}

export interface AccountInfo {
  balance: string;
  locked: string;
  nonce: number;
  balanceProof: string;
  nonceProof: string;
}

export interface StxBalance {
  balance: string;
  total_sent: string;
  total_received: string;
  locked: string;
  lock_height: number;
  lock_tx_id: string;
  burnchain_lock_height: number;
  burnchain_unlock_height: number;
}

export interface TokenBalance {
  balance: string;
  total_sent: string;
  total_received: string;
}

export interface FungibleTokenHolding {
  asset_identifier: string;
  balance: string;
}

export interface NonFungibleTokenHolding {
  asset_identifier: string;
  value: {
    hex: string;
    repr: string;
  };
}

export interface AccountBalances {
  stx: StxBalance;
  fungible_tokens: Record<string, TokenBalance>;
  non_fungible_tokens: Record<string, { count: number; total_sent: number; total_received: number }>;
}

export interface Transaction {
  tx_id: string;
  nonce: number;
  fee_rate: string;
  sender_address: string;
  sponsored: boolean;
  post_condition_mode: string;
  post_conditions: unknown[];
  anchor_mode: string;
  tx_status: string;
  receipt_time: number;
  receipt_time_iso: string;
  tx_type: string;
  block_hash?: string;
  block_height?: number;
  burn_block_time?: number;
  canonical?: boolean;
  tx_result?: {
    hex: string;
    repr: string;
  };
}

export interface ContractInfo {
  tx_id: string;
  contract_id: string;
  block_height: number;
  source_code: string;
  abi: string;
}

export interface ContractInterface {
  functions: Array<{
    name: string;
    access: string;
    args: Array<{ name: string; type: string }>;
    outputs: { type: string };
  }>;
  variables: Array<{
    name: string;
    access: string;
    type: string;
  }>;
  maps: Array<{
    name: string;
    key: string;
    value: string;
  }>;
  fungible_tokens: Array<{ name: string }>;
  non_fungible_tokens: Array<{ name: string; type: string }>;
}

export interface BlockInfo {
  hash: string;
  height: number;
  canonical: boolean;
  burn_block_hash: string;
  burn_block_height: number;
  burn_block_time: number;
  parent_block_hash: string;
  parent_microblock_hash: string;
  parent_microblock_sequence: number;
  txs: string[];
  microblocks_accepted: string[];
  microblocks_streamed: string[];
  execution_cost_read_count: number;
  execution_cost_read_length: number;
  execution_cost_runtime: number;
  execution_cost_write_count: number;
  execution_cost_write_length: number;
}

export interface MempoolTransaction {
  tx_id: string;
  tx_status: string;
  tx_type: string;
  receipt_time: number;
  receipt_time_iso: string;
  fee_rate: string;
  sender_address: string;
  nonce: number;
}

export interface PoxInfo {
  contract_id: string;
  pox_activation_threshold_ustx: number;
  first_burnchain_block_height: number;
  current_burnchain_block_height: number;
  prepare_phase_block_length: number;
  reward_phase_block_length: number;
  reward_slots: number;
  rejection_fraction: number;
  total_liquid_supply_ustx: number;
  current_cycle: {
    id: number;
    min_threshold_ustx: number;
    stacked_ustx: number;
    is_pox_active: boolean;
  };
  next_cycle: {
    id: number;
    min_threshold_ustx: number;
    min_increment_ustx: number;
    stacked_ustx: number;
    prepare_phase_start_block_height: number;
    blocks_until_prepare_phase: number;
    reward_phase_start_block_height: number;
    blocks_until_reward_phase: number;
    ustx_until_pox_rejection: number;
  };
  min_amount_ustx: number;
  prepare_cycle_length: number;
  reward_cycle_id: number;
  reward_cycle_length: number;
  rejection_votes_left_required: number;
  next_reward_cycle_in: number;
}

export interface NftHolding {
  asset_identifier: string;
  value: {
    hex: string;
    repr: string;
  };
  block_height: number;
  tx_id: string;
}

export interface NftEvent {
  sender: string;
  recipient: string;
  asset_identifier: string;
  value: {
    hex: string;
    repr: string;
  };
  tx_id: string;
  block_height: number;
}

export interface BnsName {
  name: string;
  address: string;
  blockchain: string;
  expire_block: number;
  grace_period: number;
  last_txid: string;
  resolver: string;
  status: string;
  zonefile: string;
  zonefile_hash: string;
}

// BNS V2 API Types
export interface BnsV2NameData {
  name_string: string;
  namespace_string: string;
  full_name: string;
  owner: string;
  registered_at: string;
  renewal_height: string;
  stx_burn: string;
  revoked: boolean;
  imported_at: string;
  preordered_by: string;
  is_valid: boolean;
}

export interface BnsV2NameResponse {
  current_burn_block: number;
  status: string;
  is_managed: boolean;
  data: BnsV2NameData;
}

export interface BnsV2NamesOwnedResponse {
  total: number;
  current_burn_block: number;
  names: Array<{
    full_name: string;
    name_string: string;
    namespace_string: string;
    owner: string;
    registered_at: number;
    renewal_height: number;
    stx_burn: string;
  }>;
}

export interface FeeEstimation {
  estimated_cost: {
    read_count: number;
    read_length: number;
    runtime: number;
    write_count: number;
    write_length: number;
  };
  estimated_cost_scalar: number;
  estimations: Array<{
    fee: number;
    fee_rate: number;
  }>;
  cost_scalar_change_by_byte: number;
}

/**
 * Fee priorities from the mempool.
 * Values are in micro-STX.
 */
export interface MempoolFeePriorities {
  no_priority: number;
  low_priority: number;
  medium_priority: number;
  high_priority: number;
}

/**
 * Response from /extended/v2/mempool/fees endpoint.
 * Contains fee priorities for different transaction types.
 */
export interface MempoolFeeResponse {
  all: MempoolFeePriorities;
  token_transfer: MempoolFeePriorities;
  contract_call: MempoolFeePriorities;
  smart_contract: MempoolFeePriorities;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  token_uri?: string;
  description?: string;
  image_uri?: string;
  image_thumbnail_uri?: string;
  image_canonical_uri?: string;
  tx_id: string;
  sender_address: string;
  contract_principal: string;
}

// ============================================================================
// Hiro API Service
// ============================================================================

export class HiroApiService {
  private defaultBaseUrl: string;
  private mempoolFeesCache: { data: MempoolFeeResponse; expires: number } | null = null;

  constructor(private network: Network) {
    this.defaultBaseUrl = getApiBaseUrl(network);
  }

  /**
   * Helper function to attempt a single fetch request.
   * Extracted to enable retry logic in the main fetch() method.
   */
  private async attemptFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const apiKey = (await getHiroApiKey()) || process.env.HIRO_API_KEY || "";
    const baseUrl = (await getStacksApiUrl()) || this.defaultBaseUrl;
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-hiro-api-key": apiKey } : {}),
      ...(options?.headers as Record<string, string>),
    };
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      if (response.status === 429) {
        const parsed = parseInt(response.headers.get("Retry-After") ?? "", 10);
        const retryAfterSeconds = isNaN(parsed) ? 60 : parsed;
        throw new HiroApiRateLimitError(
          `Hiro API rate limit exceeded. Retry after ${retryAfterSeconds}s`,
          retryAfterSeconds
        );
      }

      const errorText = await response.text();
      throw new Error(`Hiro API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Fetch data from the Hiro API with automatic retry on rate limits.
   * Retries up to 3 times with exponential backoff (1s, 2s, 4s).
   * Respects Retry-After header if present.
   */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const backoffDelays = [1000, 2000, 4000];
    const maxAttempts = backoffDelays.length + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.attemptFetch<T>(path, options);
      } catch (error) {
        if (!(error instanceof HiroApiRateLimitError) || attempt === maxAttempts - 1) {
          throw error;
        }

        const retryAfterMs = error.retryAfterSeconds * 1000;
        const delay = Math.max(retryAfterMs, backoffDelays[attempt]);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error("Unreachable: loop always returns or throws");
  }

  // ==========================================================================
  // Account Operations
  // ==========================================================================

  async getAccountInfo(address: string): Promise<AccountInfo> {
    return this.fetch<AccountInfo>(`/v2/accounts/${address}`);
  }

  async getStxBalance(address: string): Promise<StxBalance> {
    return this.fetch<StxBalance>(`/extended/v1/address/${address}/stx`);
  }

  async getAccountBalances(address: string): Promise<AccountBalances> {
    return this.fetch<AccountBalances>(`/extended/v1/address/${address}/balances`);
  }

  async getAccountTransactions(
    address: string,
    options?: { limit?: number; offset?: number; type?: string[] }
  ): Promise<{ limit: number; offset: number; total: number; results: Transaction[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());
    if (options?.type) options.type.forEach((t) => params.append("type", t));

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/address/${address}/transactions${query}`);
  }

  async getAccountNonce(address: string): Promise<number> {
    const info = await this.getAccountInfo(address);
    return info.nonce;
  }

  // ==========================================================================
  // Token Operations
  // ==========================================================================

  async getTokenBalance(address: string, contractId: string): Promise<string> {
    const balances = await this.getAccountBalances(address);
    const tokenKey = Object.keys(balances.fungible_tokens).find(
      (key) => key.startsWith(contractId + "::") || key === contractId
    );
    if (!tokenKey) {
      return "0";
    }
    return balances.fungible_tokens[tokenKey].balance;
  }

  async getTokenMetadata(contractId: string): Promise<TokenMetadata | null> {
    try {
      return await this.fetch<TokenMetadata>(`/metadata/v1/ft/${contractId}`);
    } catch {
      return null;
    }
  }

  async getTokenHolders(
    contractId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ limit: number; offset: number; total: number; results: Array<{ address: string; balance: string }> }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/tokens/ft/${contractId}/holders${query}`);
  }

  async getUserTokens(address: string): Promise<FungibleTokenHolding[]> {
    const balances = await this.getAccountBalances(address);
    return Object.entries(balances.fungible_tokens).map(([asset_identifier, data]) => ({
      asset_identifier,
      balance: data.balance,
    }));
  }

  // ==========================================================================
  // NFT Operations
  // ==========================================================================

  async getNftHoldings(
    address: string,
    options?: { limit?: number; offset?: number; asset_identifiers?: string[] }
  ): Promise<{ limit: number; offset: number; total: number; results: NftHolding[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());
    if (options?.asset_identifiers) {
      options.asset_identifiers.forEach((id) => params.append("asset_identifiers", id));
    }

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/tokens/nft/holdings${query}&principal=${address}`);
  }

  async getNftEvents(
    contractId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ limit: number; offset: number; total: number; results: NftEvent[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/tokens/nft/history${query}&asset_identifier=${contractId}`);
  }

  async getNftMetadata(contractId: string, tokenId: number): Promise<unknown> {
    return this.fetch(`/metadata/v1/nft/${contractId}/${tokenId}`);
  }

  // ==========================================================================
  // Contract Operations
  // ==========================================================================

  async getContractInfo(contractId: string): Promise<ContractInfo> {
    return this.fetch<ContractInfo>(`/extended/v1/contract/${contractId}`);
  }

  async getContractInterface(contractId: string): Promise<ContractInterface> {
    const { address, name } = parseContractId(contractId);
    return this.fetch<ContractInterface>(`/v2/contracts/interface/${address}/${name}`);
  }

  async getContractSource(contractId: string): Promise<{ source: string; publish_height: number }> {
    const { address, name } = parseContractId(contractId);
    return this.fetch(`/v2/contracts/source/${address}/${name}`);
  }

  async callReadOnlyFunction(
    contractId: string,
    functionName: string,
    functionArgs: ClarityValue[],
    senderAddress: string
  ): Promise<{ okay: boolean; result?: string; cause?: string }> {
    const { address, name } = parseContractId(contractId);

    const body = {
      sender: senderAddress,
      arguments: functionArgs.map((arg) => {
        const serialized = serializeCV(arg);
        // serializeCV returns hex string in newer versions, Uint8Array in older
        if (typeof serialized === "string") {
          return serialized;
        }
        return Buffer.from(serialized).toString("hex");
      }),
    };

    return this.fetch(`/v2/contracts/call-read/${address}/${name}/${functionName}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getContractEvents(
    contractId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ limit: number; offset: number; results: unknown[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/contract/${contractId}/events${query}`);
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  async getTransaction(txid: string): Promise<Transaction> {
    return this.fetch<Transaction>(`/extended/v1/tx/${txid}`);
  }

  async getTransactionStatus(txid: string): Promise<{
    status: string;
    block_height?: number;
    tx_result?: unknown;
  }> {
    try {
      const tx = await this.getTransaction(txid);
      return {
        status: tx.tx_status,
        block_height: tx.block_height,
        tx_result: tx.tx_result,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return { status: "pending" };
      }
      throw error;
    }
  }

  async searchTransactions(
    query: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ results: Transaction[] }> {
    const params = new URLSearchParams();
    params.set("query", query);
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    return this.fetch(`/extended/v1/search?${params.toString()}`);
  }

  async getMempoolTransactions(
    options?: { sender_address?: string; recipient_address?: string; limit?: number; offset?: number }
  ): Promise<{ limit: number; offset: number; total: number; results: MempoolTransaction[] }> {
    const params = new URLSearchParams();
    if (options?.sender_address) params.set("sender_address", options.sender_address);
    if (options?.recipient_address) params.set("recipient_address", options.recipient_address);
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/tx/mempool${query}`);
  }

  async estimateFee(txPayload: string): Promise<FeeEstimation> {
    return this.fetch("/v2/fees/transaction", {
      method: "POST",
      body: JSON.stringify({ transaction_payload: txPayload }),
    });
  }

  /**
   * Get fee priorities from the mempool.
   * Returns estimated fees (in micro-STX) for different priority levels
   * and transaction types.
   *
   * Cached for 60 seconds to reduce API load.
   */
  async getMempoolFees(): Promise<MempoolFeeResponse> {
    const now = Date.now();
    if (this.mempoolFeesCache && now < this.mempoolFeesCache.expires) {
      return this.mempoolFeesCache.data;
    }

    const data = await this.fetch<MempoolFeeResponse>("/extended/v2/mempool/fees");
    this.mempoolFeesCache = { data, expires: now + 60000 }; // 60s TTL
    return data;
  }

  // ==========================================================================
  // Block Operations
  // ==========================================================================

  async getBlockByHeight(height: number): Promise<BlockInfo> {
    return this.fetch<BlockInfo>(`/extended/v1/block/by_height/${height}`);
  }

  async getBlockByHash(hash: string): Promise<BlockInfo> {
    return this.fetch<BlockInfo>(`/extended/v1/block/${hash}`);
  }

  async getLatestBlock(): Promise<BlockInfo> {
    const response = await this.fetch<{ results: BlockInfo[] }>("/extended/v1/block?limit=1");
    if (!response.results.length) {
      throw new Error("No blocks found");
    }
    return response.results[0];
  }

  async getBlocks(
    options?: { limit?: number; offset?: number }
  ): Promise<{ limit: number; offset: number; total: number; results: BlockInfo[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.fetch(`/extended/v1/block${query}`);
  }

  // ==========================================================================
  // Stacking / PoX Operations
  // ==========================================================================

  async getPoxInfo(): Promise<PoxInfo> {
    return this.fetch<PoxInfo>("/v2/pox");
  }

  async getStackerInfo(address: string): Promise<unknown> {
    return this.fetch(`/extended/v1/address/${address}/stx_inbound`);
  }

  // ==========================================================================
  // BNS Operations
  // ==========================================================================

  async getBnsNameInfo(name: string): Promise<BnsName> {
    return this.fetch<BnsName>(`/v1/names/${name}`);
  }

  async getBnsNamesOwnedByAddress(
    address: string
  ): Promise<{ names: string[] }> {
    return this.fetch(`/v1/addresses/stacks/${address}`);
  }

  async getBnsNamePrice(name: string): Promise<{ units: string; amount: string }> {
    const [namespace] = name.split(".").reverse();
    return this.fetch(`/v2/prices/names/${namespace}/${name}`);
  }

  async resolveBnsName(name: string): Promise<string | null> {
    try {
      const info = await this.getBnsNameInfo(name);
      return info.address;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Network Status
  // ==========================================================================

  async getNetworkStatus(): Promise<{
    server_version: string;
    status: string;
    chain_tip: {
      block_height: number;
      block_hash: string;
      index_block_hash: string;
      microblock_hash: string;
      microblock_sequence: number;
    };
  }> {
    return this.fetch("/extended/v1/status");
  }

  async getCoreApiInfo(): Promise<{
    peer_version: number;
    pox_consensus: string;
    burn_block_height: number;
    stable_pox_consensus: string;
    stable_burn_block_height: number;
    server_version: string;
    network_id: number;
    parent_network_id: number;
    stacks_tip_height: number;
    stacks_tip: string;
    stacks_tip_consensus_hash: string;
    genesis_chainstate_hash: string;
  }> {
    return this.fetch("/v2/info");
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

let _hiroApiInstance: HiroApiService | null = null;

export function getHiroApi(network: Network): HiroApiService {
  if (!_hiroApiInstance || _hiroApiInstance["network"] !== network) {
    _hiroApiInstance = new HiroApiService(network);
  }
  return _hiroApiInstance;
}

export async function getStxBalance(
  address: string,
  network: Network
): Promise<{ stx: string; stxLocked: string }> {
  const api = getHiroApi(network);
  const balance = await api.getStxBalance(address);
  return {
    stx: balance.balance,
    stxLocked: balance.locked,
  };
}

export async function getTransactionStatus(
  txid: string,
  network: Network
): Promise<{ status: string; block_height?: number; tx_result?: unknown }> {
  const api = getHiroApi(network);
  return api.getTransactionStatus(txid);
}

// ============================================================================
// BNS V2 API Service (for .btc names)
// ============================================================================

const BNSV2_API_URL = "https://api.bnsv2.com";

export class BnsV2ApiService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = BNSV2_API_URL;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BNS V2 API error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get BNS V2 name info
   */
  async getNameInfo(name: string): Promise<BnsV2NameResponse> {
    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    return this.fetch<BnsV2NameResponse>(`/names/${fullName}`);
  }

  /**
   * Get names owned by an address
   */
  async getNamesOwnedByAddress(address: string): Promise<BnsV2NamesOwnedResponse> {
    return this.fetch<BnsV2NamesOwnedResponse>(`/names/address/${address}/valid`);
  }

  /**
   * Check if a name exists (is registered)
   */
  async nameExists(name: string): Promise<boolean> {
    try {
      const info = await this.getNameInfo(name);
      return info.status === "active" && info.data.is_valid && !info.data.revoked;
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return false;
      }
      if (error instanceof Error && error.message.includes("Name not found")) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Resolve a name to an address
   */
  async resolveName(name: string): Promise<string | null> {
    try {
      const info = await this.getNameInfo(name);
      if (info.status === "active" && info.data.is_valid && !info.data.revoked) {
        return info.data.owner;
      }
      return null;
    } catch {
      return null;
    }
  }
}

// BNS V2 singleton
let _bnsV2ApiInstance: BnsV2ApiService | null = null;

export function getBnsV2Api(): BnsV2ApiService {
  if (!_bnsV2ApiInstance) {
    _bnsV2ApiInstance = new BnsV2ApiService();
  }
  return _bnsV2ApiInstance;
}
