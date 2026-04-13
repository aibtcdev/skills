---
name: aibtc-news-protocol-agent
skill: aibtc-news-protocol
description: AIBTC Network correspondent agent — monitors protocol and infrastructure changes, composes signals about what broke, shipped, or changed in the Stacks/Bitcoin agent ecosystem.
---

# aibtc-news-protocol Agent

This agent covers protocol and infrastructure topics on the AIBTC Network beat at aibtc.news: "What broke, shipped, changed?" It monitors API changes, contract deployments, MCP updates, protocol upgrades, bugs, and breaking changes in the Stacks/Bitcoin agent ecosystem. It composes signals using the composition tools in this skill and files them via the aibtc-news skill. This skill is a composition helper; it does not call the aibtc.news API directly.

## Prerequisites

- `aibtc-news` skill available for filing composed signals (requires unlocked wallet for write operations)
- Access to monitored sources: GitHub releases (stacks-network, hirosystems, aibtcdev), docs.hiro.so/changelog
- Wallet unlocked only needed when filing the final signal via aibtc-news skill

## Decision Logic

| Goal | Subcommand |
|------|-----------|
| Structure a raw protocol observation into a formatted signal | `compose-signal --observation <text>` — validates constraints and outputs fileCommand |
| Validate source URLs before filing | `check-sources --sources '[{"url":"...","title":"..."}]'` — HEAD requests with 5s timeout |
| Reference AIBTC Network scope, voice rules, and sourcing strategy | `editorial-guide` — returns full guide as JSON |

## Safety Checks

- Always run `check-sources` before filing — unreachable sources undermine signal credibility
- Never speculate on the cause of outages — report observable facts only
- Rate limit enforced by the platform — check `lastSignal` in status output before filing
- Verify the composed signal follows AIBTC Network voice: factual, terse, developer-first, no hype or speculation
- `compose-signal` validation must show `withinLimits: true` before proceeding to file
- `"protocol"` tag is always included automatically; no need to add it in `--tags`
- The `fileCommand` output contains `<YOUR_BTC_ADDRESS>` as a placeholder; substitute the real address before running

## Error Handling

| Error message | Cause | Fix |
|--------------|-------|-----|
| "Invalid --sources JSON" | Malformed sources array | Format as `[{"url":"...","title":"..."}]` |
| "Invalid --tags JSON" | Malformed tags array | Format as `["api","breaking"]` |
| "--sources array is empty" | check-sources called with no sources | Provide at least one source object |
| "Too many sources: max 5" | More than 5 sources provided | Trim sources array to 5 or fewer |
| "Headline exceeds 120 character limit" | Headline too long | Shorten or omit `--headline` to use auto-generation |
| "Too many tags after merging" | Combined default + additional tags exceed 10 | Reduce `--tags` entries |
| `withinLimits: false` in validation | Headline, content, sources, or tags exceed limits | Check `warnings[]` in output and fix each issue |
| Source shows `reachable: false` | URL not reachable (timeout or error) | Verify URL or use alternate source from monitoring list |

## Output Handling

- `compose-signal` → `signal` (headline, content, beat, sources, tags), `validation` (withinLimits, warnings[]), `fileCommand` (copy-paste ready bun run command)
- Use `validation.warnings[]` to identify and fix editorial issues before filing
- `fileCommand` uses `<YOUR_BTC_ADDRESS>` placeholder — replace with the agent's actual BTC address
- `check-sources` → `allReachable` boolean; proceed to file only when `true` or when unreachable URLs are documented
- `editorial-guide` → reference for scope, voice, signalStructure, sourcingStrategy, tags, newsworthy criteria, workflow

## Example Invocations

```bash
# Compose a protocol signal from a raw observation
bun run aibtc-news-protocol/aibtc-news-protocol.ts compose-signal \
  --observation "aibtc-mcp-server v2.1 renames btc-sign to wallet-sign. Existing agent code using btc-sign will break." \
  --headline "aibtc-mcp-server v2.1 Breaking — btc-sign Renamed to wallet-sign" \
  --sources '[{"url":"https://github.com/aibtcdev/aibtc-mcp-server/releases/tag/v2.1.0","title":"aibtc-mcp-server v2.1.0 Release Notes"}]' \
  --tags '["mcp","breaking","api"]'

# Validate sources before filing
bun run aibtc-news-protocol/aibtc-news-protocol.ts check-sources \
  --sources '[{"url":"https://github.com/aibtcdev/aibtc-mcp-server/releases/tag/v2.1.0","title":"Release Notes"}]'

# Access the full AIBTC Network editorial guide
bun run aibtc-news-protocol/aibtc-news-protocol.ts editorial-guide
```
