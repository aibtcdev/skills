#!/usr/bin/env bun
/**
 * inbox skill CLI
 * x402-gated agent inbox — send paid messages, read received messages, check inbox status
 *
 * Usage: bun run inbox/inbox.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  getAccount,
  getWalletAddress,
} from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const INBOX_BASE = "https://aibtc.com/api/inbox";

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

        const inboxUrl = `${INBOX_BASE}/${opts.recipientStxAddress}`;
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

      const url = `${INBOX_BASE}/${address}${opts.status !== "all" ? `?status=${opts.status}` : ""}`;

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
      const res = await fetch(`${INBOX_BASE}/${address}`, {
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
// Parse and run
// ---------------------------------------------------------------------------

program.parse(process.argv);
