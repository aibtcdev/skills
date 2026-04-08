#!/usr/bin/env bun

import { Command } from "commander";
import { principalCV, serializeCV, deserializeCV, cvToJSON } from "@stacks/transactions";

// ─── Configuration ───────────────────────────────────────────────────────────

const SKILL_NAME = "defi-portfolio-scanner";
const REQUEST_TIMEOUT = 10_000; // 10 seconds per protocol
const HIRO_TIMEOUT = 15_000;

const ENDPOINTS = {
  bitflowPools: "https://bff.bitflowapis.finance/api/app/v1/pools",
  zestContract: {
    address: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N",
    name: "pool-borrow-v2-3",
    function: "get-user-reserve-data",
  },
  // STX asset contract for Zest get-user-reserve-data second arg
  zestStxAsset: "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx",
  alexBalances: (addr: string) =>
    `https://api.alexlab.co/v1/pool_tokens/balances/${addr}`,
  styxApi: "https://app.styxfinance.com/api",
  hiroBalances: (addr: string) =>
    `https://api.hiro.so/extended/v1/address/${addr}/balances`,
  hiroCallRead: (contractAddr: string, contractName: string, fn: string) =>
    `https://api.hiro.so/v2/contracts/call-read/${contractAddr}/${contractName}/${fn}`,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface SuccessEnvelope<T> {
  success: true;
  skill: string;
  command: string;
  data: T;
  timestamp: string;
}

interface ErrorEnvelope {
  success: false;
  skill: string;
  command: string;
  error: string;
  details: Record<string, unknown>;
  timestamp: string;
}

type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

interface EndpointHealth {
  name: string;
  url: string;
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  error?: string;
}

interface DoctorResult {
  overall: "ok" | "degraded" | "down";
  endpoints: EndpointHealth[];
}

interface TokenBalance {
  token: string;
  balance: string;
  decimals: number;
}

interface BitflowPosition {
  pool: string;
  tokenA: string;
  tokenB: string;
  shares: string;
  estimatedUsd: number;
}

interface ZestPosition {
  type: "supply" | "borrow";
  asset: string;
  principal: string;
  ltv: number | null;
  estimatedUsd: number;
}

interface AlexPosition {
  poolToken: string;
  balance: string;
  estimatedUsd: number;
}

interface StyxDeposit {
  id: string;
  status: string;
  amount: string;
  asset: string;
  estimatedUsd: number;
}

interface ProtocolResult<T> {
  status: "ok" | "unavailable" | "error";
  positions: T[];
  estimatedUsd: number;
  error?: string;
}

interface ScanData {
  address: string;
  wallet: TokenBalance[];
  protocols: {
    bitflow: ProtocolResult<BitflowPosition>;
    zest: ProtocolResult<ZestPosition>;
    alex: ProtocolResult<AlexPosition>;
    styx: ProtocolResult<StyxDeposit>;
  };
  totals: {
    walletUsd: number;
    bitflowUsd: number;
    zestUsd: number;
    alexUsd: number;
    styxUsd: number;
    totalUsd: number;
  };
  scannedAt: string;
}

interface RiskFactor {
  factor: string;
  severity: "low" | "medium" | "high" | "critical";
  detail: string;
}

interface SummaryData {
  address: string;
  totalEstimatedUsd: number;
  protocolBreakdown: {
    protocol: string;
    estimatedUsd: number;
    percentage: number;
  }[];
  riskScore: number;
  riskFactors: RiskFactor[];
  topHoldings: { label: string; estimatedUsd: number; protocol: string }[];
  scannedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function envelope<T>(command: string, data: T): SuccessEnvelope<T> {
  return {
    success: true,
    skill: SKILL_NAME,
    command,
    data,
    timestamp: new Date().toISOString(),
  };
}

function errorEnvelope(
  command: string,
  error: string,
  details: Record<string, unknown> = {}
): ErrorEnvelope {
  return {
    success: false,
    skill: SKILL_NAME,
    command,
    error,
    details,
    timestamp: new Date().toISOString(),
  };
}

function output(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function isValidStxAddress(addr: string): boolean {
  return /^S[PM][A-Z0-9]{38,}$/.test(addr);
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function checkEndpoint(
  name: string,
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT,
  options: RequestInit = {}
): Promise<EndpointHealth> {
  const start = Date.now();
  try {
    const resp = await fetchWithTimeout(url, options, timeoutMs);
    const latency = Date.now() - start;
    if (resp.ok) {
      return { name, url, status: "ok", latencyMs: latency };
    }
    return {
      name,
      url,
      status: "degraded",
      latencyMs: latency,
      error: `HTTP ${resp.status}`,
    };
  } catch (err: any) {
    return {
      name,
      url,
      status: "down",
      latencyMs: Date.now() - start,
      error: err?.message ?? String(err),
    };
  }
}

// ─── Price Helpers ──────────────────────────────────────────────────────────

const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price";

async function getUsdPrices(): Promise<{ stx: number; btc: number }> {
  try {
    const resp = await fetchWithTimeout(
      `${COINGECKO_SIMPLE}?ids=blockstack,bitcoin&vs_currencies=usd`,
      {},
      5_000
    );
    if (!resp.ok) return { stx: 0, btc: 0 };
    const data = await resp.json();
    return {
      stx: data?.blockstack?.usd ?? 0,
      btc: data?.bitcoin?.usd ?? 0,
    };
  } catch {
    return { stx: 0, btc: 0 };
  }
}

async function estimateWalletUsd(balances: TokenBalance[]): Promise<number> {
  const prices = await getUsdPrices();
  let total = 0;
  for (const b of balances) {
    const amount = parseInt(b.balance) / Math.pow(10, b.decimals);
    if (b.token === "STX") {
      total += amount * prices.stx;
    } else if (b.token.toLowerCase().includes("sbtc")) {
      total += amount * prices.btc;
    }
    // Other tokens: skip pricing (no reliable oracle)
  }
  return Math.round(total * 100) / 100;
}

// ─── Protocol Scanners ───────────────────────────────────────────────────────

async function scanWalletBalances(
  address: string,
  cachedHiroData?: any
): Promise<TokenBalance[]> {
  try {
    const data = cachedHiroData ?? await (async () => {
      const resp = await fetchWithTimeout(ENDPOINTS.hiroBalances(address), {}, HIRO_TIMEOUT);
      return resp.ok ? resp.json() : null;
    })();
    if (!data) return [];

    const balances: TokenBalance[] = [];

    // STX balance
    if (data.stx) {
      balances.push({
        token: "STX",
        balance: data.stx.balance ?? "0",
        decimals: 6,
      });
    }

    // Fungible tokens
    if (data.fungible_tokens) {
      for (const [tokenId, info] of Object.entries<any>(data.fungible_tokens)) {
        const shortName = tokenId.split("::").pop() ?? tokenId;
        balances.push({
          token: shortName,
          balance: info.balance ?? "0",
          decimals: 6,
        });
      }
    }

    return balances;
  } catch {
    return [];
  }
}

async function scanBitflow(
  address: string,
  cachedHiroData?: any
): Promise<ProtocolResult<BitflowPosition>> {
  try {
    const resp = await fetchWithTimeout(ENDPOINTS.bitflowPools);
    if (!resp.ok) {
      return {
        status: "unavailable",
        positions: [],
        estimatedUsd: 0,
        error: `Bitflow API returned HTTP ${resp.status}`,
      };
    }
    const pools = await resp.json();
    const positions: BitflowPosition[] = [];

    // Parse pool metadata (the /pools endpoint does NOT return per-user data)
    const poolList = Array.isArray(pools) ? pools : pools?.results ?? [];
    const poolMap = new Map<string, any>();
    for (const pool of poolList) {
      const poolId = pool.id ?? pool.pool_id ?? pool.name ?? "unknown";
      poolMap.set(poolId, pool);
    }

    // Query user positions via HODLMM bins endpoint — parallelized to avoid serial timeout accumulation
    const binsResults = await Promise.allSettled(
      [...poolMap.entries()].map(([poolId, pool]) =>
        fetchWithTimeout(
          `https://bff.bitflowapis.finance/api/app/v1/users/${address}/positions/${poolId}/bins`,
          {},
          8_000
        )
          .then(async (r) => {
            if (!r.ok) return null;
            const binsData = await r.json();
            return { poolId, pool, bins: Array.isArray(binsData) ? binsData : binsData?.bins ?? [] };
          })
          .catch(() => null)
      )
    );

    for (const result of binsResults) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const { poolId, pool, bins } = result.value;
      if (bins.length === 0) continue;

      const tokenA = pool.token_a_symbol ?? pool.tokenASymbol ?? pool.token0 ?? "?";
      const tokenB = pool.token_b_symbol ?? pool.tokenBSymbol ?? pool.token1 ?? "?";
      const totalShares = bins.reduce((s: number, b: any) => s + parseFloat(b.shares ?? b.liquidity ?? "0"), 0);
      const estimatedUsd = bins.reduce((s: number, b: any) => s + parseFloat(b.value_usd ?? "0"), 0);
      if (totalShares > 0) {
        positions.push({
          pool: poolId,
          tokenA,
          tokenB,
          shares: String(totalShares),
          estimatedUsd,
        });
      }
    }

    // Fallback: check Hiro for Bitflow LP tokens not caught above
    try {
      const hiroFallback = cachedHiroData ?? await (async () => {
        const r = await fetchWithTimeout(ENDPOINTS.hiroBalances(address), {}, HIRO_TIMEOUT);
        return r.ok ? r.json() : null;
      })();
      if (hiroFallback) {
        const fungibleTokens = hiroFallback.fungible_tokens ?? {};
        for (const [tokenId, info] of Object.entries<any>(fungibleTokens)) {
          const lowerTokenId = tokenId.toLowerCase();
          if (
            (lowerTokenId.includes("bitflow") || lowerTokenId.includes("hodlmm")) &&
            info.balance &&
            info.balance !== "0"
          ) {
            const shortName = tokenId.split("::").pop() ?? tokenId;
            // Avoid duplicates
            if (!positions.find((p) => p.pool === shortName)) {
              positions.push({
                pool: shortName,
                tokenA: "?",
                tokenB: "?",
                shares: info.balance,
                estimatedUsd: 0,
              });
            }
          }
        }
      }
    } catch {
      // Non-critical
    }

    const totalUsd = positions.reduce((sum, p) => sum + p.estimatedUsd, 0);
    return { status: "ok", positions, estimatedUsd: totalUsd };
  } catch (err: any) {
    return {
      status: "unavailable",
      positions: [],
      estimatedUsd: 0,
      error: err?.message ?? String(err),
    };
  }
}

async function scanZest(
  address: string,
  cachedHiroData?: any
): Promise<ProtocolResult<ZestPosition>> {
  try {
    const { address: contractAddr, name: contractName, function: fn } =
      ENDPOINTS.zestContract;

    // get-user-reserve-data takes two principal args: user and asset
    const serializedUser = Buffer.from(serializeCV(principalCV(address))).toString("hex");
    const serializedAsset = Buffer.from(serializeCV(principalCV(ENDPOINTS.zestStxAsset))).toString("hex");
    const body = JSON.stringify({
      sender: address,
      arguments: [`0x${serializedUser}`, `0x${serializedAsset}`],
    });

    const resp = await fetchWithTimeout(
      ENDPOINTS.hiroCallRead(contractAddr, contractName, fn),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      HIRO_TIMEOUT
    );

    if (!resp.ok) {
      // Zest may return 400 if user has no position — that is not an error
      if (resp.status === 400) {
        return { status: "ok", positions: [], estimatedUsd: 0 };
      }
      return {
        status: "unavailable",
        positions: [],
        estimatedUsd: 0,
        error: `Zest call-read returned HTTP ${resp.status}`,
      };
    }

    const data = await resp.json();
    const positions: ZestPosition[] = [];

    // Fetch STX price for USD estimation
    const prices = await getUsdPrices();

    // Parse Clarity response using @stacks/transactions decoder
    if (data.okay && data.result) {
      const resultHex = data.result;

      // If result indicates no data (none type), return empty
      if (resultHex === "0x09") {
        return { status: "ok", positions: [], estimatedUsd: 0 };
      }

      // Decode Clarity value to JSON for inspection
      try {
        const cv = deserializeCV(resultHex);
        const parsed = cvToJSON(cv);

        // get-user-reserve-data returns: principal-borrow-balance, use-as-collateral, etc.
        if (parsed?.value) {
          const val = parsed.value;
          const borrowAmount = val?.["principal-borrow-balance"]?.value ?? "0";
          const useAsCollateral = val?.["use-as-collateral"]?.value ?? false;

          // If user has collateral enabled, check receipt tokens for supply amount
          if (useAsCollateral) {
            // Supply positions detected via receipt tokens in Hiro fallback below
          }

          if (borrowAmount !== "0" && borrowAmount !== 0) {
            const borrowNum = parseInt(String(borrowAmount)) / 1e6;
            positions.push({
              type: "borrow",
              asset: "STX",
              principal: String(borrowAmount),
              ltv: null,
              estimatedUsd: Math.round(borrowNum * prices.stx * 100) / 100,
            });
          }
        }
      } catch {
        // Clarity decode failed — fall through to receipt token fallback
      }
    }

    // Fallback: check token balances for Zest receipt tokens
    try {
      const hiroFallback = cachedHiroData ?? await (async () => {
        const r = await fetchWithTimeout(ENDPOINTS.hiroBalances(address), {}, HIRO_TIMEOUT);
        return r.ok ? r.json() : null;
      })();
      if (hiroFallback) {
        const fungibleTokens = hiroFallback.fungible_tokens ?? {};
        for (const [tokenId, info] of Object.entries<any>(fungibleTokens)) {
          const lowerTokenId = tokenId.toLowerCase();
          if (
            lowerTokenId.includes("zest") &&
            info.balance &&
            info.balance !== "0"
          ) {
            const shortName = tokenId.split("::").pop() ?? tokenId;
            const isDebt = lowerTokenId.includes("debt") || lowerTokenId.includes("borrow");
            const tokenAmount = parseInt(info.balance) / 1e6;
            positions.push({
              type: isDebt ? "borrow" : "supply",
              asset: shortName,
              principal: info.balance,
              ltv: null,
              estimatedUsd: Math.round(tokenAmount * prices.stx * 100) / 100,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }

    const totalUsd = positions.reduce((sum, p) => sum + p.estimatedUsd, 0);
    return { status: "ok", positions, estimatedUsd: totalUsd };
  } catch (err: any) {
    return {
      status: "unavailable",
      positions: [],
      estimatedUsd: 0,
      error: err?.message ?? String(err),
    };
  }
}

async function scanAlex(
  address: string,
  cachedHiroData?: any
): Promise<ProtocolResult<AlexPosition>> {
  try {
    const resp = await fetchWithTimeout(ENDPOINTS.alexBalances(address));
    if (!resp.ok) {
      if (resp.status === 404) {
        return { status: "ok", positions: [], estimatedUsd: 0 };
      }
      return {
        status: "unavailable",
        positions: [],
        estimatedUsd: 0,
        error: `ALEX API returned HTTP ${resp.status}`,
      };
    }

    const data = await resp.json();
    const positions: AlexPosition[] = [];

    // ALEX returns pool token balances as an array or object
    const entries = Array.isArray(data) ? data : data?.results ?? [];
    for (const entry of entries) {
      const poolToken = entry.pool_token ?? entry.token ?? entry.name ?? "unknown";
      const balance = String(entry.balance ?? "0");
      if (balance !== "0") {
        positions.push({
          poolToken,
          balance,
          estimatedUsd: parseFloat(entry.value_usd ?? "0"),
        });
      }
    }

    // Fallback: check Hiro for ALEX LP tokens
    if (positions.length === 0) {
      try {
        const hiroFallback = cachedHiroData ?? await (async () => {
          const r = await fetchWithTimeout(ENDPOINTS.hiroBalances(address), {}, HIRO_TIMEOUT);
          return r.ok ? r.json() : null;
        })();
        if (hiroFallback) {
          const fungibleTokens = hiroFallback.fungible_tokens ?? {};
          for (const [tokenId, info] of Object.entries<any>(fungibleTokens)) {
            const lowerTokenId = tokenId.toLowerCase();
            if (
              lowerTokenId.includes("alex") &&
              info.balance &&
              info.balance !== "0"
            ) {
              const shortName = tokenId.split("::").pop() ?? tokenId;
              positions.push({
                poolToken: shortName,
                balance: info.balance,
                estimatedUsd: 0,
              });
            }
          }
        }
      } catch {
        // Non-critical
      }
    }

    const totalUsd = positions.reduce((sum, p) => sum + p.estimatedUsd, 0);
    return { status: "ok", positions, estimatedUsd: totalUsd };
  } catch (err: any) {
    return {
      status: "unavailable",
      positions: [],
      estimatedUsd: 0,
      error: err?.message ?? String(err),
    };
  }
}

async function scanStyx(
  address: string
): Promise<ProtocolResult<StyxDeposit>> {
  try {
    // Styx API — attempt to fetch user deposits
    const resp = await fetchWithTimeout(
      `${ENDPOINTS.styxApi}/deposits?address=${address}`,
      {},
      8_000 // Shorter timeout for Styx
    );

    if (!resp.ok) {
      if (resp.status === 404) {
        return { status: "ok", positions: [], estimatedUsd: 0 };
      }
      return {
        status: "unavailable",
        positions: [],
        estimatedUsd: 0,
        error: `Styx API returned HTTP ${resp.status}`,
      };
    }

    const data = await resp.json();
    const positions: StyxDeposit[] = [];

    const deposits = Array.isArray(data) ? data : data?.deposits ?? [];
    for (const dep of deposits) {
      positions.push({
        id: dep.id ?? dep.tx_id ?? "unknown",
        status: dep.status ?? "unknown",
        amount: String(dep.amount ?? "0"),
        asset: dep.asset ?? dep.token ?? "BTC",
        estimatedUsd: parseFloat(dep.value_usd ?? "0"),
      });
    }

    const totalUsd = positions.reduce((sum, p) => sum + p.estimatedUsd, 0);
    return { status: "ok", positions, estimatedUsd: totalUsd };
  } catch (err: any) {
    return {
      status: "unavailable",
      positions: [],
      estimatedUsd: 0,
      error: err?.message ?? String(err),
    };
  }
}

// ─── Risk Scoring ────────────────────────────────────────────────────────────

function computeRiskScore(scanData: ScanData): {
  score: number;
  factors: RiskFactor[];
} {
  const factors: RiskFactor[] = [];
  let score = 0;

  const { totals, protocols } = scanData;
  const totalUsd = totals.totalUsd;

  if (totalUsd === 0) {
    return { score: 0, factors: [{ factor: "empty-portfolio", severity: "low", detail: "No DeFi positions detected." }] };
  }

  // 1. Concentration risk — single protocol > 60%
  const protocolValues = [
    { name: "Bitflow", usd: totals.bitflowUsd },
    { name: "Zest", usd: totals.zestUsd },
    { name: "ALEX", usd: totals.alexUsd },
    { name: "Styx", usd: totals.styxUsd },
  ];

  for (const p of protocolValues) {
    const pct = (p.usd / totalUsd) * 100;
    if (pct > 80) {
      score += 30;
      factors.push({
        factor: "extreme-concentration",
        severity: "critical",
        detail: `${p.name} holds ${pct.toFixed(1)}% of portfolio value.`,
      });
    } else if (pct > 60) {
      score += 15;
      factors.push({
        factor: "high-concentration",
        severity: "high",
        detail: `${p.name} holds ${pct.toFixed(1)}% of portfolio value.`,
      });
    }
  }

  // 2. Protocol diversity — fewer active protocols = higher risk
  const activeProtocols = protocolValues.filter((p) => p.usd > 0).length;
  if (activeProtocols <= 1) {
    score += 20;
    factors.push({
      factor: "low-diversification",
      severity: "high",
      detail: `Only ${activeProtocols} protocol(s) with active positions.`,
    });
  } else if (activeProtocols === 2) {
    score += 10;
    factors.push({
      factor: "moderate-diversification",
      severity: "medium",
      detail: `Positions spread across ${activeProtocols} protocols.`,
    });
  }

  // 3. Zest LTV risk
  for (const pos of protocols.zest.positions) {
    if (pos.ltv !== null) {
      if (pos.ltv > 85) {
        score += 30;
        factors.push({
          factor: "zest-ltv-critical",
          severity: "critical",
          detail: `Zest position ${pos.asset} has LTV ${(pos.ltv * 100).toFixed(1)}% — liquidation risk imminent.`,
        });
      } else if (pos.ltv > 70) {
        score += 15;
        factors.push({
          factor: "zest-ltv-warning",
          severity: "high",
          detail: `Zest position ${pos.asset} has LTV ${(pos.ltv * 100).toFixed(1)}% — approaching danger zone.`,
        });
      }
    }
  }

  // 4. Bridge exposure risk — funds in transit
  const pendingStyx = protocols.styx.positions.filter(
    (d) => d.status === "pending" || d.status === "processing"
  );
  if (pendingStyx.length > 0) {
    score += 10;
    factors.push({
      factor: "bridge-in-transit",
      severity: "medium",
      detail: `${pendingStyx.length} Styx deposit(s) still in transit.`,
    });
  }

  // 5. Data completeness — unavailable protocols add uncertainty
  const unavailable = [
    { name: "Bitflow", result: protocols.bitflow },
    { name: "Zest", result: protocols.zest },
    { name: "ALEX", result: protocols.alex },
    { name: "Styx", result: protocols.styx },
  ].filter((p) => p.result.status !== "ok");

  if (unavailable.length > 0) {
    score += unavailable.length * 5;
    factors.push({
      factor: "incomplete-data",
      severity: unavailable.length >= 3 ? "high" : "medium",
      detail: `${unavailable.length} protocol(s) unreachable: ${unavailable.map((p) => p.name).join(", ")}.`,
    });
  }

  // Clamp to 0-100
  score = Math.min(100, Math.max(0, score));

  return { score, factors };
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  const checks = await Promise.all([
    checkEndpoint("Bitflow HODLMM", ENDPOINTS.bitflowPools),
    checkEndpoint(
      "Zest Protocol (Hiro)",
      "https://api.hiro.so/v2/contracts/interface/SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG/ststx-token",
      HIRO_TIMEOUT
    ),
    checkEndpoint("ALEX DEX", "https://api.alexlab.co/v1/allswaps", 8_000),
    checkEndpoint("Styx Bridge", "https://app.styxfinance.com/api", 8_000),
    checkEndpoint(
      "Hiro API",
      ENDPOINTS.hiroBalances("SP000000000000000000002Q6VF78"),
      HIRO_TIMEOUT
    ),
  ]);

  const downCount = checks.filter((c) => c.status === "down").length;
  const degradedCount = checks.filter((c) => c.status === "degraded").length;

  let overall: "ok" | "degraded" | "down";
  if (downCount === checks.length) {
    overall = "down";
  } else if (downCount > 0 || degradedCount > 0) {
    overall = "degraded";
  } else {
    overall = "ok";
  }

  output(envelope<DoctorResult>("doctor", { overall, endpoints: checks }));
}

async function fetchHiroBalances(address: string): Promise<any | null> {
  try {
    const resp = await fetchWithTimeout(
      ENDPOINTS.hiroBalances(address),
      {},
      HIRO_TIMEOUT
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function runScan(address: string): Promise<ScanData> {
  // Fetch Hiro balances ONCE and share across all scanners
  const hiroData = await fetchHiroBalances(address);

  const [wallet, bitflow, zest, alex, styx] = await Promise.all([
    scanWalletBalances(address, hiroData),
    scanBitflow(address, hiroData),
    scanZest(address, hiroData),
    scanAlex(address, hiroData),
    scanStyx(address),
  ]);

  // Estimate wallet USD using CoinGecko for STX + BTC pricing
  const walletUsd = await estimateWalletUsd(wallet);

  const totals = {
    walletUsd,
    bitflowUsd: bitflow.estimatedUsd,
    zestUsd: zest.estimatedUsd,
    alexUsd: alex.estimatedUsd,
    styxUsd: styx.estimatedUsd,
    totalUsd:
      walletUsd +
      bitflow.estimatedUsd +
      zest.estimatedUsd +
      alex.estimatedUsd +
      styx.estimatedUsd,
  };

  const scanData: ScanData = {
    address,
    wallet,
    protocols: { bitflow, zest, alex, styx },
    totals,
    scannedAt: new Date().toISOString(),
  };

  return scanData;
}

async function runScanCommand(address: string): Promise<void> {
  if (!isValidStxAddress(address)) {
    output(
      errorEnvelope("scan", `Invalid Stacks address: ${address}`, {
        hint: "Address must start with SP or SM and be at least 40 characters.",
      })
    );
    process.exit(1);
  }

  const scanData = await runScan(address);
  output(envelope<ScanData>("scan", scanData));
}

async function runSummary(address: string): Promise<void> {
  if (!isValidStxAddress(address)) {
    output(
      errorEnvelope("summary", `Invalid Stacks address: ${address}`, {
        hint: "Address must start with SP or SM and be at least 40 characters.",
      })
    );
    process.exit(1);
  }

  const scanData = await runScan(address);
  const { score, factors } = computeRiskScore(scanData);

  // Build protocol breakdown
  const protocolBreakdown = [
    { protocol: "Bitflow HODLMM", estimatedUsd: scanData.totals.bitflowUsd },
    { protocol: "Zest Protocol", estimatedUsd: scanData.totals.zestUsd },
    { protocol: "ALEX DEX", estimatedUsd: scanData.totals.alexUsd },
    { protocol: "Styx Bridge", estimatedUsd: scanData.totals.styxUsd },
  ]
    .map((p) => ({
      ...p,
      percentage:
        scanData.totals.totalUsd > 0
          ? parseFloat(((p.estimatedUsd / scanData.totals.totalUsd) * 100).toFixed(2))
          : 0,
    }))
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd);

  // Build top holdings
  const allPositions: { label: string; estimatedUsd: number; protocol: string }[] = [];

  for (const pos of scanData.protocols.bitflow.positions) {
    allPositions.push({
      label: `${pos.tokenA}/${pos.tokenB} LP (${pos.pool})`,
      estimatedUsd: pos.estimatedUsd,
      protocol: "Bitflow HODLMM",
    });
  }
  for (const pos of scanData.protocols.zest.positions) {
    allPositions.push({
      label: `${pos.type} ${pos.asset}`,
      estimatedUsd: pos.estimatedUsd,
      protocol: "Zest Protocol",
    });
  }
  for (const pos of scanData.protocols.alex.positions) {
    allPositions.push({
      label: `LP ${pos.poolToken}`,
      estimatedUsd: pos.estimatedUsd,
      protocol: "ALEX DEX",
    });
  }
  for (const pos of scanData.protocols.styx.positions) {
    allPositions.push({
      label: `Bridge ${pos.asset} (${pos.status})`,
      estimatedUsd: pos.estimatedUsd,
      protocol: "Styx Bridge",
    });
  }

  const topHoldings = allPositions
    .sort((a, b) => b.estimatedUsd - a.estimatedUsd)
    .slice(0, 5);

  const summaryData: SummaryData = {
    address,
    totalEstimatedUsd: scanData.totals.totalUsd,
    protocolBreakdown,
    riskScore: score,
    riskFactors: factors,
    topHoldings,
    scannedAt: scanData.scannedAt,
  };

  output(envelope<SummaryData>("summary", summaryData));
}

// ─── CLI Setup ───────────────────────────────────────────────────────────────

const program = new Command();

program
  .name(SKILL_NAME)
  .description(
    "Cross-protocol DeFi position aggregator for Stacks wallets. " +
      "Scans Bitflow HODLMM, Zest Protocol, ALEX DEX, and Styx Bridge."
  )
  .version("1.0.0");

program
  .command("doctor")
  .description("Check connectivity to all protocol APIs and Hiro API")
  .action(async () => {
    try {
      await runDoctor();
    } catch (err: any) {
      output(
        errorEnvelope("doctor", err?.message ?? "Unexpected error", {
          stack: err?.stack,
        })
      );
      process.exit(1);
    }
  });

program
  .command("scan")
  .description("Full position scan across all four protocols")
  .requiredOption("--address <addr>", "Stacks wallet address to scan")
  .action(async (opts: { address: string }) => {
    try {
      await runScanCommand(opts.address);
    } catch (err: any) {
      output(
        errorEnvelope("scan", err?.message ?? "Unexpected error", {
          stack: err?.stack,
        })
      );
      process.exit(1);
    }
  });

program
  .command("summary")
  .description("Condensed portfolio overview with risk scoring")
  .requiredOption("--address <addr>", "Stacks wallet address to summarize")
  .action(async (opts: { address: string }) => {
    try {
      await runSummary(opts.address);
    } catch (err: any) {
      output(
        errorEnvelope("summary", err?.message ?? "Unexpected error", {
          stack: err?.stack,
        })
      );
      process.exit(1);
    }
  });

program.parse();
