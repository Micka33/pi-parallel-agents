import { Type } from "typebox";

const NonNegativeInteger = Type.Number({ minimum: 0, multipleOf: 1 });
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
  Type.Literal("retry_question"),
  Type.Literal("review_results"),
]);

const MessageMode = Type.Union([Type.Literal("steer"), Type.Literal("queue")]);
const ReplyStatus = Type.Union([Type.Literal("answered"), Type.Literal("done"), Type.Literal("blocked")]);

export const StartAgentParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root to launch from. Defaults to this Pi session workspace." })),
  name: Type.Optional(Type.String({ description: "Optional short logical display name for the child agent." })),
  prompt: Type.String({ description: "Task assigned to the child agent." }),
  dedicatedWorktree: Type.Optional(Type.Boolean({ description: "Create a dedicated git worktree for the child. Defaults to true." })),
  inheritContext: Type.Optional(Type.Boolean({ description: "Fork or reconstruct safe requester context before the launch turn. Defaults to false." })),
  systemPrompt: Type.Optional(Type.String({ description: "Optional extra system prompt text for the child session." })),
  readOnly: Type.Optional(Type.Boolean({ description: "Restrict actual SDK tool list to read-only-safe tools. Defaults to !dedicatedWorktree." })),
  singleResponse: Type.Optional(Type.Boolean({ description: "Return one completed response and automatically dispose/clean the child. Defaults to false." })),
  maxSubAgents: Type.Optional(NonNegativeInteger),
  provider: Type.Optional(Type.String({ description: "Provider override. Defaults to requesting session provider." })),
  model: Type.Optional(Type.String({ description: "Model override. Defaults to requesting session model, then configured default." })),
  thinkingLevel: Type.Optional(Type.String({ description: "Thinking level override. Defaults to configured/default thinking." })),
  allowedTools: Type.Optional(Type.Array(Type.String({ description: "Tool name allowlist before read-only filtering." }))),
  keep: Type.Optional(Type.Boolean({ description: "For singleResponse debug/audit: keep temporary worktree/session instead of cleaning." })),
});

export const GetParallelAgentsParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose parallel-agent state should be read. Defaults to this Pi session workspace." })),
  agentId: Type.Optional(Type.String()),
  include: Type.Optional(Type.Array(IncludeItem)),
});

export const ControlParallelAgentParams = Type.Object({
  repoRoot: Type.Optional(Type.String({ description: "Git repo/workspace root whose parallel-agent state should be controlled. Defaults to this Pi session workspace." })),
  action: ControlAction,
  agentId: Type.Optional(Type.String({ description: "Agent id for stop/resume/mark_done/clean/retry_question." })),
  model: Type.Optional(Type.String({ description: "Default model for action=set_defaults." })),
  thinking: Type.Optional(Type.String({ description: "Default thinking level for action=set_defaults." })),
  summary: Type.Optional(Type.String({ description: "Summary for action=mark_done." })),
  diffSummary: Type.Optional(Type.String({ description: "Diff summary for action=mark_done." })),
  testsJson: Type.Optional(Type.String({ description: "JSON string with test results." })),
  questionId: Type.Optional(Type.String({ description: "Question id for action=retry_question." })),
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

export interface StartAgentInput {
  repoRoot?: string;
  name?: string;
  prompt: string;
  dedicatedWorktree?: boolean;
  inheritContext?: boolean;
  systemPrompt?: string;
  readOnly?: boolean;
  singleResponse?: boolean;
  maxSubAgents?: number;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  allowedTools?: string[];
  keep?: boolean;
}

export interface GetParallelAgentsInput {
  repoRoot?: string;
  agentId?: string;
  include?: Array<"status" | "summary" | "results" | "diff" | "logs" | "commands" | "queues">;
}

export interface ControlParallelAgentInput {
  repoRoot?: string;
  action: "stop" | "resume" | "set_defaults" | "refresh" | "mark_done" | "clean" | "retry_question" | "review_results";
  agentId?: string;
  model?: string;
  thinking?: string;
  summary?: string;
  diffSummary?: string;
  testsJson?: string;
  questionId?: string;
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
