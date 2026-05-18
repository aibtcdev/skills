#!/usr/bin/env bun
import { readFileSync } from "fs";
import { makeContractDeploy, AnchorMode, ClarityVersion } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const privateKey = process.env.CLIENT_PRIVATE_KEY;
if (!privateKey) { console.error("CLIENT_PRIVATE_KEY not set"); process.exit(1); }

const contractName = process.argv[2] || "dao-template-v4";
const contractFile = process.argv[3] || "/home/gregoryford963/aibtcdev-skills/dao-template.clar";
const apiKey = process.env.SPONSOR_API_KEY || "";
const codeBody = readFileSync(contractFile, "utf-8");
console.error("Contract:", contractName, "| Size:", codeBody.length, "| Sponsored:", !apiKey ? "no-key" : "yes");

// Get current account nonce from chain to avoid relay nonce gaps
const nonceResp = await fetch(`https://api.mainnet.hiro.so/v2/accounts/${process.argv[4] || "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW"}?proof=0`);
const nonceData = await nonceResp.json() as { nonce: number };
const nonce = nonceData.nonce;
console.error("Chain nonce:", nonce);

const tx = await makeContractDeploy({
  contractName,
  codeBody,
  senderKey: privateKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  fee: 0n,
  sponsored: true,
  clarityVersion: ClarityVersion.Clarity3,
  nonce,
});

const serialized = tx.serialize();
console.error("Serialized tx length:", serialized.length);

const relayUrl = "https://x402-relay.aibtc.com";
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

const resp = await fetch(`${relayUrl}/sponsor`, {
  method: "POST",
  headers,
  body: JSON.stringify({ transaction: serialized }),
});

const text = await resp.text();
console.error("Relay status:", resp.status);
console.log(text);
