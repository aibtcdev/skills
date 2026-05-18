#!/usr/bin/env bun
// Check what STX address CLIENT_PRIVATE_KEY corresponds to
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";

// Also check: derive from mnemonic using different account index
const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";
const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });

// Check first few accounts
for (let i = 0; i < 5; i++) {
  const acc = wallet.accounts[i] || { stxPrivateKey: "N/A" };
  const addr = acc.stxPrivateKey !== "N/A" ? getStxAddress(acc, "mainnet") : "N/A";
  console.log(`Account ${i}: ${addr}`);
}

console.log("\nOur expected: SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW");
console.log("CLIENT_PRIVATE_KEY: 9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab");
