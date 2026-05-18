#!/usr/bin/env bun
// Check address from mnemonic to verify CLIENT_PRIVATE_KEY matches our STX address
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";

const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
const account = wallet.accounts[0];
const addrMainnet = getStxAddress(account, "mainnet");

console.log("STX address (mainnet):", addrMainnet);
console.log("Expected:             ", "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW");
console.log("Match:", addrMainnet === "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW");
console.log("STX private key:", account.stxPrivateKey);
console.log("CLIENT_PRIVATE_KEY:  ", "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab");
