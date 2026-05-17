import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface ConsultParallelAgentOptions {
  question: string;
  thinking?: string;
  timeoutMs?: number;
  debug?: boolean;
}

export interface ConsultParallelAgentResult {
  ok: true;
  action: "consult";
  agentId: string;
  question: string;
  answer: string;
  thinking: string;
  source: {
    repoRoot: string;
    worktreePath: string | null;
    branchName: string | null;
    status: string;
    dirty: boolean;
  };
  clone: {
    worktreePath: string;
    branchName: string;
    sessionFile: string | null;
    pid: number | null;
  };
  cleanup: {
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    sessionRemoved: boolean;
    kept: boolean;
  };
}

export async function consultParallelAgent(repoRoot: string, agentId: string, options: ConsultParallelAgentOptions): Promise<ConsultParallelAgentResult> {
  const args = ["--state-db", stateDbPath(repoRoot), "--agent-id", agentId, "--question", options.question];
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.timeoutMs !== undefined) args.push("--timeout-ms", String(options.timeoutMs));
  if (options.debug) args.push("--debug");

  const result = await runJsonScript<ConsultParallelAgentResult>(scriptPath("consult-subagent-clone.sh"), args, {
    cwd: repoRoot,
    timeoutMs: options.timeoutMs ? options.timeoutMs + 10_000 : 130_000,
  });
  return result.json;
}
