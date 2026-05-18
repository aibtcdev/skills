import { signMessageHashRsv } from "@stacks/transactions";
import { bytesToHex } from "@stacks/common";
import { hashMessage } from "@stacks/encryption";

const STACKS_PRIVATE_KEY_HEX = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const STX_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";

// Get challenge for STX address
const challengeResp = await fetch(
  `https://aibtc.com/api/challenge?address=${STX_ADDRESS}&action=update-owner`
);
const { challenge } = await challengeResp.json() as any;
const challengeMsg = challenge.message;
console.log("Challenge:", challengeMsg);

// Sign with correct Stacks message hashing (using @stacks/encryption hashMessage)
const normalizedKey = STACKS_PRIVATE_KEY_HEX.endsWith("01")
  ? STACKS_PRIVATE_KEY_HEX
  : STACKS_PRIVATE_KEY_HEX + "01";

const msgHash = hashMessage(challengeMsg);
const msgHashHex = bytesToHex(msgHash);
console.log("Message hash:", msgHashHex);

const signature = signMessageHashRsv({ messageHash: msgHashHex, privateKey: normalizedKey });
console.log("Stacks signature:", signature);

// Submit challenge to update X handle (owner)
const submitResp = await fetch("https://aibtc.com/api/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: STX_ADDRESS,
    challenge: challengeMsg,
    signature,
    action: "update-owner",
    params: { owner: "369sunray" },
  }),
});
const result = await submitResp.json();
console.log("\nChallenge result:", JSON.stringify(result, null, 2));

// Also try to get a challenge for the BTC address
// and sign with the Stacks key as a workaround (in case server accepts Stacks sig)
console.log("\n--- Trying BTC challenge with Stacks sig ---");
const btcChallengeResp = await fetch(
  `https://aibtc.com/api/challenge?address=${BTC_ADDRESS}&action=update-owner`
);
const { challenge: btcChallenge } = await btcChallengeResp.json() as any;
const btcChallengeMsg = btcChallenge.message;
console.log("BTC Challenge:", btcChallengeMsg);

const btcMsgHash = hashMessage(btcChallengeMsg);
const btcMsgHashHex = bytesToHex(btcMsgHash);
const btcSignature = signMessageHashRsv({ messageHash: btcMsgHashHex, privateKey: normalizedKey });

const btcSubmitResp = await fetch("https://aibtc.com/api/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: BTC_ADDRESS,
    challenge: btcChallengeMsg,
    signature: btcSignature,
    action: "update-owner",
    params: { owner: "369sunray" },
  }),
});
const btcResult = await btcSubmitResp.json();
console.log("BTC challenge with Stacks sig:", JSON.stringify(btcResult, null, 2));
