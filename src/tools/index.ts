import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startAgent } from "./start-agent.js";
import { getParallelAgents } from "./get-parallel-agents.js";
import { controlParallelAgent } from "./control-parallel-agent.js";
import { messageParallelAgent } from "./message-parallel-agent.js";
import { replyParallelQuestion } from "./reply-parallel-question.js";
import {
  ControlParallelAgentParams,
  GetParallelAgentsParams,
  StartAgentParams,
  MessageParallelAgentParams,
  ReplyParallelQuestionParams,
  type ControlParallelAgentInput,
  type GetParallelAgentsInput,
  type StartAgentInput,
  type MessageParallelAgentInput,
  type ReplyParallelQuestionInput,
} from "./schemas.js";

export function registerParallelAgentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "start_agent",
    label: "Start Agent",
    description: "Create a Pi sub-agent with SDK sessions. Use options for worktree isolation, read-only policy, single response, sub-agent quota, model, thinking, and tools.",
    promptSnippet: "Create a child Pi sub-agent with SDK sessions and explicit options.",
    promptGuidelines: [
      "Use start_agent as the only creation primitive for sub-agents.",
      "For a one-shot question, set dedicatedWorktree=true, readOnly=true, singleResponse=true.",
      "Default maxSubAgents is 0; increase it only when the child is explicitly allowed to start direct children.",
    ],
    parameters: StartAgentParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Starting sub-agent..." }], details: {} });
      const output = await startAgent(params as StartAgentInput, ctx, pi.getActiveTools(), pi.getThinkingLevel());
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "get_parallel_agents",
    label: "Get Parallel Agents",
    description: "Read persisted parallel-agent status, sessions, worktrees, summaries, and events.",
    promptSnippet: "Inspect sub-agent status, worktrees, model/thinking, sessions, and summaries.",
    promptGuidelines: ["Use get_parallel_agents before summarizing or coordinating existing sub-agents."],
    parameters: GetParallelAgentsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = getParallelAgents(params as GetParallelAgentsInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "control_parallel_agent",
    label: "Control Parallel Agent",
    description: "Stop, resume, refresh, mark done, clean, retry blocked questions, review results, or set defaults for persisted parallel agents.",
    promptSnippet: "Control a parallel Pi sub-agent lifecycle, retry a blocked question, or review results.",
    promptGuidelines: ["Use stop before clean; do not remove worktrees, branches, or sessions unless explicitly requested.", "Use action=retry_question only for blocked outgoing queue/steer questions.", "Use action=review_results before summarizing multiple child outputs."],
    parameters: ControlParallelAgentParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await controlParallelAgent(params as ControlParallelAgentInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "message_parallel_agent",
    label: "Message Parallel Agent",
    description: "Send steering or durable queued messages to an existing child Pi agent.",
    promptSnippet: "Send a steer or queue message to an existing child agent.",
    promptGuidelines: ["Use mode=steer for immediate guidance; use mode=queue for durable follow-up work.", "Use start_agent with singleResponse=true for one-shot questions instead of message_parallel_agent."],
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
    promptSnippet: "Reply to an incoming parallel-agent question by questionId.",
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
