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
import { createApiClient, selectStacksPaymentOption } from "../src/lib/services/x402.service.js";
import { decodePaymentRequired, decodePaymentResponse } from "../src/lib/utils/x402-protocol.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Endpoint host
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://tallfenn-x402-art.petrasynthetic.workers.dev";

function resolveBaseUrl(): string {
  const custom = process.env.TALLFENN_ART_URL?.trim();
  return (custom && custom.length > 0 ? custom : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Payment verification before signing (local guard for the 402 quote)
// ---------------------------------------------------------------------------

const EXPECTED_PAY_TO = "SP3F9T1HAHTMK5AV29Q9DK1VNHCQFH3F5T5FXKQAC";
const ROUTE_PRICE_SATS: Record<string, number> = {
  "/api/art/seed-pack": 100,
  "/api/art/svg-preview": 100,
  "/api/art/motion-timeline": 100,
  "/api/art/full-bundle": 150,
};

async function verifyPaymentQuote(baseUrl: string, path: string, body: Record<string, unknown>): Promise<void> {
  const expectedPrice = ROUTE_PRICE_SATS[path];
  if (expectedPrice === undefined) {
    throw new Error(
      `Refusing payment: paid route ${path} has no locally configured price. Nothing was signed or paid.`
    );
  }

  let probe: Response;
  try {
    probe = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(
      `Refusing payment: could not fetch the payment challenge from ${baseUrl}${path} ` +
        `(${error instanceof Error ? error.message : String(error)}). Nothing was signed or paid.`
    );
  }

  if (probe.status !== 402) {
    throw new Error(
      `Refusing payment: expected a 402 challenge from ${baseUrl}${path} before paying, got HTTP ${probe.status}. ` +
        `Nothing was signed or paid.`
    );
  }

  const required = decodePaymentRequired(probe.headers.get("payment-required"));
  if (!required || !Array.isArray(required.accepts) || required.accepts.length === 0) {
    throw new Error("Refusing payment: the 402 challenge did not include valid payment requirements. Nothing was signed or paid.");
  }

  const selected = selectStacksPaymentOption(required.accepts);
  if (!selected) {
    throw new Error("Refusing payment: no compatible Stacks payment option in the 402 challenge. Nothing was signed or paid.");
  }

  if (selected.payTo !== EXPECTED_PAY_TO) {
    throw new Error(
      `Refusing payment: payTo ${selected.payTo} does not match expected ${EXPECTED_PAY_TO}. Nothing was signed or paid.`
    );
  }
  if (!/^sBTC$/i.test(selected.asset)) {
    throw new Error(
      `Refusing payment: quoted asset ${selected.asset} is not sBTC. Nothing was signed or paid.`
    );
  }
  if (selected.network !== "stacks:1") {
    throw new Error(
      `Refusing payment: quoted network ${selected.network} is not stacks:1. Nothing was signed or paid.`
    );
  }
  let quotedAmount: bigint;
  let knownPrice: bigint;
  try {
    quotedAmount = BigInt(selected.amount);
    knownPrice = BigInt(expectedPrice);
  } catch {
    throw new Error("Refusing payment: invalid quoted amount. Nothing was signed or paid.");
  }
  if (quotedAmount !== knownPrice) {
    throw new Error(
      `Refusing payment: quoted amount ${selected.amount} sats does not match the expected ${expectedPrice} sats for ${path}. ` +
        `Nothing was signed or paid.`
    );
  }
}

// ---------------------------------------------------------------------------
// Input validation (runs BEFORE any wallet or network access)
// ---------------------------------------------------------------------------

function validatePrompt(raw: string | undefined): string {
  const prompt = String(raw ?? "").trim();
  if (!prompt) {
    throw new Error("--prompt is required and cannot be empty (nothing was signed or paid).");
  }
  if (prompt.length > 500) {
    throw new Error(`--prompt must be at most 500 characters (got ${prompt.length}; nothing was signed or paid).`);
  }
  return prompt;
}

function validateVersion(raw: string | undefined): number {
  const s = String(raw ?? "1").trim();
  if (!/^[1-9]\d*$/.test(s)) {
    throw new Error(`--piece-version must be a positive integer, got "${raw}" (nothing was signed or paid).`);
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) {
    throw new Error(`--piece-version must be between 1 and 1000000, got "${raw}" (nothing was signed or paid).`);
  }
  return n;
}

function validateHash(raw: string | undefined): string {
  const hash = String(raw ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(hash)) {
    throw new Error(
      `--hash must be 16 to 64 lowercase hex characters (e.g. from seed-pack or teaser), got "${raw ?? ""}" (nothing was signed or paid).`
    );
  }
  return hash;
}

function validatePalette(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const items = raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0 || items.length > 16) {
    throw new Error("--palette must contain between 1 and 16 pipe-separated color strings (nothing was signed or paid).");
  }
  return items;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchFree(baseUrl: string, path: string): Promise<Record<string, unknown>> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function paidPost(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  tool: string
): Promise<Record<string, unknown>> {
  // Verify the worker's 402 quote (amount, payTo, asset, network) before the
  // shared x402 client signs anything. This makes AGENT.md's "verify payTo"
  // safety check a real gate instead of documentation, and keeps a changed
  // quote (or a mismatched recipient) from being paid in sponsored mode, where
  // the shared X402_MAX_SATS_PER_PAYMENT guard does not apply.
  await verifyPaymentQuote(baseUrl, path, body);

  const api = await createApiClient(baseUrl, tool);
  const response = await api.request({
    method: "POST",
    url: path,
    data: body,
    headers: { "Content-Type": "application/json" },
  });

  const output: Record<string, unknown> = {
    ...(typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : { data: response.data }),
    endpoint: `${baseUrl}${path}`,
    network: "mainnet",
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

program
  .command("meta")
  .description("Free. Service metadata, discovery URLs, and endpoint pricing catalog. No wallet needed.")
  .action(async () => {
    try {
      const baseUrl = resolveBaseUrl();
      const data = await fetchFree(baseUrl, "/");
      printJson({ ...data, endpoint: `${baseUrl}/` });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("health")
  .description("Free. Worker liveness check. No wallet needed.")
  .action(async () => {
    try {
      const baseUrl = resolveBaseUrl();
      const data = await fetchFree(baseUrl, "/health");
      printJson({ ...data, endpoint: `${baseUrl}/health` });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("teaser")
  .description("Free. One fixed deterministic seed pack to inspect the schema before paying. No wallet needed.")
  .action(async () => {
    try {
      const baseUrl = resolveBaseUrl();
      const data = await fetchFree(baseUrl, "/api/art/teaser");
      printJson({ ...data, endpoint: `${baseUrl}/api/art/teaser` });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("samples")
  .description("Free. Three fixed seed packs from the Tall Fenn series. No wallet needed.")
  .action(async () => {
    try {
      const baseUrl = resolveBaseUrl();
      const data = await fetchFree(baseUrl, "/api/art/samples");
      printJson({ ...data, endpoint: `${baseUrl}/api/art/samples` });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("seed-pack")
  .description(
    "Paid (100 sats sBTC). Deterministic seed pack (hash, palette, motion grammar, videodanza pipeline params, Art Blocks JSON) from a prompt."
  )
  .requiredOption("--prompt <text>", "Prompt text (1-500 chars)")
  .option("--piece-version <int>", "Deterministic version integer (default: 1)", "1")
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
  .requiredOption("--hash <hex>", "Seed hash (16-64 hex chars, e.g. from seed-pack or teaser)")
  .option("--palette <colors>", "Optional pipe-separated color list (e.g. 'hsl(120, 72%, 58%)|hsl(240, 72%, 58%)')")
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
  .option("--piece-version <int>", "Deterministic version integer (default: 1)", "1")
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
  .option("--piece-version <int>", "Deterministic version integer (default: 1)", "1")
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
