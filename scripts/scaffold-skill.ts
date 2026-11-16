#!/usr/bin/env bun
/**
 * Scaffold a new skill directory with SKILL.md, AGENT.md, and a CLI entry file.
 *
 * Usage:
 *   bun run scaffold <skill-name>
 *   bun run scripts/scaffold-skill.ts <skill-name>
 *
 * Example:
 *   bun run scaffold my-skill
 *   → creates my-skill/SKILL.md, my-skill/AGENT.md, my-skill/my-skill.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function skillMd(name: string): string {
  const title = kebabToTitle(name);
  return `---
name: ${name}
description: TODO — one-line description of what ${title} does
metadata:
  author: TODO — your GitHub username
  author-agent: TODO — your agent name (or remove this line)
  user-invocable: "false"
  arguments: TODO — list subcommands separated by |
  entry: ${name}/${name}.ts
  requires: ""
  tags: ""
---

# ${title}

TODO — describe what this skill does and when an agent should use it.

> **Before committing:** Update the \`metadata.requires\` and \`metadata.tags\` fields in the
> frontmatter above. Common values — requires: \`"wallet"\`, \`"wallet, signing"\`;
> tags: \`"l2, write"\`, \`"l2, read-only"\`, \`"l1, requires-funds"\`.

## Usage

\`\`\`
bun run ${name}/${name}.ts <subcommand> [options]
\`\`\`

## Subcommands

### example

TODO — describe the subcommand.

\`\`\`
bun run ${name}/${name}.ts example --flag <value>
\`\`\`

Options:
- \`--flag\` (required) — TODO description

Output:
\`\`\`json
{
  "success": true,
  "message": "TODO"
}
\`\`\`
`;
}

function agentMd(name: string): string {
  const title = kebabToTitle(name);
  return `---
name: ${name}-agent
skill: ${name}
description: TODO — one-line description matching SKILL.md
---

# ${title} Agent

TODO — describe this agent's role and what it manages.

## Capabilities

- TODO — list what the agent can do

## When to Delegate Here

Delegate to this agent when the workflow needs to:
- TODO — list trigger conditions

## Key Constraints

- TODO — list safety and ordering constraints

## Example Invocations

\`\`\`bash
# TODO — add example commands
bun run ${name}/${name}.ts example --flag value
\`\`\`
`;
}

function entryTs(name: string): string {
  const title = kebabToTitle(name);
  return `#!/usr/bin/env bun
/**
 * ${title} skill CLI
 *
 * Usage: bun run ${name}/${name}.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";

const program = new Command();

program
  .name("${name}")
  .description("${title} — TODO add description")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// example subcommand — replace with real implementation
// ---------------------------------------------------------------------------

program
  .command("example")
  .description("TODO — describe what this subcommand does")
  .requiredOption("--flag <value>", "TODO — describe this option")
  .action(async (opts: { flag: string }) => {
    try {
      // TODO — implement subcommand logic
      printJson({
        success: true,
        message: \`${title} example ran with flag=\${opts.flag}\`,
      });
    } catch (error) {
      handleError(error);
    }
  });

program.parse();
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const name = process.argv[2];

if (!name) {
  console.error("Usage: bun run scripts/scaffold-skill.ts <skill-name>");
  console.error("Example: bun run scaffold my-skill");
  process.exit(1);
}

// Validate name: lowercase kebab-case only
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  console.error(
    `Error: skill name must be lowercase kebab-case (e.g. "my-skill"), got "${name}"`
  );
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, "..");
const skillDir = join(repoRoot, name);

if (existsSync(skillDir)) {
  console.error(`Error: directory "${name}/" already exists.`);
  process.exit(1);
}

mkdirSync(skillDir, { recursive: true });

writeFileSync(join(skillDir, "SKILL.md"), skillMd(name));
writeFileSync(join(skillDir, "AGENT.md"), agentMd(name));
writeFileSync(join(skillDir, `${name}.ts`), entryTs(name));

console.log(`\n  Scaffolded skill: ${name}/`);
console.log(`    ${name}/SKILL.md   — fill in frontmatter + docs`);
console.log(`    ${name}/AGENT.md   — fill in agent delegation rules`);
console.log(`    ${name}/${name}.ts — implement subcommands\n`);
console.log("  Next steps:");
console.log("    1. Replace all TODO markers in the generated files");
console.log("    2. Implement your subcommands in the .ts file");
console.log("    3. Add an entry to the Skills table in README.md");
console.log(`    4. Run: bun run manifest   (writes ${name}/package.json and skills.json)`);
console.log(`       then: bun run typecheck && bun run validate`);
console.log(`    5. Commit: feat(${name}): add ${name} skill\n`);
