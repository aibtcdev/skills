import { ClarityValue, uintCV, principalCV, noneCV, someCV, bufferCV } from "@stacks/transactions";
import { HiroApiService, getHiroApi, FungibleTokenHolding } from "./hiro-api.js";
import { parseContractId, getWellKnownTokens, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";
import { createFungiblePostCondition } from "../transactions/post-conditions.js";

// ============================================================================
// Types
// ============================================================================

export interface TokenBalance {
  contractId: string;
  balance: string;
  decimals: number;
  symbol?: string;
  name?: string;
  formattedBalance: string;
}

export interface TokenInfo {
  contractId: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  tokenUri?: string;
  description?: string;
  imageUri?: string;
}

// ============================================================================
// Tokens Service (SIP-010)
// ============================================================================

export class TokensService {
  private hiro: HiroApiService;
  private wellKnownTokens: ReturnType<typeof getWellKnownTokens>;

  constructor(private network: Network) {
    this.hiro = getHiroApi(network);
    this.wellKnownTokens = getWellKnownTokens(network);
  }

  /**
   * Resolve a token symbol or contract ID to a contract ID
   */
  resolveToken(tokenIdentifier: string): string {
    // Check if it's a well-known token symbol (case-insensitive)
    const upperToken = tokenIdentifier.toUpperCase();

    // Look up in wellKnownTokens by iterating keys (handles case differences like sBTC vs SBTC)
    for (const [symbol, contractId] of Object.entries(this.wellKnownTokens)) {
      if (symbol.toUpperCase() === upperToken && contractId !== "native") {
        return contractId;
      }
    }

    // Not a known symbol - treat as contract ID
    return tokenIdentifier;
  }

  /**
   * Get token balance for an address
   */
  async getBalance(
    tokenContractOrSymbol: string,
    address: string
  ): Promise<TokenBalance> {
    const contractId = this.resolveToken(tokenContractOrSymbol);
    const balance = await this.hiro.getTokenBalance(address, contractId);
    const metadata = await this.hiro.getTokenMetadata(contractId);

    const decimals = metadata?.decimals || 6;
    const divisor = BigInt(10 ** decimals);
    const balanceBigInt = BigInt(balance);
    const wholePart = balanceBigInt / divisor;
    const fractionalPart = balanceBigInt % divisor;
    const formattedBalance = `${wholePart}.${fractionalPart.toString().padStart(decimals, "0")}`;

    return {
      contractId,
      balance,
      decimals,
      symbol: metadata?.symbol,
      name: metadata?.name,
      formattedBalance,
    };
  }

  /**
   * Get token information
   */
  async getTokenInfo(tokenContractOrSymbol: string): Promise<TokenInfo | null> {
    const contractId = this.resolveToken(tokenContractOrSymbol);
    const metadata = await this.hiro.getTokenMetadata(contractId);

    if (!metadata) {
      return null;
    }

    return {
      contractId,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      totalSupply: metadata.total_supply,
      tokenUri: metadata.token_uri,
      description: metadata.description,
      imageUri: metadata.image_uri,
    };
  }

  /**
   * Transfer tokens to a recipient (SIP-010 standard)
   * @param fee Optional fee in micro-STX. If omitted, fee is auto-estimated.
   */
  async transfer(
    account: Account,
    tokenContractOrSymbol: string,
    recipient: string,
    amount: bigint,
    memo?: string,
    fee?: bigint
  ): Promise<TransferResult> {
    const contractId = this.resolveToken(tokenContractOrSymbol);
    const { address: contractAddress, name: contractName } = parseContractId(contractId);

    // Fetch the contract interface to get the fungible token name
    const contractInterface = await this.hiro.getContractInterface(contractId);
    if (!contractInterface.fungible_tokens || contractInterface.fungible_tokens.length === 0) {
      throw new Error(`No fungible tokens found in contract ${contractId}`);
    }
    // Use the first fungible token name (SIP-010 contracts typically have one)
    const tokenName = contractInterface.fungible_tokens[0].name;

    // SIP-010 transfer function signature:
    // (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
    const functionArgs: ClarityValue[] = [
      uintCV(amount),
      principalCV(account.address),
      principalCV(recipient),
      memo ? someCV(bufferCV(Buffer.from(memo).subarray(0, 34))) : noneCV(),
    ];

    // Add post condition: sender must send exactly `amount` of the token
    const postCondition = createFungiblePostCondition(
      account.address,
      contractId,
      tokenName,
      "eq",
      amount
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "transfer",
      functionArgs,
      postConditions: [postCondition],
      ...(fee !== undefined && { fee }),
    });
  }

  /**
   * Get all tokens owned by an address
   */
  async getUserTokens(address: string): Promise<FungibleTokenHolding[]> {
    return this.hiro.getUserTokens(address);
  }

  /**
   * Get token holders
   */
  async getTokenHolders(
    tokenContractOrSymbol: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ total: number; results: Array<{ address: string; balance: string }> }> {
    const contractId = this.resolveToken(tokenContractOrSymbol);
    return this.hiro.getTokenHolders(contractId, options);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

let _tokensServiceInstance: TokensService | null = null;

export function getTokensService(network: Network): TokensService {
  if (!_tokensServiceInstance || _tokensServiceInstance["network"] !== network) {
    _tokensServiceInstance = new TokensService(network);
  }
  return _tokensServiceInstance;
}
