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
  serializeCV,
  deserializeCV,
  cvToValue,
  PostConditionMode,
  type ClarityValue,
} from "@stacks/transactions";
import { NETWORK, getApiBaseUrl, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { callContract, deployContract } from "../src/lib/transactions/builder.js";
import {
  createStxPostCondition,
  createFungiblePostCondition,
} from "../src/lib/transactions/post-conditions.js";
import { resolveFee } from "../src/lib/utils/fee.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAUNKR_API = "https://launkr.io/api";

// Every Launkr token is a byte-identical copy of restricted-token-template-v6,
// which declares `(define-fungible-token strategy-token)`. The SIP-010 asset
// name is therefore the same constant for every token, so sells can scope a
// real fungible post-condition instead of falling back to allow-all mode.
const STRATEGY_TOKEN_ASSET = "strategy-token";

// Singleton contract per network. Network selection follows the shared AIBTC
// `NETWORK` env var (default testnet) — the same source the wallet and every
// other skill use — so the singleton we target always matches the network the
// transaction is actually signed and broadcast on. The Hiro API host comes from
// the shared `getApiBaseUrl(network)` helper (single source of truth).
const SINGLETON: Record<"mainnet" | "testnet", string> = {
  mainnet: "SP2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9Z367PM.lp-singleton-v6",
  testnet: "ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.lp-singleton-v6",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a Stacks principal string ("SP..." or "SP....contract") into a ClarityValue. */
function parsePrincipalCV(principal: string): ClarityValue {
  const parts = principal.split(".");
  if (parts.length === 2) return contractPrincipalCV(parts[0], parts[1]);
  return standardPrincipalCV(principal);
}

/**
 * Parse a typed arg descriptor from the Launkr /api/launch response into a ClarityValue.
 * Supported types: principal, uint, string-ascii, string-utf8, optional-utf8, optional-ascii.
 */
function parseLaunkrArg(arg: { type: string; value: unknown }): ClarityValue {
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
 * Call a read-only function on the Launkr singleton via the Hiro API.
 * Returns the deserialized ClarityValue result or throws on error.
 */
async function callReadOnly(
  hiroApi: string,
  singletonId: string,
  fnName: string,
  args: ClarityValue[],
  sender: string
): Promise<{ okay: boolean; result?: string; cause?: string }> {
  const [contractAddr, contractName] = singletonId.split(".");
  const url = `${hiroApi}/v2/contracts/call-read/${contractAddr}/${contractName}/${fnName}`;

  // @stacks/transactions v7 `serializeCV` returns a hex string already; older
  // versions returned bytes. Handle both so we never double-encode the hex.
  const hexArgs = args.map((cv) => {
    const serialized = serializeCV(cv);
    const hex =
      typeof serialized === "string"
        ? serialized
        : Buffer.from(serialized as Uint8Array).toString("hex");
    return `0x${hex}`;
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: hexArgs }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Hiro API error ${resp.status} calling ${fnName}: ${body}`);
  }

  return resp.json() as Promise<{ okay: boolean; result?: string; cause?: string }>;
}

/**
 * Recursively flatten the `{ type, value }` tree that @stacks/transactions v7
 * `cvToValue` produces into plain JS values:
 *   - leaves (uint/int/bool/principal/buffer) → their scalar value
 *   - optional/response wrappers → their unwrapped inner value (none → null)
 *   - tuples → a plain object of unwrapped fields
 */
function unwrapCV(node: unknown): unknown {
  if (node == null || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  if (!("type" in o) || !("value" in o)) return node;

  const v = o.value;
  if (v == null) return null; // none / empty optional
  if (typeof v === "object") {
    const vo = v as Record<string, unknown>;
    // A nested { type, value } means an optional/response wrapper — descend.
    if ("type" in vo && "value" in vo) return unwrapCV(vo);
    // Otherwise it's a tuple: a map of field → { type, value }.
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(vo)) out[k] = unwrapCV(vo[k]);
    return out;
  }
  return v; // scalar leaf
}

/**
 * Decode a hex-encoded Clarity value returned by Hiro's call-read endpoint into
 * a flat JS value (scalars, or a plain object for tuples). Returns the raw hex
 * on failure.
 */
function decodeCV(hexResult: string): unknown {
  try {
    const bytes = Buffer.from(hexResult.replace(/^0x/, ""), "hex");
    const cv = deserializeCV(bytes);
    return unwrapCV(cvToValue(cv, true));
  } catch {
    return hexResult;
  }
}

/**
 * Poll the Hiro API until a transaction reaches a terminal status.
 * Throws if the tx aborts/drops or if the timeout is exceeded.
 */
async function waitForConfirmation(
  txid: string,
  hiroApi: string,
  timeoutMs = 300_000,
  pollMs = 6_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${hiroApi}/extended/v1/tx/${txid}`;

  process.stderr.write(`Waiting for tx ${txid} to confirm...\n`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));

    const resp = await fetch(url);
    if (resp.status === 404) continue; // not indexed yet
    if (!resp.ok) throw new Error(`Hiro API error ${resp.status} polling ${txid}`);

    const tx = (await resp.json()) as { tx_status: string };

    if (tx.tx_status === "success") {
      process.stderr.write(`Confirmed: ${txid}\n`);
      return;
    }

    const abortStatuses = [
      "abort_by_response",
      "abort_by_post_condition",
      "dropped_replace_by_fee",
      "dropped_too_expensive",
      "dropped_stale_garbage_collect",
      "dropped_replace_across_fork",
      "dropped_problematic",
    ];
    if (abortStatuses.includes(tx.tx_status)) {
      throw new Error(`Transaction failed with status: ${tx.tx_status}`);
    }

    process.stderr.write(`  status: ${tx.tx_status}, still waiting...\n`);
  }

  throw new Error(`Timed out waiting for tx ${txid} after ${timeoutMs / 1000}s`);
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
    "[bonding] Virtual STX reserve in uSTX (min 500000000 = 500 STX)"
  )
  .option(
    "--graduation-threshold <uSTX>",
    "[bonding] Real STX to collect before graduating (min 2000000000 = 2000 STX, max 10x virtual-stx)"
  )
  .option(
    "--stx-seed <uSTX>",
    "[direct] Real STX to seed the pool in uSTX (min 100000000 = 100 STX)"
  )
  .option("--uri <uri>", "Optional token metadata URI")
  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      // Validate mode-specific required args locally before spending a round-trip.
      if (opts.mode === "bonding") {
        if (!opts.virtualStx || !opts.graduationThreshold) {
          throw new Error(
            "bonding mode requires --virtual-stx and --graduation-threshold"
          );
        }
      } else if (opts.mode === "direct") {
        if (!opts.stxSeed) {
          throw new Error("direct mode requires --stx-seed");
        }
      } else {
        throw new Error(`Unknown --mode "${opts.mode}" — use "bonding" or "direct"`);
      }

      const network = NETWORK;
      const singleton = SINGLETON[network];
      const hiroApi = getApiBaseUrl(network);
      const account = await getAccount();

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
        mode: opts.mode,
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

      // -----------------------------------------------------------------------
      // Step 2 — Deploy the token contract (byte-for-byte copy of template)
      // -----------------------------------------------------------------------
      process.stderr.write(
        `Deploying token contract "${deployStep.contractName}" on ${network}...\n`
      );

      const deployFee = await resolveFee(opts.fee, network, "smart_contract");
      // The template needs Clarity 4 (it uses `contract-hash?`). We rely on the
      // shared deployContract's default, which is Clarity 4 in the pinned
      // @stacks/transactions — no explicit version needed.
      const deployResult = await deployContract(account, {
        contractName: deployStep.contractName,
        codeBody: deployStep.clarityCode,
        ...(deployFee !== undefined && { fee: deployFee }),
      });

      process.stderr.write(`Deploy tx broadcast: ${deployResult.txid}\n`);

      // -----------------------------------------------------------------------
      // Step 3 — Wait for deploy to confirm
      // -----------------------------------------------------------------------
      await waitForConfirmation(deployResult.txid, hiroApi);

      // -----------------------------------------------------------------------
      // Step 4 — Create the pool
      // -----------------------------------------------------------------------
      const clarityArgs = poolStep.functionArgs.map(parseLaunkrArg);
      const poolFee = await resolveFee(opts.fee, network, "contract_call");
      const [singletonAddr, singletonName] = singleton.split(".");

      // Direct mode: post-condition guards the STX seed pulled from the caller.
      // Bonding mode: no STX is pulled at creation — empty post-conditions.
      const postConditions =
        opts.mode === "direct" && opts.stxSeed
          ? [createStxPostCondition(account.address, "eq", BigInt(opts.stxSeed))]
          : [];

      process.stderr.write(`Creating ${opts.mode} pool on ${singleton}...\n`);

      const poolResult = await callContract(account, {
        contractAddress: singletonAddr,
        contractName: singletonName,
        functionName: poolStep.functionName,
        functionArgs: clarityArgs,
        postConditionMode: PostConditionMode.Deny,
        ...(postConditions.length > 0 && { postConditions }),
        ...(poolFee !== undefined && { fee: poolFee }),
      });

      printJson({
        success: true,
        tokenPrincipal: intent.tokenPrincipal,
        deployTxid: deployResult.txid,
        poolTxid: poolResult.txid,
        network,
        explorerUrl: getExplorerTxUrl(poolResult.txid, network),
        launkrUrl: `https://launkr.io/token/${intent.tokenPrincipal}`,
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
  .action(async (opts) => {
    try {
      const network = NETWORK;
      const singleton = SINGLETON[network];
      const hiroApi = getApiBaseUrl(network);

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

      const result = await callReadOnly(
        hiroApi,
        singleton,
        "get-pool",
        [parsePrincipalCV(opts.token)],
        sender
      );

      if (!result.okay) {
        throw new Error(`get-pool failed: ${result.cause ?? result.result}`);
      }

      // get-pool returns (optional {tuple}); decodeCV flattens `some {tuple}`
      // to a plain object and `none` to null.
      const pool = decodeCV(result.result ?? "");

      if (pool == null || typeof pool !== "object") {
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
  .action(async (opts) => {
    try {
      const network = NETWORK;
      const singleton = SINGLETON[network];
      const hiroApi = getApiBaseUrl(network);

      let sender: string;
      try {
        sender = await getWalletAddress();
      } catch {
        sender =
          network === "mainnet"
            ? "SP000000000000000000002Q6VF78"
            : "ST000000000000000000002AMW42H";
      }

      const result = await callReadOnly(
        hiroApi,
        singleton,
        "quote-buy",
        [parsePrincipalCV(opts.token), uintCV(BigInt(opts.stxIn))],
        sender
      );

      if (!result.okay) {
        throw new Error(`quote-buy failed: ${result.cause ?? result.result}`);
      }

      // quote-buy returns (optional uint): decodeCV flattens `some uN` to the
      // uint string and `none` (pool missing / zero input) to null.
      const decoded = decodeCV(result.result ?? "");
      const tokensOut = decoded == null ? null : String(decoded);

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
  .action(async (opts) => {
    try {
      const network = NETWORK;
      const singleton = SINGLETON[network];
      const hiroApi = getApiBaseUrl(network);

      let sender: string;
      try {
        sender = await getWalletAddress();
      } catch {
        sender =
          network === "mainnet"
            ? "SP000000000000000000002Q6VF78"
            : "ST000000000000000000002AMW42H";
      }

      const result = await callReadOnly(
        hiroApi,
        singleton,
        "quote-sell",
        [parsePrincipalCV(opts.token), uintCV(BigInt(opts.tokensIn))],
        sender
      );

      if (!result.okay) {
        throw new Error(`quote-sell failed: ${result.cause ?? result.result}`);
      }

      // quote-sell returns (optional uint): decodeCV flattens `some uN` to the
      // uint string and `none` (pool missing / zero input) to null.
      const decoded = decodeCV(result.result ?? "");
      const stxOut = decoded == null ? null : String(decoded);

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
  )  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      const network = NETWORK;
      const singleton = SINGLETON[network];
      const account = await getAccount();
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
        postConditionMode: PostConditionMode.Deny,
        // Guard: caller sends exactly stxIn uSTX (no more, no less).
        postConditions: [
          createStxPostCondition(account.address, "eq", BigInt(opts.stxIn)),
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
      "Requires an unlocked wallet. Scopes a fungible post-condition on the tokens " +
      "sold (asset name `strategy-token`) on top of the on-chain min-stx-out guard."
  )
  .requiredOption("--token <principal>", "Full token principal")
  .requiredOption("--tokens-in <atomic>", "Atomic token units to sell")
  .requiredOption(
    "--min-stx-out <uSTX>",
    "Minimum STX to receive — slippage guard (use quote-sell first)"
  )
  .option("--deadline <block>", "Max Stacks block height (default: no deadline)", "4294967295")
  .option("--recipient <address>", "Address to receive STX (default: wallet address)")  .option("--fee <fee>", "Fee preset (low|medium|high) or micro-STX amount")
  .action(async (opts) => {
    try {
      const network = NETWORK;
      const singleton = SINGLETON[network];
      const account = await getAccount();
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
        postConditionMode: PostConditionMode.Deny,
        // Guard: caller sends exactly tokensIn of the restricted token. Its asset
        // name is always `strategy-token` (byte-frozen template), so we can scope
        // a real FT post-condition. The STX the singleton pays back is covered by
        // its own Clarity-4 as-contract? allowance — no tx-level PC needed for it.
        postConditions: [
          createFungiblePostCondition(
            account.address,
            opts.token,
            STRATEGY_TOKEN_ASSET,
            "eq",
            BigInt(opts.tokensIn)
          ),
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
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
