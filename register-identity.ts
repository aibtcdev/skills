#!/usr/bin/env bun
/**
 * register-identity.ts — Register with identity-registry-v2 from operational wallet
 * Usage: bun run register-identity.ts "<uri>"
 *
 * Uses CLIENT_PRIVATE_KEY from .env for signing (operational STX wallet).
 * Calls SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD.identity-registry-v2.register-with-uri
 */

import {
  makeContractCall,
  stringUtf8CV,
  PostConditionMode,
  broadcastTransaction,
} from "@stacks/transactions";
import { config } from "dotenv";

config();

const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const SENDER_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const CONTRACT_ADDRESS = "SP1NMR7MY0TJ1QA7WQBZ6504KC79PZNTRQH4YGFJD";
const CONTRACT_NAME = "identity-registry-v2";
const FUNCTION_NAME = "register-with-uri";

if (!PRIVATE_KEY) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set in .env" }));
  process.exit(1);
}

const [, , uri] = process.argv;
if (!uri) {
  console.error(JSON.stringify({ error: "Usage: bun run register-identity.ts <uri>" }));
  process.exit(1);
}

const network = "mainnet";

// Fetch current nonce from Hiro API
const nonceResp = await fetch(
  `https://api.mainnet.hiro.so/v2/accounts/${SENDER_ADDRESS}?proof=0`
);
const nonceData = await nonceResp.json() as { nonce: number };
const nonce = nonceData.nonce;
console.log(`Using nonce: ${nonce}, sender: ${SENDER_ADDRESS}`);
console.log(`Registering URI: ${uri}`);

const tx = await makeContractCall({
  contractAddress: CONTRACT_ADDRESS,
  contractName: CONTRACT_NAME,
  functionName: FUNCTION_NAME,
  functionArgs: [stringUtf8CV(uri)],
  senderKey: PRIVATE_KEY,
  network,
  nonce,
  postConditionMode: PostConditionMode.Allow,
  fee: 2000,
});

const result = await broadcastTransaction({ transaction: tx, network });

if ("error" in result) {
  console.error(JSON.stringify({ error: result.error, reason: result.reason }));
  process.exit(1);
}

console.log(JSON.stringify({
  success: true,
  txid: result.txid,
  sender: SENDER_ADDRESS,
  contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
  function: FUNCTION_NAME,
  uri,
  nonce,
}, null, 2));
