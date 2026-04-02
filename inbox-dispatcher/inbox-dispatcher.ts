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

  return { priority: score, category };
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
      const scored = messages.map(msg => ({
        ...msg,
        ...scoreMessage(msg.content)
      })).sort((a, b) => b.priority - a.priority);

      printJson({
        address,
        total: scored.length,
        categories: {
          revenue: scored.filter(m => m.category === 'revenue').length,
          collaboration: scored.filter(m => m.category === 'collaboration').length,
          spam: scored.filter(m => m.category === 'spam').length,
          other: scored.filter(m => m.category === 'other').length
        },
        prioritized: scored.map(m => ({
          id: m.id,
          priority: m.priority,
          category: m.category,
          preview: m.content.substring(0, 100)
        }))
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// ack
// ---------------------------------------------------------------------------
const ackCmd = new Command("ack")
  .description("Auto-acknowledge high-priority messages (revenue/collaboration)")
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

      // In a real implementation, we'd mark as read via API call
      // For MVP, we just report what would be acked
      printJson({
        address,
        threshold,
        wouldAck: toAck.length,
        messages: toAck.map(m => ({
          id: m.id,
          priority: scoreMessage(m.content).priority,
          category: scoreMessage(m.content).category,
          preview: m.content.substring(0, 80)
        }))
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
import { program } from "commander";

program
  .name("inbox-dispatcher")
  .description("Auto-triage and respond to inbox messages based on priority scoring")
  .version("0.1.0")
  .addCommand(triageCmd)
  .addCommand(ackCmd)
  .addCommand(queueCmd);

program.parse(process.argv);
