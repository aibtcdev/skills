#!/usr/bin/env bun
/**
 * Settings skill CLI
 * Manages AIBTC configuration stored at ~/.aibtc/config.json
 *
 * Usage: bun run settings/settings.ts <subcommand> [options]
 */

import { Command } from "commander";
import { createRequire } from "module";
import {
  getHiroApiKey,
  setHiroApiKey,
  clearHiroApiKey,
  getStacksApiUrl,
  setStacksApiUrl,
  clearStacksApiUrl,
  initializeStorage,
} from "../src/lib/utils/storage.js";
import { getApiBaseUrl, NETWORK } from "../src/lib/config/networks.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("settings")
  .description("Manage AIBTC configuration stored at ~/.aibtc/config.json")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// set-hiro-api-key
// ---------------------------------------------------------------------------

program
  .command("set-hiro-api-key")
  .description(
    "Save a Hiro API key to ~/.aibtc/config.json for authenticated Hiro API requests"
  )
  .requiredOption("--api-key <apiKey>", "Your Hiro API key (sensitive)")
  .action(async (opts: { apiKey: string }) => {
    try {
      await initializeStorage();
      await setHiroApiKey(opts.apiKey);

      const masked =
        opts.apiKey.length > 8
          ? `${opts.apiKey.slice(0, 4)}...${opts.apiKey.slice(-4)}`
          : "****";

      printJson({
        success: true,
        message:
          "Hiro API key saved. All subsequent Hiro API requests will use this key.",
        maskedKey: masked,
        storedIn: "~/.aibtc/config.json",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-hiro-api-key
// ---------------------------------------------------------------------------

program
  .command("get-hiro-api-key")
  .description(
    "Check whether a Hiro API key is configured, and show its source and masked preview"
  )
  .action(async () => {
    try {
      await initializeStorage();
      const storedKey = await getHiroApiKey();
      const envKey = process.env.HIRO_API_KEY || "";

      const activeKey = storedKey || envKey;
      const source = storedKey
        ? "~/.aibtc/config.json"
        : envKey
          ? "HIRO_API_KEY environment variable"
          : "none";

      const masked =
        activeKey.length > 8
          ? `${activeKey.slice(0, 4)}...${activeKey.slice(-4)}`
          : activeKey
            ? "****"
            : "";

      printJson({
        configured: !!activeKey,
        source,
        maskedKey: masked || "(not set)",
        hint: activeKey
          ? "API key is active. Hiro API requests use authenticated rate limits."
          : "No API key configured. Using public rate limits. Get a key at https://platform.hiro.so/",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// delete-hiro-api-key
// ---------------------------------------------------------------------------

program
  .command("delete-hiro-api-key")
  .description(
    "Remove the stored Hiro API key from ~/.aibtc/config.json"
  )
  .action(async () => {
    try {
      await initializeStorage();
      const hadKey = !!(await getHiroApiKey());
      await clearHiroApiKey();

      const envFallback = !!process.env.HIRO_API_KEY;

      printJson({
        success: true,
        message: hadKey
          ? "Hiro API key removed from ~/.aibtc/config.json."
          : "No stored Hiro API key to remove.",
        envFallbackActive: envFallback,
        hint: envFallback
          ? "HIRO_API_KEY environment variable is still set and will be used."
          : "No API key configured. Requests will use public rate limits.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// set-stacks-api-url
// ---------------------------------------------------------------------------

program
  .command("set-stacks-api-url")
  .description(
    "Point all Stacks API requests at a custom node instead of the default Hiro API"
  )
  .requiredOption(
    "--url <url>",
    "Base URL of your Stacks API node (e.g. http://localhost:3999)"
  )
  .action(async (opts: { url: string }) => {
    try {
      await initializeStorage();
      const cleanUrl = opts.url.replace(/\/+$/, "");
      await setStacksApiUrl(cleanUrl);

      printJson({
        success: true,
        message:
          "Custom Stacks API URL saved. All subsequent Stacks API requests will use this node.",
        url: cleanUrl,
        storedIn: "~/.aibtc/config.json",
        tip: "Use get-stacks-api-url to verify, or delete-stacks-api-url to revert to the default Hiro API.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-stacks-api-url
// ---------------------------------------------------------------------------

program
  .command("get-stacks-api-url")
  .description(
    "Show the current Stacks API URL being used for blockchain queries"
  )
  .action(async () => {
    try {
      await initializeStorage();
      const customUrl = await getStacksApiUrl();
      const defaultUrl = getApiBaseUrl(NETWORK);

      printJson({
        activeUrl: customUrl || defaultUrl,
        isCustom: !!customUrl,
        source: customUrl ? "~/.aibtc/config.json" : "default (Hiro API)",
        defaultUrl,
        network: NETWORK,
        hint: customUrl
          ? "Using custom Stacks API node. Use delete-stacks-api-url to revert to the default Hiro API."
          : "Using default Hiro API. Use set-stacks-api-url to point to your own node.",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// delete-stacks-api-url
// ---------------------------------------------------------------------------

program
  .command("delete-stacks-api-url")
  .description(
    "Remove the custom Stacks API URL and revert to the default Hiro API"
  )
  .action(async () => {
    try {
      await initializeStorage();
      const hadUrl = !!(await getStacksApiUrl());
      await clearStacksApiUrl();
      const defaultUrl = getApiBaseUrl(NETWORK);

      printJson({
        success: true,
        message: hadUrl
          ? `Custom Stacks API URL removed. Reverted to default: ${defaultUrl}`
          : "No custom Stacks API URL was set.",
        activeUrl: defaultUrl,
        network: NETWORK,
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// get-server-version
// ---------------------------------------------------------------------------

program
  .command("get-server-version")
  .description(
    "Check the currently installed package version and compare with the latest on npm"
  )
  .action(async () => {
    try {
      // Read current version from package.json
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const packageJson = require("../package.json");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const currentVersion = packageJson.version as string;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const packageName = (packageJson.name as string) || "@aibtc/skills";

      let latestVersion = "unknown";

      try {
        const response = await fetch(
          `https://registry.npmjs.org/${packageName}/latest`
        );
        if (response.ok) {
          const data = (await response.json()) as { version: string };
          latestVersion = data.version;
        }
      } catch {
        // Network error or npm registry unavailable — non-fatal
      }

      const compare = (a: string, b: string): number => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const na = pa[i] ?? 0;
          const nb = pb[i] ?? 0;
          if (na !== nb) return na - nb;
        }
        return 0;
      };

      const fetched = latestVersion !== "unknown";
      const updateAvailable = fetched && compare(currentVersion, latestVersion) < 0;
      const isLatest = fetched && compare(currentVersion, latestVersion) >= 0;

      printJson({
        currentVersion,
        latestVersion,
        isLatest,
        updateAvailable,
        package: packageName,
        hint: updateAvailable
          ? "Update available! Install the latest version to get new features."
          : fetched
            ? "Running the latest version."
            : "Unable to verify latest version (network error).",
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// check-relay-health
// ---------------------------------------------------------------------------

program
  .command("check-relay-health")
  .description(
    "Check the health of the x402 sponsor relay and the sponsor address nonce status on-chain"
  )
  .option(
    "--relay-url <url>",
    "Base URL of the sponsor relay",
    "https://sponsor.aibtc.dev"
  )
  .option(
    "--sponsor-address <address>",
    "STX address of the relay sponsor",
    "SP1PMPPVCMVW96FSWFV30KJQ4MNBMZ8MRWR3JWQ7"
  )
  .action(
    async (opts: { relayUrl: string; sponsorAddress: string }) => {
      try {
        const relayUrl = opts.relayUrl.replace(/\/+$/, "");
        const sponsorAddress = opts.sponsorAddress;

        // ---- 1. Hit relay /health endpoint ----
        let relayHealth: Record<string, unknown> | null = null;
        let relayReachable = false;
        let relayError: string | undefined;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const res = await fetch(`${relayUrl}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (res.ok) {
            relayHealth = (await res.json()) as Record<string, unknown>;
            relayReachable = true;
          } else {
            relayError = `HTTP ${res.status} ${res.statusText}`;
          }
        } catch (err: unknown) {
          relayError =
            err instanceof Error ? err.message : "Unknown fetch error";
        }

        // ---- 2. Check sponsor nonce status via Hiro API ----
        interface NonceResponse {
          last_mempool_tx_nonce: number | null;
          last_executed_tx_nonce: number | null;
          possible_next_nonce: number;
          detected_missing_nonces: number[];
          detected_mempool_nonces: number[];
        }

        let nonceData: NonceResponse | null = null;
        let nonceError: string | undefined;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          const res = await fetch(
            `https://api.hiro.so/extended/v1/address/${sponsorAddress}/nonces`,
            { signal: controller.signal }
          );
          clearTimeout(timeout);

          if (res.ok) {
            nonceData = (await res.json()) as NonceResponse;
          } else {
            nonceError = `HTTP ${res.status} ${res.statusText}`;
          }
        } catch (err: unknown) {
          nonceError =
            err instanceof Error ? err.message : "Unknown fetch error";
        }

        // ---- 3. Build diagnostic output ----
        const issues: string[] = [];

        if (!relayReachable) {
          issues.push(`Relay unreachable: ${relayError ?? "unknown error"}`);
        }

        if (nonceData) {
          if (nonceData.detected_missing_nonces.length > 0) {
            issues.push(
              `Nonce gaps detected: [${nonceData.detected_missing_nonces.join(", ")}]. ` +
                "Transactions may be stuck. The sponsor may need to fill missing nonces."
            );
          }
          if (nonceData.detected_mempool_nonces.length > 5) {
            issues.push(
              `Mempool congestion: ${nonceData.detected_mempool_nonces.length} pending sponsor transactions. ` +
                "New sponsored transactions may be slow to confirm."
            );
          }
        } else {
          issues.push(
            `Unable to fetch sponsor nonce data: ${nonceError ?? "unknown error"}`
          );
        }

        const healthy = relayReachable && issues.length === 0;

        printJson({
          healthy,
          relay: {
            url: relayUrl,
            reachable: relayReachable,
            ...(relayHealth ?? {}),
            ...(relayError ? { error: relayError } : {}),
          },
          sponsor: {
            address: sponsorAddress,
            lastExecutedNonce: nonceData?.last_executed_tx_nonce ?? null,
            possibleNextNonce: nonceData?.possible_next_nonce ?? null,
            lastMempoolNonce: nonceData?.last_mempool_tx_nonce ?? null,
            mempoolCount: nonceData?.detected_mempool_nonces?.length ?? null,
            missingNonces: nonceData?.detected_missing_nonces ?? [],
            ...(nonceError ? { error: nonceError } : {}),
          },
          issues,
          hint: healthy
            ? "Relay and sponsor are operating normally."
            : "Issues detected — see the issues array for details.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
