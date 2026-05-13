import { Type } from "typebox";

const WorkspaceMode = Type.Union([Type.Literal("worktree"), Type.Literal("current")]);
const AccessMode = Type.Union([Type.Literal("read_only"), Type.Literal("write")]);
const IncludeItem = Type.Union([
  Type.Literal("status"),
  Type.Literal("summary"),
  Type.Literal("results"),
  Type.Literal("diff"),
  Type.Literal("logs"),
]);

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
  include?: Array<"status" | "summary" | "results" | "diff" | "logs">;
}
