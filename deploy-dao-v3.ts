#!/usr/bin/env bun
/**
 * deploy-dao-v3.ts — Deploy dao-template-v3 for Bounty #31 (Prompt-to-DAO)
 */

import { readFileSync } from "fs";
import {
  makeContractDeploy,
  broadcastTransaction,
  AnchorMode,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const privateKey = process.env.CLIENT_PRIVATE_KEY;
if (!privateKey) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set in .env" }));
  process.exit(1);
}

const codeBody = readFileSync(
  new URL("./dao-template.clar", import.meta.url).pathname,
  "utf-8"
);

console.error("Contract size:", codeBody.length, "chars");

const tx = await makeContractDeploy({
  contractName: "dao-template-v3",
  codeBody,
  senderKey: privateKey,
  network: STACKS_MAINNET,
  anchorMode: AnchorMode.Any,
  fee: 3000000n,
});

const response = await broadcastTransaction({
  transaction: tx,
  network: STACKS_MAINNET,
});

if ("error" in response) {
  console.log(JSON.stringify({
    error: response.error,
    reason: (response as any).reason,
    reason_data: (response as any).reason_data,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  success: true,
  txid: response.txid,
  contract: `SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW.dao-template-v3`,
}, null, 2));
