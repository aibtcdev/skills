#!/usr/bin/env bun
/**
 * Derive Stacks private key from mnemonic
 */
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";

const MNEMONIC = "clump expect joy tail settle insect swear grace soda hip document point gauge inflict material baby safe buzz ginger bus camera accident summer gather";

const wallet = await generateWallet({ secretKey: MNEMONIC, password: "" });
const account = wallet.accounts[0];
// 1 = mainnet
const stxAddress = getStxAddress({ account, transactionVersion: 1 });
console.log("STX Address:", stxAddress);
console.log("Private Key:", account.stxPrivateKey);
console.log("Data Private Key:", account.dataPrivateKey);
