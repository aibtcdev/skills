#!/usr/bin/env bun

import { spawn } from "child_process";
import { Command } from "commander";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonMap = { [key: string]: Json };
type Status = "success" | "blocked" | "error";
// Step union enumerates checkpoint states that have actual write paths.
// `blocked_partial_cycle` was previously listed but never written — checkpoint
// stays at its last confirmed step on mid-cycle error and `resume` picks it up
// from there. Removed per arc0btc review #4230615771 nit 3 to avoid creating
// false expectations for downstream consumers parsing the `step` field.
type Step = "idle" | "borrow_confirmed" | "swap_confirmed" | "complete" | "operator_cancelled";

interface Primitive {
  name: string;
  entry: string | null;
  requiredFor: string;
}

interface PrimitiveResult {
  status?: string;
  action?: string;
  data?: JsonMap;
  error?: JsonMap | null;
  raw?: JsonMap;
}

interface Checkpoint {
  version: number;
  cycleId: string;
  wallet: string;
  step: Step;
  requestedBorrowAmountUstx: string;
  createdAt: string;
  updatedAt: string;
  borrowTxid?: string;
  swapTxid?: string;
  depositTxid?: string;
  observedSbtcReceived?: string;
  // Captured at borrow_confirmed: the actual STX amount the wallet received from the
  // borrow primitive. Defensive against a future primitive version that deducts a
  // protocol fee from the disbursed amount — if the field is not present in the
  // primitive output, falls back to requestedBorrowAmountUstx with the note below.
  // arc0btc review #4230615771 suggestion 1.
  borrowReceivedAmountUstx?: string;
  borrowReceivedSource?: "primitive_observed" | "fallback_to_requested";
  abortReason?: string;
  nextRequiredAction?: string;
}

interface SharedOptions {
  wallet?: string;
  borrowAmountUstx?: string;
  slippageBps?: string;
  minGasReserveUstx?: string;
  mempoolDepthLimit?: string;
  waitSeconds?: string;
}

interface RunOptions extends SharedOptions {
  confirm?: string;
}

const CONFIRM_TOKEN = "CYCLE";
const DEFAULT_SLIPPAGE_BPS = "150";
const DEFAULT_MIN_GAS_RESERVE_USTX = "500000";
const DEFAULT_MEMPOOL_DEPTH_LIMIT = "0";
const DEFAULT_WAIT_SECONDS = "240";

const DEPENDENCIES = [
  { name: "zest-borrow-asset-primitive", requiredFor: "borrow STX against existing Zest sBTC collateral" },
  { name: "bitflow-swap-aggregator", requiredFor: "swap borrowed STX to sBTC through Bitflow" },
  { name: "zest-asset-deposit-primitive", requiredFor: "deposit received sBTC back into Zest collateral" },
];

class BlockedError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
    public data: JsonMap = {}
  ) {
    super(message);
  }
}

function stringify(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stringify(val)])) as JsonMap;
  }
  if (value === undefined) return null;
  return value as Json;
}

function output(status: Status, action: string, data: JsonMap, error: JsonMap | null): void {
  console.log(JSON.stringify({ status, action, data: stringify(data), error: stringify(error) }, null, 2));
}

function success(action: string, data: JsonMap): void {
  output("success", action, data, null);
}

function blocked(action: string, code: string, message: string, next: string, data: JsonMap = {}): void {
  output("blocked", action, data, { code, message, next });
}

function fail(action: string, error: unknown): void {
  if (error instanceof BlockedError) {
    blocked(action, error.code, error.message, error.next, error.data);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  output("error", action, {}, { code: "ERROR", message, next: "Run doctor and inspect the failing dependency before retrying." });
  process.exitCode = 1;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function repoRoot(): string {
  return process.env.AIBTC_SKILLS_ROOT || process.cwd();
}

async function resolvePrimitive(name: string, requiredFor: string): Promise<Primitive> {
  const root = repoRoot();
  const candidates = [
    path.join(root, "skills", name, `${name}.ts`),
    path.join(root, name, `${name}.ts`),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { name, entry: candidate, requiredFor };
  }
  return { name, entry: null, requiredFor };
}

async function dependencyReport(): Promise<Primitive[]> {
  return Promise.all(DEPENDENCIES.map((dependency) => resolvePrimitive(dependency.name, dependency.requiredFor)));
}

function missingDependencies(dependencies: Primitive[]): Primitive[] {
  return dependencies.filter((dependency) => !dependency.entry);
}

function ensureWallet(wallet?: string): string {
  if (!wallet) throw new Error("--wallet is required");
  return wallet;
}

function ensureBorrowAmount(amount?: string): string {
  if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("--borrow-amount-ustx is required and must be a positive integer");
  }
  return amount;
}

function ensureDependencies(dependencies: Primitive[]): void {
  const missing = missingDependencies(dependencies);
  if (missing.length > 0) {
    throw new BlockedError(
      "MISSING_PRIMITIVE_DEPENDENCIES",
      "This composed controller cannot run until all primitive skill dependencies are installed.",
      "Merge or install the primitive skill PRs, then rerun doctor.",
      { missing }
    );
  }
}

function checkpointDir(): string {
  return path.join(os.homedir(), ".aibtc", "state", "bitflow-zest-sbtc-leverage-cycle");
}

function checkpointPath(wallet: string): string {
  const safeWallet = wallet.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(checkpointDir(), `${safeWallet}.json`);
}

async function readCheckpoint(wallet: string): Promise<Checkpoint | null> {
  try {
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath(wallet), "utf8")) as Partial<Checkpoint>;
    if (checkpoint.version !== 1 || checkpoint.wallet !== wallet || typeof checkpoint.step !== "string") {
      return null;
    }
    return checkpoint as Checkpoint;
  } catch {
    return null;
  }
}

async function writeCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
  await fs.mkdir(checkpointDir(), { recursive: true });
  const updated = { ...checkpoint, updatedAt: new Date().toISOString() };
  await fs.writeFile(checkpointPath(checkpoint.wallet), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

function newCheckpoint(wallet: string, requestedBorrowAmountUstx: string): Checkpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    cycleId: `cycle-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    wallet,
    step: "idle",
    requestedBorrowAmountUstx,
    createdAt: now,
    updatedAt: now,
  };
}

function unresolved(checkpoint: Checkpoint | null): boolean {
  return !!checkpoint && !["complete", "operator_cancelled"].includes(checkpoint.step);
}

function primitiveByName(dependencies: Primitive[], name: string): Primitive {
  const primitive = dependencies.find((dependency) => dependency.name === name);
  if (!primitive?.entry) throw new Error(`Primitive ${name} is not installed`);
  return primitive;
}

function runPrimitive(entry: string, subcommand: string, args: string[]): Promise<PrimitiveResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", entry, subcommand, ...args], {
      cwd: repoRoot(),
      env: { ...process.env, NETWORK: process.env.NETWORK || "mainnet" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      let parsed: PrimitiveResult;
      try {
        parsed = JSON.parse(trimmed) as PrimitiveResult;
      } catch {
        reject(new BlockedError("INVALID_PRIMITIVE_OUTPUT", `Primitive ${path.basename(entry)} did not return one JSON object.`, "Inspect the primitive output and fix it before composing.", { code: code ?? -1, stdout: trimmed.slice(0, 1000), stderr: stderr.slice(0, 1000) }));
        return;
      }
      if (code !== 0 && parsed.status !== "blocked" && parsed.status !== "error") {
        parsed = { ...parsed, status: "error", error: { code: "PRIMITIVE_EXIT_NONZERO", message: `Primitive exited with code ${code}.`, stderr: stderr.slice(0, 1000) } };
      }
      resolve(parsed);
    });
  });
}

function requirePrimitiveSuccess(name: string, result: PrimitiveResult): void {
  if (result.status !== "success") {
    throw new BlockedError(
      "PRIMITIVE_BLOCKED",
      `${name} did not return success.`,
      "Resolve the primitive blocker before continuing the composed cycle.",
      { primitive: name, result: result as JsonMap }
    );
  }
}

function sharedArgs(opts: SharedOptions): string[] {
  const args = [
    "--slippage-bps", opts.slippageBps || DEFAULT_SLIPPAGE_BPS,
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
    "--mempool-depth-limit", opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT,
    "--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS,
  ];
  return args;
}

function primitiveGasArgs(opts: SharedOptions): string[] {
  // Includes mempool-depth-limit so every write-leg primitive (borrow, deposit) carries
  // the same depth gate the swap leg gets via sharedArgs(). Per PRD safety req #5:
  // "Mempool depth checked before every write leg." Diego review #4230128713 blocking item 2.
  return [
    "--min-gas-reserve-ustx", opts.minGasReserveUstx || DEFAULT_MIN_GAS_RESERVE_USTX,
    "--mempool-depth-limit", opts.mempoolDepthLimit || DEFAULT_MEMPOOL_DEPTH_LIMIT,
  ];
}

function primitiveWaitArgs(opts: SharedOptions): string[] {
  return ["--wait-seconds", opts.waitSeconds || DEFAULT_WAIT_SECONDS];
}

function borrowArgs(wallet: string, amount?: string): string[] {
  const args = ["--wallet", wallet, "--collateral-asset", "sBTC", "--borrow-asset", "STX"];
  if (amount) args.push("--amount", amount);
  return args;
}

function depositArgs(wallet: string, amount?: string): string[] {
  const args = ["--wallet", wallet, "--deposit-asset", "sBTC"];
  if (amount) args.push("--amount", amount);
  return args;
}

function ustxToStxDecimal(amountUstx: string): string {
  const value = BigInt(amountUstx);
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole.toString();
}

function swapArgs(wallet: string, amountUstx: string, opts: SharedOptions): string[] {
  return [
    "--wallet", wallet,
    "--token-in", "STX",
    "--token-out", "sBTC",
    "--amount-in", ustxToStxDecimal(amountUstx),
    ...sharedArgs(opts),
  ];
}

function extractTxid(result: PrimitiveResult): string | null {
  const data = result.data || {};
  const proof = data.proof as JsonMap | undefined;
  const direct = data.txid || proof?.txid;
  return typeof direct === "string" ? direct : null;
}

function asBigInt(value: Json | undefined): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}

function extractObservedSbtc(result: PrimitiveResult): string | null {
  // Fail-closed: returns the actual observed delta only. PRD scope requires "re-supply
  // the actual received sBTC amount" — never the quoted/expected. If the swap primitive's
  // balancesAfter payload is missing or unparseable, returns null so the caller throws
  // SWAP_OUTPUT_UNKNOWN instead of silently depositing the quoted amount under
  // adversarial slippage. Diego review #4230128713 blocking item 1.
  //
  // Unit assumption (arc0btc review #4230615771 question 2): `outputBalance` is in
  // satoshis (native sBTC base units, no decimal normalization). This matches the
  // established convention in aibtcdev/skills primitives — the deposit primitive
  // accepts --amount in the same satoshi units. If a future swap-aggregator version
  // ever switches to decimal sBTC normalization, this assumption breaks silently and
  // the deposit amount would be off by 1e8.
  const data = result.data || {};
  const before = data.balances as JsonMap | undefined;
  const after = data.balancesAfter as JsonMap | undefined;
  const beforeOutput = asBigInt(before?.outputBalance);
  const afterOutput = asBigInt(after?.outputBalance);
  if (beforeOutput !== null && afterOutput !== null && afterOutput >= beforeOutput) {
    return (afterOutput - beforeOutput).toString();
  }
  return null;
}

// Extracts the actual received-amount-uSTX from a borrow primitive result, falling
// back to null if not present. Defensive against future primitive versions that
// deduct a protocol fee from the disbursed amount — caller decides how to handle a
// missing field. arc0btc review #4230615771 suggestion 1.
function extractBorrowedAmountUstx(result: PrimitiveResult): string | null {
  const data = result.data || {};
  // Try several plausible field names; the current borrow primitive does not yet
  // expose a distinct "received" field, so this is forward-compatible.
  const candidates = [
    data.receivedAmountUstx,
    data.receivedAmount,
    (data.proof as JsonMap | undefined)?.receivedAmount,
    (data.proof as JsonMap | undefined)?.amount,
    data.amount,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^\d+$/.test(candidate) && BigInt(candidate) > 0n) return candidate;
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate.toString();
  }
  return null;
}

async function primitiveReadiness(dependencies: Primitive[], wallet: string): Promise<JsonMap> {
  const results: JsonMap = {};
  for (const dependency of dependencies) {
    if (!dependency.entry) {
      results[dependency.name] = { status: "missing", requiredFor: dependency.requiredFor };
      continue;
    }
    const args = dependency.name === "zest-asset-deposit-primitive" ? ["--wallet", wallet, "--deposit-asset", "sBTC"] : ["--wallet", wallet];
    results[dependency.name] = (await runPrimitive(dependency.entry, "doctor", args)) as JsonMap;
  }
  return results;
}

async function runDoctor(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const dependencies = await dependencyReport();
    const checkpoint = await readCheckpoint(wallet);
    const readiness = await primitiveReadiness(dependencies, wallet);
    const missing = missingDependencies(dependencies);
    const data = { dependencies, missing, checkpoint, primitiveReadiness: readiness };
    if (missing.length > 0) {
      blocked("doctor", "MISSING_PRIMITIVE_DEPENDENCIES", "Required primitive skills are not installed.", "Merge or install the primitive skill PRs before building this controller.", data);
      return;
    }
    success("doctor", data);
  } catch (error) {
    fail("doctor", error);
  }
}

async function runStatus(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const dependencies = await dependencyReport();
    const checkpoint = await readCheckpoint(wallet);
    const data: JsonMap = { dependencies, missing: missingDependencies(dependencies), checkpoint };
    if (missingDependencies(dependencies).length === 0) {
      const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
      const deposit = primitiveByName(dependencies, "zest-asset-deposit-primitive");
      data.primitiveStatus = {
        borrow: await runPrimitive(borrow.entry!, "status", borrowArgs(wallet)),
        deposit: await runPrimitive(deposit.entry!, "status", depositArgs(wallet, "1")),
      } as JsonMap;
    }
    success("status", data);
  } catch (error) {
    fail("status", error);
  }
}

// Plan-time gas baselines per leg (canonical mainnet observed values). The primitive
// plan output is the authoritative number; these baselines fill the gas-roll-up when
// a primitive plan response doesn't surface an explicit `feeUstx` field. Diego review
// #4230128713 item 3.
const GAS_BASELINE_BORROW_USTX = 70_000n;
const GAS_BASELINE_SWAP_USTX = 50_000n;
const GAS_BASELINE_DEPOSIT_USTX = 50_000n;

// Walk a primitive plan output looking for the first numeric field with one of the
// likely keys. Defensive against shape drift in primitive outputs.
function extractFee(plan: PrimitiveResult, keys: string[]): bigint | null {
  const data = plan.data;
  if (!data || typeof data !== "object") return null;
  const search = (value: unknown): bigint | null => {
    if (!value || typeof value !== "object") return null;
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) {
        if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
        if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
      }
      const nested = search(v);
      if (nested !== null) return nested;
    }
    return null;
  };
  return search(data);
}

function extractSwapExpectedOutSats(swapPlan: PrimitiveResult): bigint | null {
  const data = swapPlan.data;
  if (!data || typeof data !== "object") return null;
  const search = (value: unknown): bigint | null => {
    if (!value || typeof value !== "object") return null;
    for (const [k, v] of Object.entries(value)) {
      if ((k === "expectedAmountOut" || k === "amountOut" || k === "minAmountOut") && (typeof v === "string" || typeof v === "number")) {
        const s = String(v);
        if (/^\d+$/.test(s) && BigInt(s) >= 0n) return BigInt(s);
      }
      const nested = search(v);
      if (nested !== null) return nested;
    }
    return null;
  };
  return search(data);
}

// Fetches the wallet's current Zest position by shelling out to
// zest-borrow-asset-primitive's `status` subcommand — same composition surface
// already used by the controller's runStatus path. Avoids re-implementing the
// canonical bitmap+position read in this controller. Returns null when the read
// fails or the response shape doesn't surface usable values, so the gate output
// surfaces a degraded-data state instead of throwing. Diego review #4230128713
// item 3.
interface ZestPositionSnapshot {
  debtUstx: string | null;
  collateralSats: string | null;
  healthFactorBps: number | null;
  raw: JsonMap;
  fetchedAt: string;
}

async function readZestPositionViaPrimitive(borrow: Primitive, wallet: string): Promise<ZestPositionSnapshot | null> {
  try {
    const result = await runPrimitive(borrow.entry!, "status", [...borrowArgs(wallet)]);
    if (result.status !== "success") return null;
    const data = (result.data || {}) as JsonMap;
    // Defensive scan for canonical fields. The borrow primitive surfaces these under
    // `assets.borrow.scaledDebt` / `assets.collateral.amount` / `position` shapes,
    // but the exact path varies by primitive version — walk for the first match.
    const scan = (keys: string[]): string | null => {
      const search = (value: unknown): string | null => {
        if (!value || typeof value !== "object") return null;
        for (const [k, v] of Object.entries(value)) {
          if (keys.includes(k)) {
            if (typeof v === "string" && /^\d+$/.test(v)) return v;
            if (typeof v === "number") return String(v);
            if (v && typeof v === "object" && "value" in (v as JsonMap)) {
              const inner = (v as JsonMap).value;
              if (typeof inner === "string" && /^\d+$/.test(inner)) return inner;
            }
          }
          const nested = search(v);
          if (nested !== null) return nested;
        }
        return null;
      };
      return search(data);
    };
    return {
      debtUstx: scan(["currentDebtEstimate", "debt", "scaledDebt", "totalDebt"]),
      collateralSats: scan(["amount", "collateralAmount", "totalCollateral"]),
      healthFactorBps: null, // Health factor surfaces as a tuple field; left as a follow-up to read canonically once the primitive exposes it directly.
      raw: data,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// Builds the plan-time economics aggregation per Diego review #4230128713 item 3.
// Surfaces: per-leg gas, total cycle gas, swap price impact, projected debt
// increase, projected collateral increase, projected post-cycle position deltas,
// economic-meaningfulness flag. Items requiring USD conversion (post-cycle HF in
// USD terms) are deferred — surfaces the raw deltas + current position so the
// operator can apply their own price view.
function buildEconomicCheck(opts: SharedOptions, amount: string, borrowPlan: PrimitiveResult, swapPlan: PrimitiveResult, position: ZestPositionSnapshot | null): JsonMap {
  const borrowGasReported = extractFee(borrowPlan, ["feeUstx", "fee", "estimatedFee"]);
  const swapGasReported = extractFee(swapPlan, ["feeUstx", "fee", "estimatedFee"]);
  const borrowGas = borrowGasReported ?? GAS_BASELINE_BORROW_USTX;
  const swapGas = swapGasReported ?? GAS_BASELINE_SWAP_USTX;
  const depositGas = GAS_BASELINE_DEPOSIT_USTX; // deposit plan deferred until post-swap
  const totalGas = borrowGas + swapGas + depositGas;

  const expectedOutSats = extractSwapExpectedOutSats(swapPlan);
  const amountInUstx = BigInt(amount);

  // Implied rate: how many sats received per uSTX swapped. Operator can sanity-check
  // this against their own market view before confirming.
  const impliedSatsPerUstxBps = expectedOutSats !== null && amountInUstx > 0n
    ? Number((expectedOutSats * 1_000_000n) / amountInUstx) // sats per 1e6 uSTX (= per 1 STX), scaled
    : null;

  // Economic-meaningfulness: gas-cost vs swap-output ratio. If gas exceeds 5% of
  // the projected sBTC value (very rough proxy without USD prices), flag as not
  // meaningful. Operator override implicit via just running anyway.
  let economicallyMeaningful: boolean | null = null;
  let meaningfulReason = "";
  if (expectedOutSats !== null && expectedOutSats > 0n) {
    // Rough ratio: total_gas in uSTX, expected_out in sats. Different units, but
    // the ratio surfaces a "gas dominates" signal at very small amounts.
    const ratio = (totalGas * 10000n) / amountInUstx; // gas as bps of borrowed amount
    economicallyMeaningful = ratio < 500n; // gas < 5% of borrowed amount
    meaningfulReason = `gas ${totalGas} uSTX vs borrowed ${amountInUstx} uSTX (gas-as-bps-of-borrow=${ratio})`;
  } else {
    meaningfulReason = "swap plan did not surface expectedAmountOut; cannot compute meaningfulness";
  }

  // Projected position delta — debt increases by exactly the borrow amount;
  // collateral increases by the swap's expected output (subject to slippage at
  // run time, which the swap primitive enforces via min-out postconditions).
  const projection: JsonMap = {
    delta: {
      debtUstx: amountInUstx.toString(),
      collateralSatsEstimate: expectedOutSats !== null ? expectedOutSats.toString() : null,
      collateralSatsNote: "Estimate from swap plan's expectedAmountOut. Run-time deposit binds to the actual observed swap delta, not this estimate.",
    },
    postCycle: position ? {
      debtUstx: position.debtUstx ? (BigInt(position.debtUstx) + amountInUstx).toString() : null,
      collateralSats: position.collateralSats && expectedOutSats !== null
        ? (BigInt(position.collateralSats) + expectedOutSats).toString()
        : null,
      healthFactorBps: position.healthFactorBps,
      note: "Post-cycle HF in USD terms requires a price source — surfaced fields are raw native units. Operator applies their own price view.",
    } : null,
  };

  return {
    status: position ? "computed" : "partial_no_position_read",
    currentPosition: position ? {
      debtUstx: position.debtUstx,
      collateralSats: position.collateralSats,
      healthFactorBps: position.healthFactorBps,
      fetchedAt: position.fetchedAt,
    } : null,
    gasEstimate: {
      borrowUstx: borrowGas.toString(),
      borrowSource: borrowGasReported ? "primitive_plan" : "controller_baseline",
      swapUstx: swapGas.toString(),
      swapSource: swapGasReported ? "primitive_plan" : "controller_baseline",
      depositUstx: depositGas.toString(),
      depositSource: "controller_baseline",
      totalUstx: totalGas.toString(),
    },
    swapImpact: {
      amountInUstx: amountInUstx.toString(),
      expectedOutSats: expectedOutSats !== null ? expectedOutSats.toString() : null,
      impliedSatsPerStxScaled: impliedSatsPerUstxBps,
    },
    projection,
    economicallyMeaningful,
    meaningfulReason,
    note: "Diego review #4230128713 item 3 — plan-time economics aggregation. Items requiring USD conversion (post-cycle HF in USD terms, gas-vs-yield comparison) deferred; surfaced fields let operator do that math against their preferred price source.",
  };
}

async function runPlan(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const amount = ensureBorrowAmount(opts.borrowAmountUstx);
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const checkpoint = await readCheckpoint(wallet);
    if (unresolved(checkpoint)) {
      throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous cycle checkpoint is unresolved.", "Run resume or cancel before planning a new cycle.", { checkpoint });
    }
    const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
    const swap = primitiveByName(dependencies, "bitflow-swap-aggregator");
    const borrowPlan = await runPrimitive(borrow.entry!, "plan", [...borrowArgs(wallet, amount), ...primitiveGasArgs(opts)]);
    const swapPlan = await runPrimitive(swap.entry!, "plan", swapArgs(wallet, amount, opts));
    // Read current Zest position via the borrow primitive's status path (canonical
    // bitmap + position read), then build the economics aggregation. Primitive
    // is already invoked elsewhere in this controller; re-using the same
    // composition surface keeps the read path consistent.
    const position = await readZestPositionViaPrimitive(borrow, wallet);
    const economicCheck = buildEconomicCheck(opts, amount, borrowPlan, swapPlan, position);
    success("plan", {
      route: "borrow-stx-swap-to-sbtc-resupply-sbtc",
      dependencies,
      steps: [
        { step: "borrow", primitive: borrow.name, result: borrowPlan },
        { step: "swap", primitive: swap.name, result: swapPlan },
        { step: "deposit", primitive: "zest-asset-deposit-primitive", result: { deferred: true, reason: "Planned after swap confirms and observed sBTC amount is known. Deposit args bind to the actual received-from-swap amount, not a quoted estimate." } },
      ],
      economicCheck,
    });
  } catch (error) {
    fail("plan", error);
  }
}

async function continueFrom(checkpoint: Checkpoint, opts: RunOptions, dependencies: Primitive[]): Promise<Checkpoint> {
  const wallet = checkpoint.wallet;
  // Use the actual received amount when the borrow primitive reported one; fall
  // back to the requested amount otherwise. Keeps swap input aligned with what
  // the wallet actually holds, even if a future borrow primitive deducts fees.
  // arc0btc review #4230615771 suggestion 1.
  const amount = checkpoint.borrowReceivedAmountUstx ?? checkpoint.requestedBorrowAmountUstx;
  const swap = primitiveByName(dependencies, "bitflow-swap-aggregator");
  const deposit = primitiveByName(dependencies, "zest-asset-deposit-primitive");
  let current = checkpoint;

  if (current.step === "borrow_confirmed") {
    const swapResult = await runPrimitive(swap.entry!, "run", [...swapArgs(wallet, amount, opts), "--confirm", "SWAP"]);
    requirePrimitiveSuccess(swap.name, swapResult);
    const observedSbtc = extractObservedSbtc(swapResult);
    if (!observedSbtc || BigInt(observedSbtc) <= 0n) {
      throw new BlockedError("SWAP_OUTPUT_UNKNOWN", "The swap primitive did not expose a positive observed sBTC amount.", "Inspect the swap result and resume only with a primitive output that reports the received sBTC.", { swapResult: swapResult as JsonMap });
    }
    current = await writeCheckpoint({ ...current, step: "swap_confirmed", swapTxid: extractTxid(swapResult) || undefined, observedSbtcReceived: observedSbtc });
  }

  if (current.step === "swap_confirmed") {
    const amountSbtc = current.observedSbtcReceived;
    if (!amountSbtc || BigInt(amountSbtc) <= 0n) {
      throw new BlockedError("MISSING_DEPOSIT_AMOUNT", "Saved checkpoint does not include a positive observed sBTC amount.", "Cancel or repair the checkpoint before resuming.", { checkpoint: current });
    }
    const depositResult = await runPrimitive(deposit.entry!, "run", [...depositArgs(wallet, amountSbtc), ...primitiveGasArgs(opts), ...primitiveWaitArgs(opts), "--confirm", "DEPOSIT"]);
    requirePrimitiveSuccess(deposit.name, depositResult);
    current = await writeCheckpoint({ ...current, step: "complete", depositTxid: extractTxid(depositResult) || undefined });
  }

  return current;
}

async function runCycle(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "This composed write skill requires explicit confirmation.", "Re-run with --confirm=CYCLE.");
    }
    const wallet = ensureWallet(opts.wallet);
    const amount = ensureBorrowAmount(opts.borrowAmountUstx);
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const existing = await readCheckpoint(wallet);
    if (unresolved(existing)) {
      throw new BlockedError("UNRESOLVED_CYCLE_STATE", "A previous cycle checkpoint is unresolved.", "Run resume or cancel before starting a new cycle.", { checkpoint: existing });
    }
    const borrow = primitiveByName(dependencies, "zest-borrow-asset-primitive");
    let checkpoint = await writeCheckpoint(newCheckpoint(wallet, amount));
    const borrowResult = await runPrimitive(borrow.entry!, "run", [...borrowArgs(wallet, amount), ...primitiveGasArgs(opts), ...primitiveWaitArgs(opts), "--confirm", "BORROW"]);
    requirePrimitiveSuccess(borrow.name, borrowResult);
    // Capture actual received amount from the borrow primitive's output (defensive
    // against future fee-deducting versions). Falls back to requested amount when the
    // primitive doesn't yet expose a distinct received field — current Zest borrows
    // are exact-amount per arc0btc operational note. The fallback flag lets the swap
    // leg surface the source if needed.
    const borrowedActual = extractBorrowedAmountUstx(borrowResult);
    checkpoint = await writeCheckpoint({
      ...checkpoint,
      step: "borrow_confirmed",
      borrowTxid: extractTxid(borrowResult) || undefined,
      borrowReceivedAmountUstx: borrowedActual ?? amount,
      borrowReceivedSource: borrowedActual ? "primitive_observed" : "fallback_to_requested",
    });
    checkpoint = await continueFrom(checkpoint, opts, dependencies);
    success("run", { checkpoint, dependencies });
  } catch (error) {
    fail("run", error);
  }
}

async function runResume(opts: RunOptions): Promise<void> {
  try {
    if (opts.confirm !== CONFIRM_TOKEN) {
      throw new BlockedError("CONFIRMATION_REQUIRED", "Resume can continue writes and requires explicit confirmation.", "Re-run with --confirm=CYCLE.");
    }
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_RESUMABLE_STATE", "No unresolved cycle state exists for this wallet.", "Run plan/run for a new cycle if appropriate.", { checkpoint });
    }
    if (!["borrow_confirmed", "swap_confirmed"].includes(checkpoint.step)) {
      throw new BlockedError("UNSUPPORTED_RESUME_STEP", `Cannot resume automatically from ${checkpoint.step}.`, "Inspect the checkpoint and cancel or repair manually.", { checkpoint });
    }
    const dependencies = await dependencyReport();
    ensureDependencies(dependencies);
    const completed = await continueFrom(checkpoint, opts, dependencies);
    success("resume", { checkpoint: completed, dependencies });
  } catch (error) {
    fail("resume", error);
  }
}

async function runCancel(opts: SharedOptions): Promise<void> {
  try {
    const wallet = ensureWallet(opts.wallet);
    const checkpoint = await readCheckpoint(wallet);
    if (!checkpoint || !unresolved(checkpoint)) {
      throw new BlockedError("NO_ACTIVE_CYCLE", "No unresolved cycle state exists for this wallet.", "No cancel action is needed.", { checkpoint });
    }
    const cancelled = await writeCheckpoint({ ...checkpoint, step: "operator_cancelled", abortReason: "operator_cancelled", nextRequiredAction: "Review wallet/Zest state before starting another cycle." });
    success("cancel", { checkpoint: cancelled });
  } catch (error) {
    fail("cancel", error);
  }
}

function addSharedOptions(command: Command): Command {
  return command
    .option("--wallet <stacks-address>", "wallet that owns collateral and signs writes")
    .option("--borrow-amount-ustx <uSTX>", "STX borrow amount in micro-STX")
    .option("--slippage-bps <bps>", "swap slippage tolerance in basis points", DEFAULT_SLIPPAGE_BPS)
    .option("--min-gas-reserve-ustx <uSTX>", "minimum STX gas reserve", DEFAULT_MIN_GAS_RESERVE_USTX)
    .option("--mempool-depth-limit <count>", "maximum allowed pending tx depth", DEFAULT_MEMPOOL_DEPTH_LIMIT)
    .option("--wait-seconds <seconds>", "wait window passed to primitive write skills", DEFAULT_WAIT_SECONDS);
}

const program = new Command();

program
  .name("bitflow-zest-sbtc-leverage-cycle")
  .description("Compose Zest borrow, Bitflow swap, and Zest deposit primitives into one sBTC leverage cycle");

addSharedOptions(program.command("doctor").description("Check dependency and state readiness")).action(runDoctor);
addSharedOptions(program.command("status").description("Read current composed-cycle status")).action(runStatus);
addSharedOptions(program.command("plan").description("Plan one composed cycle without broadcasting")).action(runPlan);
addSharedOptions(program.command("run").description("Run one composed cycle"))
  .option("--confirm <CYCLE>", "required confirmation token")
  .action(runCycle);
addSharedOptions(program.command("resume").description("Resume an interrupted cycle"))
  .option("--confirm <CYCLE>", "required confirmation token")
  .action(runResume);
addSharedOptions(program.command("cancel").description("Cancel unresolved saved cycle state")).action(runCancel);

program.parse(process.argv);
