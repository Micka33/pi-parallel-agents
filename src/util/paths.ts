import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { RUNTIME_DIR, STATE_DB_FILE, TASKS_DB_FILE } from "../constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function packageRoot(): string {
  // src/util/paths.ts through jiti -> package root is ../..
  // dist/src/util/paths.js -> dist/src/util -> package root is ../../..
  const sourceLayoutRoot = resolve(__dirname, "..", "..");
  const distLayoutRoot = resolve(__dirname, "..", "..", "..");
  const candidates = [sourceLayoutRoot, distLayoutRoot];
  let root = sourceLayoutRoot;
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "scripts", "start-parallel-agent.sh"))) {
      root = candidate;
      break;
    }
  }
  return root;
}

export function scriptPath(name: string): string {
  return join(packageRoot(), "scripts", name);
}

export function promptPath(name: string): string {
  return join(packageRoot(), "src", "prompts", name);
}

export function resolveRepoRoot(cwd: string): string {
  const override = process.env.PI_PARALLEL_AGENTS_REPO_ROOT?.trim();
  if (override) return resolve(override);
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (output) return resolve(output);
  } catch {
    // Non-git directories can still use current workspace mode.
  }
  return resolve(cwd);
}

export function runtimeDir(repoRoot: string): string {
  return join(repoRoot, ...RUNTIME_DIR);
}

export function stateDbPath(repoRoot: string): string {
  const override = process.env.PI_PARALLEL_AGENTS_DB_PATH?.trim();
  return override ? resolve(repoRoot, override) : join(runtimeDir(repoRoot), STATE_DB_FILE);
}

export function tasksDbPath(repoRoot: string): string {
  const override = process.env.PI_TASKS_DB_PATH?.trim();
  return override ? resolve(repoRoot, override) : join(runtimeDir(repoRoot), TASKS_DB_FILE);
}
