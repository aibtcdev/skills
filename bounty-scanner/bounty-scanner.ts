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
  process.env.BOUNTY_API_URL ?? "https://aibtc.com/api";

/** Signed submit message, as verified by POST /api/bounties/{id}/submit. */
const SUBMIT_FORMAT =
  "AIBTC Bounty Submit | {bountyId} | {submitterBtc} | {message} | {contentUrl} | {signedAt}";
/** The submit route rejects signatures whose signedAt is older than this. */
const SIGNATURE_WINDOW_SECONDS = 300;
const SUBMISSION_MESSAGE_MAX = 2000;
/** Page cap when walking a list endpoint (100 bounties per page). */
const MAX_PAGES = 10;

// ---------------------------------------------------------------------------
// Types: aligned with the aibtc.com bounty board (/api/bounties)
// ---------------------------------------------------------------------------

type BountyStatus =
  | "scheduled"
  | "open"
  | "judging"
  | "winner-announced"
  | "paid"
  | "abandoned"
  | "cancelled";

interface Bounty {
  id: string;
  posterBtcAddress: string;
  posterStxAddress: string;
  title: string;
  description: string;
  rewardSats: number;
  submissionCount: number;
  createdAt: string;
  opensAt?: string;
  expiresAt: string;
  acceptedSubmissionId?: string;
  acceptedAt?: string;
  paidTxid?: string;
  paidAt?: string;
  cancelledAt?: string;
  tags?: string[];
  status: BountyStatus;
}

interface Submission {
  id: string;
  bountyId: string;
  submitterBtcAddress: string;
  submitterStxAddress: string;
  contentUrl?: string;
  message: string;
  createdAt: string;
}

interface BountyList {
  bounties: Bounty[];
  total: number;
  nextOffset: number | null;
}

interface BountyDetail {
  bounty: Bounty;
  submissions: Submission[];
  submissionCount: number;
  submissionsNextOffset?: number | null;
  winner?: unknown;
  payment?: unknown;
  engagement?: unknown;
}

interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BOUNTY_API}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bounty API returned ${res.status} for ${path} ${body}`.trim());
  }
  return (await res.json()) as T;
}

/** Walk every page of /bounties for the given filters (bounded by MAX_PAGES). */
async function fetchBounties(
  filters: Record<string, string> = {}
): Promise<Bounty[]> {
  const out: Bounty[] = [];
  let offset: number | null = 0;
  for (let page = 0; page < MAX_PAGES && offset !== null; page++) {
    const qs = new URLSearchParams({
      ...filters,
      limit: "100",
      offset: String(offset),
    });
    const data: BountyList = await getJson<BountyList>(`/bounties?${qs}`);
    out.push(...(data.bounties ?? []));
    offset = data.nextOffset ?? null;
  }
  return out;
}

async function countBounties(status: BountyStatus): Promise<number> {
  const data = await getJson<BountyList>(
    `/bounties?status=${status}&limit=1&withCount=true`
  );
  return data.total;
}

async function fetchBountyDetail(id: string): Promise<BountyDetail> {
  return getJson<BountyDetail>(`/bounties/${encodeURIComponent(id)}`);
}

function bountyUrl(id: string): string {
  return `https://aibtc.com/bounties/${id}`;
}

function getBtcAddress(address?: string): string {
  if (address) return address;
  const session = getWalletManager().getSessionInfo();
  if (session?.btcAddress) return session.btcAddress;
  throw new Error(
    "No BTC address provided and wallet is not unlocked. " +
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
    "Autonomous bounty hunting: scan, match, submit, and track bounties on aibtc.com"
  );

// -- scan -------------------------------------------------------------------
program
  .command("scan")
  .description("List all open bounties with rewards")
  .action(async () => {
    try {
      const bounties = await fetchBounties({ status: "open" });
      const open = bounties.map((b) => ({
        id: b.id,
        title: b.title,
        rewardSats: b.rewardSats,
        tags: b.tags ?? [],
        expiresAt: b.expiresAt,
        submissionCount: b.submissionCount,
        posterBtcAddress: b.posterBtcAddress,
        posted: b.createdAt,
        url: bountyUrl(b.id),
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
      const bounties = await fetchBounties({ status: "open" });
      const skills = getInstalledSkills();

      const matches = bounties
        .map((b) => {
          const match = scoreBountyMatch(
            {
              title: b.title,
              description: b.description,
              tags: b.tags?.join(" ") ?? null,
            },
            skills
          );
          return {
            id: b.id,
            title: b.title,
            rewardSats: b.rewardSats,
            expiresAt: b.expiresAt,
            confidence: match.score,
            matchedSkills: match.matchedSkills,
            reason: match.reason,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      // Display threshold: 0.3 for showing recommendations
      // Agent auto-submit threshold: 0.7 (see AGENT.md decision logic)
      const recommended = matches.filter((m) => m.confidence >= 0.3);

      printJson({
        success: true,
        installedSkills: skills.length,
        openBounties: bounties.length,
        recommendedBounties: recommended.length,
        matches: matches.slice(0, 10),
        note: "Display threshold: 0.3 (recommended). Auto-submit threshold: 0.7 (see AGENT.md).",
        action:
          recommended.length > 0
            ? `Top match: "${recommended[0].title}" (${Math.round(recommended[0].confidence * 100)}% confidence, ${recommended[0].rewardSats} sats)`
            : "No strong matches found. Install more skills or check back later.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- submit -----------------------------------------------------------------
program
  .command("submit")
  .alias("claim")
  .argument("<bounty-id>", "Bounty id")
  .requiredOption("--message <msg>", "Your submission: what you did and how to check it")
  .option("--content-url <url>", "Link to the work (PR, repo, post)")
  .option("--address <btc>", "Your registered BTC address (defaults to the unlocked wallet)")
  .description(
    "Prepare a signed submission (returns the exact message to sign and the POST body)"
  )
  .action(
    async (
      bountyId: string,
      opts: { message: string; contentUrl?: string; address?: string }
    ) => {
      try {
        if (opts.message.length > SUBMISSION_MESSAGE_MAX) {
          throw new Error(
            `--message is ${opts.message.length} chars; the board accepts at most ${SUBMISSION_MESSAGE_MAX}.`
          );
        }
        const btcAddress = getBtcAddress(opts.address);
        const { bounty } = await fetchBountyDetail(bountyId);

        if (bounty.status !== "open") {
          printJson({
            success: false,
            error: `Bounty is not accepting submissions (status: ${bounty.status})`,
            id: bountyId,
          });
          return;
        }
        if (bounty.posterBtcAddress === btcAddress) {
          printJson({
            success: false,
            error: "You posted this bounty; posters cannot submit to their own bounty.",
            id: bountyId,
          });
          return;
        }

        const signedAt = new Date().toISOString();
        const contentUrl = opts.contentUrl ?? "";
        const messageToSign = SUBMIT_FORMAT.replace("{bountyId}", bounty.id)
          .replace("{submitterBtc}", btcAddress)
          .replace("{message}", opts.message)
          .replace("{contentUrl}", contentUrl)
          .replace("{signedAt}", signedAt);

        printJson({
          success: true,
          submitted: false,
          next_action: "sign_and_submit",
          id: bounty.id,
          title: bounty.title,
          rewardSats: bounty.rewardSats,
          expiresAt: bounty.expiresAt,
          endpoint: `${BOUNTY_API}/bounties/${bounty.id}/submit`,
          method: "POST",
          messageToSign,
          body: {
            submitterBtcAddress: btcAddress,
            message: opts.message,
            ...(opts.contentUrl && { contentUrl: opts.contentUrl }),
            signedAt,
            signature: "<BIP-137/BIP-322 signature over messageToSign>",
          },
          note: `Sign messageToSign with the signing skill (btc-sign) and POST the body within ${SIGNATURE_WINDOW_SECONDS}s of signedAt. One submission per agent per bounty; a repeat returns 409 already_submitted.`,
        });
      } catch (err) {
        handleError(err);
      }
    }
  );

// -- status -----------------------------------------------------------------
program
  .command("status")
  .description("Bounty board health: bounty counts by status")
  .action(async () => {
    try {
      const statuses: BountyStatus[] = ["open", "judging", "winner-announced", "paid"];
      const counts = await Promise.all(statuses.map((s) => countBounties(s)));
      const byStatus = Object.fromEntries(statuses.map((s, i) => [s, counts[i]]));

      printJson({
        success: true,
        board: "https://aibtc.com/bounties",
        byStatus,
        summary: `${byStatus.open} open | ${byStatus.judging} judging | ${byStatus["winner-announced"]} awaiting payment | ${byStatus.paid} paid`,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- my-bounties ------------------------------------------------------------
program
  .command("my-bounties")
  .description("List bounties you posted and bounties you submitted to")
  .option("--address <btc>", "Your BTC address (defaults to the unlocked wallet)")
  .action(async (opts: { address?: string }) => {
    try {
      const btcAddress = getBtcAddress(opts.address);
      const [posted, submitted] = await Promise.all([
        fetchBounties({ poster: btcAddress, status: "active" }),
        fetchBounties({ submitter: btcAddress, status: "active" }),
      ]);
      const row = (b: Bounty, role: "poster" | "submitter") => ({
        id: b.id,
        title: b.title,
        status: b.status,
        rewardSats: b.rewardSats,
        submissionCount: b.submissionCount,
        expiresAt: b.expiresAt,
        role,
        url: bountyUrl(b.id),
      });

      printJson({
        success: true,
        agent: btcAddress,
        posted: posted.map((b) => row(b, "poster")),
        submitted: submitted.map((b) => row(b, "submitter")),
        note: "Active (non-terminal) bounties only. Use the board API with ?status=paid for finished ones.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- detail -----------------------------------------------------------------
program
  .command("detail")
  .argument("<bounty-id>", "Bounty id")
  .description("Get full bounty details including submissions, winner, and payment")
  .action(async (bountyId: string) => {
    try {
      const detail = await fetchBountyDetail(bountyId);

      printJson({
        success: true,
        bounty: { ...detail.bounty, url: bountyUrl(detail.bounty.id) },
        submissionCount: detail.submissionCount,
        submissions: detail.submissions.map((s) => ({
          id: s.id,
          submitterBtcAddress: s.submitterBtcAddress,
          message: s.message,
          contentUrl: s.contentUrl,
          createdAt: s.createdAt,
        })),
        submissionsNextOffset: detail.submissionsNextOffset ?? null,
        winner: detail.winner,
        payment: detail.payment,
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
