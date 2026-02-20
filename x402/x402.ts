#!/usr/bin/env bun
/**
 * x402 skill CLI
 * x402 paid API endpoints, inbox messaging, project scaffolding, and OpenRouter integration
 *
 * Usage: bun run x402/x402.ts <subcommand> [options]
 */

import { Command } from "commander";
import { NETWORK, API_URL } from "../src/lib/config/networks.js";
import {
  createApiClient,
  createPlainClient,
  probeEndpoint,
  getAccount,
  getWalletAddress,
  formatPaymentAmount,
} from "../src/lib/services/x402.service.js";
import {
  scaffoldProject,
  scaffoldAIProject,
  type EndpointConfig,
  type AIEndpointConfig,
} from "../src/lib/services/scaffold.service.js";
import path from "path";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: message });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// URL parsing helper
// ---------------------------------------------------------------------------

interface ParsedUrl {
  baseUrl: string;
  requestPath: string;
  fullUrl: string;
  params?: Record<string, string>;
}

function parseEndpointUrl(options: {
  url?: string;
  endpointPath?: string;
  apiUrl?: string;
  params?: Record<string, string>;
}): ParsedUrl {
  const { url, endpointPath, apiUrl } = options;
  let params = options.params;

  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS URLs are allowed for x402 endpoints");
    }
    if (parsed.search) {
      const urlParams = Object.fromEntries(parsed.searchParams);
      params = { ...urlParams, ...params };
    }
    return {
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      requestPath: parsed.pathname,
      fullUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      params,
    };
  }

  if (endpointPath) {
    const base = apiUrl || API_URL;
    if (apiUrl && !apiUrl.startsWith("https://")) {
      throw new Error("Only HTTPS API URLs are allowed");
    }
    return {
      baseUrl: base,
      requestPath: endpointPath,
      fullUrl: `${base}${endpointPath}`,
      params,
    };
  }

  throw new Error("Either --url or --path must be provided");
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("x402")
  .description(
    "x402 paid API endpoints, inbox messaging, project scaffolding, and OpenRouter integration"
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// list-endpoints
// ---------------------------------------------------------------------------

program
  .command("list-endpoints")
  .description(
    "List known x402 API endpoint sources and their categories. " +
      "Use execute-endpoint or probe-endpoint to interact with specific endpoints."
  )
  .action(() => {
    printJson({
      network: NETWORK,
      defaultApiUrl: API_URL,
      sources: [
        {
          name: "x402.biwas.xyz",
          url: "https://x402.biwas.xyz",
          description: "DeFi analytics, market data, wallet analysis, Zest/ALEX protocols",
          categories: ["defi", "market", "wallet", "analytics"],
          example: { path: "/api/pools/trending", method: "GET" },
        },
        {
          name: "x402.aibtc.com",
          url: "https://x402.aibtc.com",
          description: "AI inference, OpenRouter integration, Stacks utilities, hashing, storage",
          categories: ["ai", "inference", "utilities", "storage"],
          example: { path: "/inference/openrouter/chat", method: "POST" },
        },
        {
          name: "stx402.com",
          url: "https://stx402.com",
          description: "AI services, cryptography, storage, utilities, agent registry",
          categories: ["ai", "crypto", "storage", "registry"],
          example: { path: "/ai/dad-joke", method: "GET" },
        },
        {
          name: "aibtc.com",
          url: "https://aibtc.com",
          description: "Inbox messaging system",
          categories: ["inbox", "messaging"],
          example: { path: "/api/inbox/{btcAddress}", method: "POST" },
          note: "Use send-inbox-message subcommand for inbox messages (handles sponsored tx flow)",
        },
      ],
      usage: {
        probe: "bun run x402/x402.ts probe-endpoint --method GET --path /api/pools/trending",
        execute: "bun run x402/x402.ts execute-endpoint --method GET --path /api/pools/trending --auto-approve",
        customSource: "bun run x402/x402.ts execute-endpoint --method GET --url https://stx402.com/ai/dad-joke --auto-approve",
      },
      tip: "Use probe-endpoint to check cost before paying. Use execute-endpoint with --auto-approve to pay and execute.",
    });
  });

// ---------------------------------------------------------------------------
// execute-endpoint
// ---------------------------------------------------------------------------

program
  .command("execute-endpoint")
  .description(
    "Execute an x402 API endpoint. Payment is handled automatically. " +
      "By default, probes first and returns cost info for paid endpoints. " +
      "Use --auto-approve to skip the probe and pay immediately."
  )
  .option("--method <method>", "HTTP method (GET, POST, PUT, DELETE)", "GET")
  .option(
    "--url <url>",
    "Full endpoint URL (e.g., https://stx402.com/ai/dad-joke). Takes precedence over --path."
  )
  .option("--path <path>", "API endpoint path (e.g., /api/pools/trending). Required if --url not provided.")
  .option("--api-url <url>", `API base URL (default: ${API_URL})`)
  .option("--params <json>", "Query parameters as JSON object (e.g., '{\"limit\":\"10\"}')", "{}")
  .option("--data <json>", "Request body for POST/PUT as JSON object", "{}")
  .option(
    "--auto-approve",
    "Skip cost probe and execute immediately, paying if required",
    false
  )
  .action(
    async (opts: {
      method: string;
      url?: string;
      path?: string;
      apiUrl?: string;
      params: string;
      data: string;
      autoApprove: boolean;
    }) => {
      let fullUrl = "";
      try {
        const method = opts.method.toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";

        let params: Record<string, string> | undefined;
        let data: Record<string, unknown> | undefined;

        try {
          const parsedParams = JSON.parse(opts.params);
          if (Object.keys(parsedParams).length > 0) params = parsedParams;
        } catch {
          throw new Error("--params must be valid JSON");
        }

        try {
          const parsedData = JSON.parse(opts.data);
          if (Object.keys(parsedData).length > 0) data = parsedData;
        } catch {
          throw new Error("--data must be valid JSON");
        }

        const parsed = parseEndpointUrl({
          url: opts.url,
          endpointPath: opts.path,
          apiUrl: opts.apiUrl,
          params,
        });
        fullUrl = parsed.fullUrl;
        params = parsed.params;

        if (!opts.autoApprove) {
          // Probe first to show cost
          const probeResult = await probeEndpoint({ method, url: fullUrl, params, data });

          if (probeResult.type === "free") {
            printJson({
              type: "free",
              endpoint: `${method} ${fullUrl}`,
              message: "This endpoint is free (no payment required)",
              response: probeResult.data,
            });
            return;
          }

          const formattedCost = formatPaymentAmount(probeResult.amount, probeResult.asset);
          printJson({
            type: "payment_required",
            endpoint: `${method} ${fullUrl}`,
            message: `No payment made. This endpoint costs ${formattedCost}. Run again with --auto-approve to pay and execute.`,
            payment: {
              amount: probeResult.amount,
              asset: probeResult.asset,
              recipient: probeResult.recipient,
              network: probeResult.network,
            },
            retryWith: `--auto-approve ${opts.url ? `--url ${opts.url}` : `--path ${opts.path}`}${opts.apiUrl ? ` --api-url ${opts.apiUrl}` : ""}${params ? ` --params '${JSON.stringify(params)}'` : ""}${data ? ` --data '${JSON.stringify(data)}'` : ""}`,
          });
          return;
        }

        // auto-approve: probe first then execute with payment
        const probeResult = await probeEndpoint({ method, url: fullUrl, params, data });

        if (probeResult.type === "payment_required") {
          const api = await createApiClient(parsed.baseUrl);
          const response = await api.request({ method, url: parsed.requestPath, params, data });

          printJson({
            endpoint: `${method} ${fullUrl}`,
            response: response.data,
          });
          return;
        }

        // Free endpoint - execute without payment client
        const api = createPlainClient(parsed.baseUrl);
        const response = await api.request({ method, url: parsed.requestPath, params, data });

        printJson({
          endpoint: `${method} ${fullUrl}`,
          response: response.data,
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// probe-endpoint
// ---------------------------------------------------------------------------

program
  .command("probe-endpoint")
  .description(
    "Probe an x402 API endpoint to discover its cost WITHOUT making payment. " +
      "Returns cost info for paid endpoints, or the response data for free endpoints."
  )
  .option("--method <method>", "HTTP method (GET, POST, PUT, DELETE)", "GET")
  .option(
    "--url <url>",
    "Full endpoint URL (e.g., https://stx402.com/ai/dad-joke). Takes precedence over --path."
  )
  .option("--path <path>", "API endpoint path. Required if --url not provided.")
  .option("--api-url <url>", `API base URL (default: ${API_URL})`)
  .option("--params <json>", "Query parameters as JSON object", "{}")
  .option("--data <json>", "Request body for POST/PUT as JSON object", "{}")
  .action(
    async (opts: {
      method: string;
      url?: string;
      path?: string;
      apiUrl?: string;
      params: string;
      data: string;
    }) => {
      let fullUrl = "";
      try {
        const method = opts.method.toUpperCase() as "GET" | "POST" | "PUT" | "DELETE";

        let params: Record<string, string> | undefined;
        let data: Record<string, unknown> | undefined;

        try {
          const parsedParams = JSON.parse(opts.params);
          if (Object.keys(parsedParams).length > 0) params = parsedParams;
        } catch {
          throw new Error("--params must be valid JSON");
        }

        try {
          const parsedData = JSON.parse(opts.data);
          if (Object.keys(parsedData).length > 0) data = parsedData;
        } catch {
          throw new Error("--data must be valid JSON");
        }

        const parsed = parseEndpointUrl({
          url: opts.url,
          endpointPath: opts.path,
          apiUrl: opts.apiUrl,
          params,
        });
        fullUrl = parsed.fullUrl;
        params = parsed.params;

        const result = await probeEndpoint({ method, url: fullUrl, params, data });

        if (result.type === "free") {
          printJson({
            type: "free",
            endpoint: `${method} ${fullUrl}`,
            message: "This endpoint is free (no payment required)",
            response: result.data,
          });
          return;
        }

        const formattedCost = formatPaymentAmount(result.amount, result.asset);
        printJson({
          type: "payment_required",
          endpoint: `${method} ${fullUrl}`,
          message: `This endpoint costs ${formattedCost}. Use execute-endpoint --auto-approve to pay and execute.`,
          payment: {
            amount: result.amount,
            asset: result.asset,
            recipient: result.recipient,
            network: result.network,
          },
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// send-inbox-message
// ---------------------------------------------------------------------------

program
  .command("send-inbox-message")
  .description(
    "Send a paid x402 message to another agent's inbox on aibtc.com. " +
      "Uses sponsored transactions so only sBTC message cost is required — no STX gas fees. " +
      "Requires an unlocked wallet with sufficient sBTC balance."
  )
  .requiredOption("--recipient-btc-address <address>", "Recipient's Bitcoin address (bc1...)")
  .requiredOption("--recipient-stx-address <address>", "Recipient's Stacks address (SP...)")
  .requiredOption("--content <text>", "Message content (max 500 characters)")
  .action(
    async (opts: {
      recipientBtcAddress: string;
      recipientStxAddress: string;
      content: string;
    }) => {
      try {
        if (opts.content.length > 500) {
          throw new Error("Message content exceeds 500 character limit");
        }

        const account = await getAccount();

        const INBOX_BASE = "https://aibtc.com/api/inbox";
        const inboxUrl = `${INBOX_BASE}/${opts.recipientBtcAddress}`;
        const body = {
          toBtcAddress: opts.recipientBtcAddress,
          toStxAddress: opts.recipientStxAddress,
          content: opts.content,
        };

        // Step 1: POST without payment to get 402 challenge
        const initialRes = await fetch(inboxUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (initialRes.status !== 402) {
          const text = await initialRes.text();
          if (initialRes.ok) {
            printJson({
              success: true,
              message: "Message sent (no payment required)",
              response: text,
            });
            return;
          }
          throw new Error(
            `Expected 402 payment challenge, got ${initialRes.status}: ${text}`
          );
        }

        // Parse payment requirements from 402 response
        const paymentHeader = initialRes.headers.get("x-payment-required");
        if (!paymentHeader) {
          throw new Error("402 response missing x-payment-required header");
        }

        // Import x402 protocol utilities
        const {
          decodePaymentRequired,
          encodePaymentPayload,
          X402_HEADERS,
        } = await import("../src/lib/utils/x402-protocol.js");
        const {
          makeContractCall,
          uintCV,
          principalCV,
          noneCV,
        } = await import("@stacks/transactions");
        const {
          getContracts,
          parseContractId,
        } = await import("../src/lib/config/contracts.js");
        const { getStacksNetwork } = await import("../src/lib/config/networks.js");
        const { createFungiblePostCondition } = await import(
          "../src/lib/transactions/post-conditions.js"
        );
        const { getHiroApi } = await import("../src/lib/services/hiro-api.js");

        const paymentRequired = decodePaymentRequired(paymentHeader);
        if (
          !paymentRequired ||
          !paymentRequired.accepts ||
          paymentRequired.accepts.length === 0
        ) {
          throw new Error("No accepted payment methods in 402 response");
        }
        const accept = paymentRequired.accepts[0];
        const amount = BigInt(accept.amount);

        // Build sponsored sBTC transfer
        const contracts = getContracts(NETWORK);
        const { address: contractAddress, name: contractName } =
          parseContractId(contracts.SBTC_TOKEN);
        const networkName = getStacksNetwork(NETWORK);

        const postCondition = createFungiblePostCondition(
          account.address,
          contracts.SBTC_TOKEN,
          "sbtc-token",
          "eq",
          amount
        );

        // Get current nonce
        const hiro = getHiroApi(NETWORK);
        const accountInfo = await hiro.getAccountInfo(account.address);
        const nonce = BigInt(accountInfo.nonce);

        const transaction = await makeContractCall({
          contractAddress,
          contractName,
          functionName: "transfer",
          functionArgs: [
            uintCV(amount),
            principalCV(account.address),
            principalCV(accept.payTo),
            noneCV(),
          ],
          senderKey: account.privateKey,
          network: networkName,
          postConditions: [postCondition],
          sponsored: true,
          fee: 0n,
          nonce,
        });

        const txHex = "0x" + transaction.serialize();

        // Encode payment payload
        const paymentSignature = encodePaymentPayload({
          x402Version: 2,
          resource: paymentRequired.resource,
          accepted: accept,
          payload: { transaction: txHex },
        });

        // Send with payment header
        const finalRes = await fetch(inboxUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
          },
          body: JSON.stringify(body),
        });

        const responseText = await finalRes.text();
        let responseData: unknown;
        try {
          responseData = JSON.parse(responseText);
        } catch {
          responseData = { raw: responseText };
        }

        if (finalRes.status === 201 || finalRes.status === 200) {
          const settlementHeader = finalRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE);
          const { decodePaymentResponse } = await import("../src/lib/utils/x402-protocol.js");
          const settlement = decodePaymentResponse(settlementHeader);
          const txid = settlement?.transaction;

          printJson({
            success: true,
            message: "Message delivered",
            recipient: {
              btcAddress: opts.recipientBtcAddress,
              stxAddress: opts.recipientStxAddress,
            },
            contentLength: opts.content.length,
            inbox: responseData,
            ...(txid && {
              payment: {
                txid,
                amount: accept.amount + " sats sBTC",
              },
            }),
          });
          return;
        }

        throw new Error(`Message delivery failed (${finalRes.status}): ${responseText}`);
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// scaffold-endpoint
// ---------------------------------------------------------------------------

program
  .command("scaffold-endpoint")
  .description(
    "Create a complete x402 paid API project as a Cloudflare Worker. " +
      "Generates a new project folder with Hono.js app, x402 payment middleware, wrangler config, and README."
  )
  .requiredOption("--output-dir <dir>", "Directory where the project folder will be created")
  .requiredOption(
    "--project-name <name>",
    "Project name (lowercase with hyphens, e.g., my-x402-api)"
  )
  .requiredOption(
    "--endpoints <json>",
    'JSON array of endpoint configs, e.g., \'[{"path":"/api/data","method":"GET","description":"Get data","amount":"0.001","tokenType":"STX"}]\''
  )
  .option(
    "--recipient-address <address>",
    "Stacks address to receive payments (uses active wallet if omitted)"
  )
  .option("--network <network>", "Network for payments (mainnet or testnet)", "mainnet")
  .option(
    "--relay-url <url>",
    "Custom relay URL",
    "https://x402-relay.aibtc.com"
  )
  .action(
    async (opts: {
      outputDir: string;
      projectName: string;
      endpoints: string;
      recipientAddress?: string;
      network: string;
      relayUrl: string;
    }) => {
      try {
        if (!/^[a-z][a-z0-9-]*$/.test(opts.projectName)) {
          throw new Error(
            "Project name must be lowercase with hyphens only (e.g., my-x402-api)"
          );
        }

        let endpoints: EndpointConfig[];
        try {
          endpoints = JSON.parse(opts.endpoints);
          if (!Array.isArray(endpoints) || endpoints.length === 0) {
            throw new Error("--endpoints must be a non-empty JSON array");
          }
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            throw new Error(`Invalid --endpoints JSON: ${parseError.message}`);
          }
          throw parseError;
        }

        const projectPath = path.join(opts.outputDir, opts.projectName);
        const exists = await import("fs/promises").then((fs) =>
          fs.access(projectPath).then(() => true).catch(() => false)
        );
        if (exists) {
          throw new Error(
            `Directory already exists at ${projectPath}. Choose a different project name.`
          );
        }

        let recipientAddress = opts.recipientAddress;
        if (!recipientAddress) {
          try {
            recipientAddress = await getWalletAddress();
          } catch {
            // No wallet active — recipient will need to be set in .dev.vars
          }
        }

        const result = await scaffoldProject({
          outputDir: opts.outputDir,
          projectName: opts.projectName,
          endpoints,
          recipientAddress,
          network: (opts.network as "mainnet" | "testnet") || "mainnet",
          relayUrl: opts.relayUrl,
        });

        printJson({
          success: true,
          message: `Project created at ${result.projectPath}`,
          projectPath: result.projectPath,
          filesCreated: result.filesCreated,
          nextSteps: result.nextSteps,
          recipientAddress: recipientAddress || "(set in .dev.vars)",
          endpoints: endpoints.map((ep) => ({
            path: ep.path,
            method: ep.method,
            cost: ep.tier ? `tier: ${ep.tier}` : `${ep.amount || "0.001"} ${ep.tokenType}`,
          })),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// scaffold-ai-endpoint
// ---------------------------------------------------------------------------

program
  .command("scaffold-ai-endpoint")
  .description(
    "Create a complete x402 paid AI API project with OpenRouter integration as a Cloudflare Worker. " +
      "Generates a new project folder with Hono.js app, x402 middleware, OpenRouter client, and wrangler config."
  )
  .requiredOption("--output-dir <dir>", "Directory where the project folder will be created")
  .requiredOption(
    "--project-name <name>",
    "Project name (lowercase with hyphens, e.g., my-ai-api)"
  )
  .requiredOption(
    "--endpoints <json>",
    'JSON array of AI endpoint configs, e.g., \'[{"path":"/api/chat","description":"Chat endpoint","amount":"0.003","tokenType":"STX","aiType":"chat"}]\''
  )
  .option(
    "--recipient-address <address>",
    "Stacks address to receive payments (uses active wallet if omitted)"
  )
  .option("--network <network>", "Network for payments (mainnet or testnet)", "mainnet")
  .option(
    "--relay-url <url>",
    "Custom relay URL",
    "https://x402-relay.aibtc.com"
  )
  .option(
    "--default-model <model>",
    "Default OpenRouter model for all endpoints",
    "anthropic/claude-3-haiku"
  )
  .action(
    async (opts: {
      outputDir: string;
      projectName: string;
      endpoints: string;
      recipientAddress?: string;
      network: string;
      relayUrl: string;
      defaultModel: string;
    }) => {
      try {
        if (!/^[a-z][a-z0-9-]*$/.test(opts.projectName)) {
          throw new Error(
            "Project name must be lowercase with hyphens only (e.g., my-ai-api)"
          );
        }

        let endpoints: AIEndpointConfig[];
        try {
          endpoints = JSON.parse(opts.endpoints);
          if (!Array.isArray(endpoints) || endpoints.length === 0) {
            throw new Error("--endpoints must be a non-empty JSON array");
          }
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            throw new Error(`Invalid --endpoints JSON: ${parseError.message}`);
          }
          throw parseError;
        }

        const projectPath = path.join(opts.outputDir, opts.projectName);
        const exists = await import("fs/promises").then((fs) =>
          fs.access(projectPath).then(() => true).catch(() => false)
        );
        if (exists) {
          throw new Error(
            `Directory already exists at ${projectPath}. Choose a different project name.`
          );
        }

        let recipientAddress = opts.recipientAddress;
        if (!recipientAddress) {
          try {
            recipientAddress = await getWalletAddress();
          } catch {
            // No wallet active — recipient will need to be set in .dev.vars
          }
        }

        const result = await scaffoldAIProject({
          outputDir: opts.outputDir,
          projectName: opts.projectName,
          endpoints,
          recipientAddress,
          network: (opts.network as "mainnet" | "testnet") || "mainnet",
          relayUrl: opts.relayUrl,
          defaultModel: opts.defaultModel,
        });

        printJson({
          success: true,
          message: `AI project created at ${result.projectPath}`,
          projectPath: result.projectPath,
          filesCreated: result.filesCreated,
          nextSteps: result.nextSteps,
          recipientAddress: recipientAddress || "(set in .dev.vars)",
          endpoints: endpoints.map((ep) => ({
            path: ep.path,
            aiType: ep.aiType,
            model: ep.model || opts.defaultModel,
            cost: `${ep.amount} ${ep.tokenType}`,
          })),
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

// ---------------------------------------------------------------------------
// openrouter-guide
// ---------------------------------------------------------------------------

program
  .command("openrouter-guide")
  .description(
    "Get OpenRouter integration examples and code patterns. " +
      "Returns code templates for Node.js, Cloudflare Workers, and browser environments."
  )
  .option(
    "--environment <env>",
    "Target environment (nodejs, cloudflare-worker, browser, all)",
    "all"
  )
  .option(
    "--feature <feature>",
    "Specific AI feature (chat, completion, streaming, function-calling, all)",
    "all"
  )
  .action(async (opts: { environment: string; feature: string }) => {
    const guides: Record<string, string> = {};

    guides.apiOverview = `
OpenRouter API Overview
Base URL: https://openrouter.ai/api/v1
Auth: Bearer token in Authorization header
API Key: Get from https://openrouter.ai/keys

Request Format:
POST /chat/completions
{
  "model": "anthropic/claude-3-haiku",
  "messages": [
    { "role": "system", "content": "You are helpful" },
    { "role": "user", "content": "Hello" }
  ],
  "max_tokens": 1024,
  "temperature": 0.7
}
`.trim();

    guides.popularModels = `
Popular Models:
- anthropic/claude-3.5-haiku    Fast, cheap, 200K context
- anthropic/claude-sonnet-4.5   Best overall, 1M context
- openai/gpt-4o-mini            Fast, 128K context
- meta-llama/llama-3.3-70b      Best open value, 131K context
- google/gemini-2.5-flash       1M context, affordable
- deepseek/deepseek-r1          Excellent reasoning
`.trim();

    if (opts.environment === "nodejs" || opts.environment === "all") {
      guides.nodejs = `
Node.js Integration:
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${process.env.OPENROUTER_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'anthropic/claude-3.5-haiku',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
  }),
});
const data = await response.json();
console.log(data.choices[0]?.message?.content);
`.trim();
    }

    if (opts.environment === "cloudflare-worker" || opts.environment === "all") {
      guides.cloudflareWorker = `
Cloudflare Worker with Hono.js:
import { Hono } from 'hono';
type Bindings = { OPENROUTER_API_KEY: string };
const app = new Hono<{ Bindings: Bindings }>();
app.post('/api/chat', async (c) => {
  const { messages, model = 'anthropic/claude-3-haiku' } = await c.req.json();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${c.env.OPENROUTER_API_KEY}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
  });
  const data = await response.json();
  return c.json({ content: data.choices[0]?.message?.content });
});
export default app;
`.trim();
    }

    if (opts.feature === "streaming" || opts.feature === "all") {
      guides.streaming = `
Streaming:
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'anthropic/claude-3-haiku',
    messages: [{ role: 'user', content: 'Tell me a story' }],
    stream: true,
  }),
});
const reader = response.body?.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  for (const line of chunk.split('\\n').filter(l => l.startsWith('data: '))) {
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    const parsed = JSON.parse(data);
    process.stdout.write(parsed.choices[0]?.delta?.content || '');
  }
}
`.trim();
    }

    guides.bestPractices = `
Best Practices:
1. Store API key in env vars, never commit to git
2. Set reasonable max_tokens (affects cost and latency)
3. Temperature 0.0-0.3 for factual, 0.5-0.7 balanced, 0.8-1.0 creative
4. Implement exponential backoff for rate limits (429)
5. Start with claude-3.5-haiku or gpt-4o-mini, upgrade only if needed
`.trim();

    printJson({
      environment: opts.environment,
      feature: opts.feature,
      guides,
      tip: "Use these code examples as templates. Replace placeholders with your actual values.",
    });
  });

// ---------------------------------------------------------------------------
// openrouter-models
// ---------------------------------------------------------------------------

program
  .command("openrouter-models")
  .description(
    "List popular OpenRouter models with capabilities and context lengths. " +
      "Check openrouter.ai/models for latest pricing."
  )
  .option(
    "--category <category>",
    "Filter by category (fast, quality, cheap, code, long-context, all)",
    "all"
  )
  .action((opts: { category: string }) => {
    const allModels = [
      { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku", category: ["fast", "cheap"], contextLength: 200000, bestFor: "Fast responses, simple tasks, cost-effective" },
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", category: ["quality", "long-context"], contextLength: 1000000, bestFor: "Best overall, complex reasoning, coding" },
      { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", category: ["quality"], contextLength: 200000, bestFor: "Most capable, research, difficult tasks" },
      { id: "openai/gpt-4o", name: "GPT-4o", category: ["quality"], contextLength: 128000, bestFor: "General purpose, multimodal, function calling" },
      { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", category: ["fast", "cheap"], contextLength: 128000, bestFor: "Fast, cheap, good for simple tasks" },
      { id: "openai/gpt-4.1", name: "GPT-4.1", category: ["quality", "long-context"], contextLength: 1040000, bestFor: "Long context, multimodal, latest OpenAI" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", category: ["quality", "cheap"], contextLength: 131072, bestFor: "Best open source value, great quality" },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", category: ["quality", "long-context"], contextLength: 1000000, bestFor: "1M context, great reasoning, multimodal" },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", category: ["fast", "cheap", "long-context"], contextLength: 1000000, bestFor: "Fast, 1M context, affordable" },
      { id: "x-ai/grok-4", name: "Grok 4", category: ["quality"], contextLength: 256000, bestFor: "xAI flagship, real-time knowledge" },
      { id: "mistralai/mistral-large-2411", name: "Mistral Large", category: ["quality", "code"], contextLength: 131072, bestFor: "Coding, reasoning, multilingual" },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1", category: ["quality", "code"], contextLength: 163000, bestFor: "Excellent reasoning, chain-of-thought" },
      { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", category: ["code", "cheap"], contextLength: 163000, bestFor: "Fast coding, affordable" },
    ];

    const models =
      opts.category === "all"
        ? allModels
        : allModels.filter((m) => m.category.includes(opts.category));

    printJson({
      category: opts.category,
      count: models.length,
      models,
      recommendation:
        opts.category === "all"
          ? "Start with claude-3.5-haiku or gpt-4o-mini for most tasks. Use claude-sonnet-4.5 or deepseek-r1 for complex reasoning."
          : undefined,
    });
  });

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

program.parse(process.argv);
