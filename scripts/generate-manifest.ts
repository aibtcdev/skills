import { Glob } from "bun";
import { join, dirname } from "node:path";

// Types for the manifest output
interface SkillEntry {
  name: string;
  description: string;
  entry: string;
  arguments: string[];
  requires: string[];
  tags: string[];
  userInvocable: boolean;
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

// Parse a bracket-list value like "[]" or "[wallet]" or "[l2, defi, write]"
function parseBracketList(raw: string): string[] {
  const trimmed = raw.trim();
  // Strip surrounding brackets
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    // Fallback: treat as single value if non-empty
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse YAML frontmatter from SKILL.md content
function parseFrontmatter(content: string, skillName: string): SkillEntry {
  // Extract the block between the first and second "---" delimiters
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

  // Parse key-value pairs (simple single-line YAML values only)
  const fields: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fields[key] = value;
  }

  // Parse arguments: pipe-delimited string
  const rawArgs = fields["arguments"] ?? "";
  const parsedArgs =
    rawArgs.trim().length > 0
      ? rawArgs
          .split("|")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  // Parse requires and tags as bracket lists
  const parsedRequires = parseBracketList(fields["requires"] ?? "[]");
  const parsedTags = parseBracketList(fields["tags"] ?? "[]");

  // Parse userInvocable
  const userInvocable = (fields["user-invocable"] ?? "false").trim() !== "false";

  return {
    name: fields["name"]?.trim() ?? skillName,
    description: fields["description"]?.trim() ?? "",
    entry: fields["entry"]?.trim() ?? "",
    arguments: parsedArgs,
    requires: parsedRequires,
    tags: parsedTags,
    userInvocable,
  };
}

// Glob all SKILL.md files from repo root
const glob = new Glob("*/SKILL.md");
const skills: SkillEntry[] = [];

for await (const file of glob.scan({ cwd: repoRoot })) {
  const filePath = join(repoRoot, file);
  const content = await Bun.file(filePath).text();

  // Derive skill name from directory (first path segment)
  const skillName = file.split("/")[0];

  const skill = parseFrontmatter(content, skillName);
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
