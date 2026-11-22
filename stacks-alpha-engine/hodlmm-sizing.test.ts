import { describe, test, expect } from "bun:test";
import {
  sizeHodlmmOption,
  computeBestMove,
  findDeployGateOption,
  buildDeployInstructions,
  hodlmmYieldOptions,
  hodlmmDeployRefusal,
  planDeploy,
  planMigrate,
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

  test("a side with a balance but no price: not deploy_now, sized on the priced side", () => {
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
    expect(ins[0].description).toContain("--allow-one-sided");
  });

  test("USDCx only: same refusal", () => {
    const ins = buildDeployInstructions("hodlmm", 1_000_000, "usdcx", scout(0, 10), "dlmm_3");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
  });

  test("with allowOneSided, the one-sided deposit is still built (out-of-range bins +1..+5)", () => {
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

// Review follow-ups on #491.

type Scout = Parameters<typeof planDeploy>[1];
type Bal = { amount: number; usd: number };
const none: Bal = { amount: 0, usd: 0 };

function wallet(over: Partial<Record<"sbtc" | "stx" | "usdcx" | "usdh" | "aeusdc", Bal>>) {
  return { sbtc: none, stx: none, usdcx: none, usdh: none, susdh: none, aeusdc: none, ...over };
}
type Px = Record<"sbtc" | "stx" | "usdcx" | "usdh" | "aeusdc", number>;
const PRICES: Px = { sbtc: 100000, stx: 1, usdcx: 1, usdh: 1, aeusdc: 1 };
// Every protocol read OK with nothing held, unless a test passes its own.
const READ_OK = {
  zest: { has_position: false, detail: "", supply_apy_pct: 0 },
  granite: { has_position: false, detail: "", supply_apy_pct: 0, accepted_token: "aeUSDC", lp_shares: "0" },
  hermetica: { has_position: false, detail: "", susdh_balance: 0, exchange_rate: 1, apy_estimate_pct: 0, staking_enabled: true },
  hodlmm: { has_position: false, pools: [] },
};
function scoutOf(balances: ReturnType<typeof wallet>, options: YieldOption[] = [], positions?: Record<string, unknown>, prices: Partial<Px> = {}): Scout {
  return {
    wallet: "SP000000000000000000002Q6VF78", balances, options, positions: { ...READ_OK, ...positions },
    prices: { ...PRICES, ...prices },
  } as unknown as Scout;
}
// A row of the Bitflow /pools response, as fetchBitflowPools returns it.
const bitflowPool = (poolId: string, apr24h: number) => ({ poolId, apr24h, tvlUsd: 1_000_000, volumeUsd1d: 500_000 });
const tools = (p: ReturnType<typeof planDeploy>) => (p.status === "ok" ? p.instructions.map(i => i.tool) : []);
const reasons = (p: ReturnType<typeof planDeploy>) => (p.status === "refused" ? p.refusal_reasons.join(" ") : "");

describe("deploy gate: a HODLMM pool with no scan row is refused (#491 review 1)", () => {
  const stxUsdcx = wallet({ stx: usd(1000), usdcx: usd(1000) });
  const deploy3 = { protocol: "hodlmm", token: "stx", amount: "1000000", poolId: "dlmm_3" };

  test("zero-APR pool: the scan makes no row for it, so the deploy is refused", () => {
    const rows = hodlmmYieldOptions([bitflowPool("dlmm_3", 0), bitflowPool("dlmm_1", 12)], stxUsdcx, PRICES);
    expect(rows.map(r => r.pool_id)).toEqual(["dlmm_1"]);
    const plan = planDeploy(deploy3, scoutOf(stxUsdcx, rows));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("No scan data for dlmm_3");
  });

  test("Bitflow pool list unavailable (no HODLMM rows at all): refused", () => {
    const plan = planDeploy(deploy3, scoutOf(stxUsdcx, hodlmmYieldOptions([], stxUsdcx, PRICES)));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("--force");
  });

  test("--force overrides it and builds the paired deposit", () => {
    const plan = planDeploy({ ...deploy3, force: "true" }, scoutOf(stxUsdcx, []));
    expect(tools(plan)).toEqual(["bitflow:add-liquidity-simple"]);
  });
});

describe("migrate checks the HODLMM deposit before withdrawing (#491 review 2)", () => {
  const sbtcOnly = wallet({ sbtc: usd(5000, 0.05) });
  const migrate = { from: "zest", to: "hodlmm", amount: "100000", poolId: "dlmm_1" };
  const rows = [option({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps" })];

  test("zest -> hodlmm with only sBTC: refused as a whole, no zest_withdraw planned", () => {
    const plan = planMigrate(migrate, scoutOf(sbtcOnly, rows));
    expect(plan.status).toBe("refused");
    expect(tools(plan)).toEqual([]);
    expect(reasons(plan)).toContain("nothing withdrawn from zest");
    expect(reasons(plan)).toContain("--allow-one-sided");
  });

  test("both sides held: withdraw, then the paired deposit", () => {
    const plan = planMigrate(migrate, scoutOf(wallet({ sbtc: usd(5000, 0.05), usdcx: usd(5000) }), rows));
    expect(tools(plan)).toEqual(["zest_withdraw", "bitflow:add-liquidity-simple"]);
  });

  test("--allow-one-sided: the one-sided deposit earns nothing, so YTG refuses it; with --force, withdraw then deposit", () => {
    const plan = planMigrate({ ...migrate, allowOneSided: "true" }, scoutOf(sbtcOnly, rows));
    expect(reasons(plan)).toContain("one-sided so outside the active bin: earns $0");
    const forced = planMigrate({ ...migrate, allowOneSided: "true", force: "true" }, scoutOf(sbtcOnly, rows));
    expect(tools(forced)).toEqual(["zest_withdraw", "bitflow:add-liquidity-simple"]);
  });
});

describe("deploy uses the scan's dust and ratio rule (#491 review 3)", () => {
  const dustY = wallet({ sbtc: usd(5000, 0.05), usdcx: { amount: 0.000001, usd: 0.000001 } });
  const lopsided = wallet({ sbtc: usd(5000, 0.05), usdcx: usd(100) });

  test("$5,000 sBTC + 1 atomic USDCx: scan says swap_first and deploy builds no deposit", () => {
    expect(sizeHodlmmOption(dustY.sbtc, dustY.usdcx, 5000, "sBTC", "USDCx").tier).toBe("swap_first");
    const ins = buildDeployInstructions("hodlmm", 5_000_000, "sbtc", scoutOf(dustY), "dlmm_1");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
    expect(ins[0].description).toContain("no USDCx");
  });

  test("same wallet with allowOneSided: sBTC-only bins +1..+5, the USDCx dust is not paired", () => {
    const ins = buildDeployInstructions("hodlmm", 5_000_000, "sbtc", scoutOf(dustY), "dlmm_1", true);
    const add = ins.find(i => i.tool === "bitflow:add-liquidity-simple");
    const bins = JSON.parse(String(add!.params.bins)) as Array<{ activeBinOffset: number; yAmount: string }>;
    expect(bins.map(b => b.activeBinOffset)).toEqual([1, 2, 3, 4, 5]);
    expect(bins.every(b => b.yAmount === "0")).toBe(true);
  });

  test("$5,000 sBTC + $100 USDCx (under 10%): refused with the swap amount", () => {
    const ins = buildDeployInstructions("hodlmm", 5_000_000, "sbtc", scoutOf(lopsided), "dlmm_1");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
    expect(ins[0].description).toContain("~$2450");
  });

  test("scan and deploy agree: deploy_now exactly when the deposit is not refused", () => {
    const cases: Array<[Bal, Bal]> = [
      [usd(1000), usd(800)], [usd(5000), usd(0.5)], [usd(5000), usd(100)], [usd(0, 12), usd(400)],
      [usd(500), usd(50)], [usd(0), usd(0)], [usd(2), usd(1)],
    ];
    for (const [stx, usdcx] of cases) {
      const scan = sizeHodlmmOption(stx, usdcx, stx.usd + usdcx.usd, "STX", "USDCx").tier === "deploy_now";
      const deploy = hodlmmDeployRefusal("stx", scoutOf(wallet({ stx, usdcx })), "dlmm_3") === null;
      expect([stx.usd, usdcx.usd, deploy]).toEqual([stx.usd, usdcx.usd, scan]);
    }
  });
});

describe("a refused HODLMM deposit returns status refused (#491 review 4)", () => {
  const stxOnly = wallet({ stx: usd(1000) });
  const row = option({ pool_id: "dlmm_3", tier: "swap_first" });
  const deploy3 = { protocol: "hodlmm", token: "stx", amount: "1000000", poolId: "dlmm_3" };

  test("STX only into STX-USDCx: status refused with the reason, no instructions", () => {
    const plan = planDeploy(deploy3, scoutOf(stxOnly, [row]));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("Swap about half of the STX into USDCx");
  });

  test("--force alone does not allow the one-sided deposit (separate flag)", () => {
    const plan = planDeploy({ ...deploy3, force: "true" }, scoutOf(stxOnly, [row]));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("--allow-one-sided");
  });

  test("--allow-one-sided builds it", () => {
    const plan = planDeploy({ ...deploy3, allowOneSided: "true" }, scoutOf(stxOnly, [row]));
    expect(plan.status).toBe("ok");
    expect(tools(plan)).toEqual(["bitflow:add-liquidity-simple"]);
  });
});

describe("sizeHodlmmOption: neither side held on a stablecoin pair quotes the stablecoin fee (#491 nit)", () => {
  test("USDh/USDCx row, nothing in either side", () => {
    const s = sizeHodlmmOption(usd(0), usd(0), 2000, "USDh", "USDCx", true);
    expect(s.swapNote).toContain("~0.01% fee");
  });
});

// Second review of #491 (c49315c).

type Bin = { activeBinOffset: number; xAmount: string; yAmount: string };
const binsOf = (p: ReturnType<typeof planDeploy>): Bin[] => {
  const add = p.status === "ok" ? p.instructions.find(i => i.tool === "bitflow:add-liquidity-simple") : undefined;
  return add ? (JSON.parse(String(add.params.bins)) as Bin[]) : [];
};

describe("migrate sees the wallet after the withdraw (#491 review 2, point 1)", () => {
  const rows = [option({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps" }), option({ pool_id: "dlmm_7", pool: "aeUSDC-USDCx-1bps" })];

  test("zest -> hodlmm, sBTC supplied in Zest, USDCx in the wallet, 0 sBTC in the wallet: withdraw + paired deposit", () => {
    const usdcxOnly = wallet({ usdcx: usd(5000) });
    const positions = { zest: { has_position: true, detail: "", supply_amount: 0.05, supply_apy_pct: 1 } };
    const plan = planMigrate(
      { from: "zest", to: "hodlmm", token: "sbtc", amount: "100000", poolId: "dlmm_1" },
      scoutOf(usdcxOnly, rows, positions),
    );
    expect(plan.status).toBe("ok");
    expect(tools(plan)).toEqual(["zest_withdraw", "bitflow:add-liquidity-simple"]);
    // 0.001 sBTC ($100) paired with $100 of USDCx at the active bin
    expect(binsOf(plan)).toEqual([{ activeBinOffset: 0, xAmount: "100000", yAmount: "100000000" }]);
  });

  test("granite -> hodlmm aeUSDC-USDCx: the redeemed aeUSDC counts as held", () => {
    const positions = { granite: { has_position: true, detail: "", accepted_token: "aeUSDC", lp_shares: "5000000000", supply_apy_pct: 1 } };
    const plan = planMigrate(
      { from: "granite", to: "hodlmm", token: "aeusdc", amount: "1000000000", poolId: "dlmm_7" },
      scoutOf(wallet({ usdcx: usd(5000) }), rows, positions),
    );
    expect(plan.status).toBe("ok");
    expect(binsOf(plan)).toEqual([{ activeBinOffset: 0, xAmount: "1000000000", yAmount: "1000000000" }]);
  });

  test("nothing in Zest and only USDCx in the wallet: still refused before the withdraw", () => {
    const plan = planMigrate(
      { from: "zest", to: "hodlmm", token: "sbtc", amount: "100000", poolId: "dlmm_1" },
      scoutOf(wallet({ usdcx: usd(5000) }), rows, { zest: { has_position: false, detail: "" } }),
    );
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("nothing withdrawn from zest");
  });
});

describe("the dust and 10% rule applies to what the deposit puts in (#491 review 2, point 2)", () => {
  const paired = wallet({ sbtc: usd(5000, 0.05), usdcx: usd(5000) });
  const rows = [option({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps" })];
  const deploy = (token: string, amount: string) => planDeploy({ protocol: "hodlmm", token, amount, poolId: "dlmm_1" }, scoutOf(paired, rows));

  test("$5,000 + $5,000 wallet, --token usdcx --amount 1 (1 atomic USDCx): refused, not 1 USDCx + all the sBTC", () => {
    const plan = deploy("usdcx", "1");
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("the deposit would be");
    expect(reasons(plan)).toContain("--allow-one-sided");
  });

  test("--token usdcx --amount $1,000: the sBTC side is sized to $1,000, not the whole sBTC balance", () => {
    expect(binsOf(deploy("usdcx", "1000000000"))).toEqual([{ activeBinOffset: 0, xAmount: "1000000", yAmount: "1000000000" }]);
  });

  test("the other side is capped at its balance: $5,000 USDCx against $600 of sBTC pairs the $600", () => {
    const short = wallet({ sbtc: usd(600, 0.006), usdcx: usd(5000) });
    const plan = planDeploy({ protocol: "hodlmm", token: "usdcx", amount: "5000000000", poolId: "dlmm_1" }, scoutOf(short, rows));
    expect(binsOf(plan)).toEqual([{ activeBinOffset: 0, xAmount: "600000", yAmount: "5000000000" }]);
  });

  test("buildDeployInstructions applies the same rule (info step, no deposit)", () => {
    const ins = buildDeployInstructions("hodlmm", 1, "usdcx", scoutOf(paired, rows), "dlmm_1");
    expect(ins.some(i => i.tool === "bitflow:add-liquidity-simple")).toBe(false);
  });
});

describe("migrate goes through the deploy gates (#491 review 2, point 3)", () => {
  const paired = wallet({ sbtc: usd(5000, 0.05), usdcx: usd(5000) });
  const migrate = { from: "zest", to: "hodlmm", amount: "100000", poolId: "dlmm_1" };

  test("migrate to a HODLMM pool with no scan row (APR 0): refused, nothing withdrawn", () => {
    const plan = planMigrate(migrate, scoutOf(paired, [option({ pool_id: "dlmm_2", pool: "sBTC-USDCx-1bps" })]));
    expect(plan.status).toBe("refused");
    expect(tools(plan)).toEqual([]);
    expect(reasons(plan)).toContain("No scan data for dlmm_1");
    expect(reasons(plan)).toContain("nothing withdrawn from zest");
  });

  test("migrate sizes YTG on --amount, not on the pre-withdraw row (#491 review 5, point 1)", () => {
    // The row (sized on the wallet before the withdraw) says unprofitable, but
    // --amount ($100 sBTC + $100 USDCx at 600%) easily pays for the gas.
    const rows = [option({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps", ytg_profitable: false, ytg_ratio: 0.4 })];
    const plan = planMigrate(migrate, scoutOf(paired, rows));
    expect(plan.status).toBe("ok");
    // deploy still reads the row
    const dep = planDeploy({ protocol: "hodlmm", token: "sbtc", amount: "100000", poolId: "dlmm_1" }, scoutOf(paired, rows));
    expect(reasons(dep)).toContain("YTG gate");
  });

  test("migrate to a 0% APY protocol: refused", () => {
    const rows = [option({ protocol: "Granite", pool: "aeUSDC lending", apy_pct: 0 })];
    const plan = planMigrate({ from: "zest", to: "granite", amount: "1000000" }, scoutOf(paired, rows));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("APY is 0%");
  });

  test("--force overrides the gate, as on deploy", () => {
    const plan = planMigrate({ ...migrate, force: "true" }, scoutOf(paired, []));
    expect(tools(plan)).toEqual(["zest_withdraw", "bitflow:add-liquidity-simple"]);
  });
});

describe("price feed outage: a held token with no USD value still counts as held (#491 review 2, point 4)", () => {
  // STX balance present, price feed returned nothing for it
  const stxNoPrice = wallet({ stx: { amount: 1000, usd: 0 }, usdcx: usd(1000) });
  const row = option({ pool_id: "dlmm_3", tier: "swap_first" });
  const deploy3 = { protocol: "hodlmm", token: "stx", amount: "100000000", poolId: "dlmm_3" };
  const outage = { stx: 0 };

  test("deploy refuses with the price reason, not 'not held'", () => {
    const plan = planDeploy(deploy3, scoutOf(stxNoPrice, [row], undefined, outage));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("no USD value for STX");
    expect(reasons(plan).includes("not held")).toBe(false);
    expect(reasons(plan).includes("but no STX")).toBe(false);
  });

  test("--allow-one-sided deposits only --amount; the other side is not filled from the whole balance (#491 review 3, point 3)", () => {
    const plan = planDeploy({ ...deploy3, allowOneSided: "true" }, scoutOf(stxNoPrice, [row], undefined, outage));
    expect(plan.status).toBe("ok");
    expect(binsOf(plan)).toEqual([{ activeBinOffset: 0, xAmount: "100000000", yAmount: "0" }]);
    // the other way round: --token usdcx with STX unpriced puts in no STX (gas stays)
    const y = planDeploy({ ...deploy3, token: "usdcx", amount: "50000000", allowOneSided: "true" }, scoutOf(stxNoPrice, [row], undefined, outage));
    expect(binsOf(y)).toEqual([{ activeBinOffset: 0, xAmount: "0", yAmount: "50000000" }]);
  });

  test("an unpriced token on its own: one-sided with --allow-one-sided (the token is held)", () => {
    const plan = planDeploy({ ...deploy3, allowOneSided: "true" }, scoutOf(wallet({ stx: { amount: 1000, usd: 0 } }), [row], undefined, outage));
    expect(plan.status).toBe("ok");
    expect(binsOf(plan).map(b => b.activeBinOffset)).toEqual([1, 2, 3, 4, 5]);
  });

  test("the scan is unchanged: sized on the priced side, swap_first", () => {
    const s = sizeHodlmmOption({ amount: 1000, usd: 0 }, usd(1000), 1000, "STX", "USDCx");
    expect(s.tier).toBe("swap_first");
    expect(s.capUsd).toBe(1000);
  });
});

describe("third review of #491", () => {
  const row = option({ pool_id: "dlmm_3", tier: "swap_first" });

  test("point 2: leftover gas STX ($0.00 after rounding, STX priced) is dust, not an unpriced side", () => {
    const gasDust = wallet({ stx: { amount: 0.004, usd: 0 }, usdcx: usd(1000) });
    const plan = planDeploy({ protocol: "hodlmm", token: "usdcx", amount: "100000000", poolId: "dlmm_3" }, scoutOf(gasDust, [row]));
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("but no STX");
    expect(reasons(plan).includes("no USD value")).toBe(false);
    // the scan says the same, given the prices
    const rows = hodlmmYieldOptions([bitflowPool("dlmm_3", 12)], gasDust as never, { sbtc: 100000, stx: 1, usdcx: 1, usdh: 1, aeusdc: 1 });
    expect(rows[0].tier).toBe("swap_first");
  });

  test("point 3: priced pair sizes the other side from scout.prices, not the rounded usd/amount", () => {
    // the balance says $1/STX (50 STX = $50), scout.prices says $1.25: 0.002 STX is matched with 0.0025 USDCx
    const d = buildDeployInstructions("hodlmm", 2000, "stx",
      scoutOf(wallet({ stx: { amount: 50, usd: 50 }, usdcx: usd(50) }), [row], undefined, { stx: 1.25 }), "dlmm_3", true);
    const add = d.find(i => i.tool === "bitflow:add-liquidity-simple");
    expect(JSON.parse(String(add?.params.bins))).toEqual([{ activeBinOffset: 0, xAmount: "2000", yAmount: "2500" }]);
  });

  test("point 4: migrate refuses an --amount above the post-withdraw balance, before the withdraw", () => {
    const rows = [option({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps" })];
    const positions = { zest: { has_position: true, detail: "", supply_amount: 0.05, supply_apy_pct: 1 } };
    const plan = planMigrate(
      { from: "zest", to: "hodlmm", token: "sbtc", amount: "10000000", poolId: "dlmm_1", allowOneSided: "true" },
      scoutOf(wallet({ usdcx: usd(5000) }), rows, positions),
    );
    expect(plan.status).toBe("refused");
    expect(tools(plan)).toEqual([]);
    expect(reasons(plan)).toContain("Insufficient sbtc balance: have 5000000, requested 10000000");
    expect(reasons(plan)).toContain("nothing withdrawn from zest");
    // the withdrawn sBTC counts: 0.05 sBTC is enough
    const ok = planMigrate(
      { from: "zest", to: "hodlmm", token: "sbtc", amount: "5000000", poolId: "dlmm_1" },
      scoutOf(wallet({ usdcx: usd(5000) }), rows, positions),
    );
    expect(ok.status).toBe("ok");
  });
});

describe("fifth review of #491", () => {
  const usdhRow = option({ protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh" });
  const zestRow = option({ protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC" });
  const zestPos = { zest: { has_position: true, detail: "", supply_amount: 0.00001, supply_apy_pct: 1 } }; // $1 at 1%: ~$0.0002/week
  const usdhWallet = wallet({ usdh: usd(1000) });
  const toHermetica = (amount: string, over: Record<string, string> = {}) =>
    planMigrate({ from: "zest", to: "hermetica", amount, ...over }, scoutOf(usdhWallet, [usdhRow], zestPos));

  test("point 1: a dust --amount is refused by YTG before anything is withdrawn", () => {
    const plan = toHermetica("2000"); // 0.00002 USDh
    expect(plan.status).toBe("refused");
    expect(tools(plan)).toEqual([]);
    expect(reasons(plan)).toContain("YTG gate: net 7d yield change");
    expect(reasons(plan)).toContain("nothing withdrawn from zest");
    // --force still overrides it, and a sensible amount passes
    expect(toHermetica("2000", { force: "true" }).status).toBe("ok");
    expect(toHermetica("100000000000").status).toBe("ok"); // 1,000 USDh
  });

  test("point 1: the withdraw gas counts, not only the deposit gas", () => {
    // 1.7 USDh at 600%: 7d yield ~$0.195. 3x the deposit gas alone (0.05 STX) is
    // $0.15, which would pass; with Zest's withdraw (0.03 STX) it is $0.24.
    const plan = toHermetica("170000000");
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("0.08 STX, withdraw + deposit");
  });

  test("point 1: an --amount with no price can't be sized, so it is refused (--force overrides)", () => {
    const s = scoutOf(usdhWallet, [usdhRow], zestPos, { usdh: 0 });
    const plan = planMigrate({ from: "zest", to: "hermetica", amount: "100000000000" }, s);
    expect(reasons(plan)).toContain("no USD value");
    expect(planMigrate({ from: "zest", to: "hermetica", amount: "100000000000", force: "true" }, s).status).toBe("ok");
  });

  test("point 3: migrate from HODLMM refuses an --amount far above wallet + bins, before the withdraw", () => {
    const positions = { hodlmm: { has_position: true, pools: [{ pool_id: 1, name: "sBTC-USDCx-10bps", estimated_value_usd: 500 }] } };
    const over = planMigrate({ from: "hodlmm", to: "zest", amount: "100000000" }, scoutOf(wallet({}), [zestRow, option({ pool_id: "dlmm_1", apy_pct: 1 }), option({ pool_id: "dlmm_3", apy_pct: 1 })], positions)); // 1 sBTC = $100,000
    expect(over.status).toBe("refused");
    expect(tools(over)).toEqual([]);
    expect(reasons(over)).toContain("plus the HODLMM positions in pools with sbtc ($500)");
    expect(reasons(over)).toContain("nothing withdrawn from hodlmm");
    // $100 of sBTC fits in the $500 of bins
    const ok = planMigrate({ from: "hodlmm", to: "zest", amount: "100000" }, scoutOf(wallet({}), [zestRow, option({ pool_id: "dlmm_1", apy_pct: 1 }), option({ pool_id: "dlmm_3", apy_pct: 1 })], positions));
    expect(ok.status).toBe("ok");
    // no bin estimate: the bound is skipped rather than guessed (the YTG gate
    // refuses an unvalued position, see the sixth review, so --force here)
    const unknown = { hodlmm: { has_position: true, pools: [{ pool_id: 1, name: "sBTC-USDCx-10bps", estimated_value_usd: null }] } };
    expect(planMigrate({ from: "hodlmm", to: "zest", amount: "100000000", force: "true" }, scoutOf(wallet({}), [zestRow], unknown)).status).toBe("ok");
  });
});

describe("sixth review of #491", () => {
  const herm = (apy: number) => option({ protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy });
  const zest10k = (apy: number) => ({ zest: { has_position: true, detail: "", supply_amount: 0.1, supply_apy_pct: apy } }); // $10,000
  const usdh = (n: number) => String(n * 1e8);
  const migrate = (amount: string, rows: YieldOption[], positions: Record<string, unknown>, px: Partial<Px> = {}) =>
    planMigrate({ from: "zest", to: "hermetica", amount }, scoutOf(wallet({ usdh: usd(20000) }), rows, positions, px));

  test("point 1: $100 out of a $10,000 Zest position at 5% is refused; the idle $9,900 stops earning", () => {
    const plan = migrate(usdh(100), [herm(6)], zest10k(5));
    expect(plan.status).toBe("refused");
    expect(tools(plan)).toEqual([]);
    expect(reasons(plan)).toContain("withdrawn position stops earning: -$9.5893");
    // $1,000 at 6% covers the gas on its own (+$1.15/week), but not the
    // $9.59/week the whole $10,000 position stops earning
    expect(migrate(usdh(1000), [herm(6)], {}).status).toBe("ok");
    expect(migrate(usdh(1000), [herm(6)], zest10k(5)).status).toBe("refused");
  });

  test("point 1: the whole position reduces to the APY difference", () => {
    // $10,000 from 5% to 6%: +$1.92/week net, well over 3x 0.08 STX
    expect(migrate(usdh(10000), [herm(6)], zest10k(5)).status).toBe("ok");
    // same APY: nothing gained, so only gas is spent
    expect(reasons(migrate(usdh(10000), [herm(5)], zest10k(5)))).toContain("net 7d yield change $0 ");
  });

  test("point 1: a position that can't be valued is refused, --force overrides", () => {
    const plan = migrate(usdh(100), [herm(6)], zest10k(5), { sbtc: 0 });
    expect(reasons(plan)).toContain("no USD price for the Zest position");
    const forced = planMigrate({ from: "zest", to: "hermetica", amount: usdh(100), force: "true" },
      scoutOf(wallet({ usdh: usd(20000) }), [herm(6)], zest10k(5), { sbtc: 0 }));
    expect(forced.status).toBe("ok");
  });

  test("review pass: no STX price fails closed", () => {
    expect(reasons(migrate(usdh(1000), [herm(6)], {}, { stx: 0 }))).toContain("no STX price");
  });

  test("review pass: the HODLMM bound counts only pools that hold the token", () => {
    const zestRow = option({ protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC" });
    const positions = { hodlmm: { has_position: true, pools: [
      { pool_id: 1, name: "sBTC-USDCx-10bps", estimated_value_usd: 500 },
      { pool_id: 3, name: "STX-USDCx-10bps", estimated_value_usd: 10000 },
    ] } };
    const plan = planMigrate({ from: "hodlmm", to: "zest", amount: "1000000" }, scoutOf(wallet({}), [zestRow, option({ pool_id: "dlmm_1", apy_pct: 1 }), option({ pool_id: "dlmm_3", apy_pct: 1 })], positions)); // 0.01 sBTC = $1,000
    expect(plan.status).toBe("refused");
    expect(reasons(plan)).toContain("pools with sbtc ($500)");
  });
});

describe("seventh review of #491: an unknown source yield is refused, not $0", () => {
  const herm = option({ protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: 6 });
  const toHerm = (positions: Record<string, unknown>, over: Record<string, string> = {}) =>
    planMigrate({ from: "zest", to: "hermetica", amount: String(1000 * 1e8), ...over }, scoutOf(wallet({ usdh: usd(20000) }), [herm], positions));

  test("Zest read failed (no fields): refused, --force overrides", () => {
    const failed = { zest: { has_position: false, detail: "Zest read failed" } };
    expect(reasons(toHerm(failed))).toContain("the Zest position could not be read");
    expect(toHerm(failed, { force: "true" }).status).toBe("ok");
  });

  test("Zest held with APY 0 (a failed rate read also reads 0): refused", () => {
    expect(reasons(toHerm({ zest: { has_position: true, detail: "", supply_amount: 0.1, supply_apy_pct: 0 } }))).toContain("Zest APY reads 0");
  });

  test("Zest read OK, nothing held: $0 lost, the migrate goes ahead", () => {
    expect(toHerm({}).status).toBe("ok");
  });

  test("Granite read failed (no lp_shares): refused", () => {
    const plan = planMigrate({ from: "granite", to: "hermetica", amount: String(1000 * 1e8) },
      scoutOf(wallet({ usdh: usd(20000) }), [herm], { granite: { has_position: false, detail: "Granite read failed", supply_apy_pct: 0, accepted_token: "aeUSDC" } }));
    expect(reasons(plan)).toContain("the Granite position could not be read");
  });

  test("HODLMM pool held with no scan row: refused, as the deploy gate refuses it", () => {
    const zestRow = option({ protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC" });
    const positions = { hodlmm: { has_position: true, pools: [{ pool_id: 1, name: "sBTC-USDCx-10bps", estimated_value_usd: 500 }] } };
    const plan = planMigrate({ from: "hodlmm", to: "zest", amount: "100000" }, scoutOf(wallet({}), [zestRow], positions));
    expect(reasons(plan)).toContain("no scan row (APR) for HODLMM sBTC-USDCx-10bps");
  });

  test("review pass: sUSDh is valued at exchange_rate USDh, not 1:1", () => {
    // 1,000 sUSDh at 1.5 USDh each = $1,500 at 10%: ~$2.877/week stops earning
    const zest5 = option({ protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC", apy_pct: 5 });
    const plan = planMigrate({ from: "hermetica", to: "zest", amount: "100000" },
      scoutOf(wallet({ sbtc: usd(1000, 0.01), susdh: usd(1000) } as never), [zest5],
        { hermetica: { has_position: true, detail: "", susdh_balance: 1000, exchange_rate: 1.5, apy_estimate_pct: 10, staking_enabled: true } }));
    expect(reasons(plan)).toContain("stops earning: -$2.877");
  });
});
