#!/usr/bin/env bun
/**
 * maximumsats-wot/cli.ts
 *
 * Query MaximumSats Web of Trust API (wot.klabo.world).
 * Free tier: 50 req/day. L402 Lightning payment for additional queries.
 *
 * Commands:
 *   get-score       --pubkey <npub|hex>
 *   check-sybil     --pubkey <npub|hex>
 *   recommend       --pubkey <npub|hex>
 *   trust-path      --from <npub|hex> --to <npub|hex>
 *   network-health
 *
 * L402 credential: set env var MAXIMUMSATS_L402_TOKEN or store via:
 *   arc creds set --service maximumsats-wot --key l402-token --value "<token>:<preimage>"
 */

import { getCredential } from "../credentials/store.js";

const BASE_URL = "https://wot.klabo.world";

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = args[i + 1];
        i++;
      }
    }
  }
  return flags;
}

async function buildHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  // Prefer env var, fall back to encrypted credential store
  const envToken = process.env.MAXIMUMSATS_L402_TOKEN;
  if (envToken) {
    headers["Authorization"] = `L402 ${envToken}`;
    return headers;
  }
  try {
    const token = await getCredential("maximumsats-wot", "l402-token");
    if (token) headers["Authorization"] = `L402 ${token}`;
  } catch {
    // No credential stored — proceed with free tier
  }
  return headers;
}

async function wotFetch(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers = await buildHeaders();
  const res = await fetch(url.toString(), { headers });

  if (res.status === 402) {
    const wwwAuth = res.headers.get("WWW-Authenticate") ?? "";
    const invoiceMatch = wwwAuth.match(/invoice="([^"]+)"/);
    const tokenMatch = wwwAuth.match(/token="([^"]+)"/);
    const invoice = invoiceMatch?.[1] ?? "(not found)";
    const l402Token = tokenMatch?.[1] ?? "";
    console.error("⚡ Free tier exhausted (50 req/day). Pay this Lightning invoice:");
    console.error(`   ${invoice}`);
    if (l402Token) {
      console.error("After paying, store your credentials:");
      console.error(`   MAXIMUMSATS_L402_TOKEN=${l402Token}:<preimage>`);
    }
    process.exit(2);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

async function cmdGetScore(flags: Record<string, string>): Promise<void> {
  const pubkey = flags["pubkey"];
  if (!pubkey) {
    console.error("Usage: get-score --pubkey <npub|hex>");
    process.exit(1);
  }
  const data = await wotFetch("/score", { pubkey });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function cmdCheckSybil(flags: Record<string, string>): Promise<void> {
  const pubkey = flags["pubkey"];
  if (!pubkey) {
    console.error("Usage: check-sybil --pubkey <npub|hex>");
    process.exit(1);
  }
  const data = await wotFetch("/sybil", { pubkey });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function cmdRecommend(flags: Record<string, string>): Promise<void> {
  const pubkey = flags["pubkey"];
  if (!pubkey) {
    console.error("Usage: recommend --pubkey <npub|hex>");
    process.exit(1);
  }
  const data = await wotFetch("/recommend", { pubkey });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function cmdTrustPath(flags: Record<string, string>): Promise<void> {
  const from = flags["from"];
  const to = flags["to"];
  if (!from || !to) {
    console.error("Usage: trust-path --from <npub|hex> --to <npub|hex>");
    process.exit(1);
  }
  const data = await wotFetch("/trust-path", { from, to });
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

async function cmdNetworkHealth(): Promise<void> {
  const data = await wotFetch("/health", {});
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

try {
  switch (command) {
    case "get-score":
      await cmdGetScore(flags);
      break;
    case "check-sybil":
      await cmdCheckSybil(flags);
      break;
    case "recommend":
      await cmdRecommend(flags);
      break;
    case "trust-path":
      await cmdTrustPath(flags);
      break;
    case "network-health":
      await cmdNetworkHealth();
      break;
    default:
      console.error("Commands: get-score, check-sybil, recommend, trust-path, network-health");
      console.error("Run with --help for usage details");
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
