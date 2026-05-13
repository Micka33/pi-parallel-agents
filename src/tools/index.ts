import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { launchParallelAgents } from "./launch-parallel-agents.js";
import { getParallelAgents } from "./get-parallel-agents.js";
import { controlParallelAgent } from "./control-parallel-agent.js";
import { messageParallelAgent } from "./message-parallel-agent.js";
import { replyParallelQuestion } from "./reply-parallel-question.js";
import {
  ControlParallelAgentParams,
  GetParallelAgentsParams,
  LaunchParallelAgentsParams,
  MessageParallelAgentParams,
  ReplyParallelQuestionParams,
  type ControlParallelAgentInput,
  type GetParallelAgentsInput,
  type LaunchParallelAgentsInput,
  type MessageParallelAgentInput,
  type ReplyParallelQuestionInput,
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

  pi.registerTool({
    name: "control_parallel_agent",
    label: "Control Parallel Agent",
    description: "Stop, resume, refresh, mark done, clean, or set defaults for persisted parallel agents.",
    promptSnippet: "Control a parallel Pi sub-agent lifecycle or defaults.",
    promptGuidelines: ["Use stop before clean; do not remove worktrees, branches, or sessions unless explicitly requested."],
    parameters: ControlParallelAgentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await controlParallelAgent(params as ControlParallelAgentInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "message_parallel_agent",
    label: "Message Parallel Agent",
    description: "Send steering or durable queued messages to a parallel child Pi agent.",
    promptSnippet: "Send a steer or queue message to an existing parallel child agent.",
    promptGuidelines: ["Use mode=steer for immediate guidance; use mode=queue for durable follow-up work."],
    parameters: MessageParallelAgentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await messageParallelAgent(params as MessageParallelAgentInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "reply_parallel_question",
    label: "Reply Parallel Question",
    description: "Answer a durable question raised by a parallel child Pi agent.",
    promptSnippet: "Reply to an incoming parallel-agent UI question by questionId.",
    promptGuidelines: ["Inspect get_parallel_agents include=['queues'] to find incoming questions before replying."],
    parameters: ReplyParallelQuestionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await replyParallelQuestion(params as ReplyParallelQuestionInput, ctx);
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
