import { scriptPath, stateDbPath, tasksDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";
import type { StartParallelAgentResult } from "./start-agent.js";

export async function resumeParallelAgent(repoRoot: string, agentId: string): Promise<StartParallelAgentResult> {
  const result = await runJsonScript<StartParallelAgentResult>(
    scriptPath("start-parallel-agent.sh"),
    ["--resume-session", "--agent-id", agentId, "--state-db", stateDbPath(repoRoot), "--tasks-db", tasksDbPath(repoRoot)],
    {
      cwd: repoRoot,
      timeoutMs: Number(process.env.PI_PARALLEL_AGENTS_EXTENSION_START_TIMEOUT_MS ?? 45_000),
    },
  );
  return result.json;
}
