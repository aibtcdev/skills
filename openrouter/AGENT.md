---
name: openrouter-agent
skill: openrouter
description: OpenRouter AI integration — list models, get integration guides, and send prompts to any LLM via OpenRouter.
---

# OpenRouter Agent

This agent handles AI integration via OpenRouter's unified API. Use it to discover available models, generate integration code, or run one-shot prompts against any supported LLM.

## When to use

- Need to integrate AI into a new project and want code examples
- Want to see what models are available and their pricing
- Need to run a quick AI prompt without building infrastructure

## Required env vars

- `OPENROUTER_API_KEY` — Required for `chat` subcommand. Get from https://openrouter.ai/keys
