import { describe, test, expect } from "bun:test";
import {
  sizeHodlmmOption,
  computeBestMove,
  findDeployGateOption,
  buildDeployInstructions,
  type YieldOption,
} from "./stacks-alpha-engine";

// Follow-ups to #415, tracked in #489. Each block below covers one item.

const usd = (value: number, amount = value) => ({ amount, usd: value });

function option(over: Partial<YieldOption>): YieldOption {
  return {
    tier: "deploy_now", protocol: "HODLMM", pool: "STX-USDCx-10bps", token_needed: "STX/USDCx",
    apy_pct: 600, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.05,
    swap_cost_note: null, note: "", ytg_ratio: 10, ytg_profitable: true,
    ...over,
  };
}

describe("sizeHodlmmOption: dust and lopsided holdings (#489 item 1)", () => {
  test("$5,000 sBTC + 0.000001 USDCx is swap_first, not deploy_now at ~$0", () => {
    const s = sizeHodlmmOption(usd(5000, 0.05), usd(0.000001), 5000, "sBTC", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBeCloseTo(5000, 2);
    expect(s.swapNote).toContain("~$2500");
    expect(s.swapNote).toContain("sBTC into USDCx");
  });

  test("a side with a balance but no price does not count as held", () => {
    const s = sizeHodlmmOption(usd(0, 12), usd(400), 400, "STX", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBe(400);
  });

  test("both sides held but very lopsided: swap to balance instead of a tiny paired deposit", () => {
    const s = sizeHodlmmOption(usd(5000, 0.05), usd(100), 5100, "sBTC", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBe(5100);
    expect(s.swapNote).toContain("~$2450");
  });

  test("both sides held in proportion: deploy_now, bounded by the smaller side x2 (unchanged)", () => {
    const s = sizeHodlmmOption(usd(1000), usd(800), 1800, "STX", "USDCx");
    expect(s.tier).toBe("deploy_now");
    expect(s.capUsd).toBe(1600);
    expect(s.swapNote).toBeNull();
  });
});

describe("sizeHodlmmOption: swap_first rows name the amount and the fee (#489 item 4)", () => {
  test("one side only: swap about half, fee range for a volatile pair", () => {
    const s = sizeHodlmmOption(usd(5000), usd(0), 5000, "STX", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBe(5000);
    expect(s.swapNote).toContain("~$2500 of your STX into USDCx");
    expect(s.swapNote).toContain("~0.1-0.3% fee");
  });

  test("one side only on a stablecoin pair: stablecoin fee note", () => {
    const s = sizeHodlmmOption(usd(1000), usd(0), 1000, "USDh", "USDCx", true);
    expect(s.swapNote).toContain("~$500 of your USDh into USDCx");
    expect(s.swapNote).toContain("~0.01% fee");
  });

  test("neither side held: same note shape, amount per side and fee", () => {
    const s = sizeHodlmmOption(usd(0), usd(0), 2000, "sBTC", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBe(1000);
    expect(s.swapNote).toContain("~$500 into sBTC and ~$500 into USDCx");
    expect(s.swapNote).toContain("~0.1-0.3% fee");
  });

  test("nothing worth swapping: acquire_to_unlock (unchanged)", () => {
    const s = sizeHodlmmOption(usd(0), usd(0), 5, "sBTC", "USDCx");
    expect(s.tier).toBe("acquire_to_unlock");
    expect(s.capUsd).toBe(0);
  });
});

describe("computeBestMove: opportunity cost uses the option's own size (#489 item 3)", () => {
  test("$10k STX + $50 USDCx at 600%: reports the $100 paired deposit, not the whole wallet", () => {
    const daily = Math.round(((100 * 600) / 100 / 365) * 1e4) / 1e4; // 1.6438
    const best = option({ daily_usd: daily });
    const { recommendation, opportunityCost } = computeBestMove([best], 10_050, []);
    expect(opportunityCost).toBe(daily);
    expect(recommendation).toContain(`~$${daily}/day missed`);
  });

  test("no deploy_now option: no recommendation, zero cost (unchanged)", () => {
    const r = computeBestMove([option({ tier: "swap_first", daily_usd: 50 })], 10_000, []);
    expect(r.opportunityCost).toBe(0);
  });
});

describe("findDeployGateOption: the gate checks the pool being deployed to (#489 item 2b)", () => {
  const opts = [
    option({ pool_id: "dlmm_3", pool: "STX-USDCx-10bps", apy_pct: 600, ytg_profitable: true }),
    option({ pool_id: "dlmm_7", pool: "aeUSDC-USDCx-1bps", apy_pct: 0, ytg_profitable: false }),
    option({ protocol: "Hermetica", pool: "USDh Staking (sUSDh)", apy_pct: 5 }),
  ];

  test("deploy to dlmm_7 is gated on dlmm_7, not the first HODLMM row", () => {
    expect(findDeployGateOption(opts, "hodlmm", "dlmm_7")?.pool_id).toBe("dlmm_7");
  });

  test("a HODLMM pool with no option row matches nothing", () => {
    expect(findDeployGateOption(opts, "hodlmm", "dlmm_5")).toBeUndefined();
  });

  test("other protocols still match by protocol", () => {
    expect(findDeployGateOption(opts, "hermetica", "dlmm_1")?.protocol).toBe("Hermetica");
  });
});

describe("buildDeployInstructions: no one-sided HODLMM deposit by default (#489 item 2a)", () => {
  const zero = { amount: 0, usd: 0 };
  function scout(stx: number, usdcx: number) {
    return {
      wallet: "SP000000000000000000002Q6VF78",
      balances: { sbtc: zero, stx: { amount: stx, usd: stx }, usdcx: { amount: usdcx, usd: usdcx }, usdh: zero, susdh: zero, aeusdc: zero },
      prices: { sbtc: 78000, stx: 1, usdcx: 1, usdh: 1, aeusdc: 1 },
    } as unknown as Parameters<typeof buildDeployInstructions>[3];
  }

  test("STX only into STX-USDCx: no add-liquidity, an info step pointing to the swap", () => {
    const ins = buildDeployInstructions("hodlmm", 1_000_000, "stx", scout(10, 0), "dlmm_3");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
    expect(ins).toHaveLength(1);
    expect(ins[0].tool).toBe("info");
    expect(ins[0].description).toContain("Swap");
    expect(ins[0].description).toContain("--force");
  });

  test("USDCx only: same refusal", () => {
    const ins = buildDeployInstructions("hodlmm", 1_000_000, "usdcx", scout(0, 10), "dlmm_3");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
  });

  test("with force, the one-sided deposit is still built (out-of-range bins +1..+5)", () => {
    const ins = buildDeployInstructions("hodlmm", 1_000_000, "stx", scout(10, 0), "dlmm_3", true);
    const add = ins.find(i => i.tool === "bitflow:add-liquidity-simple");
    expect(add).toBeDefined();
    const bins = JSON.parse(String(add!.params.bins)) as Array<{ activeBinOffset: number }>;
    expect(bins.map(b => b.activeBinOffset)).toEqual([1, 2, 3, 4, 5]);
  });

  test("both sides held: one paired deposit at the active bin (unchanged)", () => {
    const ins = buildDeployInstructions("hodlmm", 1_000_000, "stx", scout(10, 10), "dlmm_3");
    const add = ins.find(i => i.tool === "bitflow:add-liquidity-simple");
    const bins = JSON.parse(String(add!.params.bins)) as Array<{ activeBinOffset: number }>;
    expect(bins.map(b => b.activeBinOffset)).toEqual([0]);
  });
});
