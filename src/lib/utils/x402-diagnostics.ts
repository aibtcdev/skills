import type { CanonicalPaymentAction } from "../services/x402.service.js";
import type { TerminalReason } from "@aibtc/tx-schemas/terminal-reasons";
import type { TrackedPaymentState } from "@aibtc/tx-schemas/core/enums";

export type PaymentDiagnosticEvent =
  | "payment.accepted"
  | "payment.poll"
  | "payment.finalized"
  | "payment.retry_decision"
  | "payment.fallback_used";

export interface PaymentDiagnosticEntry {
  event: PaymentDiagnosticEvent;
  service: "skills";
  tool: string;
  paymentId: string | null;
  status: TrackedPaymentState | null;
  terminalReason: TerminalReason | null;
  action: string | null;
  checkStatusUrl_present: boolean;
  compat_shim_used: boolean;
  repo_version: string;
}

interface PaymentDiagnosticOptions {
  event: PaymentDiagnosticEvent;
  tool?: string;
  paymentId?: string | null;
  status?: TrackedPaymentState | null;
  terminalReason?: TerminalReason | null;
  action?: CanonicalPaymentAction | string | null;
  checkStatusUrl?: string | null;
  compatShimUsed?: boolean;
}

// When run via `bun run`, npm_package_version is set automatically from
// package.json. This fallback only fires in bare `bun <script>` invocations
// or non-npm execution contexts.
const FALLBACK_REPO_VERSION = "unknown";

export function resolvePaymentDiagnosticTool(tool?: string): string {
  if (tool && tool.trim().length > 0) {
    return tool;
  }

  const script = process.argv[1]?.split("/").pop() ?? "unknown";
  const subcommand = process.argv[2];
  return subcommand ? `${script}:${subcommand}` : script;
}

export function getSkillsRepoVersion(): string {
  return (
    process.env.DEPLOY_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GITHUB_SHA ??
    process.env.npm_package_version ??
    FALLBACK_REPO_VERSION
  );
}

export function buildPaymentDiagnosticEntry(
  options: PaymentDiagnosticOptions
): PaymentDiagnosticEntry {
  return {
    event: options.event,
    service: "skills",
    tool: resolvePaymentDiagnosticTool(options.tool),
    paymentId: options.paymentId ?? null,
    status: options.status ?? null,
    terminalReason: options.terminalReason ?? null,
    action: options.action ?? null,
    checkStatusUrl_present: Boolean(options.checkStatusUrl),
    compat_shim_used: options.compatShimUsed ?? false,
    repo_version: getSkillsRepoVersion(),
  };
}

export function emitPaymentDiagnostic(options: PaymentDiagnosticOptions): void {
  console.error(JSON.stringify(buildPaymentDiagnosticEntry(options)));
}

export function usedCallerFacingCompatShim(status: unknown): boolean {
  return status === "pending" || status === "submitted";
}
