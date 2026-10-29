#!/usr/bin/env bun
/**
 * inbox skill CLI
 * x402-gated agent inbox — send paid messages, read received messages, check inbox status,
 * and auto-reply to paid messages via the AIBTC Inference Marketplace
 *
 * Usage: bun run inbox/inbox.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, getInboxBase } from "../src/lib/config/networks.js";
import {
  checkSponsoredPaymentBalance,
  getAccount,
  getWalletAddress,
} from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { readAppConfig, writeAppConfig, type InboxAutoReplyConfig } from "../src/lib/utils/storage.js";
import {
  DEFAULT_AUTO_REPLY_MODEL,
  DEFAULT_DAILY_CAP_SATS,
  DEFAULT_MAX_REPLIES_PER_RUN,
  MAX_REPLIES_PER_RUN,
  listLiveModels,
  marketplaceReplyGenerator,
  resolveDailyCapSats,
  runAutoReply,
} from "../src/lib/services/inbox-auto-reply.service.js";

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("inbox")
  .description(
    "x402-gated agent inbox — send paid messages, read received messages, check inbox status"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

program
  .command("send")
  .description(
    "Send a paid x402 message to another agent's inbox on aibtc.com. " +
      "Uses sponsored transactions so only sBTC message cost is required — no STX gas fees. " +
      "Requires an unlocked wallet with sufficient sBTC balance (100 sats per message)."
  )
  .requiredOption(
    "--recipient-btc-address <address>",
    "Recipient's Bitcoin address (bc1...)"
  )
  .requiredOption(
    "--recipient-stx-address <address>",
    "Recipient's Stacks address (SP...)"
  )
  .requiredOption("--content <text>", "Message content (max 500 characters)")
  .action(
    async (opts: {
      recipientBtcAddress: string;
      recipientStxAddress: string;
      content: string;
    }) => {
      try {
        if (opts.content.length > 500) {
          throw new Error("Message content exceeds 500 character limit");
        }

        const account = await getAccount();

        const inboxUrl = `${getInboxBase()}/${opts.recipientStxAddress}`;
        const body = {
          toBtcAddress: opts.recipientBtcAddress,
          toStxAddress: opts.recipientStxAddress,
          content: opts.content,
        };

        // Step 1: POST without payment to get 402 challenge
        const initialRes = await fetch(inboxUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (initialRes.status !== 402) {
          const text = await initialRes.text();
          if (initialRes.ok) {
            printJson({
              success: true,
              message: "Message sent (no payment required)",
              response: text,
            });
            return;
          }
          throw new Error(
            `Expected 402 payment challenge, got ${initialRes.status}: ${text}`
          );
        }

        // Step 2: Parse payment requirements from 402 response
        const paymentHeader = initialRes.headers.get("payment-required");
        if (!paymentHeader) {
          throw new Error("402 response missing payment-required header");
        }

        const {
          decodePaymentRequired,
          encodePaymentPayload,
          X402_HEADERS,
        } = await import("../src/lib/utils/x402-protocol.js");
        const {
          makeContractCall,
          uintCV,
          principalCV,
          noneCV,
        } = await import("@stacks/transactions");
        const {
          getContracts,
          parseContractId,
        } = await import("../src/lib/config/contracts.js");
        const { getStacksNetwork } = await import(
          "../src/lib/config/networks.js"
        );
        const { createFungiblePostCondition } = await import(
          "../src/lib/transactions/post-conditions.js"
        );
        const { getHiroApi } = await import("../src/lib/services/hiro-api.js");

        const paymentRequired = decodePaymentRequired(paymentHeader);
        if (
          !paymentRequired ||
          !paymentRequired.accepts ||
          paymentRequired.accepts.length === 0
        ) {
          throw new Error("No accepted payment methods in 402 response");
        }
        const accept = paymentRequired.accepts[0];
        const amount = BigInt(accept.amount);
        await checkSponsoredPaymentBalance(account, "sBTC", amount);

        // Step 3: Build sponsored sBTC transfer transaction
        const contracts = getContracts(NETWORK);
        const { address: contractAddress, name: contractName } =
          parseContractId(contracts.SBTC_TOKEN);
        const networkName = getStacksNetwork(NETWORK);

        const postCondition = createFungiblePostCondition(
          account.address,
          contracts.SBTC_TOKEN,
          "sbtc-token",
          "eq",
          amount
        );

        const hiro = getHiroApi(NETWORK);
        const accountInfo = await hiro.getAccountInfo(account.address);
        const nonce = BigInt(accountInfo.nonce);

        const transaction = await makeContractCall({
          contractAddress,
          contractName,
          functionName: "transfer",
          functionArgs: [
            uintCV(amount),
            principalCV(account.address),
            principalCV(accept.payTo),
            noneCV(),
          ],
          senderKey: account.privateKey,
          network: networkName,
          postConditions: [postCondition],
          sponsored: true,
          fee: 0n,
          nonce,
        });

        const txHex = "0x" + transaction.serialize();

        // Step 4: Encode payment payload
        const paymentSignature = encodePaymentPayload({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted: accept,
          payload: { transaction: txHex },
        });

        // Step 5: Send with payment header
        const finalRes = await fetch(inboxUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
          },
          body: JSON.stringify(body),
        });

        const responseText = await finalRes.text();
        let responseData: unknown;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          responseData = { raw: responseText };
        }

        if (finalRes.status === 201 || finalRes.status === 200) {
          const settlementHeader = finalRes.headers.get(
            X402_HEADERS.PAYMENT_RESPONSE
          );
          const { decodePaymentResponse } = await import(
            "../src/lib/utils/x402-protocol.js"
          );
          const settlement = decodePaymentResponse(settlementHeader);
          const txid = settlement?.transaction;

          printJson({
            success: true,
            message: "Message delivered",
            recipient: {
              btcAddress: opts.recipientBtcAddress,
              stxAddress: opts.recipientStxAddress,
            },
            contentLength: opts.content.length,
            inbox: responseData,
            ...(txid && {
              payment: {
                txid,
                amount: accept.amount + " sats sBTC",
              },
            }),
          });
          return;
        }

        throw new Error(
          `Message delivery failed (${finalRes.status}): ${responseText}`
        );
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

program
  .command("read")
  .description(
    "Read messages from the active wallet's inbox. Free — no payment required."
  )
  .option(
    "--status <filter>",
    "Filter messages by status: unread, read, or all",
    "unread"
  )
  .action(async (opts: { status: string }) => {
    try {
      const address = await getWalletAddress();

      const url = `${getInboxBase()}/${address}${opts.status !== "all" ? `?status=${opts.status}` : ""}`;

      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      const responseText = await res.text();
      let messages: unknown;
      try {
        messages = JSON.parse(responseText);
      } catch {
        messages = { raw: responseText };
      }

      if (!res.ok) {
        throw new Error(`Failed to read inbox (${res.status}): ${responseText}`);
      }

      const data = messages as Record<string, unknown>;
      const inboxData = data?.inbox as Record<string, unknown> | undefined;
      const messageArray: unknown[] = Array.isArray(inboxData?.messages)
        ? (inboxData!.messages as unknown[])
        : [];

      printJson({
        address,
        status: opts.status,
        messages: messageArray,
        count: messageArray.length,
        ...(inboxData && {
          unreadCount: inboxData.unreadCount,
          totalCount: inboxData.totalCount,
        }),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command("status")
  .description(
    "Check inbox state for the active wallet — message counts and last received timestamp. " +
      "Free — no payment required."
  )
  .action(async () => {
    try {
      const address = await getWalletAddress();

      // Single fetch — the API returns unreadCount and totalCount in one call
      const res = await fetch(`${getInboxBase()}/${address}`, {
        method: "GET",
      });

      const responseText = await res.text();
      if (!res.ok) {
        throw new Error(
          `Failed to fetch inbox status (${res.status}): ${responseText}`
        );
      }

      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        data = { raw: responseText };
      }

      const inboxData = data?.inbox as Record<string, unknown> | undefined;
      const messages = Array.isArray(inboxData?.messages)
        ? (inboxData!.messages as Array<Record<string, unknown>>)
        : [];

      printJson({
        address,
        network: NETWORK,
        inbox: {
          total: inboxData?.totalCount ?? messages.length,
          unread: inboxData?.unreadCount ?? 0,
          lastReceived: messages[0]?.sentAt ?? null,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// auto-reply-config
// ---------------------------------------------------------------------------

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--enabled must be true or false, got "${value}"`);
}

function parseNonNegativeInt(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return Number(value);
}

function requireMainnet(): void {
  if (NETWORK !== "mainnet") {
    throw new Error(
      "Inbox auto-reply is mainnet only: the aibtc.com inbox and the inference marketplace settle in mainnet sBTC. Set NETWORK=mainnet."
    );
  }
}

program
  .command("auto-reply-config")
  .description(
    "Configure inbox auto-reply (stored in ~/.aibtc/config.json, shared with the aibtc MCP server). " +
      "With no options, show the current settings. A system prompt is required before auto-reply can be enabled."
  )
  .option("--enabled <bool>", "Allow auto-reply to post replies (true|false). Dry runs work while disabled.")
  .option(
    "--model <id>",
    `Inference marketplace model id, checked against https://inference.aibtc.com/v1/models (default ${DEFAULT_AUTO_REPLY_MODEL})`
  )
  .option("--system-prompt <text>", "Who the agent is, its tone, what it offers, what it won't do (max 4000 characters)")
  .option(
    "--daily-cap-sats <sats>",
    `Most sats spent on reply inference per UTC day (default ${DEFAULT_DAILY_CAP_SATS})`
  )
  .action(
    async (opts: { enabled?: string; model?: string; systemPrompt?: string; dailyCapSats?: string }) => {
      try {
        const config = await readAppConfig();
        const current = config.inboxAutoReply;
        if (
          opts.enabled === undefined &&
          opts.model === undefined &&
          opts.systemPrompt === undefined &&
          opts.dailyCapSats === undefined
        ) {
          printJson({
            configured: Boolean(current),
            settings: current ?? null,
            ...(!current && { note: "Not configured. Set --system-prompt, then --enabled true." }),
          });
          return;
        }

        const enabled = opts.enabled === undefined ? undefined : parseBoolean(opts.enabled);
        const dailyCapSats =
          opts.dailyCapSats === undefined ? undefined : parseNonNegativeInt("--daily-cap-sats", opts.dailyCapSats);
        if (opts.systemPrompt !== undefined) {
          const trimmed = opts.systemPrompt.trim();
          if (!trimmed) throw new Error("--system-prompt must not be empty");
          if (trimmed.length > 4000) throw new Error("--system-prompt exceeds 4000 characters");
        }
        if (opts.model !== undefined) {
          const live = await listLiveModels();
          if (!live.includes(opts.model)) {
            throw new Error(`Model "${opts.model}" is not live on the inference marketplace. Live models: ${live.join(", ")}`);
          }
        }

        const next: InboxAutoReplyConfig = {
          enabled: enabled ?? current?.enabled ?? false,
          model: opts.model ?? current?.model ?? DEFAULT_AUTO_REPLY_MODEL,
          systemPrompt: opts.systemPrompt?.trim() ?? current?.systemPrompt ?? "",
          dailyCapSats: dailyCapSats ?? current?.dailyCapSats ?? DEFAULT_DAILY_CAP_SATS,
        };
        if (next.enabled && !next.systemPrompt) {
          throw new Error("Set --system-prompt before enabling auto-reply.");
        }

        await writeAppConfig({ ...config, inboxAutoReply: next });
        printJson({ success: true, settings: next });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// auto-reply
// ---------------------------------------------------------------------------

program
  .command("auto-reply")
  .description(
    "Answer paid, settled, unanswered inbox messages (oldest first). Each reply is written by an AIBTC " +
      "Inference Marketplace model (x402, ~1 sat sBTC, gas sponsored), signed with BIP-322 and posted to the " +
      "outbox (free). Never answers a message twice and stops at the daily cap. Mainnet only; requires an " +
      "unlocked wallet with a bc1q address and a little sBTC. Configure first with auto-reply-config."
  )
  .option(
    "--max-replies <n>",
    `Most messages to answer in this run, 1-${MAX_REPLIES_PER_RUN} (default ${DEFAULT_MAX_REPLIES_PER_RUN})`
  )
  .option("--dry-run", "Generate replies (inference is still paid) without posting them or marking messages handled")
  .action(async (opts: { maxReplies?: string; dryRun?: boolean }) => {
    try {
      requireMainnet();
      const maxReplies =
        opts.maxReplies === undefined
          ? DEFAULT_MAX_REPLIES_PER_RUN
          : parseNonNegativeInt("--max-replies", opts.maxReplies);
      if (maxReplies < 1 || maxReplies > MAX_REPLIES_PER_RUN) {
        throw new Error(`--max-replies must be between 1 and ${MAX_REPLIES_PER_RUN}`);
      }
      const config = (await readAppConfig()).inboxAutoReply;
      if (!config?.systemPrompt) {
        throw new Error(
          'Inbox auto-reply is not configured. Run: bun run inbox/inbox.ts auto-reply-config --system-prompt "..."'
        );
      }
      const dryRun = opts.dryRun ?? false;
      if (!config.enabled && !dryRun) {
        throw new Error(
          "Inbox auto-reply is disabled. Enable it with: bun run inbox/inbox.ts auto-reply-config --enabled true " +
            "(or pass --dry-run to preview replies)."
        );
      }

      const account = await getAccount();
      const summary = await runAutoReply({
        account,
        systemPrompt: config.systemPrompt,
        dailyCapSats: resolveDailyCapSats(config.dailyCapSats),
        maxRepliesPerRun: maxReplies,
        dryRun,
        generator: marketplaceReplyGenerator(account, config.model),
      });

      printJson({
        success: summary.failed.length === 0,
        dryRun,
        model: config.model,
        ...summary,
        repliedCount: summary.replied.length,
        skippedCount: summary.skipped.length,
        failedCount: summary.failed.length,
        dailyCapSats: resolveDailyCapSats(config.dailyCapSats),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse and run
// ---------------------------------------------------------------------------

program.parse(process.argv);
