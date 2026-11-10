import { Glob } from "bun";
import { join } from "node:path";

/**
 * Note every SKILL.md must carry when its scripts import the repo's shared
 * runtime (`src/lib/`). Such a skill cannot run from a folder copied on its
 * own (`npx skills add`), only from a full checkout (#470).
 */
export const CHECKOUT_NOTE = "**Runs from a full checkout.**";

const SHARED_RUNTIME_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["'](?:\.\.\/)+src\//;

/**
 * True when any .ts file in the skill directory imports `../src/...`.
 * npm imports don't count: Bun installs those on the fly when a copied
 * folder runs without node_modules, but `src/lib/` can't be fetched that way.
 */
export async function importsSharedRuntime(repoRoot: string, skillDir: string): Promise<boolean> {
  const tsGlob = new Glob("**/*.ts");
  for await (const rel of tsGlob.scan({ cwd: join(repoRoot, skillDir) })) {
    if (rel.includes("node_modules/")) continue;
    if (SHARED_RUNTIME_IMPORT.test(await Bun.file(join(repoRoot, skillDir, rel)).text())) return true;
  }
  return false;
}
