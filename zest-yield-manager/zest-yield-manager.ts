#!/usr/bin/env bun
/**
 * Zest Yield Manager — Autonomous sBTC yield on Zest Protocol
 *
 * Commands: doctor | run | install-packs
 * Actions (run): status | supply | withdraw | claim
 *
 * Built by Secret Mars — tested on mainnet with real sBTC positions.
 * On-chain proof: SP4DXVEC16FS6QR7RBKGWZYJKTXPC81W49W0ATJE has active Zest history.
 */

import { Command } from "commander";
import {
  uintCV,
  principalCV,
  contractPrincipalCV,
  fetchCallReadOnlyFunction,
  cvToJSON,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ── Constants ──────────────────────────────────────────────────────────

const NETWORK = STACKS_MAINNET;
const HIRO_API = "https://api.hiro.so";

// Zest Protocol contracts (mainnet, current versions)
const POOL_BORROW = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const BORROW_HELPER = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7";
const INCENTIVES = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.incentives-v2-2";
const ZSBTC = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0";
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const WSTX = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx";

// Safety defaults
const DEFAULT_MAX_SUPPLY_SATS = 500_000;
const MIN_GAS_USTX = 100_000;

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function output(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function blocked(code: string, message: string, next: string): void {
  output({ status: "blocked", action: next, data: {}, error: { code, message, next } });
}

function error(code: string, message: string, next: string): void {
  output({ status: "error", action: next, data: {}, error: { code, message, next } });
}

function splitContractId(id: string): { address: string; name: string } {
  const [address, name] = id.split(".");
  return { address, name };
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Failed to fetch STX balance: ${res.status}`);
  const data = await res.json();
  return parseInt(data.balance, 10) - parseInt(data.locked, 10);
}

async function getSbtcBalance(address: string): Promise<number> {
  const res = await fetch(
    `${HIRO_API}/extended/v1/address/${address}/balances`
  );
  if (!res.ok) throw new Error(`Failed to fetch balances: ${res.status}`);
  const data = await res.json();
  const ftKey = `${SBTC_TOKEN}::sbtc-token`;
  const sbtcEntry = data.fungible_tokens?.[ftKey];
  return sbtcEntry ? parseInt(sbtcEntry.balance, 10) : 0;
}

async function getZestPosition(address: string): Promise<{ supplied: number; borrowed: number }> {
  const { address: poolAddr, name: poolName } = splitContractId(POOL_BORROW);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);

  try {
    const result = await fetchCallReadOnlyFunction({
      network: NETWORK,
      contractAddress: poolAddr,
      contractName: poolName,
      functionName: "get-user-reserve-data",
      functionArgs: [
        principalCV(address),
        contractPrincipalCV(sbtcAddr, sbtcName),
      ],
      senderAddress: address,
    });

    const json = cvToJSON(result);
    if (json.success && json.value) {
      const val = json.value.value || json.value;
      return {
        supplied: parseInt(val["current-atoken-balance"]?.value || "0", 10),
        borrowed: parseInt(val["current-variable-debt"]?.value || "0", 10),
      };
    }
    return { supplied: 0, borrowed: 0 };
  } catch {
    // Position may not exist yet
    return { supplied: 0, borrowed: 0 };
  }
}

async function getRewardsPending(address: string): Promise<number> {
  const { address: incAddr, name: incName } = splitContractId(INCENTIVES);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);
  const { address: wstxAddr, name: wstxName } = splitContractId(WSTX);

  try {
    const result = await fetchCallReadOnlyFunction({
      network: NETWORK,
      contractAddress: incAddr,
      contractName: incName,
      functionName: "get-vault-rewards",
      functionArgs: [
        principalCV(address),
        contractPrincipalCV(sbtcAddr, sbtcName),
        contractPrincipalCV(wstxAddr, wstxName),
      ],
      senderAddress: address,
    });

    const json = cvToJSON(result);
    if (json.success) {
      return parseInt(json.value?.value || "0", 10);
    }
    return 0;
  } catch {
    return 0;
  }
}

function getWalletAddress(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) {
    error("no_wallet", "No wallet address found. Set STACKS_ADDRESS env var.", "Configure wallet");
    process.exit(1);
  }
  return addr;
}

// ── Commands ───────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const address = getWalletAddress();
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // Check STX balance (for gas)
  try {
    const stxBalance = await getStxBalance(address);
    const hasGas = stxBalance >= MIN_GAS_USTX;
    checks["stx_gas"] = {
      ok: hasGas,
      detail: `${stxBalance} uSTX (need ${MIN_GAS_USTX} min)`,
    };
  } catch (e: any) {
    checks["stx_gas"] = { ok: false, detail: e.message };
  }

  // Check sBTC balance
  try {
    const sbtcBalance = await getSbtcBalance(address);
    checks["sbtc_balance"] = {
      ok: true,
      detail: `${sbtcBalance} sats`,
    };
  } catch (e: any) {
    checks["sbtc_balance"] = { ok: false, detail: e.message };
  }

  // Check Zest contract availability
  try {
    const { address: poolAddr, name: poolName } = splitContractId(POOL_BORROW);
    const res = await fetch(
      `${HIRO_API}/v2/contracts/interface/${poolAddr}/${poolName}`
    );
    checks["zest_pool"] = {
      ok: res.ok,
      detail: res.ok ? `${POOL_BORROW} reachable` : `HTTP ${res.status}`,
    };
  } catch (e: any) {
    checks["zest_pool"] = { ok: false, detail: e.message };
  }

  // Check current position
  try {
    const pos = await getZestPosition(address);
    checks["position"] = {
      ok: true,
      detail: `supplied=${pos.supplied} sats, borrowed=${pos.borrowed} sats`,
    };
  } catch (e: any) {
    checks["position"] = { ok: false, detail: e.message };
  }

  // Check rewards
  try {
    const rewards = await getRewardsPending(address);
    checks["rewards"] = {
      ok: true,
      detail: `${rewards} uSTX pending`,
    };
  } catch (e: any) {
    checks["rewards"] = { ok: false, detail: e.message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  const blockers = Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([k, c]) => `${k}: ${c.detail}`);

  if (allOk) {
    output({
      status: "success",
      action: "Environment ready. Run with --action=status to check position.",
      data: { checks, address },
      error: null,
    });
  } else {
    output({
      status: "blocked",
      action: "Fix blockers before proceeding",
      data: { checks, address, blockers },
      error: {
        code: "doctor_failed",
        message: blockers.join("; "),
        next: "Resolve the listed issues and re-run doctor",
      },
    });
  }
}

async function runStatus(address: string): Promise<void> {
  const [stxBalance, sbtcBalance, position, rewards] = await Promise.all([
    getStxBalance(address),
    getSbtcBalance(address),
    getZestPosition(address),
    getRewardsPending(address),
  ]);

  output({
    status: "success",
    action:
      position.supplied > 0
        ? rewards > 1000
          ? "Rewards available — consider claiming with --action=claim"
          : "Position healthy. No action needed."
        : sbtcBalance > 0
        ? "Idle sBTC detected — consider supplying with --action=supply"
        : "No sBTC to manage.",
    data: {
      position: {
        supplied_sats: position.supplied,
        borrowed_sats: position.borrowed,
        rewards_pending_ustx: rewards,
        asset: "sBTC",
      },
      balances: {
        sbtc_sats: sbtcBalance,
        stx_ustx: stxBalance,
      },
    },
    error: null,
  });
}

async function runSupply(
  address: string,
  amountSats: number,
  maxSupply: number
): Promise<void> {
  // Safety: enforce spend limit
  if (amountSats > maxSupply) {
    blocked(
      "exceeds_limit",
      `Requested ${amountSats} sats exceeds max supply limit of ${maxSupply} sats`,
      `Reduce amount or set --max-supply-sats=${amountSats} to override`
    );
    return;
  }

  if (amountSats <= 0) {
    error("invalid_amount", "Supply amount must be positive", "Specify --amount=<sats>");
    return;
  }

  // Check balances
  const [stxBalance, sbtcBalance] = await Promise.all([
    getStxBalance(address),
    getSbtcBalance(address),
  ]);

  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_GAS_USTX} uSTX for gas`,
      "Acquire STX for transaction fees"
    );
    return;
  }

  if (sbtcBalance < amountSats) {
    blocked(
      "insufficient_sbtc",
      `sBTC balance ${sbtcBalance} sats < requested supply of ${amountSats} sats`,
      `Reduce amount to at most ${sbtcBalance} sats`
    );
    return;
  }

  // Build the supply transaction via borrow-helper
  const { address: helperAddr, name: helperName } = splitContractId(BORROW_HELPER);
  const { address: sbtcAddr, name: sbtcName } = splitContractId(SBTC_TOKEN);
  const { address: zsbtcAddr, name: zsbtcName } = splitContractId(ZSBTC);

  try {
    // Use MCP tool for actual broadcast (this skill generates the parameters)
    // In production, the agent framework calls the contract
    output({
      status: "success",
      action: "Execute supply transaction via MCP zest_supply tool",
      data: {
        operation: "supply",
        asset: "sBTC",
        amount_sats: amountSats,
        contract: BORROW_HELPER,
        function: "supply",
        args: {
          asset: SBTC_TOKEN,
          amount: amountSats.toString(),
          note: "Uses borrow-helper-v2-1-7 which handles Pyth oracle fee automatically",
        },
        mcp_command: {
          tool: "zest_supply",
          params: { asset: "sBTC", amount: amountSats.toString() },
        },
        pre_checks_passed: {
          gas_sufficient: true,
          balance_sufficient: true,
          within_spend_limit: true,
          stx_balance: stxBalance,
          sbtc_balance: sbtcBalance,
        },
      },
      error: null,
    });
  } catch (e: any) {
    error("supply_failed", e.message, "Check error and retry");
  }
}

async function runWithdraw(address: string, amountSats: number): Promise<void> {
  if (amountSats <= 0) {
    error("invalid_amount", "Withdraw amount must be positive", "Specify --amount=<sats>");
    return;
  }

  const [stxBalance, position] = await Promise.all([
    getStxBalance(address),
    getZestPosition(address),
  ]);

  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_GAS_USTX} uSTX for gas`,
      "Acquire STX for transaction fees"
    );
    return;
  }

  if (position.supplied < amountSats) {
    blocked(
      "insufficient_position",
      `Supplied ${position.supplied} sats < requested withdrawal of ${amountSats} sats`,
      `Reduce amount to at most ${position.supplied} sats, or use --amount=${position.supplied} for full withdrawal`
    );
    return;
  }

  output({
    status: "success",
    action: "Execute withdraw transaction via MCP zest_withdraw tool",
    data: {
      operation: "withdraw",
      asset: "sBTC",
      amount_sats: amountSats,
      contract: BORROW_HELPER,
      function: "withdraw",
      mcp_command: {
        tool: "zest_withdraw",
        params: { asset: "sBTC", amount: amountSats.toString() },
      },
      pre_checks_passed: {
        gas_sufficient: true,
        position_sufficient: true,
        current_supplied: position.supplied,
      },
    },
    error: null,
  });
}

async function runClaim(address: string): Promise<void> {
  const [stxBalance, rewards] = await Promise.all([
    getStxBalance(address),
    getRewardsPending(address),
  ]);

  if (stxBalance < MIN_GAS_USTX) {
    blocked(
      "insufficient_gas",
      `STX balance ${stxBalance} uSTX < minimum ${MIN_GAS_USTX}`,
      "Acquire STX for transaction fees"
    );
    return;
  }

  if (rewards === 0) {
    output({
      status: "success",
      action: "No rewards to claim. Check again after more time accrues.",
      data: { rewards_ustx: 0, note: "wSTX incentives accrue over time based on supply amount" },
      error: null,
    });
    return;
  }

  output({
    status: "success",
    action: "Execute claim transaction via MCP zest_claim_rewards tool",
    data: {
      operation: "claim",
      asset: "sBTC",
      rewards_ustx: rewards,
      contract: INCENTIVES,
      function: "claim-rewards",
      mcp_command: {
        tool: "zest_claim_rewards",
        params: { asset: "sBTC" },
      },
      pre_checks_passed: {
        gas_sufficient: true,
        rewards_available: rewards > 0,
      },
    },
    error: null,
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("zest-yield-manager")
  .description(
    "Autonomous sBTC yield management on Zest Protocol — supply, withdraw, claim rewards, and monitor positions"
  )
  .version("0.1.0");

program
  .command("doctor")
  .description("Check environment readiness: wallet, balances, Zest contract availability, position, and rewards")
  .action(async () => {
    await doctor();
  });

program
  .command("run")
  .description("Execute a yield management action: status, supply, withdraw, or claim")
  .option("--action <action>", "Action to perform: status | supply | withdraw | claim", "status")
  .option("--amount <sats>", "Amount in sats for supply/withdraw operations", "0")
  .option("--max-supply-sats <sats>", "Maximum sats allowed in a single supply call", String(DEFAULT_MAX_SUPPLY_SATS))
  .action(async (opts: { action: string; amount: string; maxSupplySats: string }) => {
    const address = getWalletAddress();
    const action = opts.action;
    const amount = parseInt(opts.amount, 10);
    const maxSupply = parseInt(opts.maxSupplySats, 10);

    switch (action) {
      case "status":
        await runStatus(address);
        break;
      case "supply":
        await runSupply(address, amount, maxSupply);
        break;
      case "withdraw":
        await runWithdraw(address, amount);
        break;
      case "claim":
        await runClaim(address);
        break;
      default:
        error(
          "unknown_action",
          `Unknown action: ${action}`,
          "Use --action=status|supply|withdraw|claim"
        );
    }
  });

program
  .command("install-packs")
  .description("Check and report on required dependency packages")
  .option("--pack <name>", "Specific package to check")
  .action(async () => {
    const deps = ["@stacks/transactions", "@stacks/network"];
    const missing: string[] = [];
    for (const dep of deps) {
      try {
        require.resolve(dep);
      } catch {
        missing.push(dep);
      }
    }
    if (missing.length > 0) {
      console.log(
        JSON.stringify({
          status: "success",
          action: `Install missing packages: bun add ${missing.join(" ")}`,
          data: { required: deps, missing, installed: deps.filter((d) => !missing.includes(d)) },
          error: null,
        })
      );
    } else {
      console.log(
        JSON.stringify({
          status: "success",
          action: "All dependencies installed",
          data: { required: deps, missing: [], installed: deps },
          error: null,
        })
      );
    }
  });

program.parse(process.argv);
