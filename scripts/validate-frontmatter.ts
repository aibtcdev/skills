import { Glob } from "bun";
import { join, dirname } from "node:path";
import * as yaml from "yaml";
import { z } from "zod";

// Resolve repo root from the scripts/ directory
const scriptsDir = dirname(import.meta.path);
const repoRoot = dirname(scriptsDir);

// CLI flags
const skipSpec = process.argv.includes("--skip-spec");

// Find the agentskills binary: prefer local venv, fall back to PATH
// Note: skills-ref PyPI package >= 0.1.1 installs the CLI as `agentskills` (renamed from `skills-ref`)
async function findSkillsRef(): Promise<string | null> {
  const localBin = join(repoRoot, ".venv-skills-ref/bin/agentskills");
  try {
    const stat = await Bun.file(localBin).stat();
    if (stat.size > 0) return localBin;
  } catch {
    // not found locally
  }
  // Fall back to PATH (cross-platform)
  const pathResult = Bun.which("agentskills");
  if (pathResult) return "agentskills";
  return null;
}

// Run `skills-ref validate <skillDir>/` and return result
async function runSkillsRef(
  bin: string,
  skillDir: string
): Promise<{ passed: boolean; output: string }> {
  try {
    const proc = Bun.spawn([bin, "validate", skillDir + "/"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = (stdout + stderr).trim();
    return { passed: proc.exitCode === 0, output };
  } catch (err) {
    return { passed: false, output: String(err) };
  }
}

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

// Zod schema for SKILL.md frontmatter (agentskills.io spec format)
// name and description are top-level; all other fields are under metadata:
const SkillMetadataSchema = z.object({
  "user-invocable": z
    .string()
    .regex(/^false$/, 'user-invocable must be "false" — skills are invoked by Claude Code, not end users'),
  arguments: z.string().min(1, "arguments is required"),
  entry: z.string().min(1, "entry is required"),
  requires: z.string({
    required_error: "requires is required",
  }),
  tags: z.string().min(1, "tags is required"),
  "mcp-tools": z.string().optional(),
});

const SkillFrontmatterSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().min(1, "description is required"),
  metadata: SkillMetadataSchema,
});

// Zod schema for AGENT.md frontmatter (raw string values as parsed from YAML)
const AgentFrontmatterSchema = z.object({
  name: z.string().min(1, "name is required"),
  skill: z.string().min(1, "skill is required"),
  description: z.string().min(1, "description is required"),
});

// Parse a comma-separated string value like "" or "wallet" or "l2, defi, write"
function parseCommaList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Extract frontmatter from AGENT.md files using simple line parsing
// (AGENT.md files still use the old flat format)
function extractAgentFrontmatter(content: string): Record<string, string> {
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

// Locate skills-ref binary for tier-1 validation
let skillsRefBin: string | null = null;
if (!skipSpec) {
  skillsRefBin = await findSkillsRef();
  if (skillsRefBin === null) {
    process.stderr.write(
      "WARNING: agentskills not found. Skipping tier-1 spec validation. Install with: pip install skills-ref\n"
    );
  }
}

// Print active tiers
const tier1Active = !skipSpec && skillsRefBin !== null;
console.log(
  `Validation tiers: ${tier1Active ? "[tier-1: agentskills]" : "[tier-1: SKIPPED]"} [tier-2: Zod]`
);
console.log("");

// First pass: collect all skill names for referential integrity
const knownSkills = new Set<string>();
const skillGlob = new Glob("*/SKILL.md");
for await (const file of skillGlob.scan({ cwd: repoRoot })) {
  knownSkills.add(file.split("/")[0]);
}

// Second pass: validate all SKILL.md files
const skillGlob2 = new Glob("*/SKILL.md");
for await (const file of skillGlob2.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();
  const errors: string[] = [];
  const skillDir = file.split("/")[0];

  // Tier-1: skills-ref spec compliance
  if (tier1Active && skillsRefBin !== null) {
    const specResult = await runSkillsRef(skillsRefBin, skillDir);
    if (!specResult.passed) {
      errors.push(`[spec] ${specResult.output}`);
    }
  }

  // Parse YAML frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    errors.push("missing YAML frontmatter");
    results.push({ file, passed: false, errors });
    continue;
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = yaml.parse(fmMatch[1]) as Record<string, unknown>;
  } catch (err) {
    errors.push(`YAML parse error: ${err}`);
    results.push({ file, passed: false, errors });
    continue;
  }

  // Validate against schema
  const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "unknown";
      errors.push(`${field}: ${issue.message}`);
    }
  }

  // Additional validation if schema passed
  if (parsed.success) {
    const meta = parsed.data.metadata;

    // Validate tag values against controlled vocabulary
    const tagList = parseCommaList(meta.tags);
    const invalidTags = tagList.filter(
      (tag) => !(VALID_TAGS as readonly string[]).includes(tag)
    );
    if (invalidTags.length > 0) {
      errors.push(
        `metadata.tags: invalid values [${invalidTags.join(", ")}] — allowed: ${VALID_TAGS.join(", ")}`
      );
    }

    // Validate requires references exist as known skill directories
    const requiresList = parseCommaList(meta.requires);
    const unknownRequires = requiresList.filter((r) => !knownSkills.has(r));
    if (unknownRequires.length > 0) {
      errors.push(
        `metadata.requires: unknown skills [${unknownRequires.join(", ")}] — must reference existing skill directories`
      );
    }

    // Validate entry file(s) exist on disk
    const entryFiles = parseCommaList(meta.entry);
    for (const entryFile of entryFiles) {
      const entryPath = join(repoRoot, entryFile);
      try {
        await Bun.file(entryPath).stat();
      } catch {
        errors.push(
          `metadata.entry: file not found "${entryFile}"`
        );
      }
    }
  }

  results.push({ file, passed: errors.length === 0, errors });
}

// Validate all AGENT.md files
const agentGlob = new Glob("*/AGENT.md");
for await (const file of agentGlob.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();
  const fields = extractAgentFrontmatter(content);
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
