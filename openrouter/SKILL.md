---
name: openrouter
description: "OpenRouter AI integration — list available models, get integration code examples for different environments, and send prompts to any OpenRouter-compatible model. Requires OPENROUTER_API_KEY env var for chat operations."
metadata:
  author: "tfibtcagent"
  author-agent: "Secret Dome"
  user-invocable: "false"
  arguments: "models | guide | chat"
  entry: "openrouter/openrouter.ts"
  mcp-tools: "openrouter_integration_guide, openrouter_models"
  requires: ""
  tags: "read-only"
---

# OpenRouter Skill

Provides AI integration capabilities via [OpenRouter](https://openrouter.ai) — a unified API for 100+ LLMs.

- **Model Discovery** — List available OpenRouter models with capabilities, context windows, and pricing.
- **Integration Guide** — Get code examples and patterns for integrating OpenRouter in different environments (Node.js, Cloudflare Workers, browser).
- **Chat** — Send a prompt to any OpenRouter model and return the response. Requires `OPENROUTER_API_KEY` env var.

## Usage

```
bun run openrouter/openrouter.ts <subcommand> [options]
```

## Subcommands

### models

List available OpenRouter models with capabilities and pricing.

```
bun run openrouter/openrouter.ts models [--filter <term>]
```

Options:
- `--filter` (optional) — Filter models by name (case-insensitive substring match)

### guide

Print integration code examples for a target environment.

```
bun run openrouter/openrouter.ts guide [--env <environment>] [--feature <feature>]
```

Options:
- `--env` — Target environment: `nodejs` | `cloudflare-worker` | `browser` | `all` (default: `all`)
- `--feature` — Feature to show: `chat` | `completion` | `streaming` | `function-calling` | `all` (default: `all`)

### chat

Send a prompt to an OpenRouter model. Requires `OPENROUTER_API_KEY` environment variable.

```
bun run openrouter/openrouter.ts chat --prompt "Hello" [--model <model-id>] [--max-tokens <n>]
```

Options:
- `--prompt` (required) — The prompt to send
- `--model` (optional) — Model ID (default: `openai/gpt-4o-mini`)
- `--max-tokens` (optional) — Max tokens in response (default: 1024)

## Notes

- `models` and `guide` work without an API key.
- `chat` requires `OPENROUTER_API_KEY` environment variable (get from https://openrouter.ai/keys).
- OpenRouter API base: `https://openrouter.ai/api/v1`
