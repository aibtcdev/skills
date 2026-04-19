/**
 * Inscription Queue Watcher — core logic.
 *
 * Pure, testable functions for classifying aibtc.news briefs by inscription state.
 * CLI wiring lives in ./inscription-queue-watcher.ts.
 */

export const NEWS_API_BASE = "https://aibtc.news/api";
export const MEMPOOL_API_BASE = "https://mempool.space/api";
export const MEMPOOL_EXPLORER = "https://mempool.space";

/**
 * Shape of a brief document returned by aibtc.news.
 *
 * The API currently ships both camelCase and snake_case variants of the
 * compile timestamp (`compiledAt` and `compiled_at`). Always read both so the
 * skill keeps working if the schema drifts to one form or the other.
 */
export interface BriefDocument {
  date: string;
  compiledAt: string | null;
  compiled_at?: string | null;
  inscription: { inscriptionId?: string | null; inscribedTxid?: string | null } | null;
  summary?: { correspondents?: number; beats?: number; signals?: number };
  included_signal_ids?: string[];
}

export interface BriefArchiveRoot extends BriefDocument {
  archive?: string[];
  latest?: boolean;
}

export type ClassificationState =
  | "not_compiled"
  | "stale_not_compiled"
  | "pending_inscription"
  | "compiled_no_inscription"
  | "inscription_unconfirmed"
  | "healthy";

export type ClassificationSeverity = "ok" | "info" | "warn" | "red";

export interface Classification {
  date: string;
  state: ClassificationState;
  severity: ClassificationSeverity;
  compiledAt: string | null;
  inscriptionId: string | null;
  inscribedTxid: string | null;
  onChain: OnChainResult | null;
  ageHours: number | null;
  reason: string;
  briefUrl: string;
  inscriptionUrl: string | null;
}

export interface OnChainResult {
  txid: string;
  confirmed: boolean;
  blockHeight: number | null;
  blockTime: string | null;
  explorerUrl: string;
  checkedAt: string;
}

const SEVERITY_BY_STATE: Record<ClassificationState, ClassificationSeverity> = {
  not_compiled: "info",
  stale_not_compiled: "warn",
  pending_inscription: "info",
  compiled_no_inscription: "red",
  inscription_unconfirmed: "warn",
  healthy: "ok",
};

/**
 * Return the camel/snake merged compiledAt, preferring camelCase when both exist.
 */
function readCompiledAt(brief: BriefDocument): string | null {
  return brief.compiledAt ?? brief.compiled_at ?? null;
}

/**
 * Extract the commit (reveal) txid from an ordinals inscription ID.
 *
 * Inscription IDs have the shape `<txid>i<index>` where <txid> is 64 hex chars.
 */
export function parseInscriptionId(inscriptionId: string): { txid: string; index: number } | null {
  const match = /^([0-9a-f]{64})i(\d+)$/i.exec(inscriptionId.trim());
  if (!match) return null;
  return { txid: match[1].toLowerCase(), index: parseInt(match[2], 10) };
}

export function todayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Bech32 mainnet BTC address shape check. Loose enough to cover p2wpkh (bc1q),
 * p2wsh (bc1q), and p2tr (bc1p) without pinning exact lengths. Gate for the
 * `--notify` CLI flag so garbage addresses don't silently stage into alerts.
 */
const BECH32_BTC_ADDRESS = /^bc1[a-z0-9]{25,90}$/i;

/**
 * Split a comma-separated list of BTC addresses into valid bech32 bc1 entries
 * and rejected strings. Whitespace-only entries are dropped silently; anything
 * that fails the bech32 shape check is surfaced in `rejected` so the CLI can
 * warn about misconfigured --notify inputs.
 */
export function parseNotify(raw: string | undefined): {
  valid: string[];
  rejected: string[];
} {
  if (!raw) return { valid: [], rejected: [] };
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const candidate of raw.split(",").map((s) => s.trim())) {
    if (candidate.length === 0) continue;
    if (BECH32_BTC_ADDRESS.test(candidate)) {
      valid.push(candidate);
    } else {
      rejected.push(candidate);
    }
  }
  return { valid, rejected };
}

/**
 * Classify a single brief document against a compile-to-inscribe age threshold.
 *
 * Precedence:
 * 1. compiledAt == null  →  `not_compiled` (future/today) or `stale_not_compiled` (past)
 * 2. compiledAt set, inscription missing, within grace  →  `pending_inscription`
 * 3. compiledAt set, inscription missing, past threshold  →  `compiled_no_inscription`
 * 4. compiledAt set, inscriptionId present, on-chain unconfirmed  →  `inscription_unconfirmed`
 * 5. compiledAt set, inscriptionId present, on-chain confirmed  →  `healthy`
 */
export function classifyBrief(
  brief: BriefDocument,
  options: {
    thresholdHours: number;
    onChain: OnChainResult | null;
    now?: Date;
  }
): Classification {
  const now = options.now ?? new Date();
  const todayStr = todayUtcDate(now);
  const compiledAt = readCompiledAt(brief);
  const inscriptionId = brief.inscription?.inscriptionId ?? null;
  const inscribedTxid = brief.inscription?.inscribedTxid ?? null;

  const briefUrl = `https://aibtc.news/api/brief/${brief.date}`;
  const inscriptionUrl = inscriptionId
    ? `https://ordinals.com/inscription/${inscriptionId}`
    : null;

  if (!compiledAt) {
    const isPast = brief.date < todayStr;
    const state: ClassificationState = isPast ? "stale_not_compiled" : "not_compiled";
    return {
      date: brief.date,
      state,
      severity: SEVERITY_BY_STATE[state],
      compiledAt: null,
      inscriptionId,
      inscribedTxid,
      onChain: null,
      ageHours: null,
      reason: isPast
        ? `Brief ${brief.date} has no compiledAt; today is ${todayStr} — daily cutoff missed.`
        : `Brief ${brief.date} has no compiledAt yet; expected before end of UTC day.`,
      briefUrl,
      inscriptionUrl,
    };
  }

  const compiledMs = Date.parse(compiledAt);
  const ageHours = Number.isFinite(compiledMs)
    ? (now.getTime() - compiledMs) / 36e5
    : null;

  if (!inscriptionId) {
    if (ageHours != null && ageHours > options.thresholdHours) {
      return {
        date: brief.date,
        state: "compiled_no_inscription",
        severity: SEVERITY_BY_STATE.compiled_no_inscription,
        compiledAt,
        inscriptionId: null,
        inscribedTxid: null,
        onChain: null,
        ageHours,
        reason: `Brief compiled ${ageHours.toFixed(1)}h ago but no inscription recorded (threshold ${options.thresholdHours}h).`,
        briefUrl,
        inscriptionUrl: null,
      };
    }
    return {
      date: brief.date,
      state: "pending_inscription",
      severity: SEVERITY_BY_STATE.pending_inscription,
      compiledAt,
      inscriptionId: null,
      inscribedTxid: null,
      onChain: null,
      ageHours,
      reason: `Brief compiled ${ageHours?.toFixed(1) ?? "?"}h ago; inscription still within ${options.thresholdHours}h grace window.`,
      briefUrl,
      inscriptionUrl: null,
    };
  }

  if (!options.onChain || !options.onChain.confirmed) {
    return {
      date: brief.date,
      state: "inscription_unconfirmed",
      severity: SEVERITY_BY_STATE.inscription_unconfirmed,
      compiledAt,
      inscriptionId,
      inscribedTxid,
      onChain: options.onChain,
      ageHours,
      reason: options.onChain
        ? `Inscription tx ${options.onChain.txid} broadcast but not confirmed in a block.`
        : `Inscription ${inscriptionId} not found on-chain via mempool.space.`,
      briefUrl,
      inscriptionUrl,
    };
  }

  return {
    date: brief.date,
    state: "healthy",
    severity: SEVERITY_BY_STATE.healthy,
    compiledAt,
    inscriptionId,
    inscribedTxid,
    onChain: options.onChain,
    ageHours,
    reason: `Inscription confirmed in block ${options.onChain.blockHeight ?? "?"}.`,
    briefUrl,
    inscriptionUrl,
  };
}

/**
 * Fetch a single brief by UTC date. Uses the path form (/api/brief/YYYY-MM-DD);
 * the query form (/api/brief?date=...) silently returns today and must not be used.
 */
export async function fetchBrief(
  date: string,
  fetchImpl: typeof fetch = fetch
): Promise<BriefDocument> {
  const res = await fetchImpl(`${NEWS_API_BASE}/brief/${date}`);
  if (res.status === 404) {
    // aibtc.news returns 404 for today's date until the first correspondent
    // signal lands; treat as a synthetic uncompiled brief so classifyBrief
    // can apply the today-vs-past rule uniformly.
    return { date, compiledAt: null, inscription: null };
  }
  if (!res.ok) {
    throw new Error(
      `aibtc.news brief fetch failed for ${date}: ${res.status} ${res.statusText}`
    );
  }
  const body = (await res.json()) as BriefDocument;
  if (!body.date) {
    throw new Error(`aibtc.news brief for ${date} returned no date field`);
  }
  return body;
}

/**
 * Fetch the archive index (/api/brief root). Returns the today-or-latest brief
 * plus the archive date list.
 */
export async function fetchArchiveRoot(
  fetchImpl: typeof fetch = fetch
): Promise<BriefArchiveRoot> {
  const res = await fetchImpl(`${NEWS_API_BASE}/brief`);
  if (!res.ok) {
    throw new Error(
      `aibtc.news archive root fetch failed: ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as BriefArchiveRoot;
}

/**
 * Verify an inscription's commit tx on-chain via mempool.space.
 *
 * Apr 19, 2026 finding: the brief API returns `inscribedTxid: null` even when
 * the inscription IS confirmed — the field is not populated. Source of truth is
 * the reveal tx derived from the inscriptionId itself. Avoids the Hiro ordinals
 * 410-deprecation blocker noted in project_session_2026-04-17.md.
 */
export async function checkInscriptionOnChain(
  inscriptionId: string,
  fetchImpl: typeof fetch = fetch
): Promise<OnChainResult | null> {
  const parsed = parseInscriptionId(inscriptionId);
  if (!parsed) return null;
  const res = await fetchImpl(`${MEMPOOL_API_BASE}/tx/${parsed.txid}/status`);
  const checkedAt = new Date().toISOString();
  if (res.status === 404) {
    return {
      txid: parsed.txid,
      confirmed: false,
      blockHeight: null,
      blockTime: null,
      explorerUrl: `${MEMPOOL_EXPLORER}/tx/${parsed.txid}`,
      checkedAt,
    };
  }
  if (!res.ok) {
    throw new Error(
      `mempool.space /tx/${parsed.txid}/status failed: ${res.status} ${res.statusText}`
    );
  }
  const body = (await res.json()) as {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  return {
    txid: parsed.txid,
    confirmed: Boolean(body.confirmed),
    blockHeight: body.block_height ?? null,
    blockTime: body.block_time ? new Date(body.block_time * 1000).toISOString() : null,
    explorerUrl: `${MEMPOOL_EXPLORER}/tx/${parsed.txid}`,
    checkedAt,
  };
}

/**
 * Yield the N most recent UTC dates ending today (inclusive), oldest first.
 * Uses pure UTC math so the result is stable regardless of host timezone.
 */
export function recentDates(days: number, now: Date = new Date()): string[] {
  if (days < 1) return [];
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export interface WatcherReport {
  generatedAt: string;
  thresholdHours: number;
  windowDays: number;
  totals: Record<ClassificationSeverity, number>;
  red: Classification[];
  classifications: Classification[];
  notifyRecipients: string[];
  notifyHint?: string;
}

/**
 * Run the watcher across a recent-days window and produce a report.
 */
export async function runWatcher(
  options: {
    days: number;
    thresholdHours: number;
    notifyRecipients?: string[];
    now?: Date;
    fetchImpl?: typeof fetch;
  }
): Promise<WatcherReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const dates = recentDates(options.days, now);

  // Parallelize across the date window. Each date is independent — the brief
  // fetch + optional mempool check commute across dates, so fanning out cuts
  // large windows (e.g. --days 60) from minutes to seconds. Error handling
  // stays per-date via Promise.allSettled.
  const results = await Promise.allSettled(
    dates.map(async (date) => {
      const brief = await fetchBrief(date, fetchImpl);
      let onChain: OnChainResult | null = null;
      const inscriptionId = brief.inscription?.inscriptionId ?? null;
      if (inscriptionId) {
        onChain = await checkInscriptionOnChain(inscriptionId, fetchImpl);
      }
      return classifyBrief(brief, {
        thresholdHours: options.thresholdHours,
        onChain,
        now,
      });
    })
  );

  const classifications: Classification[] = dates.map((date, i) => {
    const r = results[i];
    if (r.status === "fulfilled") return r.value;
    return {
      date,
      state: "stale_not_compiled",
      severity: "warn",
      compiledAt: null,
      inscriptionId: null,
      inscribedTxid: null,
      onChain: null,
      ageHours: null,
      reason: `Fetch failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      briefUrl: `${NEWS_API_BASE}/brief/${date}`,
      inscriptionUrl: null,
    };
  });

  const totals: Record<ClassificationSeverity, number> = {
    ok: 0,
    info: 0,
    warn: 0,
    red: 0,
  };
  for (const c of classifications) totals[c.severity]++;

  const red = classifications.filter((c) => c.severity === "red");
  const notifyRecipients = options.notifyRecipients ?? [];

  const report: WatcherReport = {
    generatedAt: now.toISOString(),
    thresholdHours: options.thresholdHours,
    windowDays: options.days,
    totals,
    red,
    classifications,
    notifyRecipients,
  };
  if (notifyRecipients.length === 0) {
    report.notifyHint = "enable operator alerts with --notify <btc_address>";
  }
  return report;
}
