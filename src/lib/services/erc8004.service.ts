/**
 * ERC-8004 Service
 *
 * Service for interacting with ERC-8004 identity, reputation, and validation contracts.
 * Deployed on mainnet and testnet with identical interfaces.
 */

import {
  ClarityValue,
  uintCV,
  intCV,
  stringUtf8CV,
  bufferCV,
  principalCV,
  listCV,
  tupleCV,
  cvToJSON,
  hexToCV,
} from "@stacks/transactions";
import { HiroApiService, getHiroApi } from "./hiro-api.js";
import { getErc8004Contracts, parseContractId, type Network } from "../config/index.js";
import { callContract, type Account, type TransferResult } from "../transactions/builder.js";
import { sponsoredContractCall } from "../transactions/sponsor-builder.js";

// ============================================================================
// Types
// ============================================================================

export interface IdentityInfo {
  agentId: number;
  owner: string;
  uri: string;
  wallet?: string;
}

export interface ReputationSummary {
  agentId: number;
  totalFeedback: number;
  summaryValue: string;
  summaryValueDecimals: number;
}

export interface FeedbackEntry {
  client: string;
  value: number;
  valueDecimals: number;
  wadValue: string;
  tag1: string;
  tag2: string;
  timestamp: number;
}

export interface ValidationStatus {
  validator: string;
  agentId: number;
  response: number;
  responseHash: string;
  tag: string;
  lastUpdate: number;
  hasResponse: boolean;
}

export interface ValidationSummary {
  count: number;
  avgResponse: number;
}

// ============================================================================
// ERC8004 Service
// ============================================================================

export class Erc8004Service {
  private hiro: HiroApiService;
  private contracts: ReturnType<typeof getErc8004Contracts>;

  constructor(private network: Network) {
    this.hiro = getHiroApi(network);
    this.contracts = getErc8004Contracts(network);
  }

  // ==========================================================================
  // Identity Registry
  // ==========================================================================

  /**
   * Register a new agent identity
   */
  async registerIdentity(
    account: Account,
    uri?: string,
    metadata?: Array<{ key: string; value: Buffer }>,
    fee?: bigint,
    sponsored?: boolean
  ): Promise<TransferResult> {
    const { address, name } = parseContractId(this.contracts.identityRegistry);

    let functionName: string;
    let functionArgs: ClarityValue[];

    if (metadata && metadata.length > 0) {
      // Use register-full with metadata
      functionName = "register-full";
      functionArgs = [
        stringUtf8CV(uri || ""),
        listCV(
          metadata.map((m) =>
            tupleCV({
              key: stringUtf8CV(m.key),
              value: bufferCV(m.value),
            })
          )
        ),
      ];
    } else if (uri) {
      // Use register-with-uri
      functionName = "register-with-uri";
      functionArgs = [stringUtf8CV(uri)];
    } else {
      // Use basic register
      functionName = "register";
      functionArgs = [];
    }

    const contractCallOptions = {
      contractAddress: address,
      contractName: name,
      functionName,
      functionArgs,
      fee,
    };

    if (sponsored) {
      return sponsoredContractCall(account, contractCallOptions, this.network);
    }

    return callContract(account, contractCallOptions);
  }

  /**
   * Get agent identity information
   */
  async getIdentity(agentId: number, callerAddress: string): Promise<IdentityInfo | null> {
    // Get owner
    const ownerResult = await this.hiro.callReadOnlyFunction(
      this.contracts.identityRegistry,
      "get-owner",
      [uintCV(agentId)],
      callerAddress
    );

    if (!ownerResult.okay || !ownerResult.result) {
      throw new Error(
        `Failed to read identity for agent ${agentId}: ${(ownerResult as any).cause || "read-only call failed"}`
      );
    }

    const ownerData = cvToJSON(hexToCV(ownerResult.result));
    if (!ownerData.success || ownerData.value.value === null) {
      return null; // Contract returned (none) — agent not found
    }

    const owner = ownerData.value.value.value;

    // Get URI
    const uriResult = await this.hiro.callReadOnlyFunction(
      this.contracts.identityRegistry,
      "get-uri",
      [uintCV(agentId)],
      callerAddress
    );

    let uri = "";
    if (uriResult.okay && uriResult.result) {
      const uriData = cvToJSON(hexToCV(uriResult.result));
      if (uriData.success && uriData.value.value !== null) {
        uri = uriData.value.value.value;
      }
    }

    // Get agent wallet
    const walletResult = await this.hiro.callReadOnlyFunction(
      this.contracts.identityRegistry,
      "get-agent-wallet",
      [uintCV(agentId)],
      callerAddress
    );

    let wallet: string | undefined;
    if (walletResult.okay && walletResult.result) {
      const walletData = cvToJSON(hexToCV(walletResult.result));
      if (walletData.success && walletData.value.value !== null) {
        wallet = walletData.value.value.value;
      }
    }

    return {
      agentId,
      owner,
      uri,
      wallet,
    };
  }

  /**
   * Update identity URI
   */
  async updateIdentityUri(
    account: Account,
    agentId: number,
    newUri: string,
    fee?: bigint,
    sponsored?: boolean
  ): Promise<TransferResult> {
    const { address, name } = parseContractId(this.contracts.identityRegistry);

    const contractCallOptions = {
      contractAddress: address,
      contractName: name,
      functionName: "set-agent-uri",
      functionArgs: [uintCV(agentId), stringUtf8CV(newUri)],
      fee,
    };

    if (sponsored) {
      return sponsoredContractCall(account, contractCallOptions, this.network);
    }

    return callContract(account, contractCallOptions);
  }

  // ==========================================================================
  // Reputation Registry
  // ==========================================================================

  /**
   * Give feedback for an agent
   */
  async giveFeedback(
    account: Account,
    agentId: number,
    value: number,
    valueDecimals: number,
    tag1?: string,
    tag2?: string,
    endpoint?: string,
    feedbackUri?: string,
    feedbackHash?: Buffer,
    fee?: bigint,
    sponsored?: boolean
  ): Promise<TransferResult> {
    const { address, name } = parseContractId(this.contracts.reputationRegistry);

    const functionArgs = [
      uintCV(agentId),
      intCV(value),
      uintCV(valueDecimals),
      stringUtf8CV(tag1 || ""),
      stringUtf8CV(tag2 || ""),
      stringUtf8CV(endpoint || ""),
      stringUtf8CV(feedbackUri || ""),
      bufferCV(feedbackHash || Buffer.alloc(32)),
    ];

    const contractCallOptions = {
      contractAddress: address,
      contractName: name,
      functionName: "give-feedback",
      functionArgs,
      fee,
    };

    if (sponsored) {
      return sponsoredContractCall(account, contractCallOptions, this.network);
    }

    return callContract(account, contractCallOptions);
  }

  /**
   * Get aggregated reputation for an agent
   */
  async getReputation(agentId: number, callerAddress: string): Promise<ReputationSummary> {
    const result = await this.hiro.callReadOnlyFunction(
      this.contracts.reputationRegistry,
      "get-summary",
      [uintCV(agentId)],
      callerAddress
    );

    if (!result.okay || !result.result) {
      throw new Error(
        `Failed to read reputation for agent ${agentId}: ${result.cause || "unknown error"}`
      );
    }

    const data = cvToJSON(hexToCV(result.result));
    if (!data.success) {
      throw new Error(
        `Failed to parse reputation response for agent ${agentId}`
      );
    }

    const rep = data.value.value;
    return {
      agentId,
      totalFeedback: parseInt(rep.count.value, 10),
      summaryValue: rep["summary-value"].value,
      summaryValueDecimals: parseInt(rep["summary-value-decimals"].value, 10),
    };
  }

  /**
   * Get total feedback count for an agent
   */
  async getFeedbackCount(agentId: number, callerAddress: string): Promise<number> {
    const result = await this.hiro.callReadOnlyFunction(
      this.contracts.reputationRegistry,
      "get-agent-feedback-count",
      [uintCV(agentId)],
      callerAddress
    );

    if (!result.okay || !result.result) {
      return 0;
    }

    const data = cvToJSON(hexToCV(result.result));
    if (!data.success) {
      return 0;
    }

    return parseInt(data.value.value, 10);
  }

  /**
   * Get specific feedback entry by index
   */
  async getFeedback(
    agentId: number,
    index: number,
    callerAddress: string
  ): Promise<FeedbackEntry | null> {
    const result = await this.hiro.callReadOnlyFunction(
      this.contracts.reputationRegistry,
      "get-feedback-at-index",
      [uintCV(agentId), uintCV(index)],
      callerAddress
    );

    if (!result.okay || !result.result) {
      return null;
    }

    const data = cvToJSON(hexToCV(result.result));
    if (!data.success || data.value.value === null) {
      return null;
    }

    const fb = data.value.value.value;
    return {
      client: fb.client.value,
      value: parseInt(fb.value.value, 10),
      valueDecimals: parseInt(fb["value-decimals"].value, 10),
      wadValue: fb["wad-value"].value,
      tag1: fb.tag1.value,
      tag2: fb.tag2.value,
      timestamp: parseInt(fb.timestamp.value, 10),
    };
  }

  // ==========================================================================
  // Validation Registry
  // ==========================================================================

  /**
   * Request validation from a validator
   */
  async requestValidation(
    account: Account,
    validator: string,
    agentId: number,
    requestUri: string,
    requestHash: Buffer,
    fee?: bigint,
    sponsored?: boolean
  ): Promise<TransferResult> {
    const { address, name } = parseContractId(this.contracts.validationRegistry);

    const functionArgs = [
      principalCV(validator),
      uintCV(agentId),
      stringUtf8CV(requestUri),
      bufferCV(requestHash),
    ];

    const contractCallOptions = {
      contractAddress: address,
      contractName: name,
      functionName: "validation-request",
      functionArgs,
      fee,
    };

    if (sponsored) {
      return sponsoredContractCall(account, contractCallOptions, this.network);
    }

    return callContract(account, contractCallOptions);
  }

  /**
   * Get validation status for a request
   */
  async getValidationStatus(
    requestHash: Buffer,
    callerAddress: string
  ): Promise<ValidationStatus | null> {
    const result = await this.hiro.callReadOnlyFunction(
      this.contracts.validationRegistry,
      "get-validation-status",
      [bufferCV(requestHash)],
      callerAddress
    );

    if (!result.okay || !result.result) {
      return null;
    }

    const data = cvToJSON(hexToCV(result.result));
    if (!data.success || data.value.value === null) {
      return null;
    }

    const vs = data.value.value.value;
    return {
      validator: vs.validator.value,
      agentId: parseInt(vs["agent-id"].value, 10),
      response: parseInt(vs.response.value, 10),
      responseHash: vs["response-hash"].value,
      tag: vs.tag.value,
      lastUpdate: parseInt(vs["last-update"].value, 10),
      hasResponse: vs["has-response"].value,
    };
  }

  /**
   * Get validation summary for an agent
   */
  async getValidationSummary(
    agentId: number,
    callerAddress: string
  ): Promise<ValidationSummary> {
    const result = await this.hiro.callReadOnlyFunction(
      this.contracts.validationRegistry,
      "get-summary",
      [uintCV(agentId)],
      callerAddress
    );

    if (!result.okay || !result.result) {
      throw new Error(
        `Failed to read validation summary for agent ${agentId}: ${(result as any).cause || "read-only call failed"}`
      );
    }

    const data = cvToJSON(hexToCV(result.result));
    if (!data.success) {
      throw new Error(
        `Failed to parse validation summary for agent ${agentId}`
      );
    }

    const summary = data.value.value;
    return {
      count: parseInt(summary.count.value, 10),
      avgResponse: parseInt(summary["avg-response"].value, 10),
    };
  }
}
