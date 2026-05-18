#!/usr/bin/env bun
// Derive STX address from CLIENT_PRIVATE_KEY
// Use @stacks/wallet-sdk with raw key approach
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import { makeContractCall, uintCV, principalCV, noneCV, PostConditionMode } from "@stacks/transactions";

// The CLIENT_PRIVATE_KEY from .env (as used in send-inbox.ts)
const key = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";

// Try to build a simple STX transfer and see what address it comes from
// by checking the serialized tx
try {
  const tx = await makeContractCall({
    contractAddress: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
    contractName: "sbtc-token",
    functionName: "transfer",
    functionArgs: [uintCV(1n), principalCV("SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW"), principalCV("SP1GFVV54QHZV32TD87PG7JN8J2X4WP1WB363QVHE"), noneCV()],
    senderKey: key,
    network: "mainnet",
    postConditionMode: PostConditionMode.Allow,
    fee: 1000n,
    nonce: 0n,
  });
  const hex = tx.serialize();
  console.log("Transaction serialized successfully");
  console.log("Hex starts with:", hex.slice(0, 80));

  // Decode the origin address from the hex (bytes 5 onwards for version+hash)
  // STX auth field starts at byte 5
  // tx format: version(1) chain_id(4) auth_type(1) ...
  // For standard auth: auth_type(1) hash_mode(1) signer_hash(20) nonce(8) fee(8) ...
  const authStart = 5; // skip version + chain_id
  const authType = hex.slice(authStart*2, (authStart+1)*2);
  const hashMode = hex.slice((authStart+1)*2, (authStart+2)*2);
  const signerHash = hex.slice((authStart+2)*2, (authStart+22)*2);
  console.log("Auth type:", authType);
  console.log("Hash mode:", hashMode);
  console.log("Signer hash160:", signerHash);
} catch (e) {
  console.error("Error:", e.message);
}
