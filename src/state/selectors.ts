import type { AgentEventRow, AgentStateRow, ParallelAgent } from "./types.js";

export function toParallelAgent(row: AgentStateRow, events?: AgentEventRow[]): ParallelAgent {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    parentSessionId: row.parent_session_id,
    repoRoot: row.repo_root,
    status: row.status,
    workspaceMode: row.workspace_mode,
    accessMode: row.access_mode,
    pid: row.pid,
    cwd: row.cwd,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    provider: row.provider,
    model: row.model,
    thinking: row.thinking,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    summary: row.summary,
    diffSummary: row.diff_summary,
    testsJson: row.tests_json,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(events ? { events } : {}),
  };
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "starting":
      return "◌";
    case "waiting":
      return "○";
    case "stopped":
      return "◼";
    case "crashed":
      return "✖";
    case "done":
      return "✓";
    case "cleaned":
      return "·";
    default:
      return "?";
  }
}
