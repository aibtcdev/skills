#!/usr/bin/env bun
/**
 * send-x402.ts — Send inbox message using x402-stacks createPaymentClient
 * Usage: bun run send-x402.ts <recipientBtcAddress> <recipientStxAddress> "<message>"
 */

import { createPaymentClient, privateKeyToAccount } from "x402-stacks";

const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set" }));
  process.exit(1);
}

const [, , recipientBtcAddress, recipientStxAddress, content] = process.argv;
if (!recipientBtcAddress || !recipientStxAddress || !content) {
  console.error(JSON.stringify({ error: "Usage: bun run send-x402.ts <btcAddr> <stxAddr> '<message>'" }));
  process.exit(1);
}

if (content.length > 500) {
  console.error(JSON.stringify({ error: "Message exceeds 500 char limit" }));
  process.exit(1);
}

// Stacks uses compressed key format — append '01' if not already present
const compressedKey = PRIVATE_KEY.length === 64 ? PRIVATE_KEY + "01" : PRIVATE_KEY;
const account = privateKeyToAccount(compressedKey, "mainnet");
console.log("Sender account:", account.address);

const api = createPaymentClient(account, { baseURL: "https://aibtc.com" });

const body = {
  toBtcAddress: recipientBtcAddress,
  toStxAddress: recipientStxAddress,
  content,
};

console.log(`Sending to ${recipientBtcAddress} (${recipientStxAddress})...`);
console.log(`Message: ${content}`);

const response = await api.post(`/api/inbox/${recipientBtcAddress}`, body);
console.log(JSON.stringify(response.data, null, 2));
