#!/usr/bin/env bun
/**
 * Bolt skill CLI
 * Gasless Stacks transactions through Bolt Protocol (boltproto.org): the
 * wallet signs a sponsored transaction, Bolt pays the STX fee and broadcasts,
 * and the wallet pays Bolt in sBTC or USDCx instead.
 *
 * Usage: bun run bolt/bolt.ts <subcommand> [options]
 */

import { Command } from "commander";
import {
  makeContractCall,
  Cl,
  PostConditionMode,
  type ClarityValue,
  type PostCondition,
} from "@stacks/transactions";
import { NETWORK, getExplorerTxUrl } from "../src/lib/config/networks.js";
import { getAccount, getWalletAddress } from "../src/lib/services/x402.service.js";
import { getHiroApi } from "../src/lib/services/hiro-api.js";
import { parseArgToClarityValue } from "../src/lib/transactions/clarity-values.js";
import {
  createFungiblePostCondition,
  createStxPostCondition,
} from "../src/lib/transactions/post-conditions.js";
import { AibtcError } from "../src/lib/utils/errors.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOLT_API = "https://boltproto.org/api";
const BOLT_DOCS = "https://boltproto.org/llms-full.txt";
const BOLT_DEPLOYER = "SP3QZNX3CGT6V7PE1PBK17FCRK1TP1AT02ZHQCMVJ";

/** Path segment the v1 credit routes use for the sBTC credit ledger. */
const CREDIT_TOKEN = "sbtc-token";
/** Smallest fee Bolt accepts for a credit-sponsored call, in sats. */
const MIN_CREDIT_FEE = 10n;
/** Above 1,200 bytes the minimum grows by 1 sat per 120 bytes of transaction. */
const CREDIT_BYTES_PER_SAT = 120n;

function minCreditFee(serializedTx: string): bigint {
  const bytes = BigInt(Math.ceil(serializedTx.length / 2));
  const bySize = (bytes + CREDIT_BYTES_PER_SAT - 1n) / CREDIT_BYTES_PER_SAT;
  return bySize > MIN_CREDIT_FEE ? bySize : MIN_CREDIT_FEE;
}
const MEMO_MAX_BYTES = 34;

type TokenKey = "sbtc" | "usdcx";

const TOKENS: Record<
  TokenKey,
  {
    symbol: string;
    unit: string;
    boltContract: string;
    assetContract: string;
    assetName: string;
    minFee: bigint;
  }
> = {
  sbtc: {
    symbol: "sBTC",
    unit: "sats",
    boltContract: "boltproto-sbtc-v2",
    assetContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    assetName: "sbtc-token",
    minFee: 10n,
  },
  usdcx: {
    symbol: "USDCx",
    unit: "micro-USDCx",
    boltContract: "boltproto-usdcx-v1",
    assetContract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    assetName: "usdcx-token",
    minFee: 100n,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireMainnet(): void {
  if (NETWORK !== "mainnet") {
    throw new AibtcError(
      "Bolt Protocol is a mainnet service; this skill has no testnet endpoint.",
      "BOLT_MAINNET_ONLY",
      { network: NETWORK },
      "Run with NETWORK=mainnet"
    );
  }
}

function parseAmount(value: string, flag: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new AibtcError(
      `${flag} must be a positive integer in the token's smallest unit`,
      "BOLT_INVALID_ARGUMENT",
      { [flag]: value }
    );
  }
  return BigInt(value);
}

function memoArg(memo: string | undefined): ClarityValue {
  if (!memo) return Cl.none();
  if (new TextEncoder().encode(memo).length > MEMO_MAX_BYTES) {
    throw new AibtcError(
      `--memo is limited to ${MEMO_MAX_BYTES} bytes`,
      "BOLT_INVALID_ARGUMENT"
    );
  }
  return Cl.some(Cl.bufferFromUtf8(memo));
}

/** Map a Bolt error response to a structured error an agent can act on. */
function boltError(status: number, message: string): AibtcError {
  const rules: Array<[RegExp, string, string]> = [
    [
      /rejected by the network/i,
      "BOLT_REJECTED",
      "Nothing was charged. The message names the network's reason: fix that, then run the command again.",
    ],
    [
      /Try again|Nothing was charged/i,
      "BOLT_TEMPORARILY_UNAVAILABLE",
      "Nothing was charged. Try again later.",
    ],
    [
      /Invalid nonce/i,
      "BOLT_INVALID_NONCE",
      "Wait for this address's pending transactions to confirm, then run the command again.",
    ],
    [
      /Insufficient sponsor credit/i,
      "BOLT_INSUFFICIENT_CREDIT",
      "Run credit-deposit, wait for it to confirm, then credit-balance before retrying.",
    ],
    [
      /not sponsored on credit/i,
      "BOLT_CONTRACT_NOT_ON_CREDIT",
      "Bolt's own contracts cannot be called through sponsor-call. Use the transfer subcommand.",
    ],
    [
      /minimum required fee/i,
      "BOLT_FEE_TOO_LOW",
      "Nothing was charged. Raise --fee to the minimum in the message.",
    ],
    [
      /Insufficient .*balance/i,
      "BOLT_INSUFFICIENT_BALANCE",
      "The wallet needs amount + fee of the token. Fund it or lower --amount.",
    ],
    [
      /serializedTx|not sponsored$|Only contract calls|signature|Invalid fee|not allowed|not supported|Post condition/i,
      "BOLT_INVALID_TRANSACTION",
      "Nothing was charged. Fix the transaction: it must be a contract call signed with sponsored: true and fee 0.",
    ],
  ];
  for (const [pattern, code, suggestion] of rules) {
    if (pattern.test(message)) {
      return new AibtcError(message, code, { status }, suggestion, BOLT_DOCS);
    }
  }
  if (status === 429) {
    return new AibtcError(
      message,
      "BOLT_RATE_LIMITED",
      { status },
      "Too many requests. Wait before sending again.",
      BOLT_DOCS
    );
  }
  return new AibtcError(
    message,
    "BOLT_REJECTED",
    { status },
    "The network refused the transaction.",
    BOLT_DOCS
  );
}

async function boltRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BOLT_API}${path}`, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const raw = (body as { message?: unknown } | undefined)?.message;
    const message = Array.isArray(raw)
      ? raw.join("; ")
      : typeof raw === "string"
        ? raw
        : `Bolt answered HTTP ${response.status}`;
    throw boltError(response.status, message);
  }
  return body as T;
}

function boltPost<T>(path: string, body: unknown): Promise<T> {
  return boltRequest<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Next nonce for the account, counting its pending transactions. */
async function nextNonce(address: string): Promise<bigint> {
  const info = await getHiroApi(NETWORK).getNonceInfo(address);
  const executed = info.last_executed_tx_nonce as number | null;
  const confirmedNext = executed === null ? 0 : executed + 1;
  const mempool = info.last_mempool_tx_nonce;
  return BigInt(mempool !== null && mempool >= confirmedNext ? mempool + 1 : confirmedNext);
}

interface CallSpec {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
  postConditionMode: PostConditionMode;
}

/** Build and sign a sponsored contract call. Nothing is broadcast here. */
async function signSponsored(
  spec: CallSpec,
  nonceOverride?: bigint
): Promise<{ serializedTx: string; sender: string; nonce: bigint }> {
  const account = await getAccount();
  const nonce = nonceOverride ?? (await nextNonce(account.address));
  const transaction = await makeContractCall({
    ...spec,
    senderKey: account.privateKey,
    network: NETWORK,
    sponsored: true,
    fee: 0n,
    nonce,
  });
  return { serializedTx: transaction.serialize(), sender: account.address, nonce };
}

/** The nonce to sign with instead, when Bolt's refusal names one. */
function nonceFromRefusal(error: unknown): bigint | undefined {
  if (!(error instanceof AibtcError) || error.code !== "BOLT_INVALID_NONCE") return undefined;
  const pending = error.message.match(/nonce (\d+) from \S+ is already pending/);
  if (pending) return BigInt(pending[1]) + 1n;
  const stale = error.message.match(/transaction has (\d+), the next nonce for \S+ is (\d+)/);
  if (stale && BigInt(stale[1]) < BigInt(stale[2])) return BigInt(stale[2]);
  return undefined;
}

/** Sign and send; if Bolt names a different nonce, sign again with it, once. */
async function signAndSend<T>(
  spec: CallSpec,
  send: (serializedTx: string) => Promise<T>
): Promise<{ result: T; sender: string; nonce: bigint }> {
  const first = await signSponsored(spec);
  try {
    return { result: await send(first.serializedTx), sender: first.sender, nonce: first.nonce };
  } catch (error) {
    const retryNonce = nonceFromRefusal(error);
    if (retryNonce === undefined) throw error;
    const second = await signSponsored(spec, retryNonce);
    return { result: await send(second.serializedTx), sender: second.sender, nonce: second.nonce };
  }
}

function parseJsonArray(value: string, flag: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (e) {
    throw new AibtcError(
      `Invalid ${flag} JSON: ${e instanceof Error ? e.message : String(e)}`,
      "BOLT_INVALID_ARGUMENT"
    );
  }
}

/** Post conditions in the same JSON shape the contract skill takes (stx, ft). */
function parsePostCondition(pc: unknown): PostCondition {
  const { type, principal, conditionCode, amount, asset, assetName } = (pc ?? {}) as Record<string, unknown>;
  const codes = ["eq", "gt", "gte", "lt", "lte"] as const;
  type Code = (typeof codes)[number];
  if (
    typeof principal !== "string" ||
    (typeof amount !== "string" && typeof amount !== "number") ||
    !codes.includes(conditionCode as Code)
  ) {
    throw new AibtcError(
      "Each post condition needs principal, amount and conditionCode (eq|gt|gte|lt|lte)",
      "BOLT_INVALID_ARGUMENT"
    );
  }
  if (type === "stx") {
    return createStxPostCondition(principal, conditionCode as Code, BigInt(amount));
  }
  if (type === "ft" && typeof asset === "string" && typeof assetName === "string") {
    return createFungiblePostCondition(principal, asset, assetName, conditionCode as Code, BigInt(amount));
  }
  throw new AibtcError(
    "Post condition type must be 'stx' or 'ft' (ft also needs asset and assetName)",
    "BOLT_INVALID_ARGUMENT"
  );
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("bolt")
  .description(
    "Bolt Protocol: gasless sBTC/USDCx transfers and prepaid gas credit for any contract call on Stacks, with no STX in the wallet"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Check that Bolt is up and show endpoints, contracts and minimum fees. No wallet needed.")
  .action(async () => {
    try {
      requireMainnet();
      const health = await boltRequest<{ status: string }>("/health");
      printJson({
        network: NETWORK,
        endpoint: BOLT_API,
        status: health.status,
        docs: BOLT_DOCS,
        transfer: Object.fromEntries(
          (Object.keys(TOKENS) as TokenKey[]).map((key) => [
            key,
            {
              contract: `${BOLT_DEPLOYER}.${TOKENS[key].boltContract}`,
              minFee: TOKENS[key].minFee.toString(),
              unit: TOKENS[key].unit,
            },
          ])
        ),
        credit: {
          token: "sBTC",
          contract: `${BOLT_DEPLOYER}.${TOKENS.sbtc.boltContract}`,
          minFeePerCall: MIN_CREDIT_FEE.toString(),
          unit: "sats",
          note: "Prepaid credit is funded and spent in sBTC only. There is no USDCx credit; USDCx is supported by transfer.",
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

program
  .command("transfer")
  .description(
    "Send sBTC or USDCx to a Stacks address with no STX: the fee is paid in the token itself, inside the same transaction. Requires an unlocked wallet."
  )
  .requiredOption("--token <token>", "sbtc or usdcx")
  .requiredOption("--recipient <address>", "Stacks address to send to")
  .requiredOption("--amount <units>", "Amount in the smallest unit: sats for sBTC, micro-USDCx for USDCx")
  .option("--fee <units>", "Fee paid to Bolt in the same token (default: the minimum, 10 sats or 100 micro-USDCx)")
  .option("--memo <text>", "Optional memo, up to 34 bytes")
  .action(async (opts: { token: string; recipient: string; amount: string; fee?: string; memo?: string }) => {
    try {
      requireMainnet();
      const key = opts.token.toLowerCase() as TokenKey;
      const token = TOKENS[key];
      if (!token) {
        throw new AibtcError("--token must be sbtc or usdcx", "BOLT_INVALID_ARGUMENT");
      }
      const amount = parseAmount(opts.amount, "--amount");
      const fee = opts.fee ? parseAmount(opts.fee, "--fee") : token.minFee;
      const sender = await getWalletAddress();

      const { result, nonce } = await signAndSend(
        {
          contractAddress: BOLT_DEPLOYER,
          contractName: token.boltContract,
          functionName: "transfer-stacks-to-stacks",
          functionArgs: [Cl.uint(amount), Cl.principal(opts.recipient), memoArg(opts.memo), Cl.uint(fee)],
          postConditions: [
            createFungiblePostCondition(sender, token.assetContract, token.assetName, "eq", amount + fee),
          ],
          postConditionMode: PostConditionMode.Deny,
        },
        (serializedTx) => boltPost<{ txid: string }>(`/v2/transaction/transfer?token=${key}`, { serializedTx })
      );

      printJson({
        success: true,
        txid: result.txid,
        from: sender,
        recipient: opts.recipient,
        token: token.symbol,
        amount: amount.toString(),
        fee: fee.toString(),
        unit: token.unit,
        nonce: nonce.toString(),
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// credit-balance
// ---------------------------------------------------------------------------

program
  .command("credit-balance")
  .description(
    "Read the prepaid gas credit of an address, in sats. Run it after a credit-deposit confirms; the credit is available after that."
  )
  .option("--address <address>", "Stacks address to check (uses active wallet if omitted)")
  .action(async (opts: { address?: string }) => {
    try {
      requireMainnet();
      const address = opts.address ?? (await getWalletAddress());
      const result = await boltRequest<{ balance: string }>(`/v1/sponsor/${CREDIT_TOKEN}/balance/${address}`);
      const balance = BigInt(result.balance);
      printJson({
        address,
        network: NETWORK,
        credit: { sats: balance.toString(), callsAtMinimumFee: (balance / MIN_CREDIT_FEE).toString() },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// credit-deposit
// ---------------------------------------------------------------------------

program
  .command("credit-deposit")
  .description(
    "Deposit sBTC as prepaid gas credit (sBTC only; there is no USDCx credit). The deposit is itself gasless. Credit is not withdrawable at this time, so deposit what you plan to use. Requires an unlocked wallet."
  )
  .requiredOption("--amount <sats>", "Credit to add, in sats")
  .option("--fee <sats>", "Fee for the deposit itself, in sats (default: 10)")
  .action(async (opts: { amount: string; fee?: string }) => {
    try {
      requireMainnet();
      const amount = parseAmount(opts.amount, "--amount");
      const fee = opts.fee ? parseAmount(opts.fee, "--fee") : TOKENS.sbtc.minFee;
      const sender = await getWalletAddress();

      const { result, nonce } = await signAndSend(
        {
          contractAddress: BOLT_DEPLOYER,
          contractName: TOKENS.sbtc.boltContract,
          functionName: "deposit-fee-fund",
          functionArgs: [Cl.uint(amount), Cl.uint(fee)],
          postConditions: [
            createFungiblePostCondition(sender, TOKENS.sbtc.assetContract, TOKENS.sbtc.assetName, "eq", amount + fee),
          ],
          postConditionMode: PostConditionMode.Deny,
        },
        (serializedTx) => boltPost<{ txid: string }>(`/v1/transaction/${CREDIT_TOKEN}`, { serializedTx })
      );

      printJson({
        success: true,
        txid: result.txid,
        address: sender,
        creditAdded: amount.toString(),
        fee: fee.toString(),
        unit: "sats",
        nonce: nonce.toString(),
        network: NETWORK,
        explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        next: "Wait for the transaction to confirm, then run credit-balance. The credit is available after that.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// sponsor-call
// ---------------------------------------------------------------------------

program
  .command("sponsor-call")
  .description(
    "Have Bolt sponsor any contract call, paid from prepaid sBTC credit. Pass --contract/--function/--args to build and sign it here, or --serialized-tx for one already signed as sponsored. Requires an unlocked wallet unless --serialized-tx is used."
  )
  .option("--contract <contractId>", "Full contract ID in ADDRESS.contract-name format")
  .option("--function <functionName>", "Public function name to call")
  .option("--args <json>", 'Function arguments as JSON array. Typed: [{"type":"uint","value":100}]', "[]")
  .option("--post-condition-mode <mode>", "'deny' (default) blocks unexpected transfers; 'allow' permits any", "deny")
  .option("--post-conditions <json>", "Post conditions as JSON array (stx and ft). See SKILL.md for format.")
  .option("--serialized-tx <hex>", "Hex of a contract call already signed with sponsored: true and fee 0")
  .option("--fee <sats>", "Credit to spend on this call, in sats (default: the minimum for its size, from 10)")
  .action(
    async (opts: {
      contract?: string;
      function?: string;
      args: string;
      postConditionMode: string;
      postConditions?: string;
      serializedTx?: string;
      fee?: string;
    }) => {
      try {
        requireMainnet();
        let fee = opts.fee ? parseAmount(opts.fee, "--fee") : undefined;

        const send = (serializedTx: string) => {
          fee ??= minCreditFee(serializedTx);
          return boltPost<{ txid: string }>(`/v1/sponsor/${CREDIT_TOKEN}/transaction`, {
            serializedTx,
            fee: fee.toString(),
          });
        };

        let result: { txid: string };
        let nonce: string | undefined;
        if (opts.serializedTx) {
          if (opts.contract || opts.function) {
            throw new AibtcError(
              "Use either --serialized-tx or --contract/--function, not both",
              "BOLT_INVALID_ARGUMENT"
            );
          }
          result = await send(opts.serializedTx.replace(/^0x/, ""));
        } else {
          const [contractAddress, contractName] = (opts.contract ?? "").split(".");
          if (!contractAddress || !contractName || !opts.function) {
            throw new AibtcError(
              "Provide --contract ADDRESS.contract-name and --function, or --serialized-tx",
              "BOLT_INVALID_ARGUMENT"
            );
          }
          const sent = await signAndSend(
            {
              contractAddress,
              contractName,
              functionName: opts.function,
              functionArgs: parseJsonArray(opts.args, "--args").map(parseArgToClarityValue),
              postConditions: opts.postConditions
                ? parseJsonArray(opts.postConditions, "--post-conditions").map(parsePostCondition)
                : [],
              postConditionMode:
                opts.postConditionMode === "allow" ? PostConditionMode.Allow : PostConditionMode.Deny,
            },
            send
          );
          result = sent.result;
          nonce = sent.nonce.toString();
        }

        printJson({
          success: true,
          txid: result.txid,
          ...(opts.contract && { contract: opts.contract, function: opts.function }),
          creditSpent: fee!.toString(),
          unit: "sats",
          ...(nonce !== undefined && { nonce }),
          network: NETWORK,
          explorerUrl: getExplorerTxUrl(result.txid, NETWORK),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

program.parse(process.argv);
