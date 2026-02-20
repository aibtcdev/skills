import { Glob } from "bun";
import { join, dirname } from "node:path";
import { z } from "zod";

// Resolve repo root from the scripts/ directory
const scriptsDir = dirname(import.meta.path);
const repoRoot = dirname(scriptsDir);

// Controlled vocabulary for SKILL.md tags
const VALID_TAGS = [
  "read-only",
  "write",
  "mainnet-only",
  "requires-funds",
  "sensitive",
  "infrastructure",
  "defi",
  "l1",
  "l2",
] as const;

// Zod schema for SKILL.md frontmatter (raw string values as parsed from YAML)
const SkillFrontmatterSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().min(1, "description is required"),
  "user-invocable": z
    .string()
    .regex(/^(true|false)$/, 'user-invocable must be "true" or "false"'),
  arguments: z.string().min(1, "arguments is required"),
  entry: z.string().min(1, "entry is required"),
  requires: z
    .string()
    .regex(/^\[.*\]$/, 'requires must be a bracket-list like [] or [wallet]'),
  tags: z
    .string()
    .regex(/^\[.*\]$/, "tags must be a bracket-list like [l2, read-only]"),
});

// Zod schema for AGENT.md frontmatter (raw string values as parsed from YAML)
const AgentFrontmatterSchema = z.object({
  name: z.string().min(1, "name is required"),
  skill: z.string().min(1, "skill is required"),
  description: z.string().min(1, "description is required"),
});

// Parse a bracket-list value like "[]" or "[wallet]" or "[l2, defi, write]"
function parseBracketList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Extract raw frontmatter fields from file content
function extractFrontmatter(content: string): Record<string, string> {
  const lines = content.split("\n");
  let inFrontmatter = false;
  const frontmatterLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break;
      }
    }
    if (inFrontmatter) {
      frontmatterLines.push(line);
    }
  }

  const fields: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  return fields;
}

// Validation result for a single file
interface FileResult {
  file: string;
  passed: boolean;
  errors: string[];
}

const results: FileResult[] = [];

// Validate all SKILL.md files
const skillGlob = new Glob("*/SKILL.md");
for await (const file of skillGlob.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();
  const fields = extractFrontmatter(content);
  const errors: string[] = [];

  const parsed = SkillFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "unknown";
      errors.push(`${field}: ${issue.message}`);
    }
  }

  // If schema passed, additionally validate tag values against controlled vocabulary
  if (parsed.success) {
    const rawTags = fields["tags"] ?? "[]";
    const tagList = parseBracketList(rawTags);
    const invalidTags = tagList.filter(
      (tag) => !(VALID_TAGS as readonly string[]).includes(tag)
    );
    if (invalidTags.length > 0) {
      errors.push(
        `tags: invalid values [${invalidTags.join(", ")}] — allowed: ${VALID_TAGS.join(", ")}`
      );
    }
  }

  results.push({ file, passed: errors.length === 0, errors });
}

// Validate all AGENT.md files
const agentGlob = new Glob("*/AGENT.md");
for await (const file of agentGlob.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();
  const fields = extractFrontmatter(content);
  const errors: string[] = [];

  const parsed = AgentFrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "unknown";
      errors.push(`${field}: ${issue.message}`);
    }
  }

  results.push({ file, passed: errors.length === 0, errors });
}

// Sort results by file path for consistent output
results.sort((a, b) => a.file.localeCompare(b.file));

// Print results
const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

for (const result of results) {
  if (result.passed) {
    console.log(`PASS  ${result.file}`);
  } else {
    console.log(`FAIL  ${result.file}`);
    for (const err of result.errors) {
      console.log(`        - ${err}`);
    }
  }
}

console.log("");
console.log(
  `Results: ${passed.length} passed, ${failed.length} failed, ${results.length} total`
);

if (failed.length > 0) {
  process.exit(1);
}
