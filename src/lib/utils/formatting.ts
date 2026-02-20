/**
 * Format STX amount from micro-STX to STX
 */
export function formatStx(microStx: string | bigint): string {
  const value = BigInt(microStx);
  const stx = value / BigInt(1_000_000);
  const remainder = value % BigInt(1_000_000);

  if (remainder === BigInt(0)) {
    return `${stx} STX`;
  }

  const decimal = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${stx}.${decimal} STX`;
}

/**
 * Format sBTC amount from sats to BTC
 */
export function formatSbtc(sats: string | bigint): string {
  const value = BigInt(sats);
  const btc = value / BigInt(100_000_000);
  const remainder = value % BigInt(100_000_000);

  if (remainder === BigInt(0)) {
    return `${btc} sBTC`;
  }

  const decimal = remainder.toString().padStart(8, "0").replace(/0+$/, "");
  return `${btc}.${decimal} sBTC`;
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(
  amount: string | bigint,
  decimals: number,
  symbol?: string
): string {
  const value = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const remainder = value % divisor;

  let result: string;
  if (remainder === BigInt(0)) {
    result = whole.toString();
  } else {
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    result = `${whole}.${decimal}`;
  }

  return symbol ? `${result} ${symbol}` : result;
}

/**
 * Parse STX amount string to micro-STX
 */
export function parseStxAmount(amount: string): bigint {
  // Remove STX suffix if present
  const cleaned = amount.replace(/\s*STX$/i, "").trim();

  if (cleaned.includes(".")) {
    const [whole, decimal] = cleaned.split(".");
    const paddedDecimal = (decimal || "").padEnd(6, "0").slice(0, 6);
    return BigInt(whole || "0") * BigInt(1_000_000) + BigInt(paddedDecimal);
  }

  return BigInt(cleaned) * BigInt(1_000_000);
}

/**
 * Format address for display (truncated)
 */
export function formatAddress(address: string, chars: number = 8): string {
  if (address.length <= chars * 2 + 3) {
    return address;
  }
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Format transaction ID for display
 */
export function formatTxId(txid: string, chars: number = 8): string {
  return formatAddress(txid, chars);
}

/**
 * Format date from timestamp
 */
export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Format block height
 */
export function formatBlockHeight(height: number): string {
  return height.toLocaleString();
}
