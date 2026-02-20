/**
 * Bitcoin transaction size constants (virtual bytes)
 *
 * Based on Bitcoin Core and @scure/btc-signer calculations.
 * Used for fee estimation across P2WPKH and P2TR transactions.
 */

/**
 * P2WPKH input size: ~68 vB (includes witness data at 1/4 weight)
 */
export const P2WPKH_INPUT_VBYTES = 68;

/**
 * P2WPKH output size: ~31 vB
 */
export const P2WPKH_OUTPUT_VBYTES = 31;

/**
 * P2TR (Taproot) output size: ~43 vB
 */
export const P2TR_OUTPUT_VBYTES = 43;

/**
 * Base transaction overhead: ~10.5 vB (version, locktime, witness marker/flag)
 */
export const TX_OVERHEAD_VBYTES = 10.5;

/**
 * Minimum output value (dust threshold)
 * Below this value, outputs are non-standard and won't be relayed
 */
export const DUST_THRESHOLD = 546;

/**
 * Taproot input base size (vbytes) - without witness data
 */
export const P2TR_INPUT_BASE_VBYTES = 57.5;
