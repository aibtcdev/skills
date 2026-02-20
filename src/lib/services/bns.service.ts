import { ClarityValue, bufferCV, uintCV, stringUtf8CV, hexToCV, cvToJSON, tupleCV, principalCV, Pc } from "@stacks/transactions";
import { asciiToBytes } from "@stacks/common";
import { HiroApiService, getHiroApi, BnsName, getBnsV2Api, BnsV2ApiService } from "./hiro-api.js";
import { getContracts, parseContractId, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";
import { createStxPostCondition, createNftSendPostCondition } from "../transactions/post-conditions.js";

// ============================================================================
// Types
// ============================================================================

export interface BnsLookupResult {
  name: string;
  address: string;
  namespace: string;
  expireBlock: number;
  zonefile?: string;
}

export interface BnsNameInfo {
  name: string;
  namespace: string;
  address: string;
  expireBlock: number;
  gracePeriod: number;
  status: string;
  zonefile?: string;
  zonefileHash?: string;
  lastTxId: string;
}

export interface BnsPrice {
  units: string;
  amount: string;
  amountStx: string;
}

// ============================================================================
// BNS Service
// ============================================================================

/**
 * Check if an error is a "not found" error (404)
 */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("(404)") || error.message.includes("not found");
  }
  return false;
}

export class BnsService {
  private hiro: HiroApiService;
  private bnsV2: BnsV2ApiService;
  private contracts: ReturnType<typeof getContracts>;

  constructor(private network: Network) {
    this.hiro = getHiroApi(network);
    this.bnsV2 = getBnsV2Api();
    this.contracts = getContracts(network);
  }

  /**
   * Lookup a BNS name and get the associated address
   * Uses BNS V2 API for .btc names, falls back to Hiro API for other namespaces
   */
  async lookupName(name: string): Promise<BnsLookupResult | null> {
    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    // For .btc names, use BNS V2 API (where most names are registered)
    if (namespace === "btc" || !namespace) {
      try {
        const info = await this.bnsV2.getNameInfo(fullName);
        if (info.status === "active" && info.data.is_valid && !info.data.revoked) {
          return {
            name: fullName,
            address: info.data.owner,
            namespace: info.data.namespace_string || "btc",
            expireBlock: parseInt(info.data.renewal_height, 10),
          };
        }
        return null;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        // Name not found in BNS V2, try Hiro API as fallback (for legacy BNS V1 names)
      }
    }

    // Fallback to Hiro API for other namespaces or legacy V1 names
    try {
      const info = await this.hiro.getBnsNameInfo(fullName);
      return {
        name: fullName,
        address: info.address,
        namespace: namespace || "btc",
        expireBlock: info.expire_block,
        zonefile: info.zonefile,
      };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return null;
    }
  }

  /**
   * Reverse lookup - get BNS names for an address
   * Combines results from both BNS V2 and Hiro API (V1)
   */
  async reverseLookup(address: string): Promise<string[]> {
    const allNames: string[] = [];

    // Get names from BNS V2
    try {
      const v2Result = await this.bnsV2.getNamesOwnedByAddress(address);
      if (v2Result.names) {
        allNames.push(...v2Result.names.map(n => n.full_name));
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    // Get names from Hiro API (BNS V1)
    try {
      const v1Result = await this.hiro.getBnsNamesOwnedByAddress(address);
      if (v1Result.names) {
        for (const name of v1Result.names) {
          if (!allNames.includes(name)) {
            allNames.push(name);
          }
        }
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    return allNames;
  }

  /**
   * Get detailed info about a BNS name
   * Uses BNS V2 API for .btc names, falls back to Hiro API
   */
  async getNameInfo(name: string): Promise<BnsNameInfo | null> {
    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    // For .btc names, try BNS V2 first
    if (namespace === "btc" || !namespace) {
      try {
        const info = await this.bnsV2.getNameInfo(fullName);
        if (info.data) {
          return {
            name: fullName,
            namespace: info.data.namespace_string || "btc",
            address: info.data.owner,
            expireBlock: parseInt(info.data.renewal_height, 10),
            gracePeriod: 0,
            status: info.status,
            lastTxId: "",
          };
        }
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }

    // Fallback to Hiro API
    try {
      const info = await this.hiro.getBnsNameInfo(fullName);
      return {
        name: fullName,
        namespace: namespace || "btc",
        address: info.address,
        expireBlock: info.expire_block,
        gracePeriod: info.grace_period,
        status: info.status,
        zonefile: info.zonefile,
        zonefileHash: info.zonefile_hash,
        lastTxId: info.last_txid,
      };
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      return null;
    }
  }

  /**
   * Check if a BNS name is available for registration
   * A name is available if it's not found in either BNS V2 or V1
   */
  async checkAvailability(name: string): Promise<boolean> {
    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;

    // Check BNS V2 first (where most .btc names are registered)
    try {
      const exists = await this.bnsV2.nameExists(fullName);
      if (exists) {
        return false; // Name is taken
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    // Also check Hiro API (BNS V1) for legacy names
    try {
      const info = await this.hiro.getBnsNameInfo(fullName);
      if (info && info.address) {
        return false; // Name is taken in V1
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    return true;
  }

  /**
   * Get the price of a BNS name
   * Uses appropriate contract based on namespace (V2 for .btc, V1 for others)
   */
  async getPrice(name: string): Promise<BnsPrice> {
    const fullName = name.includes(".") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    // Get the appropriate contract for this namespace
    const { address, name: contractName } = this.getBnsContract(namespace);
    const contractId = `${address}.${contractName}`;

    const result = await this.hiro.callReadOnlyFunction(
      contractId,
      "get-name-price",
      [
        bufferCV(Buffer.from(namespace)),
        bufferCV(Buffer.from(baseName)),
      ],
      address
    );

    if (!result.okay || !result.result) {
      throw new Error(`Failed to get price for ${fullName}: ${result.cause || "unknown error"}`);
    }

    // Parse the Clarity response
    const decoded = cvToJSON(hexToCV(result.result));
    // Handle nested response structure: V2 returns (ok (ok u<price>)), V1 returns (ok u<price>)
    const priceValue = decoded?.value?.value?.value ?? decoded?.value?.value ?? decoded?.value ?? decoded;

    if (priceValue === undefined || priceValue === null) {
      throw new Error(`Failed to parse price response for ${fullName}`);
    }

    const amountMicroStx = String(priceValue);
    const amountStx = (BigInt(amountMicroStx) / BigInt(1_000_000)).toString();
    return {
      units: "ustx",
      amount: amountMicroStx,
      amountStx,
    };
  }

  /**
   * Get all domains owned by an address
   */
  async getUserDomains(address: string): Promise<string[]> {
    return this.reverseLookup(address);
  }

  /**
   * Resolve a name to an address (convenient wrapper)
   */
  async resolve(name: string): Promise<string | null> {
    const result = await this.lookupName(name);
    return result?.address || null;
  }

  /**
   * Get BNS contract based on namespace
   * - V2 for .btc namespace (active registry)
   * - V1 for other namespaces (legacy)
   */
  private getBnsContract(namespace: string): { address: string; name: string; version: 1 | 2 } {
    if (namespace === "btc") {
      // BNS V2 for .btc names
      return {
        address: "SP2QEZ06AGJ3RKJPBV14SY1V5BBFNAW33D96YPGZF",
        name: "BNS-V2",
        version: 2,
      };
    } else {
      // BNS V1 for other namespaces
      const { address, name } = parseContractId(this.contracts.BNS);
      return { address, name, version: 1 };
    }
  }

  /**
   * Create hash160 (RIPEMD160(SHA256(data))) - 20 bytes
   */
  private async hash160(data: Buffer): Promise<Buffer> {
    const crypto = await import("crypto");
    const sha256 = crypto.createHash("sha256").update(data).digest();
    const ripemd160 = crypto.createHash("ripemd160").update(sha256).digest();
    return ripemd160;
  }

  /**
   * Claim a BNS V2 name in a single transaction using name-claim-fast.
   * This is the recommended method for BNS names — no preorder/register dance needed.
   * Burns the name price in STX and mints the BNS NFT in one atomic step.
   *
   * Works for all open namespaces (BNS V2).
   */
  async claimNameFast(
    account: Account,
    name: string,
    sendTo?: string
  ): Promise<TransferResult> {
    const fullName = name.includes(".") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    const { address: contractAddress, name: contractName } = this.getBnsContract(namespace);

    // Get the price to burn (for post-condition)
    const price = await this.getPrice(fullName);
    const stxToBurn = BigInt(price.amount);

    const recipient = sendTo || account.address;

    const functionArgs: ClarityValue[] = [
      bufferCV(asciiToBytes(baseName)),
      bufferCV(asciiToBytes(namespace)),
      principalCV(recipient),
    ];

    // Post condition: sender burns STX for the name price
    const postCondition = Pc.principal(account.address).willSendEq(stxToBurn).ustx();

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-claim-fast",
      functionArgs,
      postConditions: [postCondition],
    });
  }

  /**
   * Preorder a BNS name (Step 1 of 2)
   * Creates a commitment with hashed name+salt to prevent front-running
   * Auto-detects V1/V2 based on namespace (.btc uses V2, others use V1)
   *
   * NOTE: For name registration, consider using claimNameFast() instead —
   * it registers in a single transaction without the preorder/register wait.
   */
  async preorderName(
    account: Account,
    name: string,
    salt: string
  ): Promise<TransferResult> {
    const fullName = name.includes(".") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    const { address: contractAddress, name: contractName, version } = this.getBnsContract(namespace);

    // Get the price to burn
    const price = await this.getPrice(fullName);
    if (!price) {
      throw new Error("Could not determine name price");
    }
    const stxToBurn = BigInt(price.amount);

    // Create hash160 of (fully-qualified-name + salt)
    // Salt must be 20 bytes max, pad or truncate
    const saltBuffer = Buffer.alloc(20);
    const saltBytes = Buffer.from(salt, "hex");
    saltBytes.copy(saltBuffer, 0, 0, Math.min(20, saltBytes.length));

    const fqnWithSalt = Buffer.concat([Buffer.from(fullName), saltBuffer]);
    const hashedSaltedFqn = await this.hash160(fqnWithSalt);

    const functionArgs: ClarityValue[] = [
      bufferCV(hashedSaltedFqn),
      uintCV(stxToBurn),
    ];

    // Add post condition: sender must burn exactly stxToBurn amount
    const postCondition = createStxPostCondition(
      account.address,
      "eq",
      stxToBurn
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-preorder",
      functionArgs,
      postConditions: [postCondition],
    });
  }

  /**
   * Register a BNS name (Step 2 of 2)
   * Must be called after preorder is confirmed on-chain
   * Auto-detects V1/V2 based on namespace (.btc uses V2, others use V1)
   *
   * @param zonefileHash - Required for V1, ignored for V2. 20-byte hash of zonefile content.
   */
  async registerName(
    account: Account,
    name: string,
    salt: string,
    zonefileHash?: string
  ): Promise<TransferResult> {
    const fullName = name.includes(".") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    const { address: contractAddress, name: contractName, version } = this.getBnsContract(namespace);

    // Salt must be 20 bytes, pad or truncate
    const saltBuffer = Buffer.alloc(20);
    const saltBytes = Buffer.from(salt, "hex");
    saltBytes.copy(saltBuffer, 0, 0, Math.min(20, saltBytes.length));

    let functionArgs: ClarityValue[];

    if (version === 2) {
      // V2: (namespace, name, salt)
      functionArgs = [
        bufferCV(Buffer.from(namespace)),
        bufferCV(Buffer.from(baseName)),
        bufferCV(saltBuffer),
      ];
    } else {
      // V1: (namespace, name, salt, zonefile-hash)
      const zonefileHashBuffer = Buffer.alloc(20);
      if (zonefileHash) {
        const hashBytes = Buffer.from(zonefileHash, "hex");
        hashBytes.copy(zonefileHashBuffer, 0, 0, Math.min(20, hashBytes.length));
      }
      functionArgs = [
        bufferCV(Buffer.from(namespace)),
        bufferCV(Buffer.from(baseName)),
        bufferCV(saltBuffer),
        bufferCV(zonefileHashBuffer),
      ];
    }

    // No post conditions needed for registration (doesn't move assets)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-register",
      functionArgs,
      postConditions: [],
    });
  }

  /**
   * Update a name's zonefile
   */
  async updateZonefile(
    account: Account,
    name: string,
    zonefile: string
  ): Promise<TransferResult> {
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.BNS);

    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    const functionArgs: ClarityValue[] = [
      bufferCV(Buffer.from(namespace)),
      bufferCV(Buffer.from(baseName)),
      bufferCV(Buffer.from(zonefile)),
    ];

    // No post conditions needed for zonefile updates (doesn't move assets)
    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-update",
      functionArgs,
      postConditions: [],
    });
  }

  /**
   * Transfer a BNS name to a new owner
   */
  async transferName(
    account: Account,
    name: string,
    newOwner: string,
    zonefile?: string
  ): Promise<TransferResult> {
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.BNS);

    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    const functionArgs: ClarityValue[] = [
      bufferCV(Buffer.from(namespace)),
      bufferCV(Buffer.from(baseName)),
      { type: "principal", value: newOwner } as unknown as ClarityValue,
      zonefile ? bufferCV(Buffer.from(zonefile)) : bufferCV(Buffer.alloc(0)),
    ];

    // Fetch the BNS contract interface to get the NFT name
    const bnsContractId = this.contracts.BNS;
    const contractInterface = await this.hiro.getContractInterface(bnsContractId);
    if (!contractInterface.non_fungible_tokens || contractInterface.non_fungible_tokens.length === 0) {
      throw new Error(`No NFT tokens found in BNS contract ${bnsContractId}`);
    }
    const nftName = contractInterface.non_fungible_tokens[0].name;

    // BNS NFT token ID is a tuple: {name: (buff 48), namespace: (buff 20)}
    const nftTokenId = tupleCV({
      name: bufferCV(Buffer.from(baseName)),
      namespace: bufferCV(Buffer.from(namespace)),
    });

    // Add post condition: sender must send the BNS name NFT
    const postCondition = createNftSendPostCondition(
      account.address,
      bnsContractId,
      nftName,
      nftTokenId
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-transfer",
      functionArgs,
      postConditions: [postCondition],
    });
  }

  /**
   * Renew a BNS name
   */
  async renewName(
    account: Account,
    name: string
  ): Promise<TransferResult> {
    const { address: contractAddress, name: contractName } = parseContractId(this.contracts.BNS);

    const fullName = name.endsWith(".btc") ? name : `${name}.btc`;
    const [baseName, namespace] = fullName.split(".");

    // Get the renewal price
    const price = await this.getPrice(fullName);
    if (!price) {
      throw new Error("Could not determine renewal price");
    }
    const stxToBurn = BigInt(price.amount);

    const functionArgs: ClarityValue[] = [
      bufferCV(Buffer.from(namespace)),
      bufferCV(Buffer.from(baseName)),
      uintCV(stxToBurn),
    ];

    // Add post condition: sender must burn exactly stxToBurn amount for renewal
    const postCondition = createStxPostCondition(
      account.address,
      "eq",
      stxToBurn
    );

    return callContract(account, {
      contractAddress,
      contractName,
      functionName: "name-renewal",
      functionArgs,
      postConditions: [postCondition],
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

let _bnsServiceInstance: BnsService | null = null;

export function getBnsService(network: Network): BnsService {
  if (!_bnsServiceInstance || _bnsServiceInstance["network"] !== network) {
    _bnsServiceInstance = new BnsService(network);
  }
  return _bnsServiceInstance;
}
