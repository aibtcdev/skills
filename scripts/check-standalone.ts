/**
 * Install each skill the way `npx skills add aibtcdev/skills/<skill>` does and
 * check that it starts (#473): copy only the skill folder into a throwaway
 * project that has its own node_modules (so Bun's on-the-fly install is off,
 * as in a real project), `bun install` there, then run every entry with --help.
 *
 * By default `@aibtc/skills` is installed from this checkout (`file:`), so a PR
 * is checked against its own shared code. `--from-github` keeps the published
 * `github:aibtcdev/skills` source instead.
 *
 *   bun run scripts/check-standalone.ts [skill ...] [--from-github]
 */
import { Glob } from "bun";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as yaml from "yaml";
import { REPO_PACKAGE } from "./lib/skill-packages.js";

const repoRoot = dirname(dirname(import.meta.path));
const args = process.argv.slice(2);
const fromGithub = args.includes("--from-github");
const only = args.filter((a) => !a.startsWith("--"));

async function entriesOf(skill: string): Promise<string[]> {
  const content = await Bun.file(join(repoRoot, skill, "SKILL.md")).text();
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = ((fm ? yaml.parse(fm[1]) : {})?.metadata ?? {}) as Record<string, string>;
  return String(meta.entry ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.endsWith(".ts"))
    .map((e) => e.slice(e.indexOf("/") + 1)); // path inside the skill folder
}

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const proc = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  return { code: proc.exitCode ?? 1, out };
}

const skills: string[] = [];
for await (const file of new Glob("*/package.json").scan({ cwd: repoRoot })) {
  const skill = file.split("/")[0];
  if (skill === "node_modules") continue;
  if (only.length === 0 || only.includes(skill)) skills.push(skill);
}
skills.sort();

const project = await mkdtemp(join(tmpdir(), "skills-standalone-"));
// A project with its own node_modules, like the ones `npx skills add` installs into.
await writeFile(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }));
await mkdir(join(project, "node_modules"));

const failures: string[] = [];
try {
  for (const skill of skills) {
    const dir = join(project, ".agents", "skills", skill);
    await cp(join(repoRoot, skill), dir, {
      recursive: true,
      // Only what the skill folder ships: no tests, no local installs.
      filter: (src) => !src.includes("node_modules") && !src.endsWith(".test.ts"),
    });
    const pkgPath = join(dir, "package.json");
    const pkg = await Bun.file(pkgPath).json();
    if (!fromGithub && pkg.dependencies?.[REPO_PACKAGE]) {
      pkg.dependencies[REPO_PACKAGE] = `file:${repoRoot}`;
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    }

    const install = run([process.execPath, "install"], dir);
    if (install.code !== 0) {
      failures.push(`${skill}: bun install failed\n${install.out.trim().slice(-800)}`);
      continue;
    }
    for (const entry of await entriesOf(skill)) {
      const help = run([process.execPath, "run", entry, "--help"], dir);
      // The point is that the entry loads: a missing module/package or export, or a
      // syntax error. A CLI that rejects --help after printing its usage still started.
      const loadError = /Cannot find (module|package)|Export named .* not found|SyntaxError|ResolveMessage/;
      const broken = loadError.test(help.out) || (help.code !== 0 && !help.out.trim());
      if (broken) failures.push(`${skill}: ${entry} --help failed (exit ${help.code})\n${help.out.trim().slice(-800)}`);
      else console.log(`ok   ${skill}/${entry}`);
    }
  }
} finally {
  await rm(project, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`\nAll ${skills.length} skills start from a standalone install.`);
