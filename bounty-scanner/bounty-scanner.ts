#!/usr/bin/env bun
/**
 * Bounty Scanner skill CLI
 * Autonomous bounty hunting — scan, match, claim, and track bounties
 *
 * Usage: bun run bounty-scanner/bounty-scanner.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";
import { getWalletManager } from "@aibtc/skills/src/lib/services/wallet-manager.js";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const BOUNTY_API =
  process.env.BOUNTY_API_URL ?? "https://bounty.drx4.xyz/api";

// ---------------------------------------------------------------------------
// Types — aligned with bounty.drx4.xyz API
// ---------------------------------------------------------------------------

interface Bounty {
  id: number;
  uuid: string;
  creator_stx: string;
  creator_name: string;
  title: string;
  description: string;
  amount_sats: number;
  tags: string | null;
  status: string;
  deadline: string | null;
  claim_count: number;
  created_at: string;
  updated_at: string;
}

interface BountyDetail {
  bounty: Bounty;
  claims: Claim[];
  submissions: Submission[];
  payments: Payment[];
  actions: Record<string, ActionInfo>;
}

interface Claim {
  id: number;
  bounty_id: number;
  claimer_btc: string;
  claimer_stx: string | null;
  claimer_name: string | null;
  message: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Submission {
  id: number;
  claim_id: number;
  bounty_id: number;
  description: string;
  proof_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Payment {
  id: number;
  bounty_id: number;
  submission_id: number;
  amount_sats: number;
  txid: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ActionInfo {
  method: string;
  endpoint: string;
  description: string;
  required_fields: Record<string, string>;
  optional_fields?: Record<string, string>;
  signing_format: string;
  note: string;
}

interface BountyStats {
  total_bounties: number;
  open_bounties: number;
  completed_bounties: number;
  cancelled_bounties: number;
  total_agents: number;
  total_paid_sats: number;
  total_claims: number;
  total_submissions: number;
}

interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchBounties(
  status: string = "all",
  limit: number = 100
): Promise<Bounty[]> {
  const res = await fetch(
    `${BOUNTY_API}/bounties?status=${status}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  const data = (await res.json()) as { bounties?: Bounty[] };
  return data.bounties ?? [];
}

async function fetchBountyDetail(uuid: string): Promise<BountyDetail> {
  const res = await fetch(`${BOUNTY_API}/bounties/${uuid}`);
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  return (await res.json()) as BountyDetail;
}

async function fetchStats(): Promise<BountyStats> {
  const res = await fetch(`${BOUNTY_API}/stats`);
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  const data = (await res.json()) as { stats: BountyStats };
  return data.stats;
}

function getStxAddress(address?: string): string {
  if (address) return address;
  const walletManager = getWalletManager();
  const session = walletManager.getSessionInfo();
  if (session?.stxAddress) return session.stxAddress;
  throw new Error(
    "No STX address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

/**
 * Parse a bracket-list value like "[]" or "[wallet]" or "[l2, defi, write]".
 * Matches the logic in scripts/generate-manifest.ts.
 */
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

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Matches the parsing logic in scripts/generate-manifest.ts.
 */
function parseFrontmatter(content: string): SkillInfo | null {
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
  let inMetadata = false;
  for (const line of frontmatterLines) {
    // Detect nested `metadata:` block (agentskills.io spec format)
    if (line.trim() === "metadata:") {
      inMetadata = true;
      continue;
    }
    // Exit metadata block on next top-level key (no leading whitespace)
    if (inMetadata && line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
      inMetadata = false;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Store with metadata. prefix when inside metadata block, plain otherwise
    if (inMetadata) {
      fields[`metadata.${key}`] = value;
    } else {
      fields[key] = value;
    }
  }

  if (!fields.name) return null;

  // Support both flat (legacy) and nested (agentskills.io) tag formats
  const rawTags = fields["metadata.tags"] ?? fields.tags ?? "";

  return {
    name: fields.name,
    description: fields.description ?? fields["metadata.description"] ?? "",
    tags: parseBracketList(rawTags),
  };
}

/**
 * Load installed skill names and descriptions.
 * First tries skills.json manifest, then falls back to scanning SKILL.md files.
 */
function getInstalledSkills(): SkillInfo[] {
  const repoRoot = join(import.meta.dir, "..");

  // Try skills.json first (faster)
  const manifestPath = join(repoRoot, "skills.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const skills: SkillInfo[] = [];
      for (const skill of manifest.skills ?? []) {
        skills.push({
          name: skill.name ?? "",
          description: skill.description ?? "",
          tags: skill.tags ?? [],
        });
      }
      if (skills.length > 0) return skills;
    } catch {
      // fall through to directory scan
    }
  }

  // Directory scan fallback: find all */SKILL.md files
  const skills: SkillInfo[] = [];
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip non-skill directories
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "src" ||
        entry.name === "scripts" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const skillMdPath = join(repoRoot, entry.name, "SKILL.md");
      if (existsSync(skillMdPath)) {
        try {
          const content = readFileSync(skillMdPath, "utf-8");
          const info = parseFrontmatter(content);
          if (info) skills.push(info);
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // repo root unreadable — return empty
  }

  return skills;
}

/**
 * Score how well a bounty matches the agent's installed skills.
 * Returns 0-1 confidence score.
 */
function scoreBountyMatch(
  bounty: { title: string; description: string; tags: string | null },
  skills: SkillInfo[]
): { score: number; matchedSkills: string[]; reason: string } {
  const bountyText =
    `${bounty.title} ${bounty.description} ${bounty.tags ?? ""}`.toLowerCase();
  const matchedSkills: string[] = [];
  let score = 0;

  // Keyword matching against skill names and descriptions
  for (const skill of skills) {
    const skillWords =
      `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    const skillTokens = skillWords
      .split(/[\s\-_,./]+/)
      .filter((t) => t.length > 2);

    let hits = 0;
    for (const token of skillTokens) {
      if (bountyText.includes(token)) hits++;
    }

    if (hits >= 2) {
      matchedSkills.push(skill.name);
      score += Math.min(hits * 0.15, 0.5);
    }
  }

  // Bonus for wallet/signing only when bounty mentions payment or signing
  const mentionsPayment =
    /pay|transfer|send|sats|btc|stx|sbtc|escrow|fund/i.test(bountyText);
  const mentionsSigning = /sign|signature|verify|auth/i.test(bountyText);
  if (mentionsPayment && skills.some((s) => s.name === "wallet")) score += 0.1;
  if (mentionsSigning && skills.some((s) => s.name === "signing")) score += 0.1;

  // Cap at 1.0
  score = Math.min(score, 1.0);

  const reason =
    matchedSkills.length > 0
      ? `Matches skills: ${matchedSkills.join(", ")}`
      : "No direct skill match — may require new capabilities";

  return { score: Math.round(score * 100) / 100, matchedSkills, reason };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name("bounty-scanner")
  .description(
    "Autonomous bounty hunting — scan, match, claim, and track bounties"
  );

// -- scan -------------------------------------------------------------------
program
  .command("scan")
  .description("List all open bounties with rewards")
  .action(async () => {
    try {
      const bounties = await fetchBounties("open");
      const open = bounties.map((b) => ({
        uuid: b.uuid,
        title: b.title,
        amount_sats: b.amount_sats,
        tags: b.tags,
        deadline: b.deadline,
        claim_count: b.claim_count,
        creator_name: b.creator_name,
        posted: b.created_at,
      }));

      printJson({
        success: true,
        openBounties: open.length,
        bounties: open,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- match ------------------------------------------------------------------
program
  .command("match")
  .description("Match open bounties to your installed skills")
  .action(async () => {
    try {
      const bounties = await fetchBounties("open");
      const skills = getInstalledSkills();

      const matches = bounties
        .map((b) => {
          const match = scoreBountyMatch(
            { title: b.title, description: b.description, tags: b.tags },
            skills
          );
          return {
            uuid: b.uuid,
            title: b.title,
            amount_sats: b.amount_sats,
            deadline: b.deadline,
            confidence: match.score,
            matchedSkills: match.matchedSkills,
            reason: match.reason,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      // Display threshold: 0.3 for showing recommendations
      // Agent auto-claim threshold: 0.7 (see AGENT.md decision logic)
      const recommended = matches.filter((m) => m.confidence >= 0.3);

      printJson({
        success: true,
        installedSkills: skills.length,
        openBounties: bounties.length,
        recommendedBounties: recommended.length,
        matches: matches.slice(0, 10),
        note: "Display threshold: 0.3 (recommended). Auto-claim threshold: 0.7 (see AGENT.md).",
        action:
          recommended.length > 0
            ? `Top match: "${recommended[0].title}" (${recommended[0].confidence * 100}% confidence, ${recommended[0].amount_sats} sats)`
            : "No strong matches found. Install more skills or check back later.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- claim ------------------------------------------------------------------
program
  .command("claim")
  .argument("<bounty-uuid>", "Bounty UUID to claim")
  .option("--message <msg>", "Claim message describing your approach")
  .description(
    "Claim a bounty for your agent (requires BTC signing via signing skill)"
  )
  .action(async (bountyUuid: string, opts: { message?: string }) => {
    try {
      // Fetch bounty detail to get the signing format from actions
      const detail = await fetchBountyDetail(bountyUuid);

      if (detail.bounty.status !== "open") {
        printJson({
          success: false,
          error: `Bounty is not open (status: ${detail.bounty.status})`,
          uuid: bountyUuid,
        });
        return;
      }

      // The API requires BIP-322/BIP-137 BTC signatures.
      // Extract the signing format from the bounty's actions response.
      const claimAction = detail.actions?.claim;
      if (!claimAction) {
        printJson({
          success: false,
          error:
            "No claim action available for this bounty. It may already be fully claimed.",
          uuid: bountyUuid,
        });
        return;
      }

      printJson({
        success: true,
        claimed: false,
        next_action: "sign_and_submit",
        uuid: bountyUuid,
        title: detail.bounty.title,
        amount_sats: detail.bounty.amount_sats,
        endpoint: claimAction.endpoint,
        method: claimAction.method,
        signing_format: claimAction.signing_format,
        required_fields: claimAction.required_fields,
        optional_fields: claimAction.optional_fields,
        note: "Use the signing skill to create a BIP-322 or BIP-137 signature with the signing_format above, then POST to the endpoint with the required fields.",
        message: opts.message,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- status -----------------------------------------------------------------
program
  .command("status")
  .description("Bounty board health — stats from the API")
  .action(async () => {
    try {
      const stats = await fetchStats();

      printJson({
        success: true,
        ...stats,
        summary: `${stats.open_bounties} open bounties | ${stats.total_agents} agents | ${stats.total_paid_sats.toLocaleString()} sats paid out`,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- my-bounties ------------------------------------------------------------
program
  .command("my-bounties")
  .description("List bounties you have created")
  .option("--address <stx>", "Your STX address")
  .action(async (opts: { address?: string }) => {
    try {
      const stxAddress = getStxAddress(opts.address);
      const bounties = await fetchBounties();

      // Filter bounties where the user is the creator
      const created = bounties.filter((b) => b.creator_stx === stxAddress);

      // For claims, we need to check each bounty's detail — but that's expensive.
      // Instead, list created bounties and note that claim lookup requires detail fetches.
      printJson({
        success: true,
        agent: stxAddress,
        created: created.length,
        bounties: created.map((b) => ({
          uuid: b.uuid,
          title: b.title,
          status: b.status,
          amount_sats: b.amount_sats,
          claim_count: b.claim_count,
          role: "creator",
        })),
        note: "Shows bounties where you are the creator. Claim history requires checking individual bounty details.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- detail -----------------------------------------------------------------
program
  .command("detail")
  .argument("<bounty-uuid>", "Bounty UUID")
  .description("Get full bounty details including claims, submissions, and available actions")
  .action(async (bountyUuid: string) => {
    try {
      const detail = await fetchBountyDetail(bountyUuid);

      printJson({
        success: true,
        bounty: {
          uuid: detail.bounty.uuid,
          title: detail.bounty.title,
          description: detail.bounty.description,
          amount_sats: detail.bounty.amount_sats,
          status: detail.bounty.status,
          tags: detail.bounty.tags,
          deadline: detail.bounty.deadline,
          creator_name: detail.bounty.creator_name,
          creator_stx: detail.bounty.creator_stx,
          claim_count: detail.bounty.claim_count,
          created_at: detail.bounty.created_at,
        },
        claims: detail.claims.map((c) => ({
          claimer_btc: c.claimer_btc,
          claimer_stx: c.claimer_stx,
          claimer_name: c.claimer_name,
          message: c.message,
          status: c.status,
          created_at: c.created_at,
        })),
        submissions: detail.submissions.map((s) => ({
          description: s.description,
          proof_url: s.proof_url,
          status: s.status,
          created_at: s.created_at,
        })),
        payments: detail.payments.map((p) => ({
          amount_sats: p.amount_sats,
          txid: p.txid,
          status: p.status,
          created_at: p.created_at,
        })),
        actions: Object.keys(detail.actions ?? {}),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
