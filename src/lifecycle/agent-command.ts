import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface AgentCommandRowResult {
  id: number;
  agent_id: string;
  command_type: string;
  payload_json: string;
  status: string;
  response_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

export async function enqueueAgentCommand(repoRoot: string, agentId: string, commandType: string, payload: unknown): Promise<AgentCommandRowResult> {
  const result = await runJsonScript<{ command: AgentCommandRowResult }>(
    scriptPath("parallel-agent-state.sh"),
    [
      "enqueue-command",
      "--state-db",
      stateDbPath(repoRoot),
      "--agent-id",
      agentId,
      "--command-type",
      commandType,
      "--payload-json",
      JSON.stringify(payload),
    ],
    { cwd: repoRoot, timeoutMs: 10_000 },
  );
  return result.json.command;
}
