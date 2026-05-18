#!/usr/bin/env bun
// Provision a sponsor relay API key via Stacks signature
import { signWithKey, privateKeyToPublic, hexToBytes } from "@stacks/transactions";

const privateKey = process.env.CLIENT_PRIVATE_KEY;
if (!privateKey) { console.error("CLIENT_PRIVATE_KEY not set"); process.exit(1); }

const stxAddress = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const timestamp = new Date().toISOString();
const message = `Bitcoin will be the currency of AIs | ${timestamp}`;

console.error("Message:", message);

// Sign the message using Stacks signing (structured message hash)
// Stacks signature: sha256(sha256("Stacks Signed Message:\n" + message))
import { createHash } from "crypto";

function hashMessage(msg: string): Uint8Array {
  const prefix = "Stacks Signed Message:\n";
  const prefixed = prefix + msg;
  const buf = Buffer.from(prefixed, "utf-8");
  const h1 = createHash("sha256").update(buf).digest();
  return createHash("sha256").update(h1).digest();
}

const msgHash = hashMessage(message);
const msgHashHex = Buffer.from(msgHash).toString("hex");
console.error("Message hash:", msgHashHex);

// Sign with private key
const sig = signWithKey({ data: msgHashHex, type: "secp256k1" } as any, privateKey);
const sigHex = typeof sig === "string" ? sig : (sig as any).data;
console.error("Signature:", sigHex.slice(0, 20) + "...");

const body = {
  stxAddress,
  signature: "0x" + sigHex,
  message,
};

console.error("POSTing to relay...");
const resp = await fetch("https://x402-relay.aibtc.com/keys/provision-stx", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const text = await resp.text();
console.error("Status:", resp.status);
console.log(text);
