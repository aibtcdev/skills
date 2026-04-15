#!/usr/bin/env bun
/**
 * Contract Pre-Flight — Dry-run Stacks contract calls before broadcast
 *
 * Commands: doctor | run | install-packs
 * Actions (run): simulate | batch
 *
 * Built by Secret Mars. Uses stxer simulation API to evaluate Clarity
 * expressions against current mainnet state without broadcasting.
 * Catches runtime errors, insufficient balances, and logic failures
 * before they cost gas or abort on-chain.
 *
 * Proof of operation:
 * - Session d1c27b645459c702feae3a7a637a4777: get-balance simulation → (ok u276016)
 * - Error catch: transfer u99999999 → (err u1) detected pre-broadcast
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────

const STXER_API = "https://api.stxer.xyz";
const STXER_SIM_URL = `${STXER_API}/devtools/v2/simulations`;
const STXER_BATCH_URL = `${STXER_API}/sidecar/v2/batch`;

// Safety limits
const MAX_STEPS_PER_SESSION = 20;     // prevent runaway simulations
const SIM_TIMEOUT_MS = 15_000;        // 15s timeout per simulation
const MAX_EXPRESSION_LENGTH = 2_000;  // prevent absurdly long Clarity expressions

// Clarity type prefixes for decoding
const CLARITY_TYPES: Record<string, string> = {
  "00": "int",
  "01": "uint",
  "03": "true",
  "04": "false",
  "05": "principal",
  "06": "contract-principal",
  "07": "ok",
  "08": "err",
  "09": "none",
  "0a": "some",
};

// ── Types ──────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface SimStep {
  sender: string;
  sponsor?: string;
  contract: string;
  expression: string;
}

interface SimResult {
  step_index: number;
  expression: string;
  outcome: "ok" | "err" | "runtime_error";
  raw_hex: string;
  decoded: string;
  safe_to_broadcast: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function emit(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function decodeResultType(hex: string): { outcome: "ok" | "err" | "runtime_error"; value: string } {
  if (!hex || hex.length < 4) {
    return { outcome: "runtime_error", value: `unparseable: ${hex}` };
  }

  const prefix = hex.substring(0, 2);
  const responsePrefix = hex.substring(2, 4);

  // Response types: 07 = ok, 08 = err
  if (prefix === "07") {
    const innerType = CLARITY_TYPES[responsePrefix] || "unknown";
    const valueHex = hex.substring(4);
    const value = decodeValue(responsePrefix, valueHex);
    return { outcome: "ok", value: `(ok ${innerType} ${value})` };
  }
  if (prefix === "08") {
    const innerType = CLARITY_TYPES[responsePrefix] || "unknown";
    const valueHex = hex.substring(4);
    const value = decodeValue(responsePrefix, valueHex);
    return { outcome: "err", value: `(err ${innerType} ${value})` };
  }

  // Direct value (not wrapped in response)
  const type = CLARITY_TYPES[prefix] || "unknown";
  const valueHex = hex.substring(2);
  const value = decodeValue(prefix, valueHex);
  return { outcome: "ok", value: `${type} ${value}` };
}

function decodeValue(typePrefix: string, valueHex: string): string {
  if (typePrefix === "01") {
    // uint — 16-byte big-endian
    return BigInt("0x" + valueHex).toString();
  }
  if (typePrefix === "00") {
    // int — 16-byte big-endian signed
    const n = BigInt("0x" + valueHex);
    const max128 = BigInt(1) << BigInt(127);
    return (n >= max128 ? n - (BigInt(1) << BigInt(128)) : n).toString();
  }
  if (typePrefix === "03") return "true";
  if (typePrefix === "04") return "false";
  if (typePrefix === "09") return "none";
  return valueHex;
}

// ── Simulation Engine ─────────────────────────────────────────────────

async function createSession(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIM_TIMEOUT_MS);

  try {
    const resp = await fetch(STXER_SIM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skip_tracing: true }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`stxer session creation failed: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json() as { id: string };
    return data.id;
  } finally {
    clearTimeout(timeout);
  }
}

async function runSimulation(sessionId: string, steps: SimStep[]): Promise<SimResult[]> {
  if (steps.length > MAX_STEPS_PER_SESSION) {
    throw new Error(`Too many steps: ${steps.length} > ${MAX_STEPS_PER_SESSION}`);
  }

  const evalSteps = steps.map((s) => ({
    Eval: [s.sender, s.sponsor || "", s.contract, s.expression],
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIM_TIMEOUT_MS);

  try {
    const resp = await fetch(`${STXER_SIM_URL}/${sessionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ steps: evalSteps }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`stxer simulation failed: ${resp.status} ${body}`);
    }

    const data = await resp.json() as {
      steps: Array<{ Eval: { Ok?: string; Err?: string } }>;
    };

    return data.steps.map((step, i) => {
      const eval_ = step.Eval;
      if (eval_.Ok) {
        const decoded = decodeResultType(eval_.Ok);
        return {
          step_index: i,
          expression: steps[i].expression,
          outcome: decoded.outcome,
          raw_hex: eval_.Ok,
          decoded: decoded.value,
          safe_to_broadcast: decoded.outcome === "ok",
        };
      } else {
        return {
          step_index: i,
          expression: steps[i].expression,
          outcome: "runtime_error" as const,
          raw_hex: "",
          decoded: eval_.Err || "unknown error",
          safe_to_broadcast: false,
        };
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Commands ──────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
  const checks: Record<string, string> = {};

  // Check stxer API availability
  try {
    const resp = await fetch(`${STXER_API}/sidecar/v2/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stx: [] }),
    });
    checks["stxer_api"] = resp.ok ? "ok" : `error: ${resp.status}`;
  } catch (e) {
    checks["stxer_api"] = `unreachable: ${(e as Error).message}`;
  }

  // Check simulation endpoint
  try {
    const sessionId = await createSession();
    checks["simulation_engine"] = `ok (session: ${sessionId})`;
  } catch (e) {
    checks["simulation_engine"] = `error: ${(e as Error).message}`;
  }

  // Check Bun runtime
  checks["runtime"] = typeof Bun !== "undefined" ? "bun" : "node";

  const allOk = checks["stxer_api"]?.startsWith("ok") && checks["simulation_engine"]?.startsWith("ok");

  emit({
    status: allOk ? "success" : "error",
    action: "doctor",
    data: { checks },
    error: allOk ? null : {
      code: "DOCTOR_FAIL",
      message: "One or more pre-flight checks failed",
      next: "Verify network connectivity to api.stxer.xyz",
    },
  });
}

async function simulate(opts: {
  sender: string;
  contract: string;
  expression: string;
  sponsor?: string;
}): Promise<void> {
  // Validate inputs
  if (!opts.sender || !opts.contract || !opts.expression) {
    emit({
      status: "error",
      action: "simulate",
      data: {},
      error: {
        code: "MISSING_ARGS",
        message: "Required: --sender, --contract, --expression",
        next: "Provide all three arguments. Example: --sender SP... --contract SP...contract-name --expression '(contract-call? .contract fn args)'",
      },
    });
    return;
  }

  if (opts.expression.length > MAX_EXPRESSION_LENGTH) {
    emit({
      status: "blocked",
      action: "simulate",
      data: { expression_length: opts.expression.length, max: MAX_EXPRESSION_LENGTH },
      error: {
        code: "EXPRESSION_TOO_LONG",
        message: `Expression exceeds ${MAX_EXPRESSION_LENGTH} chars`,
        next: "Simplify the expression or split into multiple steps",
      },
    });
    return;
  }

  try {
    const sessionId = await createSession();
    const results = await runSimulation(sessionId, [{
      sender: opts.sender,
      sponsor: opts.sponsor,
      contract: opts.contract,
      expression: opts.expression,
    }]);

    const result = results[0];

    emit({
      status: result.safe_to_broadcast ? "success" : "error",
      action: "simulate",
      data: {
        session_id: sessionId,
        result: {
          outcome: result.outcome,
          decoded: result.decoded,
          raw_hex: result.raw_hex,
          safe_to_broadcast: result.safe_to_broadcast,
        },
        recommendation: result.safe_to_broadcast
          ? "Simulation passed. Safe to broadcast this contract call."
          : "Simulation returned an error. Do NOT broadcast — the transaction would abort on-chain and waste gas.",
      },
      error: result.safe_to_broadcast ? null : {
        code: "SIM_FAILED",
        message: `Contract call would fail: ${result.decoded}`,
        next: "Fix the contract call parameters and re-simulate before broadcasting",
      },
    });
  } catch (e) {
    emit({
      status: "error",
      action: "simulate",
      data: {},
      error: {
        code: "SIM_ERROR",
        message: (e as Error).message,
        next: "Check stxer API availability with 'doctor' command",
      },
    });
  }
}

async function batch(opts: {
  sender: string;
  steps: string;  // JSON string of steps array
  sponsor?: string;
}): Promise<void> {
  if (!opts.sender || !opts.steps) {
    emit({
      status: "error",
      action: "batch",
      data: {},
      error: {
        code: "MISSING_ARGS",
        message: "Required: --sender, --steps (JSON array of {contract, expression})",
        next: 'Example: --steps \'[{"contract":"SP...name","expression":"(contract-call? ...)"}]\'',
      },
    });
    return;
  }

  let parsedSteps: Array<{ contract: string; expression: string }>;
  try {
    parsedSteps = JSON.parse(opts.steps);
  } catch {
    emit({
      status: "error",
      action: "batch",
      data: {},
      error: {
        code: "INVALID_JSON",
        message: "Could not parse --steps as JSON",
        next: "Provide valid JSON array",
      },
    });
    return;
  }

  if (!Array.isArray(parsedSteps) || parsedSteps.length === 0) {
    emit({
      status: "error",
      action: "batch",
      data: {},
      error: {
        code: "EMPTY_STEPS",
        message: "Steps array is empty",
        next: "Provide at least one step",
      },
    });
    return;
  }

  if (parsedSteps.length > MAX_STEPS_PER_SESSION) {
    emit({
      status: "blocked",
      action: "batch",
      data: { step_count: parsedSteps.length, max: MAX_STEPS_PER_SESSION },
      error: {
        code: "TOO_MANY_STEPS",
        message: `${parsedSteps.length} steps exceeds limit of ${MAX_STEPS_PER_SESSION}`,
        next: "Split into multiple batch calls",
      },
    });
    return;
  }

  try {
    const sessionId = await createSession();
    const simSteps: SimStep[] = parsedSteps.map((s) => ({
      sender: opts.sender,
      sponsor: opts.sponsor,
      contract: s.contract,
      expression: s.expression,
    }));

    const results = await runSimulation(sessionId, simSteps);
    const allSafe = results.every((r) => r.safe_to_broadcast);
    const firstFailure = results.find((r) => !r.safe_to_broadcast);

    emit({
      status: allSafe ? "success" : "error",
      action: "batch",
      data: {
        session_id: sessionId,
        total_steps: results.length,
        passed: results.filter((r) => r.safe_to_broadcast).length,
        failed: results.filter((r) => !r.safe_to_broadcast).length,
        results: results.map((r) => ({
          step: r.step_index,
          outcome: r.outcome,
          decoded: r.decoded,
          safe: r.safe_to_broadcast,
        })),
        recommendation: allSafe
          ? "All steps passed. Safe to broadcast the transaction sequence."
          : `Step ${firstFailure!.step_index} failed: ${firstFailure!.decoded}. Do NOT broadcast.`,
      },
      error: allSafe ? null : {
        code: "BATCH_FAILED",
        message: `${results.filter((r) => !r.safe_to_broadcast).length} of ${results.length} steps failed`,
        next: "Fix failing steps and re-simulate the entire batch",
      },
    });
  } catch (e) {
    emit({
      status: "error",
      action: "batch",
      data: {},
      error: {
        code: "BATCH_ERROR",
        message: (e as Error).message,
        next: "Check stxer API availability with 'doctor' command",
      },
    });
  }
}

// ── CLI ───────────────────────────────────────────────────────────────

const program = new Command();
program.name("contract-preflight").description("Dry-run Stacks contract calls before broadcast").version("1.0.0");

program
  .command("doctor")
  .description("Check stxer API availability and simulation engine")
  .action(() => doctor());

program
  .command("run")
  .description("Simulate a contract call")
  .requiredOption("--action <action>", "Action: simulate | batch")
  .option("--sender <address>", "Sender Stacks address (STX principal)")
  .option("--contract <contract>", "Target contract (e.g., SP...contract-name)")
  .option("--expression <expr>", "Clarity expression to evaluate")
  .option("--sponsor <address>", "Optional sponsor address")
  .option("--steps <json>", "JSON array of steps for batch mode")
  .action(async (opts) => {
    if (opts.action === "simulate") {
      await simulate({
        sender: opts.sender,
        contract: opts.contract,
        expression: opts.expression,
        sponsor: opts.sponsor,
      });
    } else if (opts.action === "batch") {
      await batch({
        sender: opts.sender,
        steps: opts.steps,
        sponsor: opts.sponsor,
      });
    } else {
      emit({
        status: "error",
        action: opts.action,
        data: {},
        error: {
          code: "UNKNOWN_ACTION",
          message: `Unknown action: ${opts.action}`,
          next: "Use --action=simulate or --action=batch",
        },
      });
    }
  });

program
  .command("install-packs")
  .description("No additional packages required")
  .action(() => {
    emit({
      status: "success",
      action: "install-packs",
      data: { message: "No additional packages needed. Uses fetch() and commander (already in bff-skills)." },
      error: null,
    });
  });

program.parse();
