/**
 * Unit tests for hodlmm-flow skill.
 *
 * Test 1: SWAP_FUNCTIONS snapshot — verifies the array matches all 8 live
 *         entrypoints on SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1.
 *         This is a static fixture test; it fails if the array drifts without a deliberate update.
 *
 * Test 2: 429 partial-result contract — verifies that when fetchSwapTransactions
 *         throws a "Rate limited" error, analyzePool returns an object with
 *         partial: true, partial_reason: "hiro_rate_limited", and valid metric keys.
 */

import { test, expect, mock, afterEach } from "bun:test";
import { SWAP_FUNCTIONS, analyzePool } from "./hodlmm-flow";

// ---------------------------------------------------------------------------
// Test 1 — Router surface coverage
// ---------------------------------------------------------------------------

/**
 * Verified entrypoints on SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1
 * (confirmed via Hiro API, 2025-04).  If this test fails after a router upgrade,
 * update SWAP_FUNCTIONS in hodlmm-flow.ts and this fixture together.
 */
const EXPECTED_ROUTER_FUNCTIONS = [
  "swap-multi",
  "swap-simple-multi",
  "swap-x-for-y-same-multi",
  "swap-x-for-y-simple-multi",
  "swap-x-for-y-simple-range-multi",
  "swap-y-for-x-same-multi",
  "swap-y-for-x-simple-multi",
  "swap-y-for-x-simple-range-multi",
];

test("SWAP_FUNCTIONS covers all live dlmm-swap-router-v-1-1 entrypoints", () => {
  // Exact count
  expect(SWAP_FUNCTIONS.length).toBe(8);

  // Every expected function must be present
  for (const fn of EXPECTED_ROUTER_FUNCTIONS) {
    expect(SWAP_FUNCTIONS).toContain(fn);
  }

  // No extra functions beyond the verified set (fail loudly if array drifts)
  for (const fn of SWAP_FUNCTIONS) {
    expect(EXPECTED_ROUTER_FUNCTIONS).toContain(fn);
  }
});

// ---------------------------------------------------------------------------
// Test 2 — 429 partial-result contract
// ---------------------------------------------------------------------------

// We need fetch to be mockable.  analyzePool calls fetchJson which calls globalThis.fetch.
// We mock globalThis.fetch to simulate a 429 on the first Hiro call (fetchSwapTransactions)
// while returning valid fixture data for the Bitflow pool-info calls (getPoolInfo).

const MOCK_POOL_LIST = {
  pools: [
    { pool_id: "dlmm_3", bin_step: 10 },
  ],
};

const MOCK_POOL_DETAIL = {
  tokens: {
    tokenX: { symbol: "STX", decimals: 6 },
    tokenY: { symbol: "USDCx", decimals: 6 },
  },
};

afterEach(() => {
  // Reset to real fetch after each test
  globalThis.fetch = fetch;
});

test("analyzePool returns partial result with hiro_rate_limited when fetch throws 429", async () => {
  let callIndex = 0;

  // Replace globalThis.fetch with a mock that:
  //   - Calls 0,1: Bitflow pool-info (pool list + pool detail) — return fixture data
  //   - Call 2+:  Hiro transactions API — respond with 429
  globalThis.fetch = mock(async (url: string | URL | Request, _init?: RequestInit) => {
    const urlStr = url instanceof Request ? url.url : String(url);
    callIndex++;

    if (urlStr.includes("bitflowapis.finance") && urlStr.includes("/pools") && !urlStr.includes("dlmm_")) {
      // Bitflow quotes /pools (pool list)
      return new Response(JSON.stringify(MOCK_POOL_LIST), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("bitflowapis.finance") && urlStr.includes("dlmm_3")) {
      // Bitflow app /pools/dlmm_3 (pool detail)
      return new Response(JSON.stringify(MOCK_POOL_DETAIL), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // All Hiro calls → 429
    return new Response("Too Many Requests", {
      status: 429,
      statusText: "Too Many Requests",
    });
  }) as typeof fetch;

  const result = await analyzePool("dlmm_3", 10, undefined, /* skipCache */ true);

  // Core partial-result contract assertions
  expect(result.partial).toBe(true);
  expect(result.partial_reason).toBe("hiro_rate_limited");

  // swapsAnalyzed must be a number (0 is valid for an empty partial result)
  expect(typeof result.swapsAnalyzed).toBe("number");

  // coverage_rate must be null or a number (field must exist — not undefined)
  expect(result.coverage_rate === null || typeof result.coverage_rate === "number").toBe(true);

  // Structural integrity: required top-level fields must be present
  expect(result.status).toBe("success");
  expect(result.network).toBe("mainnet");
  expect(typeof result.poolId).toBe("string");
  expect(typeof result.pair).toBe("string");
  expect(result.metrics).toBeDefined();
  expect(result.verdict).toBeDefined();
  expect(Array.isArray(result.topActors)).toBe(true);
});
