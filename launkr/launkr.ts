#!/usr/bin/env bun
/**
 * Launkr skill CLI
 * Launch and trade restricted SIP-010 tokens on the Launkr protected AMM (Stacks blockchain).
 *
 * Usage: bun run launkr/launkr.ts <subcommand> [options]
 */

import { Command } from "commander";
import { tmpdir } from "os";
import { join } from "path";
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
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { callContract, deployContract } from "../src/lib/transactions/builder.js";
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
    hiroApi: "https://api.hiro.so",
    chainParam: "mainnet",
  },
  testnet: {
    singleton: "ST2ABWV7JE5SFV1A1BDS8HARP2QY7QRPGC9KJJYWE.lp-singleton-v6",
    hiroApi: "https://api.testnet.hiro.so",
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

/** Parse a Stacks principal string ("SP..." or "SP....contract") into a ClarityValue. */
function parsePrincipalCV(principal: string): ClarityValue {
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
 * value, worked around a `BadFunctionArgument` broadcast rejection seen
 * against a *different* environment (the published `@aibtc/mcp-server` npm
 * package's own dependency resolution). Verified directly against this
 * repo's exact pinned `@stacks/transactions@7.3.1` — via both a standalone
 * script and this repo's own `callContract` — that a bare `noneCV()`
 * broadcasts and confirms successfully here (testnet txids
 * `6ee46234adfd545bb55d7396835fa730a4184324ac3ad1bf47b0406305234d8e` and
 * `9403bd6670eea9fb5f6812b937bdcd1604adb2d79da019c66583ae13fe38fbc6`, both
 * `(ok true)`). The bug was real but environment-specific, not a Stacks or
 * Clarity issue — reverted to sending a proper `none` rather than a
 * permanent empty-string placeholder.
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
 * FIX (arc0btc review, PR #414): the Launkr API builds the pool-creation
 * functionArgs server-side from our request, but we never cross-checked
 * that what comes back actually matches what we asked for. A buggy or
 * compromised API response could silently swap `fee-receiver` to a
 * different address, or change `supply`, and we'd deploy + create the pool
 * without ever noticing — routing future swap fees to an address we don't
 * control. Fail loudly, before spending any gas, if these don't match.
 *
 * Positional args differ by mode:
 *   bonding: token, name, symbol, decimals, supply, uri, virtual-stx, graduation-threshold, fee-receiver
 *   direct:  token, name, symbol, decimals, supply, uri, stx-seed, fee-receiver
 * `supply` is always index 4; `fee-receiver` is always the last arg.
 */
function validatePoolStepMatchesRequest(
  poolStep: { functionArgs?: Array<{ type: string; value: unknown }> },
  requested: { supply: string; feeReceiver: string; name: string; symbol: string }
): void {
  const args = poolStep.functionArgs;
  if (!args || args.length < 8) {
    throw new Error("Launkr API returned an unexpected number of pool-creation args");
  }

  const nameArg = String(args[1]?.value);
  const symbolArg = String(args[2]?.value);
  const supplyArg = String(args[4]?.value);
  const feeReceiverArg = String(args[args.length - 1]?.value);

  const mismatches: string[] = [];
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

  if (mismatches.length > 0) {
    throw new Error(
      `Refusing to proceed — Launkr API's pool-creation args don't match what was requested:\n` +
        mismatches.map((m) => `  - ${m}`).join("\n")
    );
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

  const hexArgs = args.map(
    (cv) => `0x${Buffer.from(serializeCV(cv)).toString("hex")}`
  );

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
 * Decode a hex-encoded Clarity value returned by Hiro's call-read endpoint.
 * Returns a JS-friendly plain value via cvToValue, or the raw hex on failure.
 */
function decodeCV(hexResult: string): unknown {
  try {
    const bytes = Buffer.from(hexResult.replace(/^0x/, ""), "hex");
    const cv = deserializeCV(bytes);
    return cvToValue(cv, true); // true = convert bigints to strings
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
      const { singleton, hiroApi, chainParam } = NET_CONFIG[network];

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

      // FIX (arc0btc review, PR #414): verify the API's pool-creation args
      // actually match what we asked for — before spending any gas at all.
      validatePoolStepMatchesRequest(poolStep, {
        name: opts.name,
        symbol: opts.symbol,
        supply: opts.supply,
        feeReceiver: opts.feeReceiver,
      });

      // -----------------------------------------------------------------------
      // Step 2 — Deploy the token contract (byte-for-byte copy of template)
      // -----------------------------------------------------------------------
      const tmpPath = join(
        tmpdir(),
        `${deployStep.contractName}-${Date.now()}.clar`
      );
      await Bun.write(tmpPath, deployStep.clarityCode);
      process.stderr.write(
        `Deploying token contract "${deployStep.contractName}" on ${network}...\n`
      );

      const deployFee = await resolveFee(opts.fee, network, "smart_contract");
      const deployResult = await deployContract(account, {
        contractName: deployStep.contractName,
        codeBody: deployStep.clarityCode,
        ...(deployFee !== undefined && { fee: deployFee }),
      });

      // Clean up temp file
      try {
        await Bun.file(tmpPath).exists();
        const { unlinkSync } = await import("fs");
        unlinkSync(tmpPath);
      } catch {}

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
        chainExplorerUrl: `https://explorer.hiro.so/txid/${poolResult.txid}?chain=${chainParam}`,
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
      const { singleton, hiroApi } = NET_CONFIG[network];

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

      const decoded = decodeCV(result.result ?? "");

      // cvToValue returns the ok wrapper — unwrap it
      const pool =
        decoded != null &&
        typeof decoded === "object" &&
        "value" in (decoded as Record<string, unknown>)
          ? (decoded as Record<string, unknown>)["value"]
          : decoded;

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
      const { singleton, hiroApi } = NET_CONFIG[network];

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

      // Result shape: (ok (some uN)) → decoded as { value: { value: "N" } }
      // or (ok none) → decoded as { value: null }
      const decoded = decodeCV(result.result ?? "");
      const inner =
        decoded != null &&
        typeof decoded === "object" &&
        "value" in (decoded as Record<string, unknown>)
          ? (decoded as Record<string, unknown>)["value"]
          : decoded;

      const tokensOut =
        inner != null && typeof inner === "object" && "value" in (inner as Record<string, unknown>)
          ? String((inner as Record<string, unknown>)["value"])
          : inner != null
          ? String(inner)
          : null;

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
      const { singleton, hiroApi } = NET_CONFIG[network];

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

      const decoded = decodeCV(result.result ?? "");
      const inner =
        decoded != null &&
        typeof decoded === "object" &&
        "value" in (decoded as Record<string, unknown>)
          ? (decoded as Record<string, unknown>)["value"]
          : decoded;

      const stxOut =
        inner != null && typeof inner === "object" && "value" in (inner as Record<string, unknown>)
          ? String((inner as Record<string, unknown>)["value"])
          : inner != null
          ? String(inner)
          : null;

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
      const { singleton, chainParam } = NET_CONFIG[network];
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
      const { singleton, chainParam } = NET_CONFIG[network];
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

program.parse(process.argv);
