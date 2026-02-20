/**
 * Fee utility for resolving fee presets to micro-STX values.
 *
 * Supports both numeric strings (e.g., "100000") and preset strings
 * ("low", "medium", "high") that are resolved by fetching current
 * fee estimates from the Stacks mempool.
 */

import { getHiroApi, type MempoolFeePriorities } from "../services/hiro-api.js";
import type { Network } from "../config/networks.js";

/**
 * Fee floor and ceiling clamps by transaction type (in micro-STX).
 * Prevents absurd fees during mempool spikes while allowing reasonable variation.
 */
const FEE_CLAMPS = {
  token_transfer: { floor: 180n, ceiling: 3000n },
  contract_call: { floor: 3000n, ceiling: 100000n },
  smart_contract: { floor: 10000n, ceiling: 100000n },
  all: { floor: 180n, ceiling: 100000n }, // Widest range for aggregate fees
} as const;

/**
 * Valid fee preset strings.
 * These map to the mempool fee priorities:
 * - "low" -> low_priority
 * - "medium" -> medium_priority
 * - "high" -> high_priority
 */
export type FeePreset = "low" | "medium" | "high";

/**
 * Check if a string is a valid fee preset.
 */
export function isFeePreset(value: string): value is FeePreset {
  return ["low", "medium", "high"].includes(value.toLowerCase());
}

/**
 * Map fee preset to mempool priority key.
 */
function presetToPriorityKey(preset: FeePreset): keyof MempoolFeePriorities {
  const normalized = preset.toLowerCase() as FeePreset;
  const mapping: Record<FeePreset, keyof MempoolFeePriorities> = {
    low: "low_priority",
    medium: "medium_priority",
    high: "high_priority",
  };
  return mapping[normalized];
}

/**
 * Clamp a fee value between floor and ceiling.
 */
function clampFee(value: bigint, floor: bigint, ceiling: bigint): bigint {
  if (value < floor) return floor;
  if (value > ceiling) return ceiling;
  return value;
}

/**
 * Resolve a fee string to a bigint value in micro-STX.
 *
 * @param fee - Either a numeric string (micro-STX) or preset ("low" | "medium" | "high")
 * @param network - The network to fetch fee estimates from
 * @param txType - The transaction type for more accurate fee estimates.
 *                 Defaults to "all" which uses aggregate fees.
 * @returns The fee in micro-STX as bigint, or undefined if fee is undefined
 *
 * @example
 * // Numeric string - returns as-is
 * await resolveFee("100000", "mainnet") // -> 100000n
 *
 * // Preset string - fetches from mempool
 * await resolveFee("high", "mainnet") // -> fetches high_priority fee
 *
 * // Undefined - returns undefined (auto-estimate)
 * await resolveFee(undefined, "mainnet") // -> undefined
 */
export async function resolveFee(
  fee: string | undefined,
  network: Network,
  txType: "all" | "token_transfer" | "contract_call" | "smart_contract" = "all"
): Promise<bigint | undefined> {
  if (!fee) {
    return undefined;
  }

  if (isFeePreset(fee)) {
    const hiroApi = getHiroApi(network);

    try {
      const mempoolFees = await hiroApi.getMempoolFees();
      const feeTier = mempoolFees[txType];
      const priorityKey = presetToPriorityKey(fee);
      const rawFee = BigInt(Math.ceil(feeTier[priorityKey]));
      const clamps = FEE_CLAMPS[txType];
      return clampFee(rawFee, clamps.floor, clamps.ceiling);
    } catch (error) {
      console.error(
        `Failed to fetch mempool fees (using fallback): ${error instanceof Error ? error.message : String(error)}`
      );

      const clamps = FEE_CLAMPS[txType];
      const multipliers: Record<FeePreset, bigint> = { low: 1n, medium: 2n, high: 3n };
      const fallbackFee = clamps.floor * multipliers[fee.toLowerCase() as FeePreset];

      console.info(
        `Using fallback fee: ${fallbackFee} uSTX (${fee} preset, ${txType} type)`
      );

      return fallbackFee;
    }
  }

  const normalizedFee = fee.trim();
  if (!/^\d+$/.test(normalizedFee)) {
    throw new Error(
      `Invalid fee value "${fee}" – expected a non-negative integer string in micro-STX or preset ("low", "medium", "high").`
    );
  }
  return BigInt(normalizedFee);
}
