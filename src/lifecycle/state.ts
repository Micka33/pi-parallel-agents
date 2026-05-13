import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export async function ensureStateInitialized(repoRoot: string): Promise<void> {
  await runJsonScript(scriptPath("parallel-agent-state.sh"), ["init", "--state-db", stateDbPath(repoRoot)], {
    cwd: repoRoot,
    timeoutMs: 10_000,
  });
}
