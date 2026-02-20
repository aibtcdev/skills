#!/usr/bin/env bun
/**
 * Generate skills.json manifest from SKILL.md and AGENT.md frontmatter.
 *
 * Scans all skill directories, parses YAML frontmatter, validates against
 * the Zod schema, and writes a machine-readable skills.json to the repo root.
 *
 * Usage:
 *   bun run scripts/generate-skills-json.ts
 *   bun run scripts/generate-skills-json.ts --check   # validate only, exit 1 if out of date
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SkillFrontmatterSchema,
  AgentFrontmatterSchema,
  type SkillsManifest,
  type SkillManifestEntry,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Directories that are not skills
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "src",
  "scripts",
  ".git",
  ".github",
  "what-to-do",
  "aibtc-agents",
]);

/** Parse YAML frontmatter from a markdown file (between --- delimiters). */
function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: unknown = trimmed.slice(colonIdx + 1).trim();

    // Parse arrays: [item1, item2] or [item1]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      value = inner ? inner.split(",").map((s) => s.trim()) : [];
    }
    // Parse booleans
    else if (value === "true") value = true;
    else if (value === "false") value = false;

    result[key] = value;
  }

  return result;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const checkMode = process.argv.includes("--check");
  const entries = await readdir(ROOT);
  const skills: SkillManifestEntry[] = [];
  const errors: string[] = [];

  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    const dirPath = join(ROOT, entry);
    if (!(await isDirectory(dirPath))) continue;

    const skillMdPath = join(dirPath, "SKILL.md");
    if (!(await fileExists(skillMdPath))) continue;

    // Parse SKILL.md
    const skillContent = await readFile(skillMdPath, "utf-8");
    const raw = parseFrontmatter(skillContent);

    const parsed = SkillFrontmatterSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      errors.push(`${entry}/SKILL.md frontmatter validation failed:\n${issues}`);
      continue;
    }

    const fm = parsed.data;

    // Parse AGENT.md if present
    let agent: { name: string; description: string } | undefined;
    const agentMdPath = join(dirPath, "AGENT.md");
    if (await fileExists(agentMdPath)) {
      const agentContent = await readFile(agentMdPath, "utf-8");
      const agentRaw = parseFrontmatter(agentContent);
      const agentParsed = AgentFrontmatterSchema.safeParse(agentRaw);
      if (agentParsed.success) {
        agent = {
          name: agentParsed.data.name,
          description: agentParsed.data.description,
        };
      }
    }

    // Build manifest entry
    const args = fm.arguments
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);

    skills.push({
      name: fm.name,
      description: fm.description,
      category: fm.category,
      "user-invocable": fm["user-invocable"],
      "entry-point": fm["entry-point"],
      arguments: args,
      requires: fm.requires,
      tags: fm.tags,
      ...(agent && { agent }),
    });
  }

  if (errors.length > 0) {
    console.error("Validation errors:\n");
    for (const err of errors) {
      console.error(err);
      console.error();
    }
    process.exit(1);
  }

  const manifest: SkillsManifest = {
    $schema: "./scripts/skills-manifest-schema.json",
    version: "1.0.0",
    generated: new Date().toISOString(),
    skills,
  };

  const json = JSON.stringify(manifest, null, 2) + "\n";

  if (checkMode) {
    // Compare with existing skills.json
    const existingPath = join(ROOT, "skills.json");
    let existing = "";
    try {
      existing = await readFile(existingPath, "utf-8");
    } catch {
      console.error("skills.json does not exist. Run without --check to generate.");
      process.exit(1);
    }

    // Compare ignoring the generated timestamp
    const normalize = (s: string) =>
      JSON.parse(s, (key, val) => (key === "generated" ? "<timestamp>" : val));
    const existingNorm = JSON.stringify(normalize(existing));
    const newNorm = JSON.stringify(normalize(json));

    if (existingNorm !== newNorm) {
      console.error(
        "skills.json is out of date. Run `bun run scripts/generate-skills-json.ts` to regenerate."
      );
      process.exit(1);
    }

    console.log(`skills.json is up to date (${skills.length} skills).`);
    process.exit(0);
  }

  // Write manifest
  const outPath = join(ROOT, "skills.json");
  await writeFile(outPath, json);
  console.log(`Generated skills.json with ${skills.length} skills.`);

  // Summary table
  console.log("\nSkills by category:");
  const byCategory = new Map<string, string[]>();
  for (const s of skills) {
    const list = byCategory.get(s.category) ?? [];
    list.push(s.name);
    byCategory.set(s.category, list);
  }
  for (const [cat, names] of [...byCategory.entries()].sort()) {
    console.log(`  ${cat}: ${names.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
