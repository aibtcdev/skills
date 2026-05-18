#!/usr/bin/env bun
// Deploy via /relay endpoint (no auth required)
import { readFileSync } from "fs";
import { makeContractDeploy, AnchorMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const privateKey = process.env.CLIENT_PRIVATE_KEY;
if (!privateKey) { console.error("CLIENT_PRIVATE_KEY not set"); process.exit(1); }

const contractName = process.argv[2] || "dao-template-v4";
const contractFile = process.argv[3] || "/home/gregoryford963/aibtcdev-skills/dao-template.clar";
const codeBody = readFileSync(contractFile, "utf-8");
console.error("Contract:", contractName, "| Size:", codeBody.length);

const tx = await makeContractDeploy({
  contractName,
  codeBody,
  senderKey: privateKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  fee: 0n,
  sponsored: true,
});

const serialized = tx.serialize();
console.error("Serialized tx length:", serialized.length);

// Try /relay endpoint — no auth needed
const resp = await fetch("https://x402-relay.aibtc.com/relay", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction: serialized }),
});

const text = await resp.text();
console.error("Status:", resp.status);
console.log(text);
