#!/usr/bin/env bun
// Probe inbox 402 challenge

const recipientBtcAddress = "bc1qjj6nnd4ngpw2l84fynhal0wzwxfzmnltuw2884";
const body = {
  toBtcAddress: recipientBtcAddress,
  toStxAddress: "SP1GFVV54QHZV32TD87PG7JN8J2X4WP1WB363QVHE",
  content: "test",
};

const res = await fetch(`https://aibtc.com/api/inbox/${recipientBtcAddress}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log("Status:", res.status);
const paymentHeader = res.headers.get("payment-required");
if (paymentHeader) {
  const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  console.log("Payment required:", JSON.stringify(decoded, null, 2));
} else {
  const text = await res.text();
  console.log("Response:", text.slice(0, 500));
}
