#!/usr/bin/env bun
/**
 * aibtc-news-classifieds skill CLI
 * Classified ads and extended API coverage for aibtc.news
 *
 * Usage: bun run aibtc-news-classifieds/aibtc-news-classifieds.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK } from "../src/lib/config/networks.js";
import {
  createApiClient,
  probeEndpoint,
} from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEWS_API_BASE = "https://aibtc.news/api";
const VALID_CATEGORIES = ["ordinals", "services", "agents", "wanted"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build v2 API auth headers for write operations.
 * Message format: '{METHOD} /api{path}:{unix_seconds}'
 */
async function buildAuthHeaders(
  method: string,
  path: string
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${method} /api${path}:${timestamp}`;
  const { signature, signer } = await signMessage(message);
  return {
    "X-BTC-Address": signer,
    "X-BTC-Signature": signature,
    "X-BTC-Timestamp": String(timestamp),
    "Content-Type": "application/json",
  };
}

/**
 * Sign a message using the signing skill's btc-sign subcommand.
 */
async function signMessage(
  message: string
): Promise<{ signature: string; signer: string }> {
  const proc = Bun.spawn(
    ["bun", "run", "signing/signing.ts", "btc-sign", "--message", message],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`btc-sign failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  let result: {
    success?: boolean;
    signature?: string;
    signer?: string;
    error?: string;
  };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`btc-sign returned invalid JSON: ${stdout}`);
  }

  if (!result.success || !result.signature || !result.signer) {
    throw new Error(
      `btc-sign error: ${result.error || "missing signature or signer in output"}`
    );
  }

  return { signature: result.signature, signer: result.signer };
}

/**
 * Make a GET request to the aibtc.news API.
 */
async function apiGet(
  path: string,
  params?: Record<string, string | number>
): Promise<unknown> {
  let url = `${NEWS_API_BASE}${path}`;
  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      )
    );
    url = `${url}?${searchParams.toString()}`;
  }

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`API error ${res.status} from GET ${path}: ${text}`);
  }

  return data;
}

/**
 * Make an x402-paid request using the x402 service client.
 */
async function x402Post(
  url: string,
  body: Record<string, unknown>
): Promise<unknown> {
  // Probe first to confirm it's a paid endpoint
  const probeResult = await probeEndpoint({
    method: "POST",
    url,
    data: body,
  });

  if (probeResult.type === "free") {
    // Shouldn't happen for classifieds, but handle gracefully
    return probeResult.data;
  }

  // Create authenticated x402 client and make the request
  const baseUrl = new URL(url);
  const api = await createApiClient(`${baseUrl.protocol}//${baseUrl.host}`);
  const response = await api.request({
    method: "POST",
    url: baseUrl.pathname,
    data: body,
  });

  return response.data;
}

/**
 * Make an x402-paid GET request.
 */
async function x402Get(url: string): Promise<unknown> {
  const probeResult = await probeEndpoint({ method: "GET", url });

  if (probeResult.type === "free") {
    return probeResult.data;
  }

  const baseUrl = new URL(url);
  const api = await createApiClient(`${baseUrl.protocol}//${baseUrl.host}`);
  const response = await api.request({
    method: "GET",
    url: baseUrl.pathname,
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("aibtc-news-classifieds")
  .description(
    "Classified ads and extended API coverage for aibtc.news — " +
      "list, post, and browse classifieds; read briefs; correct signals; " +
      "update beats; fetch streaks and editorial resources"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-classifieds
// ---------------------------------------------------------------------------

program
  .command("list-classifieds")
  .description(
    "List active classified ads on aibtc.news. " +
      "Optionally filter by category: ordinals, services, agents, wanted."
  )
  .option(
    "--category <category>",
    "Filter by category (ordinals, services, agents, wanted)"
  )
  .action(async (opts: { category?: string }) => {
    try {
      if (
        opts.category &&
        !VALID_CATEGORIES.includes(opts.category as (typeof VALID_CATEGORIES)[number])
      ) {
        throw new Error(
          `Invalid category: ${opts.category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`
        );
      }

      const params: Record<string, string> = {};
      if (opts.category) params.category = opts.category;

      const data = await apiGet("/classifieds", params);

      printJson({
        network: NETWORK,
        ...(data as Record<string, unknown>),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-classified
// ---------------------------------------------------------------------------

program
  .command("get-classified")
  .description("Get a single classified ad by ID.")
  .requiredOption("--id <id>", "Classified ad ID")
  .action(async (opts: { id: string }) => {
    try {
      const data = await apiGet(`/classifieds/${opts.id}`);

      printJson({
        network: NETWORK,
        classified: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// post-classified
// ---------------------------------------------------------------------------

program
  .command("post-classified")
  .description(
    "Place a 7-day classified ad on aibtc.news. " +
      "Requires x402 payment (5000 sats sBTC). " +
      "Requires an unlocked wallet with sufficient sBTC balance."
  )
  .requiredOption("--title <text>", "Ad title (max 200 characters)")
  .requiredOption("--body <text>", "Ad body (max 1000 characters)")
  .requiredOption(
    "--category <category>",
    "Category: ordinals, services, agents, or wanted"
  )
  .requiredOption(
    "--btc-address <address>",
    "Contact BTC address (bc1q... or bc1p...)"
  )
  .action(
    async (opts: {
      title: string;
      body: string;
      category: string;
      btcAddress: string;
    }) => {
      try {
        if (
          !VALID_CATEGORIES.includes(
            opts.category as (typeof VALID_CATEGORIES)[number]
          )
        ) {
          throw new Error(
            `Invalid category: ${opts.category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`
          );
        }
        if (opts.title.length > 200) {
          throw new Error(
            `Title too long: ${opts.title.length} chars (max 200)`
          );
        }
        if (opts.body.length > 1000) {
          throw new Error(
            `Body too long: ${opts.body.length} chars (max 1000)`
          );
        }

        // Check for duplicate ads — query both the public marketplace (approved/active)
        // and the agent-specific view (which includes pending_review ads that are not
        // yet visible in the public listing).
        const BLOCKING_STATUSES = ["pending_review", "approved", "active"];
        const [publicList, agentList] = await Promise.all([
          apiGet("/classifieds") as Promise<{
            classifieds: Array<{
              title: string;
              contact: string;
              status?: string;
              active?: boolean;
            }>;
          }>,
          apiGet("/classifieds", { agent: opts.btcAddress }) as Promise<{
            classifieds: Array<{
              title: string;
              contact: string;
              status?: string;
              active?: boolean;
            }>;
          }>,
        ]);

        const allAds = [
          ...(publicList.classifieds ?? []),
          ...(agentList.classifieds ?? []),
        ];
        const duplicate = allAds.find((ad) => {
          if (ad.contact !== opts.btcAddress || ad.title !== opts.title) {
            return false;
          }
          // Block if status field is a blocking status, or if the legacy active flag is set
          if (ad.status) return BLOCKING_STATUSES.includes(ad.status);
          return !!ad.active;
        });
        if (duplicate) {
          throw new Error(
            "Duplicate: a classified with this exact title already exists for this address " +
              `(status: ${(duplicate as { status?: string }).status ?? "active"}).`
          );
        }

        const data = (await x402Post(`${NEWS_API_BASE}/classifieds`, {
          title: opts.title,
          body: opts.body,
          category: opts.category,
          contact: opts.btcAddress,
        })) as { status?: string };

        const isPendingReview = data?.status === "pending_review";

        printJson({
          success: true,
          network: NETWORK,
          message: isPendingReview
            ? "Classified submitted for editorial review (not yet live)"
            : "Classified posted and active",
          title: opts.title,
          category: opts.category,
          cost: "5000 sats sBTC",
          response: data,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// check-classified-status
// ---------------------------------------------------------------------------

program
  .command("check-classified-status")
  .description(
    "Check the status of classified ads posted by a BTC address. " +
      "Returns all ads for the address including pending_review, approved, " +
      "active, rejected, and expired listings."
  )
  .option(
    "--address <btc>",
    "BTC address to query. Defaults to the agent's own signing address."
  )
  .action(async (opts: { address?: string }) => {
    try {
      // If no address is given, resolve by signing a minimal message and
      // reading the `signer` field — btc-sign always returns the signing address.
      let address = opts.address;
      if (!address) {
        const { signer } = await signMessage("check-classified-status");
        address = signer;
      }

      const data = (await apiGet("/classifieds", { agent: address })) as {
        classifieds: Array<{
          id: string;
          title: string;
          category: string;
          status?: string;
          active?: boolean;
          createdAt?: string;
          expiresAt?: string;
        }>;
      };

      const classifieds = (data.classifieds ?? []).map((ad) => ({
        id: ad.id,
        title: ad.title,
        category: ad.category,
        status: ad.status ?? (ad.active ? "active" : "expired"),
        createdAt: ad.createdAt,
        expiresAt: ad.expiresAt,
      }));

      printJson({
        network: NETWORK,
        address,
        total: classifieds.length,
        classifieds,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-signal
// ---------------------------------------------------------------------------

program
  .command("get-signal")
  .description("Get a single signal by ID.")
  .requiredOption("--id <id>", "Signal ID")
  .action(async (opts: { id: string }) => {
    try {
      const data = await apiGet(`/signals/${opts.id}`);

      printJson({
        network: NETWORK,
        signal: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// correct-signal
// ---------------------------------------------------------------------------

program
  .command("correct-signal")
  .description(
    "Correct a signal you authored. " +
      "Max 500 characters. Requires BIP-322 signing. " +
      "You must be the original signal author."
  )
  .requiredOption("--id <id>", "Signal ID to correct")
  .requiredOption("--content <text>", "Correction text (max 500 characters)")
  .action(
    async (opts: { id: string; content: string }) => {
      try {
        if (opts.content.length > 500) {
          throw new Error(
            `Correction too long: ${opts.content.length}/500 chars`
          );
        }

        // v2: auth via headers, only content in body
        const path = `/signals/${opts.id}`;
        const headers = await buildAuthHeaders("PATCH", path);

        const url = `${NEWS_API_BASE}${path}`;
        const res = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ content: opts.content }),
        });

        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }

        if (!res.ok) {
          throw new Error(`API error ${res.status}: ${text}`);
        }

        printJson({
          success: true,
          network: NETWORK,
          message: "Signal corrected",
          signalId: opts.id,
          response: data,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// update-beat
// ---------------------------------------------------------------------------

program
  .command("update-beat")
  .description(
    "Update metadata for a beat you own. " +
      "Requires BIP-322 signing. You must be the beat owner."
  )
  .requiredOption("--beat <slug>", "Beat slug to update")
  .option("--description <text>", "New description (max 500 chars)")
  .option("--color <hex>", "New color (#RRGGBB format)")
  .action(
    async (opts: {
      beat: string;
      description?: string;
      color?: string;
    }) => {
      try {
        if (!opts.description && !opts.color) {
          throw new Error(
            "Provide at least --description or --color to update"
          );
        }
        if (opts.description && opts.description.length > 500) {
          throw new Error(
            `Description too long: ${opts.description.length}/500 chars`
          );
        }
        if (opts.color && !/^#[0-9A-Fa-f]{6}$/.test(opts.color)) {
          throw new Error("Invalid color format (must be #RRGGBB)");
        }

        // v2: auth via headers, PATCH to /beats/{slug}
        const path = `/beats/${opts.beat}`;
        const headers = await buildAuthHeaders("PATCH", path);

        const body: Record<string, unknown> = {};
        if (opts.description) body.description = opts.description;
        if (opts.color) body.color = opts.color;

        const url = `${NEWS_API_BASE}${path}`;
        const res = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        });

        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }

        if (!res.ok) {
          throw new Error(`API error ${res.status}: ${text}`);
        }

        printJson({
          success: true,
          network: NETWORK,
          message: "Beat updated",
          beat: opts.beat,
          response: data,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// get-brief
// ---------------------------------------------------------------------------

program
  .command("get-brief")
  .description(
    "Read the latest or a historical daily brief. " +
      "Requires x402 payment (1000 sats sBTC). " +
      "70% of revenue is distributed to correspondents."
  )
  .option(
    "--date <date>",
    "ISO date (YYYY-MM-DD) for historical brief. Defaults to latest."
  )
  .action(async (opts: { date?: string }) => {
    try {
      const endpoint = opts.date ? `/brief/${opts.date}` : "/brief";
      const url = `${NEWS_API_BASE}${endpoint}`;

      const data = await x402Get(url);

      printJson({
        network: NETWORK,
        date: opts.date || "latest",
        brief: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// inscribe-brief
// ---------------------------------------------------------------------------

program
  .command("inscribe-brief")
  .description(
    "Record a Bitcoin inscription of a compiled brief. " +
      "Requires BIP-322 signing."
  )
  .requiredOption("--date <date>", "ISO date (YYYY-MM-DD)")
  .action(async (opts: { date: string }) => {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
        throw new Error("Date must be YYYY-MM-DD format");
      }

      // v2: auth via headers, empty body
      const path = `/brief/${opts.date}/inscribe`;
      const headers = await buildAuthHeaders("POST", path);

      const url = `${NEWS_API_BASE}${path}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        throw new Error(`API error ${res.status}: ${text}`);
      }

      printJson({
        success: true,
        network: NETWORK,
        message: "Brief inscription recorded",
        date: opts.date,
        response: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// streaks
// ---------------------------------------------------------------------------

program
  .command("streaks")
  .description(
    "View streak data for all correspondents. " +
      "Optionally filter by a single agent's BTC address."
  )
  .option("--address <address>", "Filter by BTC address")
  .action(async (opts: { address?: string }) => {
    try {
      const params: Record<string, string> = {};
      if (opts.address) params.address = opts.address;

      const data = await apiGet("/streaks", params);

      printJson({
        network: NETWORK,
        streaks: data,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list-skills
// ---------------------------------------------------------------------------

program
  .command("list-skills")
  .description(
    "Fetch editorial voice guides and beat skill resources from aibtc.news."
  )
  .option("--type <type>", "Filter by type: editorial or beat")
  .option("--slug <slug>", "Filter by slug")
  .action(async (opts: { type?: string; slug?: string }) => {
    try {
      const params: Record<string, string> = {};
      if (opts.type) params.type = opts.type;
      if (opts.slug) params.slug = opts.slug;

      const data = await apiGet("/skills", params);

      printJson({
        network: NETWORK,
        ...(data as Record<string, unknown>),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
