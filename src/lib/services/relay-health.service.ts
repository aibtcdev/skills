import type { Network } from "../config/networks.js";
import { getApiBaseUrl } from "../config/networks.js";
import { getSponsorRelayUrl } from "../config/sponsor.js";
import { getHiroApi } from "./hiro-api.js";

export interface StuckTransaction {
  sponsorAddress: string;
  walletIndex?: number;
  txid: string;
  nonce: number;
  pendingSeconds: number;
}

export interface NonceStatus {
  lastExecuted: number;
  lastMempool: number | null;
  possibleNext: number;
  missingNonces: number[];
  mempoolNonces: number[];
  hasGaps: boolean;
  gapCount: number;
  mempoolDesync: boolean;
  desyncGap: number;
}

export interface RelayPoolSettlementTimes {
  p50?: number;
  p95?: number;
  avg?: number;
  count?: number;
}

export interface RelayPoolWalletSummary {
  walletIndex: number;
  sponsorAddress: string;
  chainFrontier: number | null;
  assignmentHead: number | null;
  pendingCount: number;
  gapCount: number;
  available: number | null;
  reserved: number | null;
  queueDepth: number | null;
  replayBufferDepth: number | null;
  circuitBreakerOpen: boolean;
  healthy: boolean;
  settlementTimes?: RelayPoolSettlementTimes;
}

export interface RelayPoolSummary {
  healthy: boolean | null;
  healInProgress: boolean;
  gapsFilled: number | null;
  totalAvailable: number | null;
  totalReserved: number | null;
  totalCapacity: number | null;
  capacityUtilization: number | null;
  lowCapacity: boolean;
  degradedWalletCount: number;
  walletsChecked: number;
  lastGapDetected?: string | null;
  recommendation?: string | null;
  settlementTimes?: RelayPoolSettlementTimes;
  probeQueue?: {
    pending: number;
    replaced: number;
    conflict: number;
    rejected: number;
  };
  wallets: RelayPoolWalletSummary[];
}

/**
 * Connectivity and metadata from the relay endpoint.
 *
 * `reachable=true` with `error` set is a valid degraded-but-up state: at least
 * one relay endpoint responded, but the /health or /pool call returned partial
 * data. Callers should surface the error as a warning rather than treating the
 * relay as down.
 */
export interface RelayStatus {
  url: string;
  /** true if at least one relay endpoint responded; does not guarantee full health */
  reachable: boolean;
  status?: string;
  version?: string;
  requestId?: string;
  /** set when a relay call partially failed; reachable may still be true */
  error?: string;
}

export interface RelaySponsorSummary {
  address: string | null;
  walletIndex?: number;
  lastExecutedNonce: number | null;
  possibleNextNonce: number | null;
  lastMempoolNonce: number | null;
  mempoolCount: number | null;
  missingNonces: number[];
  hasGaps: boolean;
  gapCount: number;
  mempoolDesync: boolean;
  desyncGap: number;
  available: number | null;
  reserved: number | null;
  queueDepth: number | null;
  replayBufferDepth: number | null;
  circuitBreakerOpen: boolean | null;
  healthy: boolean | null;
}

/**
 * Top-level result of a relay health check.
 *
 * `healthy` is `true` only when the relay is reachable AND `issues` is empty.
 * `advisories` carries routine operational notes (e.g. relay recommendations)
 * that do NOT indicate a malfunction and do NOT affect `healthy`. Callers that
 * previously branched on `issues.length === 0` should continue to do so;
 * `advisories` is a separate, informational channel.
 */
export interface RelayHealthStatus {
  /** false if relay is unreachable or any entry in issues[] is present */
  healthy: boolean;
  network: Network;
  relay: RelayStatus;
  sponsor: RelaySponsorSummary;
  pool?: RelayPoolSummary;
  stuckTransactions?: StuckTransaction[];
  /** hard problems that flip healthy=false */
  issues: string[];
  /** routine relay notes (e.g. pool.recommendation); does NOT affect healthy */
  advisories: string[];
  formatted: string;
}

interface RelayHealthResponse {
  success?: boolean;
  requestId?: string;
  status?: string;
  network?: string;
  version?: string;
}

interface HiroNonceInfo {
  last_executed_tx_nonce: number | null;
  last_mempool_tx_nonce: number | null;
  possible_next_nonce: number;
  detected_missing_nonces: number[];
  detected_mempool_nonces: number[];
}

interface RelayPoolWalletRaw {
  walletIndex?: number;
  sponsorAddress?: string;
  chainFrontier?: number;
  assignmentHead?: number;
  pendingTxs?: unknown[];
  gaps?: number[];
  available?: number;
  reserved?: number;
  circuitBreakerOpen?: boolean;
  healthy?: boolean;
  queueDepth?: number;
  replayBufferDepth?: number;
  settlementTimes?: RelayPoolSettlementTimes;
}

interface RelayPoolStateRaw {
  wallets?: RelayPoolWalletRaw[];
  healthy?: boolean;
  healInProgress?: boolean;
  gapsFilled?: number;
  totalAvailable?: number;
  totalReserved?: number;
  totalCapacity?: number;
  lastGapDetected?: string | null;
  recommendation?: string | null;
  settlementTimes?: RelayPoolSettlementTimes;
  probeQueue?: {
    pending?: number;
    replaced?: number;
    conflict?: number;
    rejected?: number;
  };
}

interface RelayPoolStateResponse {
  success?: boolean;
  requestId?: string;
  state?: RelayPoolStateRaw;
}

export interface CheckRelayHealthOptions {
  relayUrl?: string;
  sponsorAddress?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MEMPOOL_CONGESTION_THRESHOLD = 10;
const MEMPOOL_DESYNC_GAP_THRESHOLD = 5;
const STUCK_TX_THRESHOLD_SECONDS = 600;
const LOW_CAPACITY_THRESHOLD_RATIO = 0.15;

const LEGACY_PRIMARY_SPONSOR: Partial<Record<Network, string>> = {
  mainnet: "SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7",
};

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeNetwork(value?: string | null): Network | null {
  if (value === "mainnet" || value === "testnet") {
    return value;
  }

  return null;
}

function inferNetworkFromAddress(address?: string | null): Network | null {
  if (!address) {
    return null;
  }

  if (address.startsWith("SP")) {
    return "mainnet";
  }

  if (address.startsWith("ST")) {
    return "testnet";
  }

  return null;
}

async function fetchJsonWithTimeout<T>(
  url: string,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function getNonceInfo(
  network: Network,
  address: string,
  timeoutMs: number
): Promise<HiroNonceInfo> {
  const baseUrl = getApiBaseUrl(network);
  return fetchJsonWithTimeout<HiroNonceInfo>(
    `${baseUrl}/extended/v1/address/${address}/nonces`,
    timeoutMs
  );
}

function summarizePoolWallet(wallet: RelayPoolWalletRaw): RelayPoolWalletSummary {
  const pendingCount = Array.isArray(wallet.pendingTxs)
    ? wallet.pendingTxs.length
    : 0;
  const gapCount = Array.isArray(wallet.gaps) ? wallet.gaps.length : 0;

  return {
    walletIndex: wallet.walletIndex ?? -1,
    sponsorAddress: wallet.sponsorAddress ?? "",
    chainFrontier: wallet.chainFrontier ?? null,
    assignmentHead: wallet.assignmentHead ?? null,
    pendingCount,
    gapCount,
    available: wallet.available ?? null,
    reserved: wallet.reserved ?? null,
    queueDepth: wallet.queueDepth ?? null,
    replayBufferDepth: wallet.replayBufferDepth ?? null,
    circuitBreakerOpen: wallet.circuitBreakerOpen === true,
    healthy: wallet.healthy !== false,
    settlementTimes: wallet.settlementTimes,
  };
}

function buildNonceStatus(nonceInfo: HiroNonceInfo): NonceStatus {
  const lastExecuted = nonceInfo.last_executed_tx_nonce ?? 0;
  const lastMempool = nonceInfo.last_mempool_tx_nonce ?? null;
  const desyncGap =
    lastMempool !== null ? Math.max(0, lastMempool - lastExecuted) : 0;

  return {
    lastExecuted,
    lastMempool,
    possibleNext: nonceInfo.possible_next_nonce,
    missingNonces: nonceInfo.detected_missing_nonces,
    mempoolNonces: nonceInfo.detected_mempool_nonces,
    hasGaps: nonceInfo.detected_missing_nonces.length > 0,
    gapCount: nonceInfo.detected_missing_nonces.length,
    mempoolDesync: desyncGap > MEMPOOL_DESYNC_GAP_THRESHOLD,
    desyncGap,
  };
}

async function getStuckTransactions(
  network: Network,
  wallets: RelayPoolWalletSummary[]
): Promise<StuckTransaction[]> {
  if (wallets.length === 0) {
    return [];
  }

  const hiroApi = getHiroApi(network);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const batches = await Promise.all(
    wallets
      .filter((wallet) => wallet.sponsorAddress)
      .map(async (wallet) => {
        try {
          const mempoolRes = await hiroApi.getMempoolTransactions({
            sender_address: wallet.sponsorAddress,
            limit: 50,
          });

          return mempoolRes.results
            .map((tx) => {
              const receiptTime =
                typeof tx.receipt_time === "number"
                  ? tx.receipt_time
                  : Number(tx.receipt_time);
              const pendingSeconds = Number.isFinite(receiptTime)
                ? Math.max(0, nowSeconds - receiptTime)
                : 0;

              return {
                sponsorAddress: wallet.sponsorAddress,
                walletIndex: wallet.walletIndex,
                txid: tx.tx_id,
                nonce: tx.nonce,
                pendingSeconds,
              } satisfies StuckTransaction;
            })
            .filter((tx) => tx.pendingSeconds > STUCK_TX_THRESHOLD_SECONDS);
        } catch {
          return [] as StuckTransaction[];
        }
      })
  );

  return batches
    .flat()
    .sort((a, b) => b.pendingSeconds - a.pendingSeconds)
    .slice(0, 10);
}

function formatRelayHealthStatus(status: RelayHealthStatus): string {
  const lines: string[] = [];

  lines.push(`Relay Health Check (${status.network})`);
  lines.push(`Status: ${status.healthy ? "HEALTHY" : "UNHEALTHY"}`);
  lines.push(`Relay URL: ${status.relay.url}`);

  if (status.relay.version) {
    lines.push(`Version: ${status.relay.version}`);
  }

  if (status.relay.status) {
    lines.push(`Relay status: ${status.relay.status}`);
  }

  if (status.pool) {
    lines.push("");
    lines.push("Pool State:");
    lines.push(`  Healthy: ${status.pool.healthy === true ? "yes" : "no"}`);
    lines.push(`  Wallets checked: ${status.pool.walletsChecked}`);

    if (
      status.pool.totalAvailable !== null &&
      status.pool.totalCapacity !== null
    ) {
      lines.push(
        `  Capacity: ${status.pool.totalAvailable}/${status.pool.totalCapacity} available`
      );
    }

    if (status.pool.degradedWalletCount > 0) {
      lines.push(`  Degraded wallets: ${status.pool.degradedWalletCount}`);
    }

    if (status.pool.probeQueue) {
      lines.push(
        `  Probe queue: pending=${status.pool.probeQueue.pending}, conflict=${status.pool.probeQueue.conflict}, rejected=${status.pool.probeQueue.rejected}`
      );
    }
  }

  if (status.sponsor.address) {
    lines.push("");
    lines.push(`Primary Sponsor: ${status.sponsor.address}`);
    if (typeof status.sponsor.walletIndex === "number") {
      lines.push(`  Wallet index: ${status.sponsor.walletIndex}`);
    }
    lines.push(`  Last executed nonce: ${status.sponsor.lastExecutedNonce ?? "unknown"}`);
    lines.push(`  Last mempool nonce: ${status.sponsor.lastMempoolNonce ?? "none"}`);
    lines.push(`  Next nonce: ${status.sponsor.possibleNextNonce ?? "unknown"}`);

    if (status.sponsor.gapCount > 0) {
      lines.push(
        `  Missing nonces (${status.sponsor.gapCount}): ${status.sponsor.missingNonces.slice(0, 10).join(", ")}${status.sponsor.gapCount > 10 ? "..." : ""}`
      );
    } else {
      lines.push("  Missing nonces: none");
    }

    if (status.sponsor.queueDepth !== null) {
      lines.push(`  Queue depth: ${status.sponsor.queueDepth}`);
    }
    if (status.sponsor.available !== null) {
      lines.push(`  Available capacity: ${status.sponsor.available}`);
    }
    if (status.sponsor.circuitBreakerOpen === true) {
      lines.push("  Circuit breaker: OPEN");
    }
  }

  if (status.stuckTransactions && status.stuckTransactions.length > 0) {
    lines.push("");
    lines.push("Stuck Transactions:");
    for (const tx of status.stuckTransactions) {
      const minutes = Math.floor(tx.pendingSeconds / 60);
      const seconds = tx.pendingSeconds % 60;
      const duration = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      lines.push(
        `  wallet=${tx.walletIndex ?? "?"} nonce=${tx.nonce} pending=${duration} txid=${tx.txid}`
      );
    }
  }

  if (status.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of status.issues) {
      lines.push(`  - ${issue}`);
    }
  }

  if (status.advisories.length > 0) {
    lines.push("");
    lines.push("Advisories:");
    for (const advisory of status.advisories) {
      lines.push(`  - ${advisory}`);
    }
  }

  return lines.join("\n");
}

export async function checkRelayHealth(
  network: Network,
  options: CheckRelayHealthOptions = {}
): Promise<RelayHealthStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const relayUrl = normalizeUrl(options.relayUrl ?? getSponsorRelayUrl(network));
  const issues: string[] = [];
  const advisories: string[] = [];

  let healthData: RelayHealthResponse | null = null;
  let poolData: RelayPoolStateRaw | null = null;
  let relayError: string | undefined;
  let poolError: string | undefined;

  try {
    healthData = await fetchJsonWithTimeout<RelayHealthResponse>(
      `${relayUrl}/health`,
      timeoutMs
    );
  } catch (error) {
    relayError = error instanceof Error ? error.message : String(error);
    issues.push(`Relay health check failed: ${relayError}`);
  }

  try {
    const stateRes = await fetchJsonWithTimeout<RelayPoolStateResponse>(
      `${relayUrl}/nonce/state`,
      timeoutMs
    );
    poolData = stateRes.state ?? null;
  } catch (error) {
    poolError = error instanceof Error ? error.message : String(error);
    issues.push(`Pool state unavailable: ${poolError}`);
  }

  const relay: RelayStatus = {
    url: relayUrl,
    // Reachability means at least one relay endpoint responded. A degraded /health
    // call should not hide the fact that /nonce/state is still live and actionable.
    reachable: !!healthData || !!poolData,
    status: healthData?.status,
    version: healthData?.version,
    requestId: healthData?.requestId,
    ...(relayError ? { error: relayError } : {}),
  };

  if (healthData?.status && healthData.status !== "ok") {
    issues.push(`Relay reported status "${healthData.status}"`);
  }

  const poolWallets = (poolData?.wallets ?? []).map(summarizePoolWallet);
  const primaryWalletFromPool =
    poolWallets.find((wallet) => wallet.sponsorAddress === options.sponsorAddress) ??
    poolWallets.find((wallet) => wallet.walletIndex === 0) ??
    poolWallets[0];
  const resolvedNetwork =
    normalizeNetwork(healthData?.network) ??
    inferNetworkFromAddress(options.sponsorAddress) ??
    inferNetworkFromAddress(primaryWalletFromPool?.sponsorAddress) ??
    network;

  let pool: RelayPoolSummary | undefined;
  if (poolData) {
    const totalAvailable = poolData.totalAvailable ?? null;
    const totalReserved = poolData.totalReserved ?? null;
    const totalCapacity = poolData.totalCapacity ?? null;
    const capacityUtilization =
      totalCapacity && totalCapacity > 0 && totalAvailable !== null
        ? 1 - totalAvailable / totalCapacity
        : null;
    const lowCapacity =
      totalAvailable !== null &&
      totalCapacity !== null &&
      totalCapacity > 0 &&
      totalAvailable / totalCapacity < LOW_CAPACITY_THRESHOLD_RATIO;
    const degradedWallets = poolWallets.filter(
      (wallet) =>
        !wallet.healthy ||
        wallet.circuitBreakerOpen ||
        wallet.gapCount > 0
    );

    pool = {
      healthy: poolData.healthy ?? null,
      healInProgress: poolData.healInProgress === true,
      gapsFilled: poolData.gapsFilled ?? null,
      totalAvailable,
      totalReserved,
      totalCapacity,
      capacityUtilization,
      lowCapacity,
      degradedWalletCount: degradedWallets.length,
      walletsChecked: poolWallets.length,
      lastGapDetected: poolData.lastGapDetected,
      recommendation: poolData.recommendation,
      settlementTimes: poolData.settlementTimes,
      probeQueue: poolData.probeQueue
        ? {
            pending: poolData.probeQueue.pending ?? 0,
            replaced: poolData.probeQueue.replaced ?? 0,
            conflict: poolData.probeQueue.conflict ?? 0,
            rejected: poolData.probeQueue.rejected ?? 0,
          }
        : undefined,
      wallets: poolWallets,
    };

    if (pool.healthy === false) {
      issues.push("Relay pool state reports unhealthy");
    }
    if (pool.healInProgress) {
      issues.push("Relay pool heal is currently in progress");
    }
    if (pool.lowCapacity && totalAvailable !== null && totalCapacity !== null) {
      issues.push(
        `Relay capacity is low: ${totalAvailable}/${totalCapacity} sponsor slots available`
      );
    }
    if (pool.probeQueue && pool.probeQueue.conflict > 0) {
      issues.push(
        `Probe queue conflicts detected: ${pool.probeQueue.conflict}`
      );
    }
    if (pool.recommendation) {
      advisories.push(`Relay recommendation: ${pool.recommendation}`);
    }

    const circuitBreakerWallets = poolWallets.filter(
      (wallet) => wallet.circuitBreakerOpen
    );
    if (circuitBreakerWallets.length > 0) {
      issues.push(
        `Circuit breaker open on wallet(s): ${circuitBreakerWallets.map((wallet) => wallet.walletIndex).join(", ")}`
      );
    }

    const gapWallets = poolWallets.filter((wallet) => wallet.gapCount > 0);
    if (gapWallets.length > 0) {
      issues.push(
        `Pool gaps detected on wallet(s): ${gapWallets.map((wallet) => wallet.walletIndex).join(", ")}`
      );
    }

    const unhealthyWallets = poolWallets.filter((wallet) => !wallet.healthy);
    if (unhealthyWallets.length > 0) {
      issues.push(
        `Unhealthy sponsor wallet(s): ${unhealthyWallets.map((wallet) => wallet.walletIndex).join(", ")}`
      );
    }
  }

  const primaryWallet = primaryWalletFromPool;

  const sponsorAddress =
    options.sponsorAddress ??
    primaryWallet?.sponsorAddress ??
    LEGACY_PRIMARY_SPONSOR[network] ??
    null;

  let nonceStatus: NonceStatus | undefined;
  if (sponsorAddress) {
    try {
      nonceStatus = buildNonceStatus(
        await getNonceInfo(resolvedNetwork, sponsorAddress, timeoutMs)
      );
      if (nonceStatus.hasGaps) {
        issues.push(
          `Primary sponsor has ${nonceStatus.gapCount} missing nonce(s): ${nonceStatus.missingNonces.slice(0, 5).join(", ")}${nonceStatus.gapCount > 5 ? "..." : ""}`
        );
      }
      if (nonceStatus.mempoolDesync) {
        issues.push(
          `Primary sponsor mempool desync: executed=${nonceStatus.lastExecuted}, mempool=${nonceStatus.lastMempool ?? "none"}, gap=${nonceStatus.desyncGap}`
        );
      } else if (
        nonceStatus.mempoolNonces.length > MEMPOOL_CONGESTION_THRESHOLD
      ) {
        issues.push(
          `Primary sponsor mempool congestion: ${nonceStatus.mempoolNonces.length} pending nonces`
        );
      }
    } catch (error) {
      issues.push(
        `Unable to fetch sponsor nonce data: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    issues.push("No sponsor address available for nonce diagnostics");
  }

  const sponsor: RelaySponsorSummary = {
    address: sponsorAddress,
    walletIndex: primaryWallet?.walletIndex,
    lastExecutedNonce: nonceStatus?.lastExecuted ?? null,
    possibleNextNonce: nonceStatus?.possibleNext ?? null,
    lastMempoolNonce: nonceStatus?.lastMempool ?? null,
    mempoolCount: nonceStatus?.mempoolNonces.length ?? null,
    missingNonces: nonceStatus?.missingNonces ?? [],
    hasGaps: nonceStatus?.hasGaps ?? false,
    gapCount: nonceStatus?.gapCount ?? 0,
    mempoolDesync: nonceStatus?.mempoolDesync ?? false,
    desyncGap: nonceStatus?.desyncGap ?? 0,
    available: primaryWallet?.available ?? null,
    reserved: primaryWallet?.reserved ?? null,
    queueDepth: primaryWallet?.queueDepth ?? null,
    replayBufferDepth: primaryWallet?.replayBufferDepth ?? null,
    circuitBreakerOpen:
      typeof primaryWallet?.circuitBreakerOpen === "boolean"
        ? primaryWallet.circuitBreakerOpen
        : null,
    healthy:
      typeof primaryWallet?.healthy === "boolean" ? primaryWallet.healthy : null,
  };

  let stuckTransactions: StuckTransaction[] | undefined;
  if (poolWallets.length > 0) {
    const stuck = await getStuckTransactions(resolvedNetwork, poolWallets);
    if (stuck.length > 0) {
      stuckTransactions = stuck;
      issues.push(
        `Stuck sponsor transactions detected: ${stuck.length} pending longer than ${Math.floor(STUCK_TX_THRESHOLD_SECONDS / 60)} minutes`
      );
    }
  }

  const dedupedIssues = [...new Set(issues)];
  const dedupedAdvisories = [...new Set(advisories)];
  const status: RelayHealthStatus = {
    healthy: relay.reachable && dedupedIssues.length === 0,
    network: resolvedNetwork,
    relay,
    sponsor,
    pool,
    stuckTransactions,
    issues: dedupedIssues,
    advisories: dedupedAdvisories,
    formatted: "",
  };

  status.formatted = formatRelayHealthStatus(status);
  return status;
}
