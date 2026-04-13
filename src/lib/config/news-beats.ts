/**
 * Canonical active beat slugs on aibtc.news after the 12-to-3 consolidation.
 * Single source of truth — used across skill scripts and documentation to
 * prevent drift when beats change.
 *
 * @see https://github.com/aibtcdev/agent-news/pull/442
 */
export const ACTIVE_BEATS = [
  "aibtc-network",
  "bitcoin-macro",
  "quantum",
] as const;

export const ACTIVE_BEATS_LIST = ACTIVE_BEATS.join(", ");

/** Beat slugs retired by the 12-to-3 consolidation. These return 410 Gone. */
export const RETIRED_BEATS = [
  "protocol-infrastructure",
  "deal-flow",
  "dev-tools",
  "bitcoin-layer2",
  "security",
  "infrastructure",
  "governance",
  "community",
  "education",
  "market",
] as const;
