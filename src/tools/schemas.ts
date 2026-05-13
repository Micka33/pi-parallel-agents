import { Type } from "typebox";

const WorkspaceMode = Type.Union([Type.Literal("worktree"), Type.Literal("current")]);
const AccessMode = Type.Union([Type.Literal("read_only"), Type.Literal("write")]);
const IncludeItem = Type.Union([
  Type.Literal("status"),
  Type.Literal("summary"),
  Type.Literal("results"),
  Type.Literal("diff"),
  Type.Literal("logs"),
  Type.Literal("commands"),
  Type.Literal("queues"),
]);

const ControlAction = Type.Union([
  Type.Literal("stop"),
  Type.Literal("resume"),
  Type.Literal("set_defaults"),
  Type.Literal("refresh"),
  Type.Literal("mark_done"),
  Type.Literal("clean"),
]);

const MessageMode = Type.Union([Type.Literal("steer"), Type.Literal("queue")]);
const ReplyStatus = Type.Union([Type.Literal("answered"), Type.Literal("done"), Type.Literal("blocked")]);

export const LaunchParallelAgentsParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root to launch agents from. Defaults to this Pi session workspace." })),
  defaultProvider: Type.Optional(Type.String({ description: "Provider to use for agents unless overridden. Defaults to the parent session provider." })),
  defaultModel: Type.Optional(Type.String({ description: "Model to use for agents unless overridden. Defaults to the parent session model, then gpt-5.5." })),
  defaultThinking: Type.Optional(Type.String({ description: "Thinking level unless overridden. Defaults to high." })),
  parentPrompt: Type.Optional(Type.String({ description: "Original user request or high-level orchestration context." })),
  agents: Type.Array(
    Type.Object({
      name: Type.String({ description: "Short logical name for this sub-agent." }),
      prompt: Type.String({ description: "Task assigned to this sub-agent." }),
      workspaceMode: Type.Optional(WorkspaceMode),
      accessMode: Type.Optional(AccessMode),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
    }),
    { minItems: 1 },
  ),
});

export const GetParallelAgentsParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose parallel-agent state should be read. Defaults to this Pi session workspace." })),
  agentId: Type.Optional(Type.String()),
  include: Type.Optional(Type.Array(IncludeItem)),
});

export const ControlParallelAgentParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose parallel-agent state should be controlled. Defaults to this Pi session workspace." })),
  action: ControlAction,
  agentId: Type.Optional(Type.String({ description: "Agent id for stop/resume/mark_done/clean." })),
  model: Type.Optional(Type.String({ description: "Default model for action=set_defaults." })),
  thinking: Type.Optional(Type.String({ description: "Default thinking level for action=set_defaults." })),
  summary: Type.Optional(Type.String({ description: "Summary for action=mark_done." })),
  diffSummary: Type.Optional(Type.String({ description: "Diff summary for action=mark_done." })),
  testsJson: Type.Optional(Type.String({ description: "JSON string with test results for action=mark_done." })),
  removeWorktree: Type.Optional(Type.Boolean({ description: "For clean: remove the agent worktree when safe." })),
  removeBranch: Type.Optional(Type.Boolean({ description: "For clean: remove the agent branch; requires explicit true." })),
  removeSession: Type.Optional(Type.Boolean({ description: "For clean: remove the session file; requires explicit true." })),
  deleteHistory: Type.Optional(Type.Boolean({ description: "For clean: delete the agent row instead of marking cleaned." })),
  force: Type.Optional(Type.Boolean({ description: "For clean: allow dirty worktree/force branch deletion." })),
});

export const MessageParallelAgentParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose parallel-agent state should be used. Defaults to this Pi session workspace." })),
  agentId: Type.String(),
  mode: MessageMode,
  message: Type.String(),
  questionId: Type.Optional(Type.String({ description: "Optional stable id for the durable queue row." })),
});

export const ReplyParallelQuestionParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose queue should be used. Defaults to this Pi session workspace." })),
  agentId: Type.String(),
  questionId: Type.String(),
  response: Type.String(),
  status: Type.Optional(ReplyStatus),
});

export interface LaunchParallelAgentsInput {
  repoRoot?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinking?: string;
  parentPrompt?: string;
  agents: Array<{
    name: string;
    prompt: string;
    workspaceMode?: "worktree" | "current";
    accessMode?: "read_only" | "write";
    provider?: string;
    model?: string;
    thinking?: string;
  }>;
}

export interface GetParallelAgentsInput {
  repoRoot?: string;
  agentId?: string;
  include?: Array<"status" | "summary" | "results" | "diff" | "logs" | "commands" | "queues">;
}

export interface ControlParallelAgentInput {
  repoRoot?: string;
  action: "stop" | "resume" | "set_defaults" | "refresh" | "mark_done" | "clean";
  agentId?: string;
  model?: string;
  thinking?: string;
  summary?: string;
  diffSummary?: string;
  testsJson?: string;
  removeWorktree?: boolean;
  removeBranch?: boolean;
  removeSession?: boolean;
  deleteHistory?: boolean;
  force?: boolean;
}

export interface MessageParallelAgentInput {
  repoRoot?: string;
  agentId: string;
  mode: "steer" | "queue";
  message: string;
  questionId?: string;
}

export interface ReplyParallelQuestionInput {
  repoRoot?: string;
  agentId: string;
  questionId: string;
  response: string;
  status?: "answered" | "done" | "blocked";
}
