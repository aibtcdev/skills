#!/usr/bin/env bun
/**
 * inbox-dispatcher skill
 * Auto-triage and respond to inbox messages based on priority
 *
 * Usage: bun run inbox-dispatcher/inbox-dispatcher.ts <subcommand> [options]
 */

import { Command } from "commander";
import { getWalletAddress } from "../src/lib/services/x402.service.js";
import { printJson, handleError } from "../src/lib/utils/cli.js";

const INBOX_BASE = "https://aibtc.com/api/inbox";

// Simple keyword-based priority scorer
const PRIORITY_KEYWORDS = {
  revenue: ["payout", "payment", "bounty", "reward", "sats", "usd", "$", "invoice", "deal"],
  collaboration: ["partner", "collaborate", "project", "proposal", "join", "team", "contribute"],
  spam: ["unsubscribe", "stop", "promotion", "advertisement", "offer", "discount", "free"]
};

function scoreMessage(content: string): { priority: number; category: string } {
  const lower = content.toLowerCase();
  let revenue = 0, collab = 0, spam = 0;

  for (const kw of PRIORITY_KEYWORDS.revenue) if (lower.includes(kw)) revenue++;
  for (const kw of PRIORITY_KEYWORDS.collaboration) if (lower.includes(kw)) collab++;
  for (const kw of PRIORITY_KEYWORDS.spam) if (lower.includes(kw)) spam++;

  // Priority: revenue high, collaboration medium, spam negative
  const score = (revenue * 3) + (collab * 2) - (spam * 2);
  let category = "other";
  if (revenue > collab && revenue > spam) category = "revenue";
  else if (collab > revenue && collab > spam) category = "collaboration";
  else if (spam > revenue && spam > collab) category = "spam";
  // Tie cases (revenue === collab, etc.) remain "other" — intentionally ambiguous

  return { priority: score, category };
}

// ---------------------------------------------------------------------------
// Helper: Sign a message with Bitcoin key using btc-sign subcommand
// ---------------------------------------------------------------------------
async function signMessageWithBtc(message: string): Promise<{ signature: string; signer: string }> {
  // Spawn btc-sign subprocess using Bun
  const proc = Bun.spawn(
    ["bun", "run", "signing/signing.ts", "btc-sign", "--message", message],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`btc-sign failed (exit ${exitCode}): ${stderr || stdout}`);
  }

  let result: { success?: boolean; signature?: string; signer?: string; error?: string };
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`btc-sign returned invalid JSON: ${stdout}`);
  }

  if (!result.success || !result.signature || !result.signer) {
    throw new Error(`btc-sign error: ${result.error || "missing signature or signer in output"}`);
  }

  return { signature: result.signature, signer: result.signer };
}

// ---------------------------------------------------------------------------
// triage
// ---------------------------------------------------------------------------
const triageCmd = new Command("triage")
  .description("Score all unread messages by priority")
  .action(async () => {
    try {
      const address = await getWalletAddress();
      const url = `${INBOX_BASE}/${address}?status=unread`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
      const data = await res.json();

      const messages: Array<{ id: string; content: string; sentAt?: string }> = data.inbox?.messages || [];
      const scored = messages.map(msg => {
        const { priority, category } = scoreMessage(msg.content);
        return {
          id: msg.id,
          priority,
          category,
          preview: msg.content.substring(0, 100)
        };
      }).sort((a, b) => b.priority - a.priority);

      printJson({
        address,
        total: scored.length,
        categories: {
          revenue: scored.filter(m => m.category === 'revenue').length,
          collaboration: scored.filter(m => m.category === 'collaboration').length,
          spam: scored.filter(m => m.category === 'spam').length,
          other: scored.filter(m => m.category === 'other').length
        },
        prioritized: scored
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------
const ackCmd = new Command("ack")
  .description("Auto-acknowledge high-priority messages (revenue/collaboration) by marking them as read")
  .option("--threshold <score>", "Minimum priority score to auto-ack", "2")
  .action(async (opts: { threshold: string }) => {
    try {
      const address = await getWalletAddress();
      const threshold = parseInt(opts.threshold, 10);
      const url = `${INBOX_BASE}/${address}?status=unread`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
      const data = await res.json();

      const messages: Array<{ id: string; content: string }> = data.inbox?.messages || [];
      const toAck = messages.filter(m => {
        const { priority } = scoreMessage(m.content);
        return priority >= threshold;
      });

      // Process each message: sign the "Inbox Read | {messageId}" message and PATCH
      const results = [];
      for (const msg of toAck) {
        try {
          const signMsg = `Inbox Read | ${msg.id}`;
          const { signature } = await signMessageWithBtc(signMsg);

          const patchUrl = `${INBOX_BASE}/${address}/${msg.id}`;
          const patchRes = await fetch(patchUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: msg.id, signature }),
          });

          if (!patchRes.ok) {
            const body = await patchRes.text();
            results.push({
              id: msg.id,
              success: false,
              error: `HTTP ${patchRes.status}: ${body}`,
              priority: scoreMessage(msg.content).priority,
              category: scoreMessage(msg.content).category
            });
          } else {
            results.push({
              id: msg.id,
              success: true,
              priority: scoreMessage(msg.content).priority,
              category: scoreMessage(msg.content).category
            });
          }
        } catch (err) {
          results.push({
            id: msg.id,
            success: false,
            error: err.message,
            priority: scoreMessage(msg.content).priority,
            category: scoreMessage(msg.content).category
          });
        }
      }

      printJson({
        address,
        threshold,
        total: toAck.length,
        succeeded: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        results
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------
const queueCmd = new Command("queue")
  .description("Generate an action queue for responding to messages")
  .action(async () => {
    try {
      const address = await getWalletAddress();
      const url = `${INBOX_BASE}/${address}?status=unread`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Inbox fetch failed: ${res.status}`);
      const data = await res.json();

      const messages: Array<{ id: string; content: string; from?: string }> = data.inbox?.messages || [];
      const queue = [];
      for (const msg of messages) {
        const { priority, category } = scoreMessage(msg.content);
        let action = "ignore";
        if (category === "revenue") action = "respond_immediately";
        else if (category === "collaboration") action = "review_and_respond";
        else if (category === "spam") action = "ignore";

        queue.push({
          id: msg.id,
          from: msg.from || "unknown",
          priority,
          category,
          action,
          suggestedReply: category === "revenue" ? "Thank you. I'm interested. Let's discuss details." : undefined
        });
      }

      queue.sort((a, b) => b.priority - a.priority);

      printJson({
        address,
        queued: queue.length,
        actions: queue
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command()
  .name("inbox-dispatcher")
  .description("Auto-triage and respond to inbox messages based on priority scoring")
  .version("0.1.0")
  .addCommand(triageCmd)
  .addCommand(ackCmd)
  .addCommand(queueCmd);

program.parse(process.argv);