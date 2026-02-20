import { ClarityValue, uintCV, principalCV } from "@stacks/transactions";
import { HiroApiService, getHiroApi, NftHolding, NftEvent } from "./hiro-api.js";
import { parseContractId, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";
import { createNftSendPostCondition } from "../transactions/post-conditions.js";

// ============================================================================
// Types
// ============================================================================

export interface NftInfo {
  contractId: string;
  tokenId: number;
  owner: string;
  metadata?: unknown;
}

export interface NftCollectionInfo {
  contractId: string;
  name?: string;
  totalSupply?: number;
  functions: string[];
}

export interface NftTransferEvent {
  sender: string;
  recipient: string;
  tokenId: string;
  txId: string;
  blockHeight: number;
}

// ============================================================================
// NFT Service (SIP-009)
// ============================================================================

export class NftService {
  private hiro: HiroApiService;

  constructor(private network: Network) {
    this.hiro = getHiroApi(network);
  }

  /**
   * Get all NFTs owned by an address
   */
  async getHoldings(
    address: string,
    options?: { limit?: number; offset?: number; contractId?: string }
  ): Promise<{ total: number; nfts: NftHolding[] }> {
    const assetIdentifiers = options?.contractId ? [options.contractId] : undefined;
    const result = await this.hiro.getNftHoldings(address, {
      limit: options?.limit,
      offset: options?.offset,
      asset_identifiers: assetIdentifiers,
    });

    return {
      total: result.total,
      nfts: result.results,
    };
  }

  /**
   * Get NFT metadata
   */
  async getMetadata(contractId: string, tokenId: number): Promise<unknown> {
    return this.hiro.getNftMetadata(contractId, tokenId);
  }

  /**
   * Get NFT owner by calling the contract
   */
  async getOwner(
    contractId: string,
    tokenId: number,
    senderAddress: string
  ): Promise<string | null> {
    parseContractId(contractId); // Validate contract ID format

    try {
      const result = await this.hiro.callReadOnlyFunction(
        contractId,
        "get-owner",
        [uintCV(tokenId)],
        senderAddress
      );

      if (result.okay && result.result) {
        // Parse the result - it returns (optional principal)
        // This is a simplified parsing - actual implementation may need more robust parsing
        const match = result.result.match(/\(some\s+([^\)]+)\)/);
        if (match) {
          return match[1];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get collection information
   */
  async getCollectionInfo(contractId: string): Promise<NftCollectionInfo> {
    const contractInterface = await this.hiro.getContractInterface(contractId);

    // Get the NFT token type info
    const nftTokens = contractInterface.non_fungible_tokens || [];
    const functions = contractInterface.functions.map((f) => f.name);

    // Try to get the last token ID to determine supply
    let totalSupply: number | undefined;
    try {
      // Many NFT contracts have get-last-token-id function (SIP-009 requirement)
      const lastTokenResult = await this.hiro.callReadOnlyFunction(
        contractId,
        "get-last-token-id",
        [],
        contractId.split(".")[0]
      );
      if (lastTokenResult.okay && lastTokenResult.result) {
        const match = lastTokenResult.result.match(/\(ok\s+u(\d+)\)/);
        if (match) {
          totalSupply = parseInt(match[1], 10);
        }
      }
    } catch {
      // Function may not exist or may fail
    }

    return {
      contractId,
      name: nftTokens[0]?.name,
      totalSupply,
      functions,
    };
  }

  /**
   * Get NFT transfer history
   */
  async getHistory(
    contractId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ total: number; events: NftTransferEvent[] }> {
    const result = await this.hiro.getNftEvents(contractId, options);

    const events: NftTransferEvent[] = result.results.map((event: NftEvent) => ({
      sender: event.sender,
      recipient: event.recipient,
      tokenId: event.value.repr,
      txId: event.tx_id,
      blockHeight: event.block_height,
    }));

    return {
      total: result.total,
      events,
    };
  }

  /**
   * Transfer an NFT (SIP-009 standard)
   * @param fee Optional fee in micro-STX. If omitted, fee is auto-estimated.
   */
  async transfer(
    account: Account,
    contractId: string,
    tokenId: number,
    recipient: string,
    fee?: bigint
  ): Promise<TransferResult> {
    const { address: contractAddress, name: contractName } = parseContractId(contractId);

    // Fetch the contract interface to get the NFT token name
    const contractInterface = await this.hiro.getContractInterface(contractId);
    if (!contractInterface.non_fungible_tokens || contractInterface.non_fungible_tokens.length === 0) {
      throw new Error(`No NFT tokens found in contract ${contractId}`);
    }
    // Use the first NFT token name (SIP-009 contracts typically have one)
    const nftName = contractInterface.non_fungible_tokens[0].name;

    // SIP-009 transfer function signature:
    // (transfer (token-id uint) (sender principal) (recipient principal))
    const functionArgs: ClarityValue[] = [
      uintCV(tokenId),
      principalCV(account.address),
      principalCV(recipient),
    ];

    // Add post condition: sender must send this specific NFT
    const postCondition = createNftSendPostCondition(
      account.address,
      contractId,
      nftName,
      tokenId
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
   * Mint an NFT (contract-specific, not part of SIP-009)
   */
  async mint(
    account: Account,
    contractId: string,
    recipient: string,
    mintFunctionName: string = "mint"
  ): Promise<TransferResult> {
    const { address: contractAddress, name: contractName } = parseContractId(contractId);

    // This is a generic mint call - actual parameters depend on the specific contract
    const functionArgs: ClarityValue[] = [principalCV(recipient)];

    // No post conditions needed for minting (contract creates new asset)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: mintFunctionName,
      functionArgs,
      postConditions: [],
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

let _nftServiceInstance: NftService | null = null;

export function getNftService(network: Network): NftService {
  if (!_nftServiceInstance || _nftServiceInstance["network"] !== network) {
    _nftServiceInstance = new NftService(network);
  }
  return _nftServiceInstance;
}
