#!/usr/bin/env bun
/**
 * dao-launch.ts -- Prompt-to-DAO launcher for AIBTC Bounty #31
 *
 * Deploys dao-template.clar to Stacks mainnet from a natural-language prompt.
 *
 * Usage:
 *   bun run dao-launch.ts "<prompt>"                              # deploy + initialize
 *   bun run dao-launch.ts deploy "<prompt>"                       # explicit deploy
 *   bun run dao-launch.ts add-member <contract> <stx-address>
 *   bun run dao-launch.ts deposit <contract> <amount-sats>
 *   bun run dao-launch.ts propose <contract> "<title>" "<desc>" <amount-sats> <recipient>
 *   bun run dao-launch.ts vote <contract> <proposal-id> <yes|no>
 *   bun run dao-launch.ts execute <contract> <proposal-id>
 *   bun run dao-launch.ts info <contract>
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeContractDeploy,
  makeContractCall,
  broadcastTransaction,
  stringAsciiCV,
  uintCV,
  principalCV,
  boolCV,
  PostConditionMode,
  AnchorMode,
} from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY ?? "";
const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS ?? "";
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "dao-template.clar");
const HIRO_API = "https://api.mainnet.hiro.so";

if (!PRIVATE_KEY) {
  console.error(
    JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set in environment" })
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugify the first 3 words of the prompt, prefix with "dao-", max 40 chars.
 */
function promptToContractName(prompt: string): string {
  const words = prompt.trim().toLowerCase().split(/\s+/).slice(0, 3);
  const slug = words.join("-").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const name = `dao-${slug}`.slice(0, 40);
  return name;
}

/**
 * Extract a human-friendly DAO name (first 3-4 words, title-cased) from prompt.
 */
function promptToDaoName(prompt: string): string {
  return prompt.trim().split(/\s+/).slice(0, 4).map(
    (w) => w.charAt(0).toUpperCase() + w.slice(1)
  ).join(" ").slice(0, 64);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split "SP123.my-contract" into [address, name]. */
function parseContractId(contractId: string): [string, string] {
  const dot = contractId.lastIndexOf(".");
  if (dot === -1) throw new Error(`Invalid contract ID: ${contractId}`);
  return [contractId.slice(0, dot), contractId.slice(dot + 1)];
}

/** Call a read-only function via Hiro API (no wallet needed). */
async function callReadOnly(
  contractAddress: string,
  contractName: string,
  functionName: string,
  args: string[] = [],
  sender?: string
): Promise<unknown> {
  const url = `${HIRO_API}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: sender ?? contractAddress,
      arguments: args,
    }),
  });
  if (!res.ok) {
    throw new Error(`Read-only call failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

async function deployDao(prompt: string): Promise<void> {
  const contractName = promptToContractName(prompt);
  const daoName = promptToDaoName(prompt);
  const daoPurpose = prompt.slice(0, 256);
  const codeBody = readFileSync(TEMPLATE_PATH, "utf-8");

  // -- Deploy --
  const deployTx = await makeContractDeploy({
    contractName,
    codeBody,
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const deployBroadcast = await broadcastTransaction({
    transaction: deployTx,
    network: STACKS_MAINNET,
  });

  if ("error" in deployBroadcast) {
    throw new Error(
      `Deploy broadcast failed: ${deployBroadcast.error} -- ${String((deployBroadcast as { reason?: unknown }).reason ?? "")}`
    );
  }

  const deployTxid = deployBroadcast.txid;
  const contractId = `${DEPLOYER_ADDRESS}.${contractName}`;

  // Wait for nonce increment before sending initialize tx
  await sleep(1000);

  // -- Initialize --
  const initTx = await makeContractCall({
    contractAddress: DEPLOYER_ADDRESS,
    contractName,
    functionName: "initialize",
    functionArgs: [stringAsciiCV(daoName), stringAsciiCV(daoPurpose)],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const initBroadcast = await broadcastTransaction({
    transaction: initTx,
    network: STACKS_MAINNET,
  });

  if ("error" in initBroadcast) {
    throw new Error(
      `Initialize broadcast failed: ${initBroadcast.error} -- ${String((initBroadcast as { reason?: unknown }).reason ?? "")}`
    );
  }

  console.log(
    JSON.stringify(
      {
        contractId,
        deployTxid,
        initTxid: initBroadcast.txid,
        daoName,
        daoPurpose,
        instructions: [
          `Contract deployed as ${contractId}`,
          `Deploy tx: https://explorer.hiro.so/txid/${deployTxid}?chain=mainnet`,
          `Init tx:   https://explorer.hiro.so/txid/${initBroadcast.txid}?chain=mainnet`,
          "Wait for both transactions to confirm before interacting.",
          `Add members: bun run dao-launch.ts add-member ${contractId} <stx-address>`,
          `Deposit sBTC: bun run dao-launch.ts deposit ${contractId} <amount-sats>`,
        ],
      },
      null,
      2
    )
  );
}

async function addMember(contractId: string, newMember: string): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "add-member",
    functionArgs: [principalCV(newMember)],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const broadcast = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in broadcast) throw new Error(`Broadcast failed: ${broadcast.error}`);

  console.log(JSON.stringify({ txid: broadcast.txid, member: newMember, contractId }, null, 2));
}

async function depositSbtc(contractId: string, amountSats: number): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "deposit-sbtc",
    functionArgs: [uintCV(amountSats)],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const broadcast = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in broadcast) throw new Error(`Broadcast failed: ${broadcast.error}`);

  console.log(JSON.stringify({ txid: broadcast.txid, amountSats, contractId }, null, 2));
}

async function createProposal(
  contractId: string,
  title: string,
  description: string,
  amountSats: number,
  recipient: string
): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "create-proposal",
    functionArgs: [
      stringAsciiCV(title.slice(0, 128)),
      stringAsciiCV(description.slice(0, 512)),
      uintCV(amountSats),
      principalCV(recipient),
    ],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const broadcast = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in broadcast) throw new Error(`Broadcast failed: ${broadcast.error}`);

  console.log(JSON.stringify({ txid: broadcast.txid, title, amountSats, recipient, contractId }, null, 2));
}

async function castVote(contractId: string, proposalId: number, voteYes: boolean): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "vote",
    functionArgs: [uintCV(proposalId), boolCV(voteYes)],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const broadcast = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in broadcast) throw new Error(`Broadcast failed: ${broadcast.error}`);

  console.log(JSON.stringify({ txid: broadcast.txid, proposalId, vote: voteYes ? "yes" : "no", contractId }, null, 2));
}

async function executeProposal(contractId: string, proposalId: number): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);

  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: "execute-proposal",
    functionArgs: [uintCV(proposalId)],
    senderKey: PRIVATE_KEY,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Allow,
  });

  const broadcast = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in broadcast) throw new Error(`Broadcast failed: ${broadcast.error}`);

  console.log(JSON.stringify({ txid: broadcast.txid, proposalId, contractId }, null, 2));
}

async function getInfo(contractId: string): Promise<void> {
  const [contractAddress, contractName] = parseContractId(contractId);
  const result = await callReadOnly(contractAddress, contractName, "get-info", [], contractAddress);
  console.log(JSON.stringify({ contractId, info: result }, null, 2));
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      JSON.stringify(
        {
          error: "No arguments provided",
          usage: [
            'bun run dao-launch.ts "<prompt>"',
            'bun run dao-launch.ts deploy "<prompt>"',
            "bun run dao-launch.ts add-member <contract> <stx-address>",
            "bun run dao-launch.ts deposit <contract> <amount-sats>",
            'bun run dao-launch.ts propose <contract> "<title>" "<desc>" <amount-sats> <recipient>',
            "bun run dao-launch.ts vote <contract> <proposal-id> <yes|no>",
            "bun run dao-launch.ts execute <contract> <proposal-id>",
            "bun run dao-launch.ts info <contract>",
          ],
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const subcommand = args[0];

  // If the first arg looks like a prompt (not a known subcommand), treat as deploy
  const knownSubcommands = ["deploy", "add-member", "deposit", "propose", "vote", "execute", "info"];
  if (!knownSubcommands.includes(subcommand)) {
    await deployDao(args.join(" "));
    return;
  }

  switch (subcommand) {
    case "deploy": {
      if (args.length < 2) throw new Error("deploy requires a prompt argument");
      await deployDao(args.slice(1).join(" "));
      break;
    }
    case "add-member": {
      if (args.length < 3) throw new Error("add-member requires <contract> <stx-address>");
      await addMember(args[1], args[2]);
      break;
    }
    case "deposit": {
      if (args.length < 3) throw new Error("deposit requires <contract> <amount-sats>");
      await depositSbtc(args[1], parseInt(args[2], 10));
      break;
    }
    case "propose": {
      if (args.length < 6) throw new Error("propose requires <contract> <title> <desc> <amount-sats> <recipient>");
      await createProposal(args[1], args[2], args[3], parseInt(args[4], 10), args[5]);
      break;
    }
    case "vote": {
      if (args.length < 4) throw new Error("vote requires <contract> <proposal-id> <yes|no>");
      const voteYes = args[3].toLowerCase() === "yes";
      await castVote(args[1], parseInt(args[2], 10), voteYes);
      break;
    }
    case "execute": {
      if (args.length < 3) throw new Error("execute requires <contract> <proposal-id>");
      await executeProposal(args[1], parseInt(args[2], 10));
      break;
    }
    case "info": {
      if (args.length < 2) throw new Error("info requires <contract>");
      await getInfo(args[1]);
      break;
    }
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((err) => {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2));
  process.exit(1);
});
