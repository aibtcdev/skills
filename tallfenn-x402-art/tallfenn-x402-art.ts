#!/usr/bin/env bun
/**
 * tallfenn-x402-art skill CLI
 *
 * Deterministic generative-art seed packs, 512x512 SVG previews, and keyframed
 * motion timelines for agents — free discovery/samples plus sBTC pay-per-call
 * generation over x402 v2 on Stacks.
 *
 * Usage: bun run tallfenn-x402-art/tallfenn-x402-art.ts <subcommand> [options]
 */

import { Command } from "commander";
// Namespace import so a missing export reads as undefined instead of failing
// at link time; the support marker is checked before any wallet access.
import * as x402 from "@aibtc/skills/src/lib/services/x402.service.js";
import { decodePaymentResponse, type PaymentRequirementsV2 } from "@aibtc/skills/src/lib/utils/x402-protocol.js";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Endpoint host
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://tallfenn-x402-art.petrasynthetic.workers.dev";

function isLocalDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Origin only (no path prefix) until shared x402 dedup keys include the full request URL (#493). */
function resolveBaseUrl(): string {
  const raw = process.env.TALLFENN_ART_URL;
  if (raw === undefined) {
    return DEFAULT_BASE_URL;
  }
  if (raw.trim() === "") {
    throw new Error(
      "TALLFENN_ART_URL was set but is empty or whitespace-only (nothing was signed or paid). Unset it to use the production worker."
    );
  }
  if (raw !== raw.trim()) {
    throw new Error(
      "TALLFENN_ART_URL must not have leading or trailing whitespace (nothing was signed or paid)."
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "TALLFENN_ART_URL must be a valid absolute URL (e.g. https://your-worker.workers.dev). Nothing was signed or paid."
    );
  }
  const httpsOk = parsed.protocol === "https:";
  const httpLocal = parsed.protocol === "http:" && isLocalDevHost(parsed.hostname);
  if (!httpsOk && !httpLocal) {
    throw new Error(
      `TALLFENN_ART_URL must use https (or http://localhost, http://127.0.0.1, or http://[::1] for local wrangler dev). Got ${parsed.protocol}//${parsed.hostname}. Nothing was signed or paid.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("TALLFENN_ART_URL must not include credentials in the URL (nothing was signed or paid).");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "TALLFENN_ART_URL must not include query or fragment (nothing was signed or paid)."
    );
  }
  if (parsed.pathname.replace(/\/+$/, "") !== "") {
    throw new Error(
      "TALLFENN_ART_URL must be an origin only (no path prefix). Base-path overrides share x402 dedup keys incorrectly until fixed in the shared client. Nothing was signed or paid."
    );
  }
  return parsed.origin;
}

// ---------------------------------------------------------------------------
// Payment verification before signing (local guard for the 402 quote)
// ---------------------------------------------------------------------------

// The worker settles on mainnet only; both names come from this one place.
const NETWORK = "mainnet";
const STACKS_CHAIN_ID = "stacks:1";
const EXPECTED_PAY_TO = "SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC";
const ROUTE_PRICE_SATS: Record<string, number> = {
  "/api/art/seed-pack": 100,
  "/api/art/svg-preview": 100,
  "/api/art/motion-timeline": 100,
  "/api/art/full-bundle": 150,
};

function refuse(reason: string, cause?: unknown): never {
  throw new x402.PaymentRefusedError(`Refusing payment: ${reason} Nothing was signed or paid.`, { cause });
}

function assertClientOptionsSupported(): void {
  if (x402.X402_CLIENT_OPTIONS_SUPPORTED !== true || typeof x402.PaymentRefusedError !== "function") {
    throw new Error(
      "Refusing payment: the installed @aibtc/skills predates beforePay/paymentMode support, so the payTo, " +
        "price and asset checks would be skipped. Run `bun update @aibtc/skills` in this skill folder. " +
        "Nothing was signed or paid."
    );
  }
}

function assertAcceptedQuote(path: string, selected: Readonly<PaymentRequirementsV2>): void {
  const expectedPrice = ROUTE_PRICE_SATS[path];
  if (expectedPrice === undefined) {
    refuse(`paid route ${path} has no locally configured price.`);
  }
  if (selected.payTo !== EXPECTED_PAY_TO) {
    refuse(`payTo ${selected.payTo} does not match expected ${EXPECTED_PAY_TO}.`);
  }
  // Same allowlist the direct builder uses: native STX or the canonical
  // mainnet sBTC contract id. Bare "sBTC" is refused here, before signing.
  let assetKind: "STX" | "sBTC";
  try {
    assetKind = x402.resolveDirectPaymentAsset(selected.asset, NETWORK).kind;
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error), error);
  }
  if (assetKind !== "sBTC") {
    refuse(`quoted asset ${selected.asset} is not the canonical sBTC contract.`);
  }
  // Defence in depth: the shared client rejects a network mismatch before beforePay runs.
  if (selected.network !== STACKS_CHAIN_ID) {
    refuse(`quoted network ${selected.network} is not ${STACKS_CHAIN_ID}.`);
  }
  const amountStr = String(selected.amount ?? "");
  if (!/^[1-9]\d*$/.test(amountStr)) {
    refuse("invalid quoted amount.");
  }
  if (BigInt(amountStr) > BigInt(expectedPrice)) {
    refuse(`quoted amount ${amountStr} sats exceeds the expected ${expectedPrice} sats for ${path}.`);
  }
}

// ---------------------------------------------------------------------------
// Input validation (runs BEFORE any wallet or network access)
// ---------------------------------------------------------------------------

function validatePrompt(raw: string | undefined): string {
  const prompt = String(raw ?? "");
  if (prompt !== prompt.trim()) {
    throw new Error("--prompt must not have leading or trailing whitespace (nothing was signed or paid).");
  }
  if (!prompt) {
    throw new Error("--prompt is required and cannot be empty (nothing was signed or paid).");
  }
  if (prompt.length > 500) {
    throw new Error(`--prompt must be at most 500 characters (got ${prompt.length}; nothing was signed or paid).`);
  }
  return prompt;
}

function validateVersion(raw: string | undefined): number {
  const s = String(raw ?? "1");
  if (s !== s.trim() || !/^[1-9]\d*$/.test(s)) {
    throw new Error(`--piece-version must be an integer from 1 to 1000000 with no surrounding whitespace, got "${raw}" (nothing was signed or paid).`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) {
    throw new Error(`--piece-version must be between 1 and 1000000, got "${raw}" (nothing was signed or paid).`);
  }
  return n;
}

function validateHash(raw: string | undefined): string {
  const hash = String(raw ?? "");
  // seed-pack and teaser emit lowercase SHA-256. svg-preview returns 402 before
  // it looks at the hash, so a shorter or uppercase hash would be paid for.
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `--hash must be exactly 64 lowercase hex characters, with no surrounding whitespace (a SHA-256 seed from seed-pack or teaser), got "${raw ?? ""}" (nothing was signed or paid).`
    );
  }
  return hash;
}

function isPaletteColor(value: string): boolean {
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) return true;
  const match = /^hsl\(\s*(\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*\)$/.exec(value);
  if (!match) return false;
  const hue = Number(match[1]);
  const saturation = Number(match[2]);
  const lightness = Number(match[3]);
  return hue >= 0 && hue <= 360 && saturation >= 0 && saturation <= 100 && lightness >= 0 && lightness <= 100;
}

function validatePalette(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new Error(
      "--palette was provided but is empty or whitespace-only (nothing was signed or paid). Omit the flag for the default palette."
    );
  }
  const items: string[] = [];
  for (const segment of raw.split("|")) {
    if (segment !== segment.trim()) {
      throw new Error(
        "--palette segments must not have leading or trailing whitespace (nothing was signed or paid)."
      );
    }
    if (segment.length === 0) {
      throw new Error("--palette must not contain empty segments between pipes (nothing was signed or paid).");
    }
    items.push(segment);
  }
  if (items.length > 16) {
    throw new Error("--palette must contain at most 16 pipe-separated colors (nothing was signed or paid).");
  }
  for (const color of items) {
    if (!isPaletteColor(color)) {
      throw new Error(
        `--palette entry "${color}" must be #RGB, #RRGGBB, or hsl(h, s%, l%) (nothing was signed or paid).`
      );
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function getFree(baseUrl: string, path: string): Promise<Record<string, unknown>> {
  // Plain client: a 402 on a free route fails instead of paying.
  const response = await x402.createPlainClient(baseUrl).get(path, {
    headers: { Accept: "application/json" },
  });
  return { result: response.data, endpoint: `${baseUrl}${path}` };
}

async function paidPost(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  tool: string
): Promise<Record<string, unknown>> {
  assertClientOptionsSupported();
  // The relay settles a self-paid transfer and refuses a fee-0 sponsor slot.
  // paymentMode is an option, not an environment mutation: beforePay runs on
  // the same 402 the client then signs.
  const api = await x402.createApiClient(baseUrl, tool, {
    paymentMode: "direct",
    preferredAsset: "sBTC",
    beforePay: async (accept) => {
      assertAcceptedQuote(path, accept);
    },
  });
  const response = await api.request({
    method: "POST",
    url: path,
    data: body,
    headers: { "Content-Type": "application/json" },
  });

  const workerBody =
    typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : { data: response.data };

  const output: Record<string, unknown> = {
    result: workerBody,
    endpoint: `${baseUrl}${path}`,
    network: NETWORK,
    ...x402.getDirectPaymentMetadata(response),
  };
  const receiptHeader = response.headers?.["payment-response"];
  const receipt =
    typeof receiptHeader === "string" ? decodePaymentResponse(receiptHeader) : null;
  if (receipt) {
    output.payment_receipt = receipt;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Commander CLI
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("tallfenn-x402-art")
  .description(
    "Deterministic generative-art seed packs, 512x512 SVG previews, and keyframed motion timelines via x402 v2 on Stacks"
  )
  .version("1.2.0");

const FREE_COMMANDS: ReadonlyArray<[name: string, path: string, description: string]> = [
  ["meta", "/", "Free. Service metadata, discovery URLs, and endpoint pricing catalog. No wallet needed."],
  ["health", "/health", "Free. Worker liveness check. No wallet needed."],
  [
    "teaser",
    "/api/art/teaser",
    "Free. One fixed deterministic seed pack to inspect the schema before paying. No wallet needed.",
  ],
  ["samples", "/api/art/samples", "Free. Three fixed seed packs from the Tall Fenn series. No wallet needed."],
];

for (const [name, path, description] of FREE_COMMANDS) {
  program
    .command(name)
    .description(description)
    .action(async () => {
      try {
        printJson(await getFree(resolveBaseUrl(), path));
      } catch (error) {
        handleError(error);
      }
    });
}

program
  .command("seed-pack")
  .description(
    "Paid (100 sats sBTC). Deterministic seed pack (hash, palette, motion grammar, videodanza pipeline params, Art Blocks JSON) from a prompt."
  )
  .requiredOption("--prompt <text>", "Prompt text (1-500 chars)")
  .option("--piece-version <int>", "Deterministic version integer from 1 to 1000000 (default: 1)", "1")
  .action(async (options) => {
    try {
      const prompt = validatePrompt(options.prompt);
      const version = validateVersion(options.pieceVersion);
      const baseUrl = resolveBaseUrl();
      const output = await paidPost(
        baseUrl,
        "/api/art/seed-pack",
        { prompt, version },
        "tallfenn-x402-art.seed-pack"
      );
      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("svg-preview")
  .description("Paid (100 sats sBTC). Deterministic 512x512 SVG preview from a seed hash.")
  .requiredOption("--hash <hex>", "Seed hash (exactly 64 lowercase hex chars, from seed-pack or teaser)")
  .option("--palette <colors>", "Optional pipe-separated #RGB, #RRGGBB, or hsl(h, s%, l%) colors")
  .action(async (options) => {
    try {
      const hash = validateHash(options.hash);
      const palette = validatePalette(options.palette);
      const baseUrl = resolveBaseUrl();
      const body: Record<string, unknown> = { hash };
      if (palette) body.palette = palette;
      const output = await paidPost(
        baseUrl,
        "/api/art/svg-preview",
        body,
        "tallfenn-x402-art.svg-preview"
      );
      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("motion-timeline")
  .description("Paid (100 sats sBTC). Deterministic 24fps keyframed motion timeline from a prompt.")
  .requiredOption("--prompt <text>", "Prompt text (1-500 chars)")
  .option("--piece-version <int>", "Deterministic version integer from 1 to 1000000 (default: 1)", "1")
  .action(async (options) => {
    try {
      const prompt = validatePrompt(options.prompt);
      const version = validateVersion(options.pieceVersion);
      const baseUrl = resolveBaseUrl();
      const output = await paidPost(
        baseUrl,
        "/api/art/motion-timeline",
        { prompt, version },
        "tallfenn-x402-art.motion-timeline"
      );
      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("full-bundle")
  .description("Paid (150 sats sBTC). Seed pack + 512x512 SVG preview + motion timeline in one deterministic call.")
  .requiredOption("--prompt <text>", "Prompt text (1-500 chars)")
  .option("--piece-version <int>", "Deterministic version integer from 1 to 1000000 (default: 1)", "1")
  .action(async (options) => {
    try {
      const prompt = validatePrompt(options.prompt);
      const version = validateVersion(options.pieceVersion);
      const baseUrl = resolveBaseUrl();
      const output = await paidPost(
        baseUrl,
        "/api/art/full-bundle",
        { prompt, version },
        "tallfenn-x402-art.full-bundle"
      );
      printJson(output);
    } catch (error) {
      handleError(error);
    }
  });

program.parseAsync(process.argv).catch(handleError);
