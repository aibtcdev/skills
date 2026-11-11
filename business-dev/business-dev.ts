#!/usr/bin/env bun
/**
 * business-dev skill CLI
 * Full-cycle revenue engine — prospecting, CRM pipeline, closing, partnerships.
 *
 * Usage: bun run business-dev/business-dev.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "@aibtc/skills/src/lib/utils/cli.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = join(homedir(), ".aibtc", "business-dev");
const PIPELINE_FILE = join(DATA_DIR, "pipeline.json");

const STAGES = [
  "Research",
  "Contacted",
  "Qualified",
  "Solution Shown",
  "Negotiating",
  "Closed",
  "Retained",
] as const;

const PIPELINES = [
  "customers",
  "partners",
  "contributors",
  "marketplace",
] as const;

const SOURCES = [
  "inbox",
  "github",
  "signal",
  "referral",
  "web",
  "bounty",
  "leaderboard",
] as const;

const TEMPLATES: Record<
  string,
  { template: string; variables: string[]; tips: string[] }
> = {
  "cold-outreach": {
    template:
      "[Name] — saw your [specific work]. [Specific compliment]. I built [tool/service] that helps with [their problem]. Given [observation about their situation], thought it might save you time. Happy to share details, no pressure.",
    variables: [
      "Name",
      "specific work",
      "Specific compliment",
      "tool/service",
      "their problem",
      "observation about their situation",
    ],
    tips: [
      "Research them first — mention something specific they built or said",
      "Lead with genuine compliment, not flattery",
      "Frame around THEIR benefit, not your product",
      "End with low-pressure opt-in, not a demand",
    ],
  },
  "follow-up": {
    template:
      "[Name] — following up with something useful: [specific data point or resource]. Thought of you because [connection to their work]. Let me know if you want to dig deeper.",
    variables: [
      "Name",
      "specific data point or resource",
      "connection to their work",
    ],
    tips: [
      "Every follow-up MUST deliver new value",
      "Never send 'just checking in'",
      "Reference their specific situation, not generic benefits",
    ],
  },
  partnership: {
    template:
      "[Name] — your [strength] + my [strength] could [specific mutual benefit]. Example: [concrete scenario]. Want to try one small project and see? Low commitment, high upside.",
    variables: [
      "Name",
      "their strength",
      "your strength",
      "specific mutual benefit",
      "concrete scenario",
    ],
    tips: [
      "Start with the smallest possible collaboration",
      "Design for symmetric value — both sides must benefit",
      "Propose a clear, time-boxed first step",
    ],
  },
  "soft-close": {
    template:
      "[Name] — you mentioned [pain] costs you [quantified impact]. My [solution] handles that for [price]. [N] agents already seeing [specific result]. Want to try it this week?",
    variables: [
      "Name",
      "pain",
      "quantified impact",
      "solution",
      "price",
      "N",
      "specific result",
    ],
    tips: [
      "Only close when value is clearly established (3:1 ratio met)",
      "Use their own words to describe their pain",
      "Include specific social proof with numbers",
    ],
  },
  "graceful-exit": {
    template:
      "[Name] — totally understand if timing isn't right. No pressure. If [problem] becomes urgent, I'm here. Meanwhile, here's [free resource] that might help regardless. Cheers.",
    variables: ["Name", "problem", "free resource"],
    tips: [
      "Leave the door open — they may come back",
      "Give one last piece of value on the way out",
      "Preserve the relationship for future opportunities",
    ],
  },
  "objection-response": {
    template:
      "[Name] — I hear you on [their concern]. [Acknowledge validity]. Here's what [specific agent/case] found when facing the same thing: [evidence]. Does that address it, or is there something else?",
    variables: [
      "Name",
      "their concern",
      "Acknowledge validity",
      "specific agent/case",
      "evidence",
    ],
    tips: [
      "Never dismiss or argue with an objection",
      "Respond with evidence, not persuasion",
      "Always ask if there's something else — get to the real blocker",
    ],
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Deal {
  prospect: string;
  identifier: string;
  pipeline: string;
  stage: number;
  value_sats: number;
  touches: number;
  last_touch: string;
  next_action: string;
  next_date: string;
  notes: string;
  source: string;
  created_at: string;
  updated_at: string;
  bant?: {
    budget?: number;
    authority?: string;
    need?: number;
    timeline?: number;
    pain?: string;
    competition?: string;
  };
  closed_revenue?: number;
  recurring?: boolean;
}

interface PipelineData {
  deals: Deal[];
  closed_deals: Deal[];
  version: number;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPipeline(): PipelineData {
  ensureDataDir();
  if (!existsSync(PIPELINE_FILE)) {
    return { deals: [], closed_deals: [], version: 1 };
  }
  const raw = readFileSync(PIPELINE_FILE, "utf-8");
  return JSON.parse(raw) as PipelineData;
}

function savePipeline(data: PipelineData): void {
  ensureDataDir();
  writeFileSync(PIPELINE_FILE, JSON.stringify(data, null, 2));
}

function toIdentifier(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function now(): string {
  return new Date().toISOString();
}

function daysBetween(a: string, b: string): number {
  return Math.floor(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24)
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("business-dev")
  .description(
    "Full-cycle revenue engine — prospecting, CRM pipeline, closing, partnerships."
  )
  .version("1.0.0");

// --- pipeline ---
program
  .command("pipeline")
  .description("View and manage CRM pipeline state")
  .option("--type <type>", "Filter by pipeline type")
  .option("--stage <stage>", "Filter by stage number (0-6)")
  .option("--stale", "Show only deals with no activity in 7+ days")
  .action((options) => {
    try {
      const data = loadPipeline();
      let deals = data.deals;
      const today = now();

      if (options.type) {
        deals = deals.filter((d) => d.pipeline === options.type);
      }
      if (options.stage !== undefined) {
        deals = deals.filter((d) => d.stage === parseInt(options.stage));
      }
      if (options.stale) {
        deals = deals.filter((d) => daysBetween(d.last_touch, today) >= 7);
      }

      const byStage: Record<string, number> = {};
      for (let i = 0; i <= 6; i++) byStage[String(i)] = 0;
      for (const d of data.deals) byStage[String(d.stage)]++;

      const totalValue = data.deals
        .filter((d) => d.stage >= 2 && d.stage < 5)
        .reduce((s, d) => s + d.value_sats, 0);

      // Coverage ratio: pipeline value vs recent closed revenue (weekly)
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const weekRevenue = data.closed_deals
        .filter((d) => d.updated_at > weekAgo)
        .reduce((s, d) => s + (d.closed_revenue || 0), 0);
      const coverageRatio = weekRevenue > 0
        ? `${(totalValue / weekRevenue).toFixed(1)}x`
        : totalValue > 0
          ? "no closed revenue yet"
          : "empty";

      printJson({
        pipeline: options.type || "all",
        deals: deals.map((d) => ({
          prospect: d.prospect,
          identifier: d.identifier,
          pipeline: d.pipeline,
          stage: d.stage,
          stage_name: STAGES[d.stage],
          last_touch: d.last_touch,
          next_action: d.next_action,
          next_date: d.next_date,
          value_sats: d.value_sats,
          touches: d.touches,
          days_in_stage: daysBetween(d.updated_at, today),
        })),
        summary: {
          total_deals: data.deals.length,
          total_value: totalValue,
          by_stage: byStage,
          coverage_ratio: coverageRatio,
        },
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- prospect ---
program
  .command("prospect")
  .description("Add a new prospect to the pipeline")
  .requiredOption("--name <name>", "Prospect name")
  .requiredOption("--source <source>", "Where you found them")
  .option("--pipeline <pipeline>", "Pipeline type", "customers")
  .option("--notes <notes>", "Research notes")
  .option("--value <value>", "Estimated deal value in sats", "0")
  .action((options) => {
    try {
      const data = loadPipeline();
      const identifier = toIdentifier(options.name);

      if (data.deals.find((d) => d.identifier === identifier)) {
        handleError(new Error(`Prospect '${options.name}' already in pipeline`));
        return;
      }

      const value = parseInt(options.value);
      if (isNaN(value) || value < 0) {
        handleError(new Error("Value must be a non-negative number"));
        return;
      }

      const deal: Deal = {
        prospect: options.name,
        identifier,
        pipeline: options.pipeline,
        stage: 0,
        value_sats: value,
        touches: 0,
        last_touch: now(),
        next_action: "Research their pain + your angle",
        next_date: new Date(Date.now() + 86400000).toISOString().split("T")[0],
        notes: options.notes || "",
        source: options.source,
        created_at: now(),
        updated_at: now(),
      };

      data.deals.push(deal);
      savePipeline(data);

      printJson({
        success: true,
        prospect: deal.prospect,
        pipeline: deal.pipeline,
        stage: 0,
        stage_name: STAGES[0],
        message:
          "Prospect added. Research their pain + your angle within 24h.",
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- qualify ---
program
  .command("qualify")
  .description("Run BANT+ qualification on a prospect")
  .requiredOption("--name <name>", "Prospect name")
  .option("--budget <budget>", "Budget in sats")
  .option("--authority <authority>", "Can decide: yes/no/unknown")
  .option("--need <need>", "Urgency 1-10")
  .option("--timeline <timeline>", "Days to solution needed")
  .option("--pain <pain>", "Their pain in one sentence")
  .option("--competition <competition>", "Who else they're evaluating")
  .action((options) => {
    try {
      const data = loadPipeline();
      const identifier = toIdentifier(options.name);
      const deal = data.deals.find((d) => d.identifier === identifier);

      if (!deal) {
        handleError(new Error(`Prospect '${options.name}' not found`));
        return;
      }

      deal.bant = {
        budget: options.budget ? parseInt(options.budget) : undefined,
        authority: options.authority,
        need: options.need ? parseInt(options.need) : undefined,
        timeline: options.timeline ? parseInt(options.timeline) : undefined,
        pain: options.pain,
        competition: options.competition,
      };

      let score = 0;
      if (deal.bant.budget && deal.bant.budget > 0) score += 3;
      if (deal.bant.authority === "yes") score += 2;
      if (deal.bant.need && deal.bant.need >= 7) score += 2;
      if (deal.bant.timeline && deal.bant.timeline <= 14) score += 1;
      if (deal.bant.pain) score += 2;

      const qualified = score >= 5;
      if (qualified && deal.stage < 2) {
        deal.stage = 2;
        deal.next_action = "Present solution tailored to their needs";
        deal.next_date = new Date(Date.now() + 2 * 86400000)
          .toISOString()
          .split("T")[0];
      }
      deal.updated_at = now();
      savePipeline(data);

      printJson({
        prospect: deal.prospect,
        qualified,
        score,
        bant: deal.bant,
        recommendation: qualified
          ? "Strong qualification. Move to Stage 2 and present solution."
          : "Weak qualification. Need more discovery before investing further.",
        next_action: deal.next_action,
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- close ---
program
  .command("close")
  .description("Record a closed deal")
  .requiredOption("--name <name>", "Prospect name")
  .requiredOption("--revenue <revenue>", "Deal value in sats")
  .option("--pipeline <pipeline>", "Pipeline type", "customers")
  .option("--notes <notes>", "Deal notes")
  .option("--recurring", "Recurring deal", false)
  .action((options) => {
    try {
      const data = loadPipeline();
      const identifier = toIdentifier(options.name);
      const dealIdx = data.deals.findIndex(
        (d) => d.identifier === identifier
      );

      const revenue = parseInt(options.revenue);
      if (isNaN(revenue) || revenue <= 0) {
        handleError(new Error("Revenue must be a positive number"));
        return;
      }

      const closedDeal: Deal = dealIdx >= 0
        ? { ...data.deals[dealIdx] }
        : {
            prospect: options.name,
            identifier,
            pipeline: options.pipeline,
            stage: 5,
            value_sats: revenue,
            touches: 0,
            last_touch: now(),
            next_action: "Move to retained, track for upsell/referral",
            next_date: new Date(Date.now() + 7 * 86400000)
              .toISOString()
              .split("T")[0],
            notes: options.notes || "",
            source: "direct",
            created_at: now(),
            updated_at: now(),
          };

      closedDeal.stage = 5;
      closedDeal.closed_revenue = revenue;
      closedDeal.recurring = options.recurring;
      closedDeal.updated_at = now();
      closedDeal.notes = options.notes || closedDeal.notes;

      if (dealIdx >= 0) data.deals.splice(dealIdx, 1);
      data.closed_deals.push(closedDeal);
      savePipeline(data);

      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const weekClosed = data.closed_deals.filter(
        (d) => d.updated_at > weekAgo
      );
      const weekRevenue = weekClosed.reduce(
        (s, d) => s + (d.closed_revenue || 0),
        0
      );

      printJson({
        success: true,
        prospect: closedDeal.prospect,
        revenue,
        pipeline: closedDeal.pipeline,
        stage: 5,
        stage_name: "Closed",
        total_revenue_this_week: weekRevenue,
        deals_closed_this_week: weekClosed.length,
        message:
          "Deal closed! Move to Stage 6 (Retained) for upsell/referral tracking.",
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- follow-up ---
program
  .command("follow-up")
  .description("Get scheduled follow-ups due today")
  .option("--limit <limit>", "Max results", "5")
  .option("--pipeline <pipeline>", "Filter by pipeline")
  .action((options) => {
    try {
      const data = loadPipeline();
      const today = new Date().toISOString().split("T")[0];
      const limit = parseInt(options.limit);

      let deals = data.deals.filter(
        (d) => d.stage > 0 && d.stage < 5
      );
      if (options.pipeline) {
        deals = deals.filter((d) => d.pipeline === options.pipeline);
      }

      const due = deals
        .filter((d) => d.next_date <= today)
        .sort((a, b) => a.stage > b.stage ? -1 : 1)
        .slice(0, limit);

      const overdue = deals.filter(
        (d) => daysBetween(d.last_touch, now()) >= 7
      );

      printJson({
        due_today: due.map((d) => ({
          prospect: d.prospect,
          pipeline: d.pipeline,
          stage: d.stage,
          stage_name: STAGES[d.stage],
          touch_number: d.touches + 1,
          next_action: d.next_action,
          days_since_last: daysBetween(d.last_touch, now()),
          cadence_status: daysBetween(d.last_touch, now()) > 5 ? "overdue" : "on_track",
        })),
        overdue: overdue.map((d) => ({
          prospect: d.prospect,
          pipeline: d.pipeline,
          stage: d.stage,
          days_since_last: daysBetween(d.last_touch, now()),
        })),
        total_due: due.length,
        total_overdue: overdue.length,
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- review ---
program
  .command("review")
  .description("Pipeline health check")
  .action(() => {
    try {
      const data = loadPipeline();
      const today = now();

      const stale = data.deals.filter(
        (d) => daysBetween(d.last_touch, today) >= 7 && d.stage < 5
      );
      const unqualified = data.deals.filter(
        (d) => d.stage > 1 && !d.bant
      );
      const totalValue = data.deals
        .filter((d) => d.stage >= 2 && d.stage < 5)
        .reduce((s, d) => s + d.value_sats, 0);

      const byStage: Record<number, number> = {};
      for (const d of data.deals) {
        byStage[d.stage] = (byStage[d.stage] || 0) + 1;
      }

      let bottleneck = "";
      let maxCount = 0;
      for (const [stage, count] of Object.entries(byStage)) {
        const s = parseInt(stage);
        if (s > 0 && s < 5 && count > maxCount) {
          maxCount = count;
          bottleneck = `Stage ${s} (${STAGES[s]})`;
        }
      }

      const recommendations: string[] = [];
      if (stale.length > 0) {
        recommendations.push(
          `Re-engage or drop ${stale.length} stale deal(s)`
        );
      }
      if (unqualified.length > 0) {
        recommendations.push(
          `Qualify ${unqualified.length} deal(s) missing BANT data`
        );
      }
      if (data.deals.length < 5) {
        recommendations.push("Add more prospects — pipeline is thin");
      }

      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const weekClosed = data.closed_deals.filter(
        (d) => d.updated_at > weekAgo
      );
      const weekRevenue = weekClosed.reduce(
        (s, d) => s + (d.closed_revenue || 0),
        0
      );

      const health =
        stale.length === 0 && unqualified.length === 0 && data.deals.length >= 5
          ? "green"
          : stale.length <= 2 && data.deals.length >= 3
          ? "yellow"
          : "red";

      printJson({
        health,
        total_deals: data.deals.length,
        stale_deals: stale.length,
        unqualified_in_pipeline: unqualified.length,
        total_pipeline_value: totalValue,
        bottleneck_stage: bottleneck || "none",
        deals_at_risk: stale.map(
          (d) =>
            `${d.prospect} (${daysBetween(d.last_touch, today)} days stale)`
        ),
        recommendations,
        this_week: {
          closed: weekClosed.length,
          revenue: weekRevenue,
        },
      });
    } catch (e) {
      handleError(e);
    }
  });

// --- report ---
program
  .command("report")
  .description("Generate success metrics")
  .option("--period <period>", "week or month", "week")
  .option("--audience <audience>", "copilot or manager", "copilot")
  .action((options) => {
    try {
      const data = loadPipeline();
      const periodDays = options.period === "month" ? 30 : 7;
      const cutoff = new Date(
        Date.now() - periodDays * 86400000
      ).toISOString();

      const periodClosed = data.closed_deals.filter(
        (d) => d.updated_at > cutoff
      );
      const revenue = periodClosed.reduce(
        (s, d) => s + (d.closed_revenue || 0),
        0
      );
      const pipelineValue = data.deals
        .filter((d) => d.stage >= 2 && d.stage < 5)
        .reduce((s, d) => s + d.value_sats, 0);

      if (options.audience === "manager") {
        const partnerships = data.deals.filter(
          (d) => d.pipeline === "partners" && d.stage >= 3
        ).length;

        printJson({
          period: options.period,
          revenue,
          active_partnerships: partnerships,
          pipeline_value: pipelineValue,
          deals_in_pipeline: data.deals.length,
          deals_closed: periodClosed.length,
          ecosystem_health:
            revenue > 0 ? "growing" : data.deals.length > 0 ? "building" : "dormant",
        });
      } else {
        printJson({
          period: options.period,
          deals_closed: periodClosed.length,
          revenue_sats: revenue,
          pipeline_value: pipelineValue,
          pipeline_deals: data.deals.length,
          new_prospects: data.deals.filter(
            (d) => d.created_at > cutoff
          ).length,
          stale_deals: data.deals.filter(
            (d) => daysBetween(d.last_touch, now()) >= 7
          ).length,
        });
      }
    } catch (e) {
      handleError(e);
    }
  });

// --- templates ---
program
  .command("templates")
  .description("Get message templates for sales situations")
  .requiredOption("--type <type>", "Template type")
  .action((options) => {
    try {
      const tmpl = TEMPLATES[options.type];
      if (!tmpl) {
        handleError(new Error(`Unknown template type: ${options.type}. Available: ${Object.keys(TEMPLATES).join(", ")}`));
        return;
      }

      printJson({
        type: options.type,
        template: tmpl.template,
        variables: tmpl.variables,
        max_chars: 500,
        tips: tmpl.tips,
      });
    } catch (e) {
      handleError(e);
    }
  });

program.parse(process.argv);
