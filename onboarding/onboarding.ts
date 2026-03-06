#!/usr/bin/env bun
/**
 * Onboarding skill CLI
 * Automates first-hour setup for new AIBTC agents.
 *
 * Usage: bun run onboarding/onboarding.ts <subcommand> [options]
 */

import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const GENESIS_MESSAGE = "Bitcoin will be the currency of AIs";
const MOLTBOOK_AIBTC_URL = "https://www.moltbook.com/m/aibtc";

type JsonValue = Record<string, unknown>;

interface CmdResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  json: JsonValue | null;
  cmd: string;
}

interface PackDefinition {
  name: string;
  skills: string[];
  notes: string;
}

const PACKS: Record<string, PackDefinition> = {
  core: {
    name: "core",
    skills: ["wallet", "settings", "signing", "query", "credentials"],
    notes: "Safe default pack for every new agent.",
  },
  builder: {
    name: "builder",
    skills: ["x402", "bns"],
    notes: "Builder/network pack for messaging + naming workflows.",
  },
  finance: {
    name: "finance",
    skills: ["bitflow", "defi"],
    notes: "Optional DeFi pack. Mainnet write-capable. Requires explicit consent.",
  },
};

const VALID_PACKS = ["core", "builder", "finance", "all"] as const;
type PackName = (typeof VALID_PACKS)[number];

function assertValidPack(pack: string): asserts pack is PackName {
  if (!VALID_PACKS.includes(pack as PackName)) {
    throw new Error(
      `Unknown pack: "${pack}". Valid options: ${VALID_PACKS.join(", ")}`
    );
  }
}

function parseJsonOrNull(text: string): JsonValue | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return null;
  }
}

function runLocalBun(args: string[], env?: Record<string, string>): CmdResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", ...args],
    cwd: repoRoot,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : "";
  const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";

  return {
    ok: proc.exitCode === 0,
    code: proc.exitCode,
    stdout,
    stderr,
    json: parseJsonOrNull(stdout),
    cmd: `bun run ${args.join(" ")}`,
  };
}

async function getWalletStatus(): Promise<CmdResult> {
  return runLocalBun(["wallet/wallet.ts", "status"]);
}

async function unlockWalletInProcess(password: string): Promise<JsonValue> {
  try {
    const walletManager = getWalletManager();
    let targetWalletId = await walletManager.getActiveWalletId();

    if (!targetWalletId) {
      return {
        success: false,
        error: "No active wallet found. Create/import a wallet first.",
      };
    }

    const account = await walletManager.unlock(targetWalletId, password);
    return {
      success: true,
      message: "Wallet unlocked successfully.",
      walletId: targetWalletId,
      btcAddress: account.btcAddress,
      stxAddress: account.address,
      network: account.network,
      security: {
        passwordInChildProcessArgs: false,
        note:
          "Password handled in-process to avoid exposing it in child process argv.",
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchHeartbeat(btcAddress: string): Promise<JsonValue | null> {
  try {
    const res = await fetch(
      `https://aibtc.com/api/heartbeat?address=${encodeURIComponent(btcAddress)}`
    );
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        error: `heartbeat GET failed (${res.status})`,
      };
    }
    return (await res.json()) as JsonValue;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchVerify(stxAddress: string): Promise<JsonValue | null> {
  try {
    const res = await fetch(`https://aibtc.com/api/verify/${encodeURIComponent(stxAddress)}`);
    if (!res.ok) {
      return {
        registered: false,
        status: res.status,
        error: `verify failed (${res.status})`,
      };
    }
    return (await res.json()) as JsonValue;
  } catch (error) {
    return {
      registered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postCheckIn(
  btcAddress: string,
  walletPassword?: string
): Promise<JsonValue> {
  const timestamp = new Date().toISOString();
  const signingEnv = walletPassword
    ? { AIBTC_WALLET_PASSWORD: walletPassword }
    : undefined;
  const signArgs = [
    "signing/signing.ts",
    "btc-sign",
    "--message",
    `AIBTC Check-In | ${timestamp}`,
  ];

  if (walletPassword) {
    signArgs.push("--wallet-password-env", "AIBTC_WALLET_PASSWORD");
  }

  const sign = runLocalBun(signArgs, signingEnv);

  const signature =
    (sign.json?.signatureBase64 as string | undefined) ??
    (sign.json?.signature as string | undefined) ??
    "";

  if (!sign.ok || !signature) {
    return {
      success: false,
      step: "sign-checkin",
      cmd: sign.cmd,
      error: sign.stderr || sign.stdout || "Failed to sign heartbeat check-in message.",
    };
  }

  try {
    const res = await fetch("https://aibtc.com/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timestamp, signature, btcAddress }),
    });

    const body = (await res.json()) as JsonValue;
    return {
      success: res.ok,
      status: res.status,
      timestamp,
      response: body,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function postRegistration(walletPassword?: string): Promise<JsonValue> {
  const signingEnv = walletPassword
    ? { AIBTC_WALLET_PASSWORD: walletPassword }
    : undefined;

  const btcArgs = [
    "signing/signing.ts",
    "btc-sign",
    "--message",
    GENESIS_MESSAGE,
  ];
  const stxArgs = [
    "signing/signing.ts",
    "stacks-sign",
    "--message",
    GENESIS_MESSAGE,
  ];

  if (walletPassword) {
    btcArgs.push("--wallet-password-env", "AIBTC_WALLET_PASSWORD");
    stxArgs.push("--wallet-password-env", "AIBTC_WALLET_PASSWORD");
  }

  const btcSign = runLocalBun(btcArgs, signingEnv);
  const stxSign = runLocalBun(stxArgs, signingEnv);

  const btcSignature =
    (btcSign.json?.signatureBase64 as string | undefined) ??
    (btcSign.json?.signature as string | undefined) ??
    "";
  const stxSignature = (stxSign.json?.signature as string | undefined) ?? "";

  if (!btcSign.ok || !btcSignature) {
    return {
      success: false,
      step: "btc-sign",
      cmd: btcSign.cmd,
      error: btcSign.stderr || btcSign.stdout || "Failed to sign BTC registration message.",
    };
  }

  if (!stxSign.ok || !stxSignature) {
    return {
      success: false,
      step: "stx-sign",
      cmd: stxSign.cmd,
      error: stxSign.stderr || stxSign.stdout || "Failed to sign STX registration message.",
    };
  }

  try {
    const res = await fetch("https://aibtc.com/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bitcoinSignature: btcSignature, stacksSignature: stxSignature }),
    });
    const body = (await res.json()) as JsonValue;
    return {
      success: res.ok,
      status: res.status,
      response: body,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function flattenRequestedPacks(pack: string): PackDefinition[] {
  assertValidPack(pack);

  if (pack === "all") {
    return [PACKS.core, PACKS.builder, PACKS.finance];
  }
  return [PACKS[pack]];
}

function mergedSkillList(pack: string): string[] {
  const set = new Set<string>();
  for (const p of flattenRequestedPacks(pack)) {
    for (const skill of p.skills) set.add(skill);
  }
  return [...set];
}

async function runDoctor(): Promise<JsonValue> {
  const wallet = await getWalletStatus();
  const walletJson = wallet.json ?? {};
  const walletObj = (walletJson.wallet as JsonValue | undefined) ?? {};

  const btcAddress = (walletObj.btcAddress as string | undefined) ?? "";
  const stxAddress = (walletObj.address as string | undefined) ?? "";
  const unlocked = walletJson.isUnlocked === true;

  const heartbeat = btcAddress ? await fetchHeartbeat(btcAddress) : null;
  const verify = stxAddress ? await fetchVerify(stxAddress) : null;

  const checks = [
    {
      check: "wallet-present",
      ok: Boolean(walletObj.id),
      details: walletObj.id ? "Wallet exists." : "No active wallet detected.",
    },
    {
      check: "wallet-unlocked",
      ok: unlocked,
      details: unlocked
        ? "Wallet is unlocked for write operations."
        : "Wallet locked (safe default). Unlock only when needed.",
    },
    {
      check: "aibtc-registration",
      ok: verify?.registered === true,
      details:
        verify?.registered === true
          ? "AIBTC registration verified."
          : "Registration not confirmed. Run onboarding run --register after wallet unlock.",
    },
    {
      check: "heartbeat-read",
      ok: heartbeat !== null && heartbeat.success !== false,
      details:
        heartbeat !== null && heartbeat.success !== false
          ? "Heartbeat endpoint reachable."
          : "Heartbeat endpoint unavailable or returned an error.",
    },
    {
      check: "community-target",
      ok: true,
      details: `Optional channel for onboarding community step: ${MOLTBOOK_AIBTC_URL}`,
    },
  ];

  const nextActions: string[] = [];
  if (!walletObj.id) {
    nextActions.push("Create wallet: bun run wallet/wallet.ts create --name main --password <password> --network mainnet");
  }
  if (walletObj.id && !unlocked) {
    nextActions.push("Unlock wallet: bun run wallet/wallet.ts unlock --password <password>");
  }
  if (verify?.registered !== true) {
    nextActions.push("Register agent: bun run onboarding/onboarding.ts run --register --wallet-password <password>");
  }
  nextActions.push("Install core pack: bun run onboarding/onboarding.ts install-packs --pack core --run");

  return {
    success: true,
    wallet: walletJson,
    registration: verify,
    heartbeat,
    checks,
    score: `${checks.filter((c) => c.ok).length}/${checks.length}`,
    nextActions,
    reminder: "Dream big. Ship concrete. Keep onboarding idempotent.",
  };
}

const program = new Command();

program
  .name("onboarding")
  .description("Automate first-hour setup for AIBTC agents")
  .version("0.1.0");

program
  .command("doctor")
  .description("Run onboarding health checks and return actionable next steps")
  .action(async () => {
    try {
      const report = await runDoctor();
      printJson(report);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("install-packs")
  .description("Preview or install onboarding skill packs (core, builder, finance, all)")
  .option("--pack <pack>", "core | builder | finance | all", "core")
  .option("--run", "Execute installation commands", false)
  .action(async (opts: { pack: string; run?: boolean }) => {
    try {
      assertValidPack(opts.pack);
      const selected = flattenRequestedPacks(opts.pack);
      const skills = mergedSkillList(opts.pack);

      if (!opts.run) {
        printJson({
          success: true,
          mode: "preview",
          selectedPacks: selected,
          skills,
          commandTemplate: "npx skills add aibtcdev/skills/<skill> -y -g",
          warning:
            "Finance pack is write-capable on mainnet. Install only when you intend to use DeFi operations.",
        });
        return;
      }

      const installs = skills.map((skillName) => {
        const proc = Bun.spawnSync({
          cmd: ["npx", "skills", "add", `aibtcdev/skills/${skillName}`, "-y", "-g"],
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });

        const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
        const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";

        return {
          skill: skillName,
          success: proc.exitCode === 0,
          exitCode: proc.exitCode,
          output: (stdout || stderr).trim().slice(0, 600),
        };
      });

      printJson({
        success: installs.every((i) => i.success),
        mode: "execute",
        selectedPacks: selected.map((s) => s.name),
        installs,
      });
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("run")
  .description("Execute first-hour onboarding flow with optional registration/check-in")
  .option(
    "--wallet-password <password>",
    "Wallet password to auto-unlock when needed (less secure: visible in process args)"
  )
  .option(
    "--wallet-password-env <envVar>",
    "Environment variable name containing wallet password",
    "AIBTC_WALLET_PASSWORD"
  )
  .option("--register", "Attempt AIBTC registration if not registered", false)
  .option("--check-in", "Submit heartbeat check-in after health checks", false)
  .option("--pack <pack>", "core | builder | finance | all", "core")
  .option("--install", "Install selected pack(s)", false)
  .option("--skip-community", "Skip Moltbook community step", false)
  .action(
    async (opts: {
      walletPassword?: string;
      walletPasswordEnv?: string;
      register?: boolean;
      checkIn?: boolean;
      pack: string;
      install?: boolean;
      skipCommunity?: boolean;
    }) => {
      try {
        assertValidPack(opts.pack);
        const steps: JsonValue[] = [];

        const doctorBefore = await runDoctor();
        steps.push({ step: "doctor-before", result: doctorBefore });

        const wallet = (doctorBefore.wallet as JsonValue | undefined) ?? {};
        const walletUnlocked = wallet.isUnlocked === true;

        const passwordFromEnvName = opts.walletPasswordEnv || "AIBTC_WALLET_PASSWORD";
        const passwordFromEnv = process.env[passwordFromEnvName];
        const effectivePassword = passwordFromEnv || opts.walletPassword;

        if (!walletUnlocked && effectivePassword) {
          const unlock = await unlockWalletInProcess(effectivePassword);
          steps.push({
            step: "wallet-unlock",
            result: {
              ...unlock,
              passwordSource: passwordFromEnv ? `env:${passwordFromEnvName}` : "cli-arg",
              warning: passwordFromEnv
                ? undefined
                : "Using --wallet-password exposes secrets in process args. Prefer --wallet-password-env.",
            },
          });
        }

        if (opts.install) {
          const skills = mergedSkillList(opts.pack);
          const installs = skills.map((skillName) => {
            const proc = Bun.spawnSync({
              cmd: ["npx", "skills", "add", `aibtcdev/skills/${skillName}`, "-y", "-g"],
              cwd: process.cwd(),
              stdout: "pipe",
              stderr: "pipe",
            });
            return {
              skill: skillName,
              success: proc.exitCode === 0,
              exitCode: proc.exitCode,
            };
          });
          steps.push({ step: "install-packs", result: installs });
        }

        const doctorAfter = await runDoctor();
        steps.push({ step: "doctor-after", result: doctorAfter });

        const registration = doctorAfter.registration as JsonValue | undefined;
        const walletAfter = (doctorAfter.wallet as JsonValue | undefined) ?? {};
        const walletAfterObj = (walletAfter.wallet as JsonValue | undefined) ?? {};
        const btcAddress = (walletAfterObj.btcAddress as string | undefined) ?? "";

        if (opts.register && registration?.registered !== true) {
          const registerResult = await postRegistration(effectivePassword);
          steps.push({ step: "register", result: registerResult });
        }

        if (opts.checkIn && btcAddress) {
          const checkInResult = await postCheckIn(btcAddress, effectivePassword);
          steps.push({ step: "check-in", result: checkInResult });
        }

        if (!opts.skipCommunity) {
          steps.push({
            step: "community",
            result: {
              status: "optional",
              message: "Join Moltbook /aibtc for network visibility and signal exchange.",
              url: MOLTBOOK_AIBTC_URL,
              blocking: false,
            },
          });
        }

        printJson({
          success: true,
          flow: "first-hour-onboarding",
          selectedPack: opts.pack,
          steps,
          finalReminder: "Dream big. Keep shipping. Reply only when you can add value.",
        });
      } catch (error) {
        handleError(error);
      }
    }
  );

program.parseAsync();
