import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface CleanAgentOptions {
  removeWorktree?: boolean;
  removeBranch?: boolean;
  removeSession?: boolean;
  deleteHistory?: boolean;
  force?: boolean;
}

export interface CleanAgentResult {
  ok: boolean;
  action: "clean";
  agent: unknown | null;
  actions: Array<Record<string, unknown>>;
  deletedHistory: boolean;
}

export async function cleanParallelAgent(repoRoot: string, agentId: string, options: CleanAgentOptions = {}): Promise<CleanAgentResult> {
  const args = ["--state-db", stateDbPath(repoRoot), "--agent-id", agentId];
  if (options.removeWorktree) args.push("--remove-worktree", "true");
  if (options.removeBranch) args.push("--remove-branch", "true");
  if (options.removeSession) args.push("--remove-session", "true");
  if (options.deleteHistory) args.push("--delete-history", "true");
  if (options.force) args.push("--force", "true");
  const result = await runJsonScript<CleanAgentResult>(scriptPath("clean-parallel-agent.sh"), args, { cwd: repoRoot, timeoutMs: 20_000 });
  return result.json;
}
