#!/usr/bin/env bun
// Convert hash160 to Stacks address using c32check encoding embedded in @stacks/transactions
import { addressToString } from "@stacks/transactions";

// Hash from CLIENT_PRIVATE_KEY signed transaction
const hash = "ea41bef47ec2fa26d25e2c5456330b260c800c97";

// Manually do c32 encoding
// version 22 = mainnet p2pkh = "SP" prefix
// The Stacks address format uses c32check with version byte

// Use a helper from @stacks/transactions internals
// Actually, let's just check our SP3 address hash
// SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW
// Base-check decode to get hash160...

// Simpler: decode from known address
// SP = version 22 (0x16)
// Use the address in a tx and extract
import { makeSTXTokenTransfer } from "@stacks/transactions";
const tx = await makeSTXTokenTransfer({
  recipient: "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW",
  amount: 1n,
  senderKey: "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab",
  network: "mainnet",
  fee: 1000n,
  nonce: 0n,
});
const hex = tx.serialize();
// sender hash160 is at bytes 6-25 (after version+chainId+authType+hashMode)
const senderHash = hex.slice(12, 52); // 2 bytes per hex char, offset 6 bytes = 12 chars
console.log("Sender hash160:", senderHash);

// The recipient hash160 is in the outputs
// For STX transfer, check after the auth fields
// Let's just print the full hex and manually inspect
console.log("Full hex:", hex);
