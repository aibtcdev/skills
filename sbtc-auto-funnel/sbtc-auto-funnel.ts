#!/usr/bin/env bun
/**
 * sBTC Auto-Funnel — Route excess sBTC above reserve to Zest yield
 *
 * Commands: doctor | run | install-packs
 * Actions (run): check | funnel
 *
 * Built by Secret Mars. On-chain proof:
 * - Zest supply 70k: aed49fc3d702655343f2b983109b6ecb9d0f37b07c7a2a1198338689f67d7543
 * - Zest supply 175k: previous cycle (confirmed on-chain)
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

// Safety defaults — hardcoded floors, not just documentation
const DEFAULT_RESERVE_SATS = 200_000;
const MIN_RESERVE_SATS = 50_000;      // hard floor — cannot go lower
const MIN_FUNNEL_SATS = 10_000;       // don't supply dust (gas > yield)
const MIN_GAS_USTX = 150_000;         // need STX for tx fees

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

// ── Balance Reads ──────────────────────────────────────────────────────

async function getSbtcBalance(address: string): Promise<number> {
  // Read sBTC balance via Hiro API (fungible token balance)
  const [contractAddr, contractName] = SBTC_CONTRACT.split(".");
  const url = `${HIRO_API}/extended/v1/address/${address}/balances`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hiro API ${resp.status}: ${resp.statusText}`);

  const data = await resp.json() as {
    fungible_tokens: Record<string, { balance: string }>;
  };

  const key = `${SBTC_CONTRACT}::sbtc-token`;
  const entry = data.fungible_tokens[key];
  if (!entry) return 0;
  return parseInt(entry.balance, 10);
}

async function getStxBalance(address: string): Promise<number> {
  const url = `${HIRO_API}/extended/v1/address/${address}/stx`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hiro API ${resp.status}: ${resp.statusText}`);
  const data = await resp.json() as { balance: string };
  return parseInt(data.balance, 10);
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(address: string): Promise<void> {
  const checks: Record<string, boolean> = {
    address_set: false,
    hiro_api: false,
    sbtc_readable: false,
    stx_gas_ok: false,
  };

  // Check address
  if (!address) {
    emit({
      status: "error",
      action: "Provide --address <stx_address> or set via wallet",
      data: { checks },
      error: { code: "NO_ADDRESS", message: "No Stacks address provided", next: "Pass --address flag or ensure wallet is configured" },
    });
    return;
  }
  checks.address_set = true;

  // Check Hiro API
  try {
    const resp = await fetch(`${HIRO_API}/v2/info`);
    checks.hiro_api = resp.ok;
  } catch {
    checks.hiro_api = false;
  }

  // Check sBTC balance readable
  try {
    await getSbtcBalance(address);
    checks.sbtc_readable = true;
  } catch {
    checks.sbtc_readable = false;
  }

  // Check STX gas
  try {
    const stx = await getStxBalance(address);
    checks.stx_gas_ok = stx >= MIN_GAS_USTX;
  } catch {
    checks.stx_gas_ok = false;
  }

  const allOk = Object.values(checks).every(Boolean);
  emit({
    status: allOk ? "success" : "error",
    action: allOk ? "All pre-flight checks passed" : "Some checks failed — see data",
    data: { checks, address },
    error: allOk ? null : { code: "DOCTOR_FAIL", message: "Pre-flight checks incomplete", next: "Fix failing checks before running funnel" },
  });
}

async function check(address: string, reserve: number): Promise<void> {
  if (!address) {
    emit({
      status: "error",
      action: "Provide --address <stx_address>",
      data: {},
      error: { code: "NO_ADDRESS", message: "No Stacks address provided", next: "Pass --address flag" },
    });
    return;
  }

  const sbtcBalance = await getSbtcBalance(address);
  const stxBalance = await getStxBalance(address);

  const excess = Math.max(0, sbtcBalance - reserve);
  // Round down to nearest 1000 for clean supply amounts
  const funnelAmount = Math.floor(excess / 1000) * 1000;
  const actionable = funnelAmount >= MIN_FUNNEL_SATS && stxBalance >= MIN_GAS_USTX;

  emit({
    status: "success",
    action: actionable
      ? `${funnelAmount} sats excess — ready to funnel to Zest`
      : excess > 0
        ? `${excess} sats excess but below minimum funnel (${MIN_FUNNEL_SATS}) or gas insufficient`
        : "No excess — balance at or below reserve",
    data: {
      balance: {
        sbtc_liquid: sbtcBalance,
        reserve_threshold: reserve,
        excess,
        funnel_amount: funnelAmount,
        stx_gas_ustx: stxBalance,
        gas_sufficient: stxBalance >= MIN_GAS_USTX,
      },
      actionable,
    },
    error: null,
  });
}

async function funnel(address: string, reserve: number): Promise<void> {
  if (!address) {
    emit({
      status: "error",
      action: "Provide --address <stx_address>",
      data: {},
      error: { code: "NO_ADDRESS", message: "No Stacks address provided", next: "Pass --address flag" },
    });
    return;
  }

  const sbtcBalance = await getSbtcBalance(address);
  const stxBalance = await getStxBalance(address);

  // Validate gas
  if (stxBalance < MIN_GAS_USTX) {
    emit({
      status: "blocked",
      action: "Insufficient STX gas — acquire STX before funneling",
      data: { stx_balance_ustx: stxBalance, min_required_ustx: MIN_GAS_USTX },
      error: { code: "LOW_GAS", message: `STX balance ${stxBalance} < ${MIN_GAS_USTX} uSTX`, next: "Fund wallet with STX for gas" },
    });
    return;
  }

  // Calculate funnel amount
  const excess = Math.max(0, sbtcBalance - reserve);
  const funnelAmount = Math.floor(excess / 1000) * 1000;

  if (funnelAmount < MIN_FUNNEL_SATS) {
    emit({
      status: "blocked",
      action: excess > 0
        ? `Excess ${excess} sats below minimum funnel amount (${MIN_FUNNEL_SATS})`
        : "No excess to funnel — balance at or below reserve",
      data: {
        sbtc_liquid: sbtcBalance,
        reserve_threshold: reserve,
        excess,
        min_funnel: MIN_FUNNEL_SATS,
      },
      error: { code: "BELOW_MIN", message: `Funnel amount ${funnelAmount} < ${MIN_FUNNEL_SATS}`, next: "Wait for more sBTC revenue" },
    });
    return;
  }

  // Output the MCP command (do NOT execute)
  emit({
    status: "success",
    action: `Ready to funnel ${funnelAmount} sats to Zest. Execute the mcp_command below.`,
    data: {
      balance: {
        sbtc_liquid: sbtcBalance,
        reserve_threshold: reserve,
        excess,
        funnel_amount: funnelAmount,
        remaining_after: sbtcBalance - funnelAmount,
      },
      mcp_command: {
        tool: "zest_supply",
        params: {
          asset: "sBTC",
          amount: String(funnelAmount),
        },
      },
      safety: {
        reserve_enforced: true,
        min_funnel_enforced: funnelAmount >= MIN_FUNNEL_SATS,
        gas_sufficient: true,
        supply_only: true,
        auto_execute: false,
      },
    },
    error: null,
  });
}

// ── CLI (Commander.js) ────────────────────────────────────────────────

const program = new Command();

program
  .name("sbtc-auto-funnel")
  .description("Route excess sBTC above reserve to Zest yield");

program
  .command("doctor")
  .description("Pre-flight checks: wallet, API, gas")
  .option("--address <stx_address>", "Stacks address")
  .action(async (opts: { address?: string }) => {
    await doctor(opts.address || "");
  });

program
  .command("run")
  .description("Check balance or funnel excess to Zest")
  .requiredOption("--action <action>", "Action to perform: check | funnel")
  .option("--address <stx_address>", "Stacks address")
  .option("--reserve <sats>", "Reserve threshold in sats", String(DEFAULT_RESERVE_SATS))
  .action(async (opts: { action: string; address?: string; reserve: string }) => {
    const address = opts.address || "";
    const parsedReserve = parseInt(opts.reserve, 10);
    const reserve = isNaN(parsedReserve) ? DEFAULT_RESERVE_SATS : Math.max(parsedReserve, MIN_RESERVE_SATS);

    switch (opts.action) {
      case "check":
        await check(address, reserve);
        break;
      case "funnel":
        await funnel(address, reserve);
        break;
      default:
        emit({
          status: "error",
          action: `Unknown action: ${opts.action}`,
          data: { valid_actions: ["check", "funnel"] },
          error: { code: "BAD_ACTION", message: `Unknown action '${opts.action}'`, next: "Use --action=check or --action=funnel" },
        });
    }
  });

program
  .command("install-packs")
  .description("Install dependencies (none required)")
  .action(() => {
    emit({
      status: "success",
      action: "No additional packages required — uses native fetch API",
      data: {},
      error: null,
    });
  });

program.parseAsync().catch((err) => {
  emit({
    status: "error",
    action: "Unexpected error",
    data: {},
    error: { code: "UNHANDLED", message: String(err), next: "Check logs and retry" },
  });
  process.exit(1);
});
