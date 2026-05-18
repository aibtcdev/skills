import { signMessageHashRsv } from "@stacks/transactions";
import { bytesToHex, hexToBytes } from "@stacks/common";
import { hashSha256Sync } from "@stacks/encryption";

const STACKS_PRIVATE_KEY_HEX = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const STX_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";

// Step 1: Get a challenge for btcAddress to update-owner
// (so we can set our X handle, making the viral tweet easier to verify)
const challengeResp = await fetch(
  `https://aibtc.com/api/challenge?address=${BTC_ADDRESS}&action=update-owner`
);
const challengeData = await challengeResp.json() as any;
console.log("Challenge:", JSON.stringify(challengeData, null, 2));

if (!challengeData.challenge) {
  console.log("No challenge received");
  process.exit(1);
}

const challengeMsg = challengeData.challenge.message;
console.log("\nChallenge message:", challengeMsg);

// Step 2: Try signing with Stacks key (the STX address is also registered)
// The Stacks RSV signature format
const normalizedKey = STACKS_PRIVATE_KEY_HEX.endsWith("01")
  ? STACKS_PRIVATE_KEY_HEX
  : STACKS_PRIVATE_KEY_HEX + "01";

// Hash the message Stacks-style
function hashStacksMessage(message: string): string {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode("\x17Stacks Signed Message:\n");
  const varintBytes = msgBytes.length < 253
    ? new Uint8Array([msgBytes.length])
    : new Uint8Array([0xfd, msgBytes.length & 0xff, (msgBytes.length >> 8) & 0xff]);
  const combined = new Uint8Array([...prefix, ...varintBytes, ...msgBytes]);
  return bytesToHex(hashSha256Sync(hashSha256Sync(combined)));
}

// Actually use the proper Stacks signing approach
// The Stacks signature is: RSV format, hex encoded
// Based on how it was done in registration
const messageHash = hashStacksMessage(challengeMsg);
const stacksSig = signMessageHashRsv({
  messageHash,
  privateKey: normalizedKey
});
console.log("Stacks signature:", stacksSig);

// Step 3: Submit the challenge with Stacks address + Stacks signature
const submitResp = await fetch("https://aibtc.com/api/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: STX_ADDRESS,
    challenge: challengeMsg,
    signature: stacksSig,
    action: "update-owner",
    params: { owner: "369sunray" },
  }),
});
const submitData = await submitResp.json();
console.log("\nChallenge submit response:", JSON.stringify(submitData, null, 2));

// Also try with BTC address (btcPublicKey is "" but maybe Stacks sig works too)
const submitResp2 = await fetch("https://aibtc.com/api/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: BTC_ADDRESS,
    challenge: challengeMsg,
    signature: stacksSig,
    action: "update-owner",
    params: { owner: "369sunray" },
  }),
});
const submitData2 = await submitResp2.json();
console.log("\nChallenge submit (btcAddress) response:", JSON.stringify(submitData2, null, 2));
