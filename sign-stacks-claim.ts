// Try: use Stacks key to sign the claims/code message
// Both as a test to see if the endpoint accepts Stacks signatures
import { signMessageHashRsv, hashMessage, getPublicKeyFromPrivate } from "@stacks/transactions";
import { bytesToHex, hexToBytes } from "@stacks/common";

const STACKS_PRIVATE_KEY = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const STX_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const MESSAGE = `Regenerate claim code for ${BTC_ADDRESS}`;

// Sign with Stacks
const normalizedKey = STACKS_PRIVATE_KEY.endsWith("01") ? STACKS_PRIVATE_KEY : STACKS_PRIVATE_KEY + "01";
const msgHash = bytesToHex(hashMessage(MESSAGE));
const stacksSig = signMessageHashRsv({ messageHash: msgHash, privateKey: normalizedKey });
console.log("Stacks signature:", stacksSig);

// Try with stxAddress instead of btcAddress
const r1 = await fetch("https://aibtc.com/api/claims/code", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    btcAddress: BTC_ADDRESS,
    stxAddress: STX_ADDRESS,
    bitcoinSignature: stacksSig,
  }),
});
const d1 = await r1.json();
console.log("Response with Stacks sig as bitcoinSignature:", JSON.stringify(d1));

// Try challenge approach - get a challenge first
const challengeUrl = `https://aibtc.com/api/challenge?address=${BTC_ADDRESS}&action=update-description`;
const challengeResp = await fetch(challengeUrl);
const challengeData = await challengeResp.json();
console.log("\nChallenge response:", JSON.stringify(challengeData, null, 2));
