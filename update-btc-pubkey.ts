// Set btcPublicKey via challenge action=update-pubkey (one-time fix for BIP-322 wallets)
import { signMessageHashRsv } from "@stacks/transactions";
import { bytesToHex } from "@stacks/common";
import { hashMessage } from "@stacks/encryption";

const STACKS_PRIVATE_KEY_HEX = "9922d5bc84b89f73559caeb66b304c8d9cc688e3d457a4a9e375b2420f0ffbab";
const STX_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const BTC_ADDRESS = "bc1qw0y4ant38zykzjqssgnujqmszruvhkwupvp6dn";
const BTC_PUBKEY  = "02b7e7eff43d34149bb884ae8d0296cfe400c8b166b0c84adcef95d81067f6210d";

// 1. Get challenge
const challengeResp = await fetch(
  `https://aibtc.com/api/challenge?address=${STX_ADDRESS}&action=update-pubkey`
);
const challengeData = await challengeResp.json() as any;
if (!challengeData.challenge) { console.log("update-pubkey not yet deployed:", JSON.stringify(challengeData)); process.exit(1); }
const { challenge } = challengeData;
const challengeMsg = challenge.message;
console.log("Challenge:", challengeMsg);

// 2. Sign with Stacks key
const normalizedKey = STACKS_PRIVATE_KEY_HEX.endsWith("01")
  ? STACKS_PRIVATE_KEY_HEX
  : STACKS_PRIVATE_KEY_HEX + "01";
const msgHash = hashMessage(challengeMsg);
const signature = signMessageHashRsv({ messageHash: bytesToHex(msgHash), privateKey: normalizedKey });
console.log("Signature:", signature);

// 3. Submit with btcPublicKey in params
const submitResp = await fetch("https://aibtc.com/api/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    address: STX_ADDRESS,
    challenge: challengeMsg,
    signature,
    action: "update-pubkey",
    params: { btcPublicKey: BTC_PUBKEY },
  }),
});
const result = await submitResp.json();
console.log("\nResult:", JSON.stringify(result, null, 2));
