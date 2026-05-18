import type { AgentCommandRow, AgentEventRow, AgentStateRow, ParallelAgent, QueueQuestionRow } from "./types.js";

export function toParallelAgent(row: AgentStateRow, events?: AgentEventRow[], commands?: AgentCommandRow[], queue?: QueueQuestionRow[]): ParallelAgent {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    parentSessionId: row.parent_session_id,
    repoRoot: row.repo_root,
    status: row.status,
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
    requesterAgentId: row.requester_agent_id,
    dedicatedWorktree: Boolean(row.dedicated_worktree),
    readOnly: Boolean(row.read_only),
    singleResponse: Boolean(row.single_response),
    inheritContext: Boolean(row.inherit_context),
    maxSubAgents: row.max_sub_agents,
    allowedTools: parseAllowedTools(row.allowed_tools_json),
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(events ? { events } : {}),
    ...(commands ? { commands } : {}),
    ...(queue ? { queue } : {}),
  };
}

function parseAllowedTools(value: string | null): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
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
