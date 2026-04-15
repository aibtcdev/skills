#!/usr/bin/env bun
/**
 * Stacking Delegation — Monitor and manage STX stacking positions
 *
 * Commands: doctor | run | install-packs
 * Run actions: status | rewards | pox-info
 *
 * Checks stacking status, PoX cycle info, and reward eligibility
 * for any Stacks address. Helps agents decide when to delegate,
 * extend, or revoke stacking.
 */

import { Command } from "commander";

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 10_000;

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

function out(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function errOut(action: string, code: string, message: string, next: string): void {
  out({ status: "error", action, data: {}, error: { code, message, next } });
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const program = new Command();
program
  .name("stacking-delegation")
  .description("Monitor and manage STX stacking positions");

program
  .command("doctor")
  .description("Check Hiro PoX API availability")
  .action(async () => {
    try {
      const res = await fetchWithTimeout(`${HIRO_API}/v2/pox`);
      if (!res.ok) {
        errOut("doctor", "API_DOWN", `Hiro PoX returned ${res.status}`, "Retry later");
        return;
      }
      const data = await res.json() as { current_cycle: { id: number } };
      out({
        status: "success",
        action: "doctor",
        data: { hiro_pox: "healthy", current_cycle: data.current_cycle?.id },
        error: null,
      });
    } catch (e: unknown) {
      errOut("doctor", "UNREACHABLE", e instanceof Error ? e.message : String(e), "Check network");
    }
  });

const runCmd = program.command("run").description("Stacking commands");

runCmd
  .command("status")
  .description("Check stacking status for an address")
  .requiredOption("--stx-address <addr>", "Stacks address to check")
  .action(async (opts: { stxAddress: string }) => {
    try {
      const [stackingRes, balRes] = await Promise.all([
        fetchWithTimeout(`${HIRO_API}/extended/v1/address/${opts.stxAddress}/stx`),
        fetchWithTimeout(`${HIRO_API}/v2/pox`),
      ]);

      if (!stackingRes.ok || !balRes.ok) {
        errOut("status", "FETCH_ERROR", "Failed to fetch stacking data", "Check address format");
        return;
      }

      const stxData = await stackingRes.json() as {
        balance: string;
        locked: string;
        burnchain_unlock_height: number;
        lock_height: number;
        lock_tx_id: string;
      };
      const poxData = await balRes.json() as {
        current_cycle: { id: number; min_threshold_ustx: number };
        next_cycle: { id: number; min_threshold_ustx: number; blocks_until_prepare_phase: number; blocks_until_reward_phase: number };
        reward_cycle_length: number;
      };

      const balance = parseInt(stxData.balance, 10);
      const locked = parseInt(stxData.locked, 10);
      const available = balance - locked;
      const isStacking = locked > 0;
      const meetsMin = available >= poxData.current_cycle.min_threshold_ustx;

      const signals: string[] = [];
      if (!isStacking && meetsMin) signals.push("ELIGIBLE: Available STX meets solo stacking minimum — can delegate to a pool");
      if (!isStacking && !meetsMin && available > 0) signals.push("POOL_ELIGIBLE: Below solo threshold but any positive balance qualifies for pool delegation");
      if (!isStacking && available === 0) signals.push("NO_STX: No available STX to delegate");
      if (isStacking) signals.push(`STACKING: ${(locked / 1_000_000).toFixed(2)} STX locked until burnchain height ${stxData.burnchain_unlock_height}`);
      if (isStacking && available > 1_000_000) signals.push("ADDITIONAL: Unlocked STX available — could delegate more");

      out({
        status: "success",
        action: "status",
        data: {
          address: opts.stxAddress,
          balance_ustx: balance,
          balance_stx: (balance / 1_000_000).toFixed(6),
          locked_ustx: locked,
          locked_stx: (locked / 1_000_000).toFixed(6),
          available_ustx: available,
          available_stx: (available / 1_000_000).toFixed(6),
          is_stacking: isStacking,
          unlock_height: stxData.burnchain_unlock_height || null,
          lock_tx: stxData.lock_tx_id || null,
          current_cycle: poxData.current_cycle.id,
          min_threshold_stx: (poxData.current_cycle.min_threshold_ustx / 1_000_000).toFixed(0),
          meets_minimum: meetsMin,
          signals,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("status", "FETCH_ERROR", e instanceof Error ? e.message : String(e), "Check address and network");
    }
  });

runCmd
  .command("pox-info")
  .description("Current PoX cycle info and timing")
  .action(async () => {
    try {
      const res = await fetchWithTimeout(`${HIRO_API}/v2/pox`);
      if (!res.ok) {
        errOut("pox-info", "FETCH_ERROR", `Hiro returned ${res.status}`, "Retry later");
        return;
      }
      const data = await res.json() as {
        contract_id: string;
        current_cycle: { id: number; min_threshold_ustx: number; stacked_ustx: number };
        next_cycle: { id: number; min_threshold_ustx: number; blocks_until_prepare_phase: number; blocks_until_reward_phase: number; stacked_ustx: number };
        reward_cycle_length: number;
        current_burnchain_block_height: number;
        prepare_phase_block_length: number;
      };

      const inPrepare = data.next_cycle.blocks_until_prepare_phase <= 0;

      out({
        status: "success",
        action: "pox-info",
        data: {
          contract: data.contract_id,
          current_cycle: {
            id: data.current_cycle.id,
            min_threshold_stx: (data.current_cycle.min_threshold_ustx / 1_000_000).toFixed(0),
            total_stacked_stx: (data.current_cycle.stacked_ustx / 1_000_000).toFixed(0),
          },
          next_cycle: {
            id: data.next_cycle.id,
            min_threshold_stx: (data.next_cycle.min_threshold_ustx / 1_000_000).toFixed(0),
            blocks_until_prepare: data.next_cycle.blocks_until_prepare_phase,
            blocks_until_reward: data.next_cycle.blocks_until_reward_phase,
          },
          timing: {
            cycle_length_blocks: data.reward_cycle_length,
            prepare_length_blocks: data.prepare_phase_block_length,
            current_block: data.current_burnchain_block_height,
            in_prepare_phase: inPrepare,
          },
          note: inPrepare
            ? "Prepare phase active — delegations for next cycle must be committed now"
            : `${data.next_cycle.blocks_until_prepare_phase} blocks until prepare phase (~${Math.round(data.next_cycle.blocks_until_prepare_phase * 10 / 60)} hours)`,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("pox-info", "FETCH_ERROR", e instanceof Error ? e.message : String(e), "Check network");
    }
  });

runCmd
  .command("rewards")
  .description("Check recent stacking reward payouts for an address")
  .requiredOption("--btc-address <addr>", "BTC reward address")
  .action(async (opts: { btcAddress: string }) => {
    try {
      const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/burnchain/rewards/${opts.btcAddress}?limit=10`);
      if (!res.ok) {
        errOut("rewards", "FETCH_ERROR", `Hiro returned ${res.status}`, "Check BTC address format");
        return;
      }
      const data = await res.json() as { results: Array<{ reward_amount: string; burn_block_height: number; burn_block_hash: string }> };

      const rewards = data.results.map(r => ({
        amount_sats: parseInt(r.reward_amount, 10),
        amount_btc: (parseInt(r.reward_amount, 10) / 100_000_000).toFixed(8),
        block_height: r.burn_block_height,
      }));

      const totalSats = rewards.reduce((sum, r) => sum + r.amount_sats, 0);

      out({
        status: "success",
        action: "rewards",
        data: {
          btc_address: opts.btcAddress,
          recent_rewards: rewards,
          total_recent_sats: totalSats,
          total_recent_btc: (totalSats / 100_000_000).toFixed(8),
          count: rewards.length,
        },
        error: null,
      });
    } catch (e: unknown) {
      errOut("rewards", "FETCH_ERROR", e instanceof Error ? e.message : String(e), "Check address and network");
    }
  });

program
  .command("install-packs")
  .description("Install dependencies")
  .action(() => {
    try {
      const result = Bun.spawnSync(["bun", "add", "commander"], { stdio: ["pipe", "pipe", "pipe"] });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      out({ status: "success", action: "install-packs", data: { installed: ["commander"] }, error: null });
    } catch (e: unknown) {
      errOut("install-packs", "INSTALL_FAIL", e instanceof Error ? e.message : String(e), "Run 'bun add commander' manually");
    }
  });

program.parse();
