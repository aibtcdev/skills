#!/usr/bin/env bun
import { readFileSync } from "fs";
import { makeContractDeploy, AnchorMode } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const privateKey = process.env.CLIENT_PRIVATE_KEY;
if (!privateKey) { console.error("CLIENT_PRIVATE_KEY not set"); process.exit(1); }

const contractName = process.argv[2] || "dao-minimal-test";
const contractFile = process.argv[3] || "/tmp/dao-minimal.clar";
const codeBody = readFileSync(contractFile, "utf-8");
console.error("Contract:", contractName, "| Size:", codeBody.length);

const tx = await makeContractDeploy({
  contractName,
  codeBody,
  senderKey: privateKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  fee: 100000n,
});

const serialized = tx.serialize();
const resp = await fetch("https://api.mainnet.hiro.so/v2/transactions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tx: serialized }),
});

const text = await resp.text();
if (!resp.ok) {
  console.log(JSON.stringify({ error: text }, null, 2));
  process.exit(1);
}

const txid = JSON.parse(text);
console.log(JSON.stringify({ success: true, txid, contract: `SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW.${contractName}` }, null, 2));
