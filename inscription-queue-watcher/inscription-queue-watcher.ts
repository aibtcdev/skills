#!/usr/bin/env bun
/**
 * Inscription Queue Watcher skill CLI
 *
 * Read-only monitor for the aibtc.news brief → ordinals inscription pipeline.
 * Detects stuck briefs (compiled but not inscribed) and unconfirmed inscriptions.
 *
 * Usage: bun run inscription-queue-watcher/inscription-queue-watcher.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import {
  NEWS_API_BASE,
  MEMPOOL_API_BASE,
  fetchArchiveRoot,
  parseNotify,
  runWatcher,
} from "./lib.js";

const program = new Command();

program
  .name("inscription-queue-watcher")
  .description(
    "Read-only monitor for the aibtc.news brief → ordinals inscription pipeline. Classifies recent briefs and surfaces stuck ones."
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command("doctor")
  .description(
    "Verify reachability of the aibtc.news brief API and mempool.space tx status endpoint. No arguments."
  )
  .action(async () => {
    try {
      const [newsRes, mempoolRes] = await Promise.all([
        fetch(`${NEWS_API_BASE}/brief`),
        fetch(`${MEMPOOL_API_BASE}/blocks/tip/height`),
      ]);
      printJson({
        ok: newsRes.ok && mempoolRes.ok,
        newsApi: {
          url: `${NEWS_API_BASE}/brief`,
          status: newsRes.status,
          ok: newsRes.ok,
        },
        mempoolApi: {
          url: `${MEMPOOL_API_BASE}/blocks/tip/height`,
          status: mempoolRes.status,
          ok: mempoolRes.ok,
        },
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

program
  .command("run")
  .description(
    "Classify each brief in a rolling window. Emits a single JSON report with per-date state, totals, and any red-state alerts."
  )
  .option("--days <n>", "Number of UTC days to scan ending today (1-60)", "7")
  .option(
    "--threshold-hours <h>",
    "Hours between brief compile and on-chain inscription before a brief is flagged red. Empirical basis: Apr 10, 2026 void batch (90K sats voided) took ~28h from compile.",
    "24"
  )
  .option(
    "--notify <addresses>",
    "Comma-separated BTC addresses to stage for operator inbox alerts (100 sats/alert/recipient). Off by default; v1 records recipients to the JSON report — live dispatch is a v2 follow-up. Example: --notify bc1q...publisher,bc1q...editor"
  )
  .action(async (opts: { days: string; thresholdHours: string; notify?: string }) => {
    try {
      const days = parseInt(opts.days, 10);
      if (!Number.isFinite(days) || days < 1 || days > 60) {
        throw new Error("--days must be an integer between 1 and 60");
      }
      const thresholdHours = parseFloat(opts.thresholdHours);
      if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
        throw new Error("--threshold-hours must be a positive number");
      }
      const { valid: notifyRecipients, rejected } = parseNotify(opts.notify);
      if (rejected.length > 0) {
        console.error(
          `[watcher] notifications: ignoring ${rejected.length} invalid address(es): ${rejected.join(", ")} (expected bech32 bc1... format)`
        );
      }
      if (notifyRecipients.length > 0) {
        console.error(
          `[watcher] notifications: STAGED \u2192 ${notifyRecipients.length} recipient(s): ${notifyRecipients.join(", ")} (v1 records intent; v2 will dispatch via aibtc.news inbox at 100 sats/alert)`
        );
      } else {
        console.error(
          "[watcher] notifications: OFF. Run with --notify <btc_address> to stage operator inbox alerts (100 sats/alert)."
        );
      }

      const report = await runWatcher({
        days,
        thresholdHours,
        notifyRecipients,
      });
      printJson(report);
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// list-archive
// ---------------------------------------------------------------------------

program
  .command("list-archive")
  .description("List archived brief dates available from aibtc.news, newest first.")
  .option("--limit <n>", "Maximum dates to return (1-200)", "30")
  .action(async (opts: { limit: string }) => {
    try {
      const limit = parseInt(opts.limit, 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
        throw new Error("--limit must be an integer between 1 and 200");
      }
      const root = await fetchArchiveRoot();
      const archive = (root.archive ?? []).slice(0, limit);
      printJson({
        latestDate: root.date,
        latestCompiledAt: root.compiledAt ?? root.compiled_at ?? null,
        archive,
        count: archive.length,
      });
    } catch (error) {
      handleError(error);
    }
  });

program.parse(process.argv);
