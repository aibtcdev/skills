/**
 * Shared logic for the stackspot and stacking-lottery skills.
 *
 * Both skills wrap the same on-chain stackspot.app contracts.  Any change to
 * the pot list, deployer addresses, or read-only call logic only needs to be
 * made here — the individual CLI entry-points are thin wrappers that import
 * from this module.
 */

import { NETWORK } from "../config/networks.js";
import { getHiroApi } from "../services/hiro-api.js";
import { type ClarityValue, deserializeCV, cvToJSON } from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const POT_DEPLOYER = "SPT4SQP5RC1BFAJEQKBHZMXQ8NQ7G118F335BD85";
export const PLATFORM_ADDRESS = "SP7FSE31MWSJJFTQBEQ1TT6TF3G4J6GDKE81SWD9";
export const PLATFORM_CONTRACT = "stackspots";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PotInfo {
  name: string;
  contractName: string;
  maxParticipants: number;
  minAmountStx: number;
  deployer: string;
}

// ---------------------------------------------------------------------------
// Known pots
// ---------------------------------------------------------------------------

export const KNOWN_POTS: PotInfo[] = [
  {
    name: "Genesis",
    contractName: "Genesis",
    maxParticipants: 2,
    minAmountStx: 20,
    deployer: POT_DEPLOYER,
  },
  {
    name: "BuildOnBitcoin",
    contractName: "BuildOnBitcoin",
    maxParticipants: 10,
    minAmountStx: 100,
    deployer: POT_DEPLOYER,
  },
  {
    name: "STXLFG",
    contractName: "STXLFG",
    maxParticipants: 100,
    minAmountStx: 21,
    deployer: POT_DEPLOYER,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a contract name that may be fully qualified (deployer.name) or bare (name).
 * Returns { deployer, contractName }.
 */
export function parseContractName(input: string): {
  deployer: string;
  contractName: string;
} {
  if (input.includes(".")) {
    const [deployer, ...rest] = input.split(".");
    return { deployer, contractName: rest.join(".") };
  }
  return { deployer: POT_DEPLOYER, contractName: input };
}

/**
 * Call a read-only function on a pot contract.
 * Accepts either a bare contract name or fully qualified deployer.name.
 * Returns the deserialized Clarity value as a JSON-friendly object.
 */
export async function callPotReadOnly(
  contractNameOrId: string,
  functionName: string,
  args: ClarityValue[]
): Promise<unknown> {
  const hiro = getHiroApi(NETWORK);
  const { deployer, contractName } = parseContractName(contractNameOrId);
  const contractId = `${deployer}.${contractName}`;
  const result = await hiro.callReadOnlyFunction(
    contractId,
    functionName,
    args,
    deployer
  );
  if (!result.okay) {
    throw new Error(
      `Read-only call ${functionName} failed: ${result.cause ?? "unknown error"}`
    );
  }
  if (!result.result) {
    return null;
  }
  const hex = result.result.startsWith("0x")
    ? result.result.slice(2)
    : result.result;
  const cv = deserializeCV(Buffer.from(hex, "hex"));
  return cvToJSON(cv);
}
