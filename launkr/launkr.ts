#!/usr/bin/env bun
/**
 * Launkr skill CLI
 * Launch and trade restricted SIP-010 tokens on the Launkr protected AMM (Stacks blockchain).
 *
 * Usage: bun run launkr/launkr.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  contractPrincipalCV,
  standardPrincipalCV,
  uintCV,
  stringAsciiCV,
  stringUtf8CV,
  noneCV,
  someCV,
  deserializeCV,
  cvToValue,
  PostConditionMode,
  type ClarityValue,
} from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { callContract, deployContract } from "../src/lib/transactions/builder.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { pollTransactionConfirmation } from "../src/lib/utils/x402-recovery.js";
import {
  createStxPostCondition,
  createContractStxPostCondition,
  createFungiblePostCondition,
  createContractFungiblePostCondition,
} from "../src/lib/transactions/post-conditions.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAUNKR_API = "https://launkr.io/api";

// Every token deployed from Launkr's byte-frozen template defines the exact
// same fungible-token asset name internally — only the contract address
// varies. Verified against the deployed template source (mainnet + testnet):
// `(define-fungible-token strategy-token)`. Do not confuse this with the
// token's display name/symbol, which is unrelated and set at initialize().
const LAUNKR_FT_ASSET_NAME = "strategy-token";

const NET_CONFIG = {
  mainnet: {
    singleton: "SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.lp-singleton-v6",
    template: "SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.restricted-token-template-v6",
    chainParam: "mainnet",
  },
  testnet: {
    singleton: "ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.lp-singleton-v6",
    template: "ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.restricted-token-template-v6",
    chainParam: "testnet",
  },
} as const;

type LaunkrNetwork = keyof typeof NET_CONFIG;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the Launkr network from CLI option or AIBTC NETWORK config. */
function resolveNetwork(opt?: string): LaunkrNetwork {
  const n = (opt ?? NETWORK ?? "mainnet").toLowerCase();
  if (n === "mainnet" || n === "testnet") return n as LaunkrNetwork;
  throw new Error(`Unknown network "${n}" — use "mainnet" or "testnet"`);
}

/**
 * FIX (biwasxyz review, PR #414, worth-addressing #8): AGENT.md tells an
 * agent to "fetch GET /api/protocol fresh, every session... never hardcode
 * an address from memory or from an old run" — but nothing in this file
 * ever called it; every command read the addresses baked into NET_CONFIG
 * at the time this script was written. That's exactly the failure mode the
 * doc warns about: this contract already redeployed once (2026-07-16), and
 * a second redeploy would silently point every write at a retired
 * singleton and make every read report `found: false`, with nothing in
 * the code to catch it. NET_CONFIG is now only the fallback for when the
 * live endpoint is unreachable, not the primary source.
 */
async function fetchProtocolConfig(
  network: LaunkrNetwork
): Promise<{ singleton: string; template: string }> {
  const fallback = NET_CONFIG[network];
  try {
    const resp = await fetch(`${LAUNKR_API}/protocol?network=${network}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      contracts?: { singleton?: string; template?: string };
    };
    const { singleton, template } = data.contracts ?? {};
    if (!singleton || !template) {
      throw new Error("response missing contracts.singleton/template");
    }
    return { singleton, template };
  } catch (err) {
    process.stderr.write(
      `Warning: could not fetch live config from ${LAUNKR_API}/protocol?network=${network} ` +
        `(${err instanceof Error ? err.message : String(err)}) — falling back to the address ` +
        `baked into this script (${fallback.singleton}). This may be stale if Launkr has ` +
        `redeployed since this version of the skill was published.\n`
    );
    return { singleton: fallback.singleton, template: fallback.template };
  }
}

/** Parse a Stacks principal string ("SP..." or "SP....contract") into a ClarityValue. */
export function parsePrincipalCV(principal: string): ClarityValue {
  const parts = principal.split(".");
  if (parts.length === 2) return contractPrincipalCV(parts[0], parts[1]);
  return standardPrincipalCV(principal);
}

/**
 * Parse a typed arg descriptor from the Launkr /api/launch response into a ClarityValue.
 * Supported types: principal, uint, string-ascii, string-utf8, optional-utf8, optional-ascii.
 *
 * RESOLVED (2026-08-05, biwasxyz review question #3): an earlier version of
 * this function substituted `someCV(stringUtf8CV(""))` for a null optional
 * value, working around a `BadFunctionArgument` broadcast rejection seen
 * against a *different* environment (the published `@aibtc/mcp-server` npm
 * package's own dependency resolution).
 *
 * CORRECTION (2026-08-14): this comment previously cited two testnet txids
 * as verification against this repo's pinned `@stacks/transactions@7.3.1`.
 * Those txids were written before the verification was actually run and do
 * not exist on-chain — that was a mistake, not a stale reference to a real
 * result. The underlying claim has now actually been verified: a bare
 * `noneCV()` for this same optional-uri argument, signed with this exact
 * pinned dependency version and broadcast for real, confirms successfully —
 * mainnet txid
 * `29b7e58d636d2be118ca658707220e3f5ff19100fbb264f5aeb00c765202e390`,
 * `(ok true)`, calling `set-token-uri` with `noneCV()` on a live Launkr
 * token. (Testnet was used for the original, unverified claim but wasn't
 * available for re-verification — its API is returning nonce 0 / balance 0
 * for addresses with known prior history, consistent with a testnet reset;
 * mainnet was used instead. The mechanism being verified — optional-argument
 * encoding — is identical on both networks.) The bug behind the original
 * workaround was real but environment-specific, not a Stacks or Clarity
 * issue — reverted to sending a proper `none` rather than a permanent
 * empty-string placeholder.
 */
export function parseLaunkrArg(arg: { type: string; value: unknown }): ClarityValue {
  switch (arg.type) {
    case "principal":
      return parsePrincipalCV(String(arg.value));
    case "uint":
      return uintCV(BigInt(String(arg.value)));
    case "string-ascii":
      return stringAsciiCV(String(arg.value));
    case "string-utf8":
      return stringUtf8CV(String(arg.value));
    case "optional-utf8":
      return arg.value == null ? noneCV() : someCV(stringUtf8CV(String(arg.value)));
    case "optional-ascii":
      return arg.value == null ? noneCV() : someCV(stringAsciiCV(String(arg.value)));
    default:
      throw new Error(`Unsupported Launkr arg type: "${arg.type}"`);
  }
}

/**
 * FIX (arc0btc review, PR #414): the Launkr API builds the pool-creation
 * functionArgs server-side from our request, but we never cross-checked
 * that what comes back actually matches what we asked for. A buggy or
 * compromised API response could silently swap `fee-receiver` to a
 * different address, or change `supply`, and we'd deploy + create the pool
 * without ever noticing — routing future swap fees to an address we don't
 * control. Fail loudly, before spending any gas, if these don't match.
 *
 * EXTENDED (biwasxyz review round 1, PR #414, worth-addressing #5): the
 * original version only checked name/symbol/supply/fee-receiver — not the
 * curve parameters (virtual-stx/graduation-threshold for bonding, stx-seed
 * for direct), even though those define the entire price curve.
 *
 * EXTENDED AGAIN (biwasxyz review round 2): three more gaps.
 * - The curve-parameter checks above only ran when the caller happened to
 *   pass the corresponding flag (`!= null`) — but `--virtual-stx`/
 *   `--graduation-threshold`/`--stx-seed` were optional CLI flags, so the
 *   *default*, most common invocation validated zero curve parameters.
 *   Resolved structurally rather than by widening this function: `launch`
 *   and `create-pool` now require these flags per mode (mirroring
 *   blocker B's fix for `--stx-seed`), so `requested.virtualStx` etc. are
 *   always defined by the time this runs — nothing here needed to change
 *   for that part, but it's why the `!= null` guards below are no longer
 *   reachable as "not provided."
 * - The arity check (`args.length < 8`) accepted 8 args for bonding (which
 *   needs 9) and 9 for direct (needs 8) — in the 8-arg bonding case
 *   `args[7]` was read as both graduation-threshold and fee-receiver. Now
 *   checked as an exact length per mode.
 * - `args[0]`, the token principal — which pool the args are even for —
 *   was never checked. A response could pass `verifyDeploySourceMatchesTemplate`
 *   on step 1 and still point step 2's pool creation at a different token.
 *   Now compared against the token principal derived locally from the
 *   deployer address + contract name (or passed in directly by `create-pool`,
 *   which already knows the target token from `--token`).
 *
 * Positional args differ by mode:
 *   bonding: token, name, symbol, decimals, supply, uri, virtual-stx, graduation-threshold, fee-receiver  (9 args)
 *   direct:  token, name, symbol, decimals, supply, uri, stx-seed, fee-receiver                           (8 args)
 */
export function validatePoolStepMatchesRequest(
  poolStep: { functionArgs?: Array<{ type: string; value: unknown }> },
  requested: {
    mode: "bonding" | "direct";
    tokenPrincipal: string;
    supply: string;
    feeReceiver: string;
    name: string;
    symbol: string;
    virtualStx?: string;
    graduationThreshold?: string;
    stxSeed?: string;
  }
): void {
  const args = poolStep.functionArgs;
  const expectedLength = requested.mode === "bonding" ? 9 : 8;
  if (!args || args.length !== expectedLength) {
    throw new Error(
      `Launkr API returned ${args?.length ?? 0} pool-creation args for mode ` +
        `"${requested.mode}", expected exactly ${expectedLength}`
    );
  }

  const tokenArg = String(args[0]?.value);
  const nameArg = String(args[1]?.value);
  const symbolArg = String(args[2]?.value);
  const supplyArg = String(args[4]?.value);
  const feeReceiverArg = String(args[args.length - 1]?.value);

  const mismatches: string[] = [];
  if (tokenArg !== requested.tokenPrincipal) {
    mismatches.push(
      `token: expected "${requested.tokenPrincipal}", API returned "${tokenArg}"`
    );
  }
  if (nameArg !== requested.name) {
    mismatches.push(`name: requested "${requested.name}", API returned "${nameArg}"`);
  }
  if (symbolArg !== requested.symbol) {
    mismatches.push(`symbol: requested "${requested.symbol}", API returned "${symbolArg}"`);
  }
  if (supplyArg !== requested.supply) {
    mismatches.push(`supply: requested ${requested.supply}, API returned ${supplyArg}`);
  }
  if (feeReceiverArg !== requested.feeReceiver) {
    mismatches.push(`fee-receiver: requested ${requested.feeReceiver}, API returned ${feeReceiverArg}`);
  }

  if (requested.mode === "bonding") {
    const virtualStxArg = String(args[6]?.value);
    const graduationThresholdArg = String(args[7]?.value);
    if (requested.virtualStx != null && virtualStxArg !== requested.virtualStx) {
      mismatches.push(
        `virtual-stx: requested ${requested.virtualStx}, API returned ${virtualStxArg}`
      );
    }
    if (
      requested.graduationThreshold != null &&
      graduationThresholdArg !== requested.graduationThreshold
    ) {
      mismatches.push(
        `graduation-threshold: requested ${requested.graduationThreshold}, API returned ${graduationThresholdArg}`
      );
    }
  } else {
    const stxSeedArg = String(args[6]?.value);
    if (requested.stxSeed != null && stxSeedArg !== requested.stxSeed) {
      mismatches.push(`stx-seed: requested ${requested.stxSeed}, API returned ${stxSeedArg}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Refusing to proceed — Launkr API's pool-creation args don't match what was requested:\n` +
        mismatches.map((m) => `  - ${m}`).join("\n")
    );
  }
}

/**
 * FIX (biwasxyz review, PR #414, worth-addressing #4): the token's Clarity
 * source came straight from the API and was deployed under the user's own
 * key with no local check — the much larger trust surface compared to the
 * pool-creation args above, since it's arbitrary contract code. The
 * singleton already gates on a hash of the byte-frozen template, so
 * fetching that template on-chain and comparing before deploying catches a
 * bad/compromised API response *before* spending gas rather than after
 * (the singleton would reject a mismatched deploy anyway via
 * `ERR_TOKEN_NOT_OURS`, but only after the deploy fee is already spent).
 */
async function verifyDeploySourceMatchesTemplate(
  codeBody: string,
  network: LaunkrNetwork,
  templateContractId: string
): Promise<void> {
  const { source: templateSource } = await getHiroApi(network).getContractSource(
    templateContractId
  );
  if (codeBody !== templateSource) {
    throw new Error(
      "Refusing to deploy — the API's clarityCode does not byte-match the " +
        `on-chain template (${templateContractId}). This would be rejected ` +
        "by the singleton anyway (ERR_TOKEN_NOT_OURS), but checking first " +
        "avoids spending the deploy fee on a token that can never get a pool."
    );
  }
}

/**
 * Decode a hex-encoded Clarity value returned by Hiro's call-read endpoint.
 * Returns a `cvToValue`-shaped tree (nodes are `{type, value}`, all the way
 * down) or the raw hex on failure. Pass the result through `unwrapCV` to
 * get a plain JS value/object — `decodeCV` alone is not usable directly for
 * anything beyond a single scalar.
 */
export function decodeCV(hexResult: string): unknown {
  try {
    const bytes = Buffer.from(hexResult.replace(/^0x/, ""), "hex");
    const cv = deserializeCV(bytes);
    return cvToValue(cv, true); // true = convert bigints to strings
  } catch {
    return hexResult;
  }
}

/**
 * FIX (biwasxyz review, PR #414, blocker A): `cvToValue` doesn't flatten to
 * plain JS — every node, at every depth, stays wrapped as `{type, value}`.
 * `get-pool`'s old code unwrapped exactly one level (assuming that was the
 * "ok" or "some" wrapper) and then read tuple fields directly off the
 * result — but a tuple's *fields* are each still `{type, value}` nodes one
 * level further down, so every field came back as an object
 * (`String(...)` → `"[object Object]"`) or `undefined`. Verified directly:
 * a real `get-pool` response run through the old code printed
 * `mode: "[object Object]"` and `active: {type:"bool",value:true}` instead
 * of `mode: "bonding"` / `active: true`.
 *
 * This recurses through the whole tree instead of assuming a fixed depth,
 * so it's correct for any Clarity value shape — a bare value, a `some`,
 * a tuple, a list, or nested combinations — not just the ones this file
 * happens to call today.
 */
export function unwrapCV(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const { value } = node as { type?: unknown; value?: unknown };
  if (!("type" in (node as object)) || !("value" in (node as object))) return node;

  if (Array.isArray(value)) return value.map(unwrapCV);

  if (value !== null && typeof value === "object") {
    // A nested single Clarity value (e.g. the payload of a `some` or `ok`)
    // looks the same shape as the node we're already unwrapping — recurse.
    if ("type" in value && "value" in value) return unwrapCV(value);
    // Otherwise this is a tuple's field map: { fieldName: {type, value}, ... }.
    const result: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = unwrapCV(fieldValue);
    }
    return result;
  }

  // Already a plain scalar (string/number/boolean/null) — nothing to unwrap.
  return value;
}

// FIX (biwasxyz review, PR #414, worth-addressing #7): terminal statuses a
// Stacks tx can land in without succeeding. Used by `waitForConfirmation`
// below, which wraps the shared `pollTransactionConfirmation` (from
// src/lib/utils/x402-recovery.js — reused instead of a hand-rolled poller
// so this also picks up the Hiro API key header that helper attaches).
const ABORT_STATUSES = [
  "abort_by_response",
  "abort_by_post_condition",
  "dropped_replace_by_fee",
  "dropped_too_expensive",
  "dropped_stale_garbage_collect",
  "dropped_replace_across_fork",
  "dropped_problematic",
];

/**
 * Wait for a transaction to reach a terminal status, using the shared
 * poller. Throws if it aborts/drops or if the timeout is exceeded.
 */
async function waitForConfirmation(
  txid: string,
  network: LaunkrNetwork,
  timeoutMs = 300_000
): Promise<void> {
  process.stderr.write(`Waiting for tx ${txid} to confirm...\n`);
  const result = await pollTransactionConfirmation(txid, network, timeoutMs, 6_000);

  if (result.status === "success") {
    process.stderr.write(`Confirmed: ${txid}\n`);
    return;
  }
  if (ABORT_STATUSES.includes(result.status)) {
    throw new Error(`Transaction failed with status: ${result.status}`);
  }
  throw new Error(`Timed out waiting for tx ${txid} after ${timeoutMs / 1000}s (last status: ${result.status})`);
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("launkr")
  .description(
    "Launch and trade restricted SIP-010 tokens on Launkr — " +
      "a protected token launcher and XYK AMM on the Stacks blockchain."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

program
  .command("launch")
  .description(
    "Launch a new token on Launkr: deploy the token contract (step 1), " +
      "wait for confirmation, then create the AMM pool (step 2). " +
      "Requires an unlocked wallet with STX for fees and optional seed."
  )
  .requiredOption("--name <name>", "Token display name (max 32 chars)")
  .requiredOption("--symbol <symbol>", "Token symbol (max 32 chars)")
  .requiredOption(
    "--supply <atomic>",
    "Total supply in atomic units (min 100000000000000 = 100M @ 6 decimals)"
  )
  .requiredOption(
    "--mode <mode>",
    "Pool mode: 'bonding' (virtual reserves, 1% fee) or 'direct' (real STX seed, 5% fee)"
  )
  .requiredOption(
    "--fee-receiver <address>",
    "STX address that receives 90% of swap fees"
  )
  .option(
    "--virtual-stx <uSTX>",
    "Required if --mode bonding. Virtual STX reserve in uSTX (min 500000000 = 500 STX)"
  )
  .option(
    "--graduation-threshold <uSTX>",
    "Required if --mode bonding. Real STX to collect before graduating (min 2000000000 = 2000 STX, max 10x virtual-stx)"
  )
  .option(
    "--stx-seed <uSTX>",
    "Required if --mode direct. Real STX to seed the pool in uSTX (min 100000000 = 100 STX)"
  )
  .option("--uri <uri>", "Optional token metadata URI")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      // FIX (biwasxyz review, PR #414, worth-addressing #9): validate --mode
      // locally rather than letting a typo or case mismatch reach the API —
      // `opts.mode === "direct"` further down (the post-condition guard for
      // the STX seed) is case-sensitive, so e.g. "Direct" would silently
      // skip that guard instead of erroring.
      if (opts.mode !== "bonding" && opts.mode !== "direct") {
        throw new Error(`--mode must be exactly "bonding" or "direct", got "${opts.mode}"`);
      }
      const mode = opts.mode as "bonding" | "direct";

      // FIX (biwasxyz review round 2, PR #414, blocker B): `--stx-seed` (and
      // the bonding equivalents) were plain `.option()`s, so a `--mode
      // direct` run with no `--stx-seed` proceeded all the way through the
      // deploy — spending that fee — before failing at pool creation with
      // `abort_by_post_condition` (the post-condition guarding the seed
      // can't be built from `undefined`). Fail before deploying, not after.
      if (mode === "bonding" && (!opts.virtualStx || !opts.graduationThreshold)) {
        throw new Error(
          "--virtual-stx and --graduation-threshold are required when --mode is bonding"
        );
      }
      if (mode === "direct" && !opts.stxSeed) {
        throw new Error("--stx-seed is required when --mode is direct");
      }

      // FIX (biwasxyz review, PR #414, blocker #2): the network that
      // actually gets signed/broadcast to is account.network (set by which
      // wallet is loaded, via the NETWORK env var at wallet-creation time)
      // — a `--network` flag here can never change that, since
      // callContract/deployContract derive their network from the account,
      // not from a parameter we control. Rather than have a flag that looks
      // like it selects the network but silently doesn't, derive everything
      // from the account so there's only one source of truth.
      const account = await getAccount();
      const network = account.network;
      const { chainParam } = NET_CONFIG[network];
      const { singleton, template } = await fetchProtocolConfig(network);

      // -----------------------------------------------------------------------
      // Step 1 — Get the launch intent from the Launkr API
      // -----------------------------------------------------------------------
      process.stderr.write(`Calling Launkr API to build launch intent...\n`);

      const launchBody: Record<string, string | undefined> = {
        network,
        deployerAddress: account.address,
        name: opts.name,
        symbol: opts.symbol,
        supply: opts.supply,
        mode,
        feeReceiver: opts.feeReceiver,
        ...(opts.uri && { uri: opts.uri }),
        ...(opts.virtualStx && { virtualStx: opts.virtualStx }),
        ...(opts.graduationThreshold && { graduationThreshold: opts.graduationThreshold }),
        ...(opts.stxSeed && { stxSeed: opts.stxSeed }),
      };

      const launchResp = await fetch(`${LAUNKR_API}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(launchBody),
      });

      if (!launchResp.ok) {
        const errBody = await launchResp.json().catch(() => ({ error: "unknown" })) as {
          error: string;
        };
        throw new Error(`Launkr API error ${launchResp.status}: ${errBody.error}`);
      }

      type LaunkrStep = {
        step: number;
        kind: string;
        contractName?: string;
        clarityCode?: string;
        functionName?: string;
        functionArgs?: Array<{ type: string; value: unknown }>;
        postConditionMode?: string;
        postConditions?: unknown[];
        note?: string;
      };

      const intent = (await launchResp.json()) as {
        tokenPrincipal: string;
        singletonId: string;
        steps: LaunkrStep[];
      };

      const deployStep = intent.steps[0];
      const poolStep = intent.steps[1];

      if (!deployStep?.clarityCode || !deployStep.contractName) {
        throw new Error("Launkr API returned an unexpected intent shape (missing step 1)");
      }
      if (!poolStep?.functionName || !poolStep.functionArgs) {
        throw new Error("Launkr API returned an unexpected intent shape (missing step 2)");
      }

      // FIX (biwasxyz review round 2, PR #414, "also worth fixing"): the
      // function actually called comes from the API, but nothing checked it
      // agreed with the locally-validated --mode. A response could pass
      // every arg check above while pointing at the *other* mode's
      // function — `--mode bonding` + an API response of
      // `create-pool-direct` would pass every other check here and then
      // broadcast a call that pulls real STX with no post-condition, since
      // the post-condition array below is built from the local `mode`.
      const expectedFunctionName = mode === "bonding" ? "create-pool-bonding" : "create-pool-direct";
      if (poolStep.functionName !== expectedFunctionName) {
        throw new Error(
          `Refusing to proceed — requested mode "${mode}" but the API's pool-creation ` +
            `step calls "${poolStep.functionName}", not "${expectedFunctionName}"`
        );
      }

      // FIX (arc0btc review, PR #414; extended twice by biwasxyz — round 1
      // worth-addressing #5 added the curve parameters, round 2 added the
      // exact-arity check and the token-principal check): verify the API's
      // pool-creation args actually match what we asked for, before
      // spending any gas at all.
      validatePoolStepMatchesRequest(poolStep, {
        mode,
        tokenPrincipal: `${account.address}.${deployStep.contractName}`,
        name: opts.name,
        symbol: opts.symbol,
        supply: opts.supply,
        feeReceiver: opts.feeReceiver,
        virtualStx: opts.virtualStx,
        graduationThreshold: opts.graduationThreshold,
        stxSeed: opts.stxSeed,
      });

      // FIX (biwasxyz review, PR #414, worth-addressing #4): confirm the
      // deploy source is really the approved template before spending gas
      // on it — see verifyDeploySourceMatchesTemplate for why.
      await verifyDeploySourceMatchesTemplate(deployStep.clarityCode, network, template);

      // -----------------------------------------------------------------------
      // Step 2 — Deploy the token contract (byte-for-byte copy of template)
      // -----------------------------------------------------------------------
      process.stderr.write(
        `Deploying token contract "${deployStep.contractName}" on ${network}...\n`
      );

      const deployFee = await resolveFee(opts.fee, network, "smart_contract");
      const deployResult = await deployContract(account, {
        contractName: deployStep.contractName,
        codeBody: deployStep.clarityCode,
        ...(deployFee !== undefined && { fee: deployFee }),
      });

      process.stderr.write(`Deploy tx broadcast: ${deployResult.txid}\n`);
      process.stderr.write(
        `If step 2 below fails or this process is interrupted, the token is ` +
          `already deployed at ${account.address}.${deployStep.contractName} — ` +
          `re-run with the \`create-pool\` subcommand instead of \`launch\` to ` +
          `resume without deploying a second token.\n`
      );

      // -----------------------------------------------------------------------
      // Step 3 — Wait for deploy to confirm
      // -----------------------------------------------------------------------
      await waitForConfirmation(deployResult.txid, network);

      // -----------------------------------------------------------------------
      // Step 4 — Create the pool
      // -----------------------------------------------------------------------
      const clarityArgs = poolStep.functionArgs.map(parseLaunkrArg);
      const poolFee = await resolveFee(opts.fee, network, "contract_call");
      const [singletonAddr, singletonName] = singleton.split(".");

      // Direct mode: post-condition guards the STX seed pulled from the caller.
      // Bonding mode: no STX is pulled at creation — empty post-conditions.
      const postConditions =
        mode === "direct" && opts.stxSeed
          ? [createStxPostCondition(account.address, "eq", BigInt(opts.stxSeed))]
          : [];

      process.stderr.write(`Creating ${mode} pool on ${singleton}...\n`);

      const poolResult = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: poolStep.functionName,
        functionArgs: clarityArgs,
        postConditionMode: PostConditionMode.Deny,
        ...(postConditions.length > 0 && { postConditions }),
        ...(poolFee !== undefined && { fee: poolFee }),
      });

      // FIX (biwasxyz review round 2, PR #414, "also worth fixing"): this
      // used to print `success: true` right after *broadcasting* the pool
      // tx — the deploy is awaited via waitForConfirmation above, but the
      // pool creation wasn't, so a caller had no way to tell "pool created"
      // from "pool creation is still pending" from "pool creation aborted
      // on-chain" from this JSON alone. Wait for it the same way.
      process.stderr.write(`Pool tx broadcast: ${poolResult.txid}\n`);
      await waitForConfirmation(poolResult.txid, network);

      printJson({
        success: true,
        tokenPrincipal: intent.tokenPrincipal,
        deployTxid: deployResult.txid,
        poolTxid: poolResult.txid,
        network,
        explorerUrl: getExplorerTxUrl(poolResult.txid, network),
        launkrUrl: `https://launkr.io/token/${intent.tokenPrincipal}`,
        chainExplorerUrl: `https://explorer.hiro.so/txid/${poolResult.txid}?chain=${chainParam}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// create-pool
// ---------------------------------------------------------------------------
//
// FIX (biwasxyz review, PR #414, worth-addressing #6): `launch` is two
// transactions with no recovery path — if step 2 (pool creation) fails, or
// the process is killed during the 5-minute confirmation wait, the token
// sits deployed with no pool, and re-running `launch` deploys a *second*
// token rather than resuming. This subcommand takes an already-deployed
// token and runs only the pool-creation step, so `launch` failing partway
// through has a documented way out (see the message `launch` itself prints
// after a successful deploy).
//
// Builds the create-pool-* call directly from the same args a `launch`
// invocation would have used, rather than round-tripping through
// /api/launch again — the function signature is fully documented (see
// SKILL.md) and entirely derivable from user-supplied input, so there's
// nothing the API would add here except another chance to disagree with
// what was actually deployed.

program
  .command("create-pool")
  .description(
    "Create a pool for a token that's already deployed but has no pool yet " +
      "— the recovery path when `launch` deployed the token but failed (or " +
      "was interrupted) before/during pool creation. Requires an unlocked wallet."
  )
  .requiredOption(
    "--token <principal>",
    "Full principal of the already-deployed token (ADDRESS.contract-name)"
  )
  .requiredOption("--name <name>", "Token display name — must match what was deployed")
  .requiredOption("--symbol <symbol>", "Token symbol — must match what was deployed")
  .requiredOption(
    "--supply <atomic>",
    "Total supply in atomic units — must match what was deployed"
  )
  .requiredOption("--mode <mode>", "Pool mode: 'bonding' or 'direct'")
  .requiredOption("--fee-receiver <address>", "STX address that receives 90% of swap fees")
  .option("--virtual-stx <uSTX>", "Required if --mode bonding. Virtual STX reserve in uSTX")
  .option("--graduation-threshold <uSTX>", "Required if --mode bonding. Real STX to collect before graduating")
  .option("--stx-seed <uSTX>", "Required if --mode direct. Real STX to seed the pool in uSTX")
  .option("--uri <uri>", "Optional token metadata URI")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      if (opts.mode !== "bonding" && opts.mode !== "direct") {
        throw new Error(`--mode must be exactly "bonding" or "direct", got "${opts.mode}"`);
      }
      const mode = opts.mode as "bonding" | "direct";

      // FIX (biwasxyz review round 2, PR #414, "also worth fixing"): these
      // were plain `.option()`s, so e.g. `create-pool --mode bonding` with
      // no `--virtual-stx` reached `BigInt(undefined)` and crashed with
      // `Cannot convert undefined to a BigInt` — an unhelpful error on the
      // one command someone reaches only after `launch` already stranded a
      // token. Same fix as `launch`: fail with a clear message first.
      if (mode === "bonding" && (!opts.virtualStx || !opts.graduationThreshold)) {
        throw new Error(
          "--virtual-stx and --graduation-threshold are required when --mode is bonding"
        );
      }
      if (mode === "direct" && !opts.stxSeed) {
        throw new Error("--stx-seed is required when --mode is direct");
      }

      const account = await getAccount();
      const network = account.network;
      const { singleton } = await fetchProtocolConfig(network);
      const [singletonAddr, singletonName] = singleton.split(".");

      // FIX (biwasxyz review round 2, PR #414, "also worth fixing"): this
      // hardcoded `uintCV(6)` while `launch` takes decimals from whatever
      // the API's deploy step actually used. If those ever disagreed, this
      // recovery path would silently create a differently-configured pool
      // than `launch` would have. Reading it back from the already-deployed
      // token is the only source that can't drift from what's actually on
      // chain — it's not a parameter to get right, it's a fact to look up.
      const decimalsResult = await getHiroApi(network).callReadOnlyFunction(
        opts.token,
        "get-decimals",
        [],
        account.address
      );
      if (!decimalsResult.okay) {
        throw new Error(`Could not read decimals from ${opts.token}: ${decimalsResult.cause}`);
      }
      const decimals = Number(unwrapCV(decodeCV(decimalsResult.result ?? "")));
      if (!Number.isInteger(decimals)) {
        throw new Error(`Unexpected get-decimals result from ${opts.token}: ${decimalsResult.result}`);
      }

      const uriArg = opts.uri ? someCV(stringUtf8CV(opts.uri)) : noneCV();

      const functionArgs =
        mode === "bonding"
          ? [
              parsePrincipalCV(opts.token),
              stringAsciiCV(opts.name),
              stringAsciiCV(opts.symbol),
              uintCV(decimals),
              uintCV(BigInt(opts.supply)),
              uriArg,
              uintCV(BigInt(opts.virtualStx)),
              uintCV(BigInt(opts.graduationThreshold)),
              parsePrincipalCV(opts.feeReceiver),
            ]
          : [
              parsePrincipalCV(opts.token),
              stringAsciiCV(opts.name),
              stringAsciiCV(opts.symbol),
              uintCV(decimals),
              uintCV(BigInt(opts.supply)),
              uriArg,
              uintCV(BigInt(opts.stxSeed)),
              parsePrincipalCV(opts.feeReceiver),
            ];

      const postConditions =
        mode === "direct"
          ? [createStxPostCondition(account.address, "eq", BigInt(opts.stxSeed))]
          : [];

      const fee = await resolveFee(opts.fee, network, "contract_call");

      const result = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: mode === "bonding" ? "create-pool-bonding" : "create-pool-direct",
        functionArgs,
        postConditionMode: PostConditionMode.Deny,
        ...(postConditions.length > 0 && { postConditions }),
        ...(fee !== undefined && { fee }),
      });

      process.stderr.write(`Pool tx broadcast: ${result.txid}\n`);
      await waitForConfirmation(result.txid, network);

      printJson({
        success: true,
        token: opts.token,
        poolTxid: result.txid,
        network,
        explorerUrl: getExplorerTxUrl(result.txid, network),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// set-fee-receiver / accept-fee-receiver
// ---------------------------------------------------------------------------
//
// Answers biwasxyz review question #5: the singleton's two-step
// fee-receiver transfer (`set-pending-fee-receiver` proposed by the
// current receiver, `accept-fee-receiver` confirmed by the new one) exists
// on-chain but wasn't exposed by this skill — meaning a launch with the
// wrong fee-receiver had no correction path through this CLI. Exposed here
// since the fee-receiver collects 90% of swap volume permanently; not
// having a way to fix a mistake was a real sharp edge.

program
  .command("set-fee-receiver")
  .description(
    "Propose a new fee-receiver for a token's pool (step 1 of 2). Must be " +
      "called by the pool's *current* fee-receiver. The new address must " +
      "call accept-fee-receiver to complete the transfer. Requires an " +
      "unlocked wallet."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .requiredOption("--new-receiver <address>", "STX address to propose as the new fee-receiver")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      const account = await getAccount();
      const network = account.network;
      const { singleton } = await fetchProtocolConfig(network);
      const [singletonAddr, singletonName] = singleton.split(".");
      const fee = await resolveFee(opts.fee, network, "contract_call");

      const result = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: "set-pending-fee-receiver",
        functionArgs: [parsePrincipalCV(opts.token), parsePrincipalCV(opts.newReceiver)],
        postConditionMode: PostConditionMode.Deny,
        ...(fee !== undefined && { fee }),
      });

      printJson({
        success: true,
        txid: result.txid,
        token: opts.token,
        newReceiver: opts.newReceiver,
        network,
        explorerUrl: getExplorerTxUrl(result.txid, network),
        note: "The proposed address must now call accept-fee-receiver to complete the transfer.",
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("accept-fee-receiver")
  .description(
    "Accept a pending fee-receiver transfer for a token's pool (step 2 of " +
      "2). Must be called by the address set-fee-receiver proposed. " +
      "Requires an unlocked wallet."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      const account = await getAccount();
      const network = account.network;
      const { singleton } = await fetchProtocolConfig(network);
      const [singletonAddr, singletonName] = singleton.split(".");
      const fee = await resolveFee(opts.fee, network, "contract_call");

      const result = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: "accept-fee-receiver",
        functionArgs: [parsePrincipalCV(opts.token)],
        postConditionMode: PostConditionMode.Deny,
        ...(fee !== undefined && { fee }),
      });

      printJson({
        success: true,
        txid: result.txid,
        token: opts.token,
        network,
        explorerUrl: getExplorerTxUrl(result.txid, network),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-pool
// ---------------------------------------------------------------------------

program
  .command("get-pool")
  .description(
    "Get pool state for a token (reserves, mode, graduation progress, fee-receiver). " +
      "No wallet required."
  )
  .requiredOption(
    "--token <principal>",
    "Full token principal in ADDRESS.contract-name format"
  )
  .option("--network <network>", "mainnet or testnet")
  .action(async (opts) => {
    try {
      const network = resolveNetwork(opts.network);
      const { singleton } = await fetchProtocolConfig(network);

      let sender: string;
      try {
        sender = await getWalletAddress();
      } catch {
        // Fallback — any valid address works for read-only calls
        sender =
          network === "mainnet"
            ? "SP000000000000000000002Q6VF78"
            : "ST000000000000000000002AMW42H";
      }

      // FIX (biwasxyz review, PR #414, worth-addressing #7): use the shared
      // Hiro client (adds the API key header, avoiding rate limits) instead
      // of a hand-rolled fetch.
      const result = await getHiroApi(network).callReadOnlyFunction(
        singleton,
        "get-pool",
        [parsePrincipalCV(opts.token)],
        sender
      );

      if (!result.okay) {
        throw new Error(`get-pool failed: ${result.cause ?? result.result}`);
      }

      // FIX (biwasxyz review, PR #414, blocker A): a single `.value` unwrap
      // isn't enough — `get-pool` returns `(optional (tuple ...))`, and
      // every field *inside* the tuple is its own {type, value} node.
      // `unwrapCV` recurses all the way down instead of assuming one level.
      const pool = unwrapCV(decodeCV(result.result ?? ""));

      if (pool == null || pool === false) {
        printJson({ found: false, token: opts.token, network });
        return;
      }

      // Map mode uint string → human-readable label
      const modeMap: Record<string, string> = {
        "0": "direct",
        "1": "bonding",
        "2": "graduated",
      };

      const p = pool as Record<string, unknown>;
      const rawMode = String(p["mode"] ?? "");
      printJson({
        found: true,
        token: opts.token,
        network,
        mode: modeMap[rawMode] ?? rawMode,
        active: p["active"],
        stxReserve: p["stx-reserve"],
        tokenReserve: p["token-reserve"],
        virtualStx: p["virtual-stx"],
        virtualToken: p["virtual-token"],
        graduationThreshold: p["graduation-threshold"],
        bondedStxCollected: p["bonded-stx-collected"],
        bondedTokensSold: p["bonded-tokens-sold"],
        feeReceiver: p["fee-receiver"],
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// quote-buy
// ---------------------------------------------------------------------------

program
  .command("quote-buy")
  .description(
    "Simulate a buy and return the expected tokens out (net of fees). " +
      "No wallet required. Use the result to set --min-tokens-out in swap-buy."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .requiredOption("--stx-in <uSTX>", "uSTX to spend")
  .option("--network <network>", "mainnet or testnet")
  .action(async (opts) => {
    try {
      const network = resolveNetwork(opts.network);
      const { singleton } = await fetchProtocolConfig(network);

      let sender: string;
      try {
        sender = await getWalletAddress();
      } catch {
        sender =
          network === "mainnet"
            ? "SP000000000000000000002Q6VF78"
            : "ST000000000000000000002AMW42H";
      }

      const result = await getHiroApi(network).callReadOnlyFunction(
        singleton,
        "quote-buy",
        [parsePrincipalCV(opts.token), uintCV(BigInt(opts.stxIn))],
        sender
      );

      if (!result.okay) {
        throw new Error(`quote-buy failed: ${result.cause ?? result.result}`);
      }

      // (some uN) → the uint as a string; none → null.
      const unwrapped = unwrapCV(decodeCV(result.result ?? ""));
      const tokensOut = unwrapped == null ? null : String(unwrapped);

      printJson({
        token: opts.token,
        stxIn: opts.stxIn,
        tokensOut,
        network,
        note:
          tokensOut === null
            ? "Pool not found or stx-in is zero"
            : `Use ${tokensOut} (minus slippage tolerance) as --min-tokens-out in swap-buy`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// quote-sell
// ---------------------------------------------------------------------------

program
  .command("quote-sell")
  .description(
    "Simulate a sell and return the expected STX out (net of fees). " +
      "No wallet required. Use the result to set --min-stx-out in swap-sell."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .requiredOption("--tokens-in <atomic>", "Atomic token units to sell")
  .option("--network <network>", "mainnet or testnet")
  .action(async (opts) => {
    try {
      const network = resolveNetwork(opts.network);
      const { singleton } = await fetchProtocolConfig(network);

      let sender: string;
      try {
        sender = await getWalletAddress();
      } catch {
        sender =
          network === "mainnet"
            ? "SP000000000000000000002Q6VF78"
            : "ST000000000000000000002AMW42H";
      }

      const result = await getHiroApi(network).callReadOnlyFunction(
        singleton,
        "quote-sell",
        [parsePrincipalCV(opts.token), uintCV(BigInt(opts.tokensIn))],
        sender
      );

      if (!result.okay) {
        throw new Error(`quote-sell failed: ${result.cause ?? result.result}`);
      }

      const unwrapped = unwrapCV(decodeCV(result.result ?? ""));
      const stxOut = unwrapped == null ? null : String(unwrapped);

      printJson({
        token: opts.token,
        tokensIn: opts.tokensIn,
        stxOut,
        network,
        note:
          stxOut === null
            ? "Pool not found or tokens-in is zero"
            : `Use ${stxOut} (minus slippage tolerance) as --min-stx-out in swap-sell`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// swap-buy
// ---------------------------------------------------------------------------

program
  .command("swap-buy")
  .description(
    "Buy tokens with STX via swap-exact-stx-for-tokens on the Launkr singleton. " +
      "Run quote-buy first and apply a slippage tolerance (1–2%) to --min-tokens-out. " +
      "Requires an unlocked wallet."
  )
  .requiredOption("--token <principal>", "Full token principal (ADDRESS.contract-name)")
  .requiredOption("--stx-in <uSTX>", "uSTX to spend")
  .requiredOption(
    "--min-tokens-out <atomic>",
    "Minimum tokens to receive — slippage guard (use quote-buy first)"
  )
  .option(
    "--deadline <block>",
    "Max Stacks block height (default: 4294967295 = no deadline)",
    "4294967295"
  )
  .option(
    "--recipient <address>",
    "Address to receive tokens (default: wallet address)"
  )
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      // FIX (biwasxyz review, PR #414, blocker #2) — see the identical note
      // in `launch`: the account's own network is the only thing that
      // actually determines the broadcast target, so it's the only thing
      // that should select which singleton/config we use.
      const account = await getAccount();
      const network = account.network;
      const { chainParam } = NET_CONFIG[network];
      const { singleton } = await fetchProtocolConfig(network);
      const recipient = opts.recipient ?? account.address;
      const [singletonAddr, singletonName] = singleton.split(".");
      const resolvedFee = await resolveFee(opts.fee, network, "contract_call");

      const result = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: "swap-exact-stx-for-tokens",
        functionArgs: [
          parsePrincipalCV(opts.token),
          uintCV(BigInt(opts.stxIn)),
          uintCV(BigInt(opts.minTokensOut)),
          uintCV(BigInt(opts.deadline)),
          parsePrincipalCV(recipient),
        ],
        // FIX (biwasxyz review, PR #414, blocker #1 — verified on-chain,
        // both testnet and mainnet, 2026-08-05): Deny mode requires EVERY
        // principal that moves an asset in the transaction to be covered,
        // not just the caller. A buy has the singleton sending back BOTH
        // the FT payout and STX (the two fee legs, treasury + protocol) —
        // omitting those two conditions aborts with abort_by_post_condition
        // even though the underlying contract call succeeds. One
        // post-condition per (principal, asset) covers the *aggregate*
        // amount that principal sends of that asset across the whole tx —
        // confirmed empirically, no need for one condition per fee leg.
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          // Caller: sends exactly stxIn uSTX, no more, no less.
          createStxPostCondition(account.address, "eq", BigInt(opts.stxIn)),
          // Singleton: pays out the two STX fee legs (treasury + protocol).
          // Not meaningful to bound tightly here — the amount is the
          // contract's own fee math, not attacker-controlled input — so
          // `gte 0` just satisfies Deny mode's "every sender is covered"
          // rule without asserting anything false.
          createContractStxPostCondition(singleton, "gte", 0n),
          // Singleton: pays out at least minTokensOut of the FT — this
          // *is* the meaningful guard (the actual slippage protection).
          createContractFungiblePostCondition(
            singleton,
            opts.token,
            LAUNKR_FT_ASSET_NAME,
            "gte",
            BigInt(opts.minTokensOut)
          ),
        ],
        ...(resolvedFee !== undefined && { fee: resolvedFee }),
      });

      printJson({
        success: true,
        txid: result.txid,
        token: opts.token,
        stxIn: opts.stxIn,
        minTokensOut: opts.minTokensOut,
        recipient,
        network,
        explorerUrl: getExplorerTxUrl(result.txid, network),
        chainExplorerUrl: `https://explorer.hiro.so/txid/${result.txid}?chain=${chainParam}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// swap-sell
// ---------------------------------------------------------------------------

program
  .command("swap-sell")
  .description(
    "Sell tokens for STX via swap-exact-tokens-for-stx on the Launkr singleton. " +
      "Run quote-sell first and apply a slippage tolerance (1–2%) to --min-stx-out. " +
      "Requires an unlocked wallet."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .requiredOption("--tokens-in <atomic>", "Atomic token units to sell")
  .requiredOption(
    "--min-stx-out <uSTX>",
    "Minimum STX to receive — slippage guard (use quote-sell first)"
  )
  .option("--deadline <block>", "Max Stacks block height (default: no deadline)", "4294967295")
  .option("--recipient <address>", "Address to receive STX (default: wallet address)")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      // FIX (biwasxyz review, PR #414, blocker #2) — see the identical note
      // in `launch`.
      const account = await getAccount();
      const network = account.network;
      const { chainParam } = NET_CONFIG[network];
      const { singleton } = await fetchProtocolConfig(network);
      const recipient = opts.recipient ?? account.address;
      const [singletonAddr, singletonName] = singleton.split(".");
      const resolvedFee = await resolveFee(opts.fee, network, "contract_call");

      const result = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: "swap-exact-tokens-for-stx",
        functionArgs: [
          parsePrincipalCV(opts.token),
          uintCV(BigInt(opts.tokensIn)),
          uintCV(BigInt(opts.minStxOut)),
          uintCV(BigInt(opts.deadline)),
          parsePrincipalCV(recipient),
        ],
        // The FT asset name is NOT per-token-variable — every Launkr token
        // uses the identical internal asset name `strategy-token` (verified
        // against the deployed byte-frozen template source, both mainnet
        // and testnet). Only the contract address varies.
        //
        // FIX (biwasxyz review, PR #414, blocker #1 — verified on-chain,
        // both testnet and mainnet, 2026-08-05): a sell has the singleton
        // paying out STX (the swap proceeds *and* the two fee legs) — Deny
        // mode requires that covered too, not just the caller's FT leg.
        // One post-condition per (principal, asset) covers the aggregate
        // amount sent, confirmed empirically — a single `gte minStxOut` on
        // the singleton's uSTX is both correct and the meaningful guard
        // here (the actual slippage protection).
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          createFungiblePostCondition(
            account.address,
            opts.token,
            LAUNKR_FT_ASSET_NAME,
            "eq",
            BigInt(opts.tokensIn)
          ),
          createContractStxPostCondition(singleton, "gte", BigInt(opts.minStxOut)),
        ],
        ...(resolvedFee !== undefined && { fee: resolvedFee }),
      });

      printJson({
        success: true,
        txid: result.txid,
        token: opts.token,
        tokensIn: opts.tokensIn,
        minStxOut: opts.minStxOut,
        recipient,
        network,
        explorerUrl: getExplorerTxUrl(result.txid, network),
        chainExplorerUrl: `https://explorer.hiro.so/txid/${result.txid}?chain=${chainParam}`,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

if (import.meta.main) {
  program.parse();
}
