import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface StopAgentResult {
  ok: boolean;
  action: "stop";
  agent: unknown;
  stopped: boolean;
}

export async function stopParallelAgent(repoRoot: string, agentId: string): Promise<StopAgentResult> {
  const result = await runJsonScript<StopAgentResult>(
    scriptPath("stop-parallel-agent.sh"),
    ["--state-db", stateDbPath(repoRoot), "--agent-id", agentId],
    { cwd: repoRoot, timeoutMs: 10_000 },
  );
  return result.json;
}
