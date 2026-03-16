#!/usr/bin/env bun
/**
 * OpenRouter skill CLI
 * AI integration via OpenRouter — list models, get integration guides, send prompts.
 *
 * Usage: bun run openrouter/openrouter.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

interface ModelSummary {
  id: string;
  name: string;
  contextLength: number;
  pricingPerMtokens: {
    prompt: string;
    completion: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeModel(model: OpenRouterModel): ModelSummary {
  const promptPriceRaw = parseFloat(model.pricing.prompt || "0");
  const completionPriceRaw = parseFloat(model.pricing.completion || "0");
  return {
    id: model.id,
    name: model.name,
    contextLength: model.context_length,
    pricingPerMtokens: {
      prompt:
        promptPriceRaw === 0
          ? "free"
          : `$${(promptPriceRaw * 1_000_000).toFixed(4)}`,
      completion:
        completionPriceRaw === 0
          ? "free"
          : `$${(completionPriceRaw * 1_000_000).toFixed(4)}`,
    },
  };
}

function buildGuide(
  environment: string,
  feature: string
): Record<string, string> {
  const guides: Record<string, string> = {};

  const nodeChat = `// Node.js chat with OpenRouter
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://your-site.com",
  },
});

const response = await client.chat.completions.create({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.choices[0].message.content);`;

  const cfWorkerChat = `// Cloudflare Worker chat with OpenRouter
interface Env {
  OPENROUTER_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: \`Bearer \${env.OPENROUTER_API_KEY}\`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://your-site.com",
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Hello!" }],
      }),
    });
    const data = await response.json();
    return Response.json(data);
  },
};`;

  const browserChat = `// Browser chat with OpenRouter
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    "Content-Type": "application/json",
    "HTTP-Referer": window.location.origin,
  },
  body: JSON.stringify({
    model: "openai/gpt-4o-mini",
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
const data = await response.json();
console.log(data.choices[0].message.content);`;

  const streamingExample = `// Streaming responses with OpenRouter (Node.js)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const stream = await client.chat.completions.create({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Tell me a story" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`;

  const showNodejs = environment === "nodejs" || environment === "all";
  const showCfWorker =
    environment === "cloudflare-worker" || environment === "all";
  const showBrowser = environment === "browser" || environment === "all";
  const showStreaming = feature === "streaming" || feature === "all";

  if (showNodejs && (feature === "chat" || feature === "all")) {
    guides["nodejs-chat"] = nodeChat;
  }
  if (showCfWorker && (feature === "chat" || feature === "all")) {
    guides["cloudflare-worker-chat"] = cfWorkerChat;
  }
  if (showBrowser && (feature === "chat" || feature === "all")) {
    guides["browser-chat"] = browserChat;
  }
  if (showNodejs && showStreaming) {
    guides["nodejs-streaming"] = streamingExample;
  }

  return guides;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command()
  .name("openrouter")
  .description("OpenRouter AI integration — list models, get guides, chat")
  .version("1.0.0");

program
  .command("models")
  .description("List available OpenRouter models with capabilities and pricing")
  .option("--filter <term>", "Filter models by name (case-insensitive)")
  .action(async (options: { filter?: string }) => {
    try {
      const response = await fetch(`${OPENROUTER_BASE}/models`);
      if (!response.ok) {
        throw new Error(
          `OpenRouter API error: ${response.status} ${response.statusText}`
        );
      }
      const data = (await response.json()) as { data: OpenRouterModel[] };
      let models = data.data.map(summarizeModel);

      if (options.filter) {
        const term = options.filter.toLowerCase();
        models = models.filter(
          (m) =>
            m.id.toLowerCase().includes(term) ||
            m.name.toLowerCase().includes(term)
        );
      }

      printJson({
        network: "openrouter",
        modelCount: models.length,
        models,
      });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("guide")
  .description("Get integration code examples for a target environment")
  .option(
    "--env <environment>",
    "Target environment: nodejs | cloudflare-worker | browser | all",
    "all"
  )
  .option(
    "--feature <feature>",
    "Feature: chat | completion | streaming | function-calling | all",
    "all"
  )
  .action(async (options: { env: string; feature: string }) => {
    try {
      const guides = buildGuide(options.env, options.feature);
      printJson({
        environment: options.env,
        feature: options.feature,
        guides,
      });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("chat")
  .description(
    "Send a prompt to an OpenRouter model (requires OPENROUTER_API_KEY)"
  )
  .requiredOption("--prompt <text>", "The prompt to send")
  .option("--model <id>", "Model ID", "openai/gpt-4o-mini")
  .option("--max-tokens <n>", "Max tokens in response", "1024")
  .action(async (options: { prompt: string; model: string; maxTokens: string }) => {
    try {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          "OPENROUTER_API_KEY environment variable is required for chat. " +
            "Get your key at https://openrouter.ai/keys"
        );
      }

      const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aibtc.com",
          "X-Title": "AIBTC Agent",
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: "user", content: options.prompt }],
          max_tokens: parseInt(options.maxTokens, 10),
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
          `OpenRouter API error: ${response.status} ${response.statusText}: ${errorData}`
        );
      }

      const data = await response.json() as {
        id: string;
        model: string;
        choices: Array<{
          message: { content: string };
          finish_reason: string;
        }>;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      printJson({
        model: data.model,
        response: data.choices[0]?.message?.content ?? "",
        finishReason: data.choices[0]?.finish_reason,
        usage: data.usage,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
