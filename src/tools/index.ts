import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launchParallelAgents } from "./launch-parallel-agents.js";
import { getParallelAgents } from "./get-parallel-agents.js";
import {
  GetParallelAgentsParams,
  LaunchParallelAgentsParams,
  type GetParallelAgentsInput,
  type LaunchParallelAgentsInput,
} from "./schemas.js";

export function registerParallelAgentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "launch_parallel_agents",
    label: "Launch Parallel Agents",
    description: "Launch one or more Pi sub-agents in parallel workspaces and persist their state.",
    promptSnippet: "Launch multiple Pi sub-agents with isolated worktrees or read-only current workspace mode.",
    promptGuidelines: [
      "Use launch_parallel_agents when the user asks to split work across multiple agents in parallel.",
      "For analysis-only agents in the current checkout, set workspaceMode to current; it defaults to read_only.",
    ],
    parameters: LaunchParallelAgentsParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Launching parallel agents..." }], details: {} });
      const output = await launchParallelAgents(params as LaunchParallelAgentsInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "get_parallel_agents",
    label: "Get Parallel Agents",
    description: "Read persisted parallel-agent status, sessions, workspaces, summaries, and events.",
    promptSnippet: "Inspect sub-agent status, workspaces, model/thinking, sessions, and summaries.",
    promptGuidelines: ["Use get_parallel_agents before summarizing or coordinating existing parallel sub-agents."],
    parameters: GetParallelAgentsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = getParallelAgents(params as GetParallelAgentsInput, ctx);
      return jsonResult(output);
    },
  });
}

function jsonResult(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}
