import {
  PostCondition,
  PostConditionMode,
  Pc,
  uintCV,
  ClarityValue,
} from "@stacks/transactions";

export { PostConditionMode };

type ContractId = `${string}.${string}`;

function asContractId(contractId: string): ContractId {
  if (!contractId.includes(".")) {
    throw new Error(`Invalid contract ID: ${contractId}`);
  }
  return contractId as ContractId;
}

/**
 * Create an STX post condition for a standard principal
 */
export function createStxPostCondition(
  address: string,
  conditionCode: "eq" | "gt" | "gte" | "lt" | "lte",
  amount: bigint
): PostCondition {
  switch (conditionCode) {
    case "eq":
      return Pc.principal(address).willSendEq(amount).ustx();
    case "gt":
      return Pc.principal(address).willSendGt(amount).ustx();
    case "gte":
      return Pc.principal(address).willSendGte(amount).ustx();
    case "lt":
      return Pc.principal(address).willSendLt(amount).ustx();
    case "lte":
      return Pc.principal(address).willSendLte(amount).ustx();
    default:
      return Pc.principal(address).willSendEq(amount).ustx();
  }
}

/**
 * Create an STX post condition for a contract principal
 */
export function createContractStxPostCondition(
  contractId: string,
  conditionCode: "eq" | "gt" | "gte" | "lt" | "lte",
  amount: bigint
): PostCondition {
  switch (conditionCode) {
    case "eq":
      return Pc.principal(contractId).willSendEq(amount).ustx();
    case "gt":
      return Pc.principal(contractId).willSendGt(amount).ustx();
    case "gte":
      return Pc.principal(contractId).willSendGte(amount).ustx();
    case "lt":
      return Pc.principal(contractId).willSendLt(amount).ustx();
    case "lte":
      return Pc.principal(contractId).willSendLte(amount).ustx();
    default:
      return Pc.principal(contractId).willSendEq(amount).ustx();
  }
}

/**
 * Create a fungible token post condition for a standard principal
 */
export function createFungiblePostCondition(
  address: string,
  tokenContract: string,
  tokenName: string,
  conditionCode: "eq" | "gt" | "gte" | "lt" | "lte",
  amount: bigint
): PostCondition {
  const contract = asContractId(tokenContract);

  switch (conditionCode) {
    case "eq":
      return Pc.principal(address).willSendEq(amount).ft(contract, tokenName);
    case "gt":
      return Pc.principal(address).willSendGt(amount).ft(contract, tokenName);
    case "gte":
      return Pc.principal(address).willSendGte(amount).ft(contract, tokenName);
    case "lt":
      return Pc.principal(address).willSendLt(amount).ft(contract, tokenName);
    case "lte":
      return Pc.principal(address).willSendLte(amount).ft(contract, tokenName);
    default:
      return Pc.principal(address).willSendEq(amount).ft(contract, tokenName);
  }
}

/**
 * Create a fungible token post condition for a contract principal
 */
export function createContractFungiblePostCondition(
  senderContract: string,
  tokenContract: string,
  tokenName: string,
  conditionCode: "eq" | "gt" | "gte" | "lt" | "lte",
  amount: bigint
): PostCondition {
  const contract = asContractId(tokenContract);

  switch (conditionCode) {
    case "eq":
      return Pc.principal(senderContract).willSendEq(amount).ft(contract, tokenName);
    case "gt":
      return Pc.principal(senderContract).willSendGt(amount).ft(contract, tokenName);
    case "gte":
      return Pc.principal(senderContract).willSendGte(amount).ft(contract, tokenName);
    case "lt":
      return Pc.principal(senderContract).willSendLt(amount).ft(contract, tokenName);
    case "lte":
      return Pc.principal(senderContract).willSendLte(amount).ft(contract, tokenName);
    default:
      return Pc.principal(senderContract).willSendEq(amount).ft(contract, tokenName);
  }
}

/**
 * Create a non-fungible token post condition for sending an NFT
 * tokenId can be a number/bigint (wrapped in uintCV) or a ClarityValue for complex types (e.g. tuples)
 */
export function createNftSendPostCondition(
  address: string,
  nftContract: string,
  nftName: string,
  tokenId: bigint | number | ClarityValue
): PostCondition {
  const contract = asContractId(nftContract);
  const assetId = typeof tokenId === "object" ? tokenId : uintCV(tokenId);
  return Pc.principal(address).willSendAsset().nft(contract, nftName, assetId);
}

/**
 * Create a non-fungible token post condition for not sending an NFT
 * tokenId can be a number/bigint (wrapped in uintCV) or a ClarityValue for complex types (e.g. tuples)
 */
export function createNftNotSendPostCondition(
  address: string,
  nftContract: string,
  nftName: string,
  tokenId: bigint | number | ClarityValue
): PostCondition {
  const contract = asContractId(nftContract);
  const assetId = typeof tokenId === "object" ? tokenId : uintCV(tokenId);
  return Pc.principal(address).willNotSendAsset().nft(contract, nftName, assetId);
}
