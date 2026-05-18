#!/usr/bin/env bun
import { makeSTXTokenTransfer } from "@stacks/transactions";
const tx = await makeSTXTokenTransfer({
  recipient: "SP1GFVV54QHZV32TD87PG7JN8J2X4WP1WB363QVHE",
  amount: 1n,
  senderKey: "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab",
  network: "mainnet",
  fee: 1000n,
  nonce: 99n,
});
const serialized = tx.serialize();
console.log("Type:", typeof serialized);
console.log("Is Uint8Array:", serialized instanceof Uint8Array);
console.log("First 8 chars:", String(serialized).slice(0, 16));
