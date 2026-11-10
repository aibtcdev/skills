import { Glob } from "bun";
import { join, dirname } from "node:path";
import * as yaml from "yaml";
import { expectedSkillPackage, formatSkillPackage } from "./lib/skill-packages.js";

// Types for the manifest output
interface SkillEntry {
  name: string;
  description: string;
  author?: string | string[];
  authorAgent?: string | string[];
  entry: string | string[];
  arguments: string[];
  requires: string[];
  tags: string[];
  userInvocable: boolean;
  /**
   * True when the skill's folder runs on its own after `npx skills add`
   * (plus `install`, when set). Every skill qualifies since #473; kept for
   * consumers that read it (aibtc.com/skills).
   */
  standalone: boolean;
  /**
   * Command to run inside the installed skill folder before first use, when
   * the skill has dependencies (its generated package.json). Absent for
   * doc-only skills.
   */
  install?: string;
  mcpTools?: string[];
  deprecated?: string;
}

interface Manifest {
  version: string;
  generated: string;
  skills: SkillEntry[];
}

// Resolve repo root from the scripts/ directory
const scriptsDir = dirname(import.meta.path);
const repoRoot = dirname(scriptsDir);

// Read version from package.json
const packageJsonPath = join(repoRoot, "package.json");
const packageJson = await Bun.file(packageJsonPath).json();
const version: string = packageJson.version;

// Parse a comma-separated string value like "" or "wallet" or "l2, defi, write"
function parseCommaList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse YAML frontmatter from SKILL.md content (agentskills.io spec format)
function parseFrontmatter(content: string, skillName: string): SkillEntry {
  // Extract the block between the first and second "---" delimiters
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    throw new Error(`No YAML frontmatter found in ${skillName}/SKILL.md`);
  }

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = yaml.parse(fmMatch[1]) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`YAML parse error in ${skillName}/SKILL.md: ${err}`);
  }

  const meta = (frontmatter.metadata ?? {}) as Record<string, string>;

  // Parse arguments: pipe-delimited string
  const rawArgs = meta["arguments"] ?? "";
  const parsedArgs =
    rawArgs.trim().length > 0
      ? rawArgs
          .split("|")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  // Parse requires and tags as comma-separated lists
  const parsedRequires = parseCommaList(meta["requires"] ?? "");
  const parsedTags = parseCommaList(meta["tags"] ?? "");

  // Parse userInvocable (string "true"/"false" in new format)
  const userInvocable = (meta["user-invocable"] ?? "false").trim() === "true";

  // Parse entry: comma-separated string for multi-entry skills, plain string otherwise
  const rawEntry = meta["entry"]?.trim() ?? "";
  const entryList = parseCommaList(rawEntry);
  const entry = entryList.length > 1 ? entryList : rawEntry;

  // Parse optional author fields (comma-separated for multi-author)
  const rawAuthor = meta["author"]?.trim();
  const rawAuthorAgent = (meta["author-agent"] ?? meta["author_agent"])?.trim();

  const authorList = rawAuthor ? parseCommaList(rawAuthor) : [];
  const author: string | string[] | undefined =
    authorList.length > 1
      ? authorList
      : authorList.length === 1
        ? authorList[0]
        : undefined;

  const agentList = rawAuthorAgent ? parseCommaList(rawAuthorAgent) : [];
  const authorAgent: string | string[] | undefined =
    agentList.length > 1
      ? agentList
      : agentList.length === 1
        ? agentList[0]
        : undefined;

  const skill: SkillEntry = {
    name: (frontmatter["name"] as string)?.trim() ?? skillName,
    description: (frontmatter["description"] as string)?.trim() ?? "",
    entry,
    arguments: parsedArgs,
    requires: parsedRequires,
    tags: parsedTags,
    userInvocable,
    standalone: true,
  };

  if (author) skill.author = author;
  if (authorAgent) skill.authorAgent = authorAgent;

  // Parse optional mcp-tools field (comma-separated list of MCP tool names)
  const rawMcpTools = meta["mcp-tools"]?.trim();
  if (rawMcpTools) {
    skill.mcpTools = parseCommaList(rawMcpTools);
  }

  // Parse optional deprecated field (why the skill no longer works, and what replaces it)
  const rawDeprecated = meta["deprecated"]?.trim();
  if (rawDeprecated) {
    skill.deprecated = rawDeprecated;
  }

  return skill;
}

// Glob all SKILL.md files from repo root
const glob = new Glob("*/SKILL.md");
const skills: SkillEntry[] = [];
const packageErrors: string[] = [];

for await (const file of glob.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();

  // Derive skill name from directory (first path segment)
  const skillName = file.split("/")[0];

  const skill = parseFrontmatter(content, skillName);

  // Write the skill's own package.json so its folder installs on its own (#473).
  const pkg = await expectedSkillPackage(repoRoot, skillName, packageJson.dependencies ?? {});
  if (pkg.errors.length > 0) {
    skill.standalone = false;
    packageErrors.push(...pkg.errors.map((e) => `${skillName}: ${e}`));
  }
  if (pkg.json) {
    await Bun.write(join(repoRoot, skillName, "package.json"), formatSkillPackage(pkg.json));
    skill.install = "bun install";
  }
  skills.push(skill);
}

// Sort alphabetically by name
skills.sort((a, b) => a.name.localeCompare(b.name));

// Build manifest
const manifest: Manifest = {
  version,
  generated: new Date().toISOString(),
  skills,
};

// Write to repo root
const outputPath = join(repoRoot, "skills.json");
await Bun.write(outputPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`Generated skills.json with ${skills.length} skills.`);
if (packageErrors.length > 0) {
  // `bun run validate` reports these too; surface them here so a stale import is caught early.
  console.error(`Skills whose folder cannot run on its own:\n  - ${packageErrors.join("\n  - ")}`);
  process.exit(1);
}
