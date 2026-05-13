import type { AccessMode, WorkspaceMode } from "../constants.js";

export type AgentStatus = "starting" | "running" | "waiting" | "stopped" | "crashed" | "done" | "cleaned";

export interface AgentStateRow {
  agent_id: string;
  parent_session_id: string;
  display_name: string;
  repo_root: string;
  status: AgentStatus;
  workspace_mode: WorkspaceMode;
  access_mode: AccessMode;
  pid: number | null;
  cwd: string;
  worktree_path: string | null;
  branch_name: string | null;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  session_id: string | null;
  session_file: string | null;
  summary: string | null;
  diff_summary: string | null;
  tests_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEventRow {
  id: number;
  agent_id: string;
  event_type: string;
  payload_json: string | null;
  created_at: string;
}

export type AgentCommandStatus = "queued" | "delivering" | "succeeded" | "failed" | "canceled";

export interface AgentCommandRow {
  id: number;
  agent_id: string;
  command_type: string;
  payload_json: string;
  status: AgentCommandStatus;
  response_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  completed_at: string | null;
}

export type QueueDirection = "incoming" | "outgoing";
export type QueueMode = "steer" | "queue" | "reply";
export type QueueStatus = "queued" | "delivered" | "answered" | "done" | "blocked" | "canceled";

export interface QueueQuestionRow {
  question_id: string;
  agent_id: string;
  direction: QueueDirection;
  mode: QueueMode;
  status: QueueStatus;
  message: string;
  response: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  answered_at: string | null;
}

export interface ParallelAgent {
  agentId: string;
  displayName: string;
  parentSessionId: string;
  repoRoot: string;
  status: AgentStatus;
  workspaceMode: WorkspaceMode;
  accessMode: AccessMode;
  pid: number | null;
  cwd: string;
  worktreePath: string | null;
  branchName: string | null;
  provider: string | null;
  model: string | null;
  thinking: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  summary: string | null;
  diffSummary: string | null;
  testsJson: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  events?: AgentEventRow[];
  commands?: AgentCommandRow[];
  queue?: QueueQuestionRow[];
}

export interface ParallelAgentSettings {
  default_model?: string;
  default_thinking?: string;
  [key: string]: unknown;
}
