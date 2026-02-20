/**
 * Zod schemas for SKILL.md and AGENT.md frontmatter validation.
 *
 * Used by:
 *   - generate-skills-json.ts to validate parsed frontmatter
 *   - CI to catch malformed skills before merge
 */

import { z } from "zod";

// --- SKILL.md frontmatter ---

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).describe("Skill identifier (directory name)"),
  description: z.string().min(1).describe("One-line description"),
  "user-invocable": z.boolean().describe("Whether users can invoke directly"),
  arguments: z.string().min(1).describe("Pipe-separated subcommands"),
  category: z
    .enum([
      "wallet-keys",
      "bitcoin-l1",
      "stacks-l2",
      "assets",
      "defi",
      "identity",
      "payments",
      "smart-wallets",
    ])
    .describe("Skill category for grouping"),
  requires: z
    .array(z.string())
    .default([])
    .describe("Skills that must be available (e.g. wallet unlock)"),
  tags: z
    .array(
      z.enum([
        "read-only",
        "mainnet-only",
        "requires-funds",
        "requires-wallet",
        "has-write-ops",
        "has-read-ops",
      ])
    )
    .default([])
    .describe("Capability tags for filtering"),
  "entry-point": z
    .string()
    .min(1)
    .describe("CLI entry point relative to skill directory"),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

// --- AGENT.md frontmatter ---

export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1).describe("Agent identifier"),
  skill: z.string().min(1).describe("Associated skill name"),
  description: z.string().min(1).describe("Agent capability summary"),
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

// --- skills.json manifest ---

export const SkillManifestEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  category: SkillFrontmatterSchema.shape.category,
  "user-invocable": z.boolean(),
  "entry-point": z.string(),
  arguments: z.array(z.string()).describe("Parsed subcommand list"),
  requires: z.array(z.string()),
  tags: z.array(z.string()),
  agent: z
    .object({
      name: z.string(),
      description: z.string(),
    })
    .optional()
    .describe("From colocated AGENT.md if present"),
});

export type SkillManifestEntry = z.infer<typeof SkillManifestEntrySchema>;

export const SkillsManifestSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().describe("Manifest schema version"),
  generated: z.string().describe("ISO 8601 generation timestamp"),
  skills: z.array(SkillManifestEntrySchema),
});

export type SkillsManifest = z.infer<typeof SkillsManifestSchema>;
