import { Network } from "./networks.js";

/**
 * Known contract addresses for mainnet
 */
export const MAINNET_CONTRACTS = {
  // sBTC
  SBTC_TOKEN: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  SBTC_DEPOSIT: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit",
  SBTC_REGISTRY: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",

  // Stablecoins
  USDCX: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",

  // BNS
  BNS: "SP000000000000000000002Q6VF78.bns",

  // Stacking
  POX_4: "SP000000000000000000002Q6VF78.pox-4",

  // ALEX DEX (SDK handles most operations, but we need pool contract for queries)
  ALEX_AMM_POOL: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.amm-swap-pool-v1-1",
  ALEX_TOKEN: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex",
  ALEX_WSTX: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wstx-v2",

  // Zest Protocol
  ZEST_POOL_BORROW: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3",
  ZEST_BORROW_HELPER: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-5",
  ZEST_POOL_RESERVE: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-0-reserve-v2-0",
  ZEST_FEES_CALCULATOR: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.fees-calculator",
  ZEST_INCENTIVES: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.incentives-v2-2",
  ZEST_WSTX: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx",

  // ERC-8004 Identity & Reputation
  IDENTITY_REGISTRY: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2",
  REPUTATION_REGISTRY: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.reputation-registry-v2",
  VALIDATION_REGISTRY: "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.validation-registry-v2",
} as const;

/**
 * Zest Protocol asset configuration
 * Each asset has: token, lpToken, oracle, decimals, symbol
 */
export interface ZestAssetConfig {
  token: string;
  lpToken: string;
  oracle: string;
  decimals: number;
  symbol: string;
  name: string;
}

export const ZEST_ASSETS: Record<string, ZestAssetConfig> = {
  sBTC: {
    token: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.stx-btc-oracle-v1-4",
    decimals: 8,
    symbol: "sBTC",
    name: "sBTC",
  },
  aeUSDC: {
    token: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zaeusdc-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.aeusdc-oracle-v1-0",
    decimals: 6,
    symbol: "aeUSDC",
    name: "Aave USDC",
  },
  USDH: {
    token: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zusdh-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.usdh-oracle-v1-0",
    decimals: 8,
    symbol: "USDH",
    name: "USDH Stablecoin",
  },
  stSTX: {
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zststx-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.stx-btc-oracle-v1-4",
    decimals: 6,
    symbol: "stSTX",
    name: "Stacked STX",
  },
  wSTX: {
    token: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zwstx-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.stx-btc-oracle-v1-4",
    decimals: 6,
    symbol: "wSTX",
    name: "Wrapped STX",
  },
  sUSDT: {
    token: "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsusdt-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.susdt-oracle-v1-0",
    decimals: 6,
    symbol: "sUSDT",
    name: "Stacks USDT",
  },
  USDA: {
    token: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.usda-token",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zusda-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.usda-oracle-v1-1",
    decimals: 6,
    symbol: "USDA",
    name: "USDA Stablecoin",
  },
  DIKO: {
    token: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.arkadiko-token",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zdiko-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.diko-oracle-v1-1",
    decimals: 6,
    symbol: "DIKO",
    name: "Arkadiko Token",
  },
  ALEX: {
    token: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zalex-v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.alex-oracle-v1-1",
    decimals: 8,
    symbol: "ALEX",
    name: "ALEX Token",
  },
  "stSTX-BTC": {
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    lpToken: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zststxbtc-v2_v2-0",
    oracle: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.stx-btc-oracle-v1-4",
    decimals: 6,
    symbol: "stSTX-BTC",
    name: "Stacked STX BTC",
  },
};

/**
 * Ordered list of Zest assets for building the assets-list parameter
 * Order matters for contract calls
 */
export const ZEST_ASSETS_LIST: ZestAssetConfig[] = [
  ZEST_ASSETS.stSTX,
  ZEST_ASSETS.aeUSDC,
  ZEST_ASSETS.wSTX,
  ZEST_ASSETS.DIKO,
  ZEST_ASSETS.USDH,
  ZEST_ASSETS.sUSDT,
  ZEST_ASSETS.USDA,
  ZEST_ASSETS.sBTC,
  ZEST_ASSETS.ALEX,
  ZEST_ASSETS["stSTX-BTC"],
];

/**
 * Known contract addresses for testnet
 */
export const TESTNET_CONTRACTS = {
  // sBTC (testnet)
  SBTC_TOKEN: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token",
  SBTC_DEPOSIT: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-deposit",
  SBTC_REGISTRY: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-registry",

  // Stablecoins
  USDCX: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx",

  // BNS
  BNS: "ST000000000000000000002AMW42H.bns",

  // Stacking
  POX_4: "ST000000000000000000002AMW42H.pox-4",

  // ERC-8004 Identity & Reputation
  IDENTITY_REGISTRY: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.identity-registry-v2",
  REPUTATION_REGISTRY: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.reputation-registry-v2",
  VALIDATION_REGISTRY: "ST3YT0XW92E6T2FE59B2G5N2WNNFSBZ6MZKQS5D18.validation-registry-v2",
} as const;

/**
 * Get contract addresses for the specified network
 */
export function getContracts(network: Network) {
  return network === "mainnet" ? MAINNET_CONTRACTS : TESTNET_CONTRACTS;
}

/**
 * Parse a contract identifier into address and name
 */
export function parseContractId(contractId: string): { address: string; name: string } {
  const [address, name] = contractId.split(".");
  if (!address || !name) {
    throw new Error(`Invalid contract ID: ${contractId}`);
  }
  return { address, name };
}

/**
 * Fallback token contract IDs (used only when dynamic resolution fails)
 * Prefer using resolveTokenSymbol() which checks user balances first
 */
export const WELL_KNOWN_TOKENS = {
  mainnet: {
    STX: "native",
    sBTC: MAINNET_CONTRACTS.SBTC_TOKEN,
    USDCx: MAINNET_CONTRACTS.USDCX,
    ALEX: MAINNET_CONTRACTS.ALEX_TOKEN,
    wSTX: MAINNET_CONTRACTS.ALEX_WSTX,
  },
  testnet: {
    STX: "native",
    sBTC: TESTNET_CONTRACTS.SBTC_TOKEN,
    USDCx: TESTNET_CONTRACTS.USDCX,
  },
} as const;

/**
 * Get ALEX DEX contract addresses for the network
 * Note: Most ALEX operations use the alex-sdk, but we need the pool contract for queries
 */
export function getAlexContracts(network: Network) {
  if (network === "mainnet") {
    return {
      ammPool: MAINNET_CONTRACTS.ALEX_AMM_POOL,
    };
  }
  // ALEX is mainnet-only currently
  return null;
}

/**
 * Get Zest Protocol contract addresses for the network
 */
export function getZestContracts(network: Network) {
  if (network === "mainnet") {
    return {
      poolBorrow: MAINNET_CONTRACTS.ZEST_POOL_BORROW,
      borrowHelper: MAINNET_CONTRACTS.ZEST_BORROW_HELPER,
      poolReserve: MAINNET_CONTRACTS.ZEST_POOL_RESERVE,
      feesCalculator: MAINNET_CONTRACTS.ZEST_FEES_CALCULATOR,
      incentives: MAINNET_CONTRACTS.ZEST_INCENTIVES,
      wstx: MAINNET_CONTRACTS.ZEST_WSTX,
    };
  }
  // Zest is mainnet-only currently
  return null;
}

export function getWellKnownTokens(network: Network) {
  return WELL_KNOWN_TOKENS[network];
}

/**
 * Bitflow DEX contract addresses
 */
export const BITFLOW_CONTRACTS = {
  mainnet: {
    // Primary StableSwap and Earn contracts
    PRIMARY: "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3M",
    // XYK pool contracts
    XYK: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  },
  testnet: {
    PRIMARY: "STRP7MYBHSMFH5EGN3HGX6KNQ7QBHVTBPF1669DW",
    XYK: null,
  },
} as const;

/**
 * Bitflow configuration
 */
export interface BitflowConfig {
  apiHost: string;
  apiKey: string | undefined;
  readOnlyCallApiHost: string;
  keeperApiHost?: string;
  keeperApiKey?: string;
}

/**
 * Get Bitflow configuration from environment.
 *
 * As of @bitflowlabs/core-sdk v2.4.2, all API keys are optional.
 * The SDK works out of the box with public rate limits (500 req/min per IP).
 *
 * Optional env vars for higher rate limits:
 *   - BITFLOW_API_KEY: Core API (tokens, quotes, routes)
 *   - BITFLOW_API_HOST: Override API host
 *   - BITFLOW_KEEPER_API_KEY: Keeper automation features
 *   - BITFLOW_KEEPER_API_HOST: Override Keeper API host
 *   - BITFLOW_READONLY_API_HOST: Override Stacks read-only node
 *
 * Request higher limits: help@bitflow.finance
 */
export function getBitflowConfig(): BitflowConfig {
  const readOnlyCallApiHost = process.env.BITFLOW_READONLY_API_HOST || "https://api.hiro.so";

  return {
    apiHost: process.env.BITFLOW_API_HOST || "https://bitflowsdk-api-test-7owjsmt8.uk.gateway.dev",
    apiKey: process.env.BITFLOW_API_KEY,
    readOnlyCallApiHost,
    keeperApiHost: process.env.BITFLOW_KEEPER_API_HOST || "https://bitflow-keeper-test-7owjsmt8.uc.gateway.dev",
    keeperApiKey: process.env.BITFLOW_KEEPER_API_KEY,
  };
}

/**
 * Get Bitflow contract addresses for the network
 */
export function getBitflowContracts(network: Network) {
  return BITFLOW_CONTRACTS[network];
}

/**
 * Bitflow public API base URL (no API key required)
 */
export const BITFLOW_PUBLIC_API = "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev";

/**
 * Get ERC-8004 contract addresses for the network
 */
export function getErc8004Contracts(network: Network) {
  const contracts = network === "mainnet" ? MAINNET_CONTRACTS : TESTNET_CONTRACTS;
  return {
    identityRegistry: contracts.IDENTITY_REGISTRY,
    reputationRegistry: contracts.REPUTATION_REGISTRY,
    validationRegistry: contracts.VALIDATION_REGISTRY,
  };
}
