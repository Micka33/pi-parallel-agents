import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
    description: "Create a Pi sub-agent with SDK sessions. Use options for worktree isolation, read-only policy, single response, wait policy, sub-agent quota, model, thinking, and tools.",
    promptSnippet: "Create a child Pi sub-agent with SDK sessions and explicit options.",
    promptGuidelines: [
      "Use start_agent as the only creation primitive for sub-agents.",
      "For a one-shot question, set dedicatedWorktree=true, readOnly=true, singleResponse=true.",
      "For a persistent child that should answer before the parent continues, set singleResponse=false and waitUntil='initial_response'.",
      "Default maxSubAgents is 0; increase it only when the child is explicitly allowed to start direct children.",
    ],
    parameters: StartAgentParams,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Starting sub-agent..." }], details: { phase: "starting" } });
      const output = await startAgent(params as StartAgentInput, ctx, pi.getActiveTools(), pi.getThinkingLevel());
      return jsonResult(output);
    },
    renderCall(args, theme, _context) {
      return new Text(renderStartAgentCall(args as Partial<StartAgentInput>, theme), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(renderStartAgentPartial(context.args as Partial<StartAgentInput>, theme), 0, 0);
      return new Text(renderStartAgentResult(result, expanded, theme, context.args as Partial<StartAgentInput>), 0, 0);
    },
  });

  pi.registerTool({
    name: "get_parallel_agents",
    label: "Get Parallel Agents",
    description: "List persisted parallel agents as compact rows containing only agentId, displayName, sessionId, and status.",
    promptSnippet: "Inspect compact sub-agent identity, session id, and status.",
    promptGuidelines: ["Use get_parallel_agents for a compact list of existing sub-agents before coordinating them."],
    parameters: GetParallelAgentsParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = getParallelAgents(params as GetParallelAgentsInput, ctx);
      return jsonResult(output);
    },
  });

  pi.registerTool({
    name: "control_parallel_agent",
    label: "Control Parallel Agent",
    description: "Stop, resume, refresh, mark done, clean, retry blocked questions, review results, or set defaults for persisted parallel agents. Outputs include a queue array of parallel questions.",
    promptSnippet: "Control a parallel Pi sub-agent lifecycle, retry a blocked question, or review results.",
    promptGuidelines: ["Clean refuses live active agents; stop them before clean. Do not remove worktrees, branches, or sessions unless explicitly requested.", "Use action=retry_question only for blocked outgoing queue/steer questions.", "Use action=review_results before summarizing multiple child outputs."],
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
    promptGuidelines: ["Use reply_parallel_question when you know the child agent id and question id."],
    parameters: ReplyParallelQuestionParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await replyParallelQuestion(params as ReplyParallelQuestionInput, ctx);
      return jsonResult(output);
    },
  });
}

type StartAgentRenderColor = "toolTitle" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "toolOutput";

interface StartAgentTheme {
  fg(color: StartAgentRenderColor, text: string): string;
  bold(text: string): string;
}

interface ToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

function jsonResult(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function renderStartAgentCall(args: Partial<StartAgentInput>, theme: StartAgentTheme): string {
  const options = summarizeStartArgs(args);
  const prompt = truncateOneLine(typeof args.prompt === "string" ? args.prompt : "", 100) || "…";

  let text = theme.fg("toolTitle", theme.bold("start_agent ")) + theme.fg("accent", options.name);
  text += `\n  ${theme.fg("dim", `“${prompt}”`)}`;
  text += `\n  ${theme.fg("muted", summarizeMode(options))}`;

  const allowedTools = arrayOfStrings(args.allowedTools);
  const extras = [args.inheritContext ? "inherits context" : undefined, allowedTools?.length ? `tools: ${allowedTools.join(", ")}` : undefined].filter(
    (item): item is string => Boolean(item),
  );
  if (extras.length > 0) text += `\n  ${theme.fg("dim", extras.join(" · "))}`;

  return text;
}

function renderStartAgentPartial(args: Partial<StartAgentInput>, theme: StartAgentTheme): string {
  const options = summarizeStartArgs(args);

  return [
    `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold("Starting sub-agent"))} ${theme.fg("accent", options.name)}`,
    `  ${theme.fg("muted", summarizeMode(options))}`,
  ].join("\n");
}

function renderStartAgentResult(result: unknown, expanded: boolean, theme: StartAgentTheme, args: Partial<StartAgentInput>): string {
  const toolResult = asRecord(result) as ToolResultLike | null;
  const output = parseStartAgentOutput(toolResult?.details) ?? parseStartAgentOutputFromContent(toolResult);
  if (!output) return fallbackToolText(toolResult, theme);
  if (output.ok === false) return `${theme.fg("error", "✗")} ${theme.fg("error", "Failed to start sub-agent")}`;

  const child = asRecord(output.result);
  if (!child) return fallbackToolText(toolResult, theme);
  if (isWaitInitialResponseResult(child)) return renderWaitInitialResponseResult(child, expanded, theme);
  if (isSingleResponseResult(child)) return renderSingleResponseResult(child, expanded, theme, args);
  return renderPersistentStartResult(child, expanded, theme);
}

function renderSingleResponseResult(result: Record<string, unknown>, expanded: boolean, theme: StartAgentTheme, args: Partial<StartAgentInput>): string {
  const answer = stringValue(result.answer).trim() || "(no answer)";
  const metadata = asRecord(result.metadata);
  const cleanup = asRecord(result.cleanup);
  const name = args.name?.trim();
  const agentId = stringValue(result.agentId);
  const titleSuffix = name ? ` · ${name}` : agentId ? ` · ${short(agentId)}` : "";
  const dedicatedWorktree = booleanValue(metadata?.dedicatedWorktree, false);
  const readOnly = booleanValue(metadata?.readOnly, true);
  const sessionRemoved = booleanValue(cleanup?.sessionRemoved, true);
  const worktreeRemoved = booleanValue(cleanup?.worktreeRemoved, false);
  const branchRemoved = booleanValue(cleanup?.branchRemoved, false);
  const kept = booleanValue(cleanup?.kept, false);

  let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(`Sub-agent completed${titleSuffix}`))}`;
  text += `\n${colorBlock(limitMultiline(answer, expanded ? 4_000 : 700, expanded ? 80 : 8), "  ", "toolOutput", theme)}`;

  const status = ["one-shot", dedicatedWorktree ? "dedicated worktree" : "shared checkout", readOnly ? "read-only" : "write-enabled"];
  status.push(kept ? "kept" : sessionRemoved ? "session cleaned" : "session ended");
  text += `\n\n  ${theme.fg("muted", status.join(" · "))}`;

  const model = formatModel(stringValue(metadata?.provider), stringValue(metadata?.model));
  const thinking = stringValue(metadata?.thinking);
  if (model || thinking) text += `\n  ${theme.fg("dim", `model: ${model || "?"}${thinking ? ` · thinking: ${thinking}` : ""}`)}`;

  if (!expanded) return text;

  const details = [
    agentId ? `agent id: ${agentId}` : undefined,
    `cwd: ${stringValue(metadata?.cwd) || "?"}`,
    `worktree: ${stringValue(metadata?.worktreePath) || (dedicatedWorktree && !worktreeRemoved ? "created" : "none")}`,
    `branch: ${stringValue(metadata?.branchName) || (dedicatedWorktree && !branchRemoved ? "created" : "none")}`,
    `session: ${stringValue(metadata?.sessionId) || "ephemeral"}`,
    `session file: ${stringValue(metadata?.sessionFile) || (sessionRemoved ? "removed" : "none")}`,
    `cleanup: session ${yesNo(sessionRemoved)}, worktree ${yesNo(worktreeRemoved)}, branch ${yesNo(branchRemoved)}, kept ${yesNo(kept)}`,
  ].filter((line): line is string => Boolean(line));
  text += `\n\n${theme.fg("muted", "Execution details:")}`;
  text += `\n${colorBlock(details.map((line) => `- ${line}`).join("\n"), "  ", "dim", theme)}`;
  return text;
}

function renderWaitInitialResponseResult(result: Record<string, unknown>, expanded: boolean, theme: StartAgentTheme): string {
  const agent = asRecord(result.agent) ?? {};
  const wait = asRecord(result.wait) ?? {};
  const waitStatus = stringValue(wait.status) || "completed";
  const displayName = stringValue(agent.displayName) || "agent";
  const agentId = stringValue(agent.agentId);
  const pid = numberValue(agent.pid);
  const answer = stringValue(result.answer).trim();
  const question = asRecord(wait.question);
  const title = waitStatus === "completed" ? "Sub-agent answered" : waitStatus === "timeout" ? "Started sub-agent; initial response timed out" : "Sub-agent needs parent input";

  let text = `${theme.fg(waitStatus === "completed" ? "success" : "warning", waitStatus === "completed" ? "✓" : "!")} ${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("accent", displayName)}`;
  const runtime = [`status: ${stringValue(agent.status) || "started"}`, pid !== undefined ? `pid: ${pid}` : undefined, agentId ? `id: ${short(agentId)}` : undefined].filter(
    (item): item is string => Boolean(item),
  );
  text += `\n  ${theme.fg("muted", runtime.join(" · "))}`;

  if (waitStatus === "completed") {
    text += `\n${colorBlock(limitMultiline(answer || "(no answer)", expanded ? 4_000 : 700, expanded ? 80 : 8), "  ", "toolOutput", theme)}`;
  } else if (waitStatus === "question") {
    const questionId = stringValue(question?.questionId);
    const message = stringValue(question?.message) || "Child is waiting for parent input.";
    text += `\n  ${theme.fg("warning", `question${questionId ? ` ${questionId}` : ""}: ${truncateOneLine(message, 180)}`)}`;
  } else {
    const timeoutMs = numberValue(wait.timeoutMs);
    text += `\n  ${theme.fg("warning", `No initial answer${timeoutMs ? ` after ${timeoutMs}ms` : " yet"}; child keeps running.`)}`;
  }

  const worktreePath = stringValue(agent.worktreePath);
  if (worktreePath) text += `\n  ${theme.fg("dim", `worktree: ${worktreePath}`)}`;
  text += `\n  ${theme.fg("dim", "Next: message_parallel_agent · get_parallel_agents · control_parallel_agent")}`;

  if (!expanded) return text;
  const details = [
    agentId ? `agent id: ${agentId}` : undefined,
    `wait status: ${waitStatus}`,
    `cwd: ${stringValue(agent.cwd) || "?"}`,
    `session id: ${stringValue(agent.sessionId) || "none"}`,
    `session file: ${stringValue(agent.sessionFile) || "none"}`,
    `model: ${formatModel(stringValue(agent.provider), stringValue(agent.model)) || "?"}${stringValue(agent.thinking) ? ` · thinking: ${stringValue(agent.thinking)}` : ""}`,
  ].filter((line): line is string => Boolean(line));
  text += `\n\n${theme.fg("muted", "Execution details:")}`;
  text += `\n${colorBlock(details.map((line) => `- ${line}`).join("\n"), "  ", "dim", theme)}`;
  return text;
}

function renderPersistentStartResult(result: Record<string, unknown>, expanded: boolean, theme: StartAgentTheme): string {
  const displayName = stringValue(result.displayName) || "agent";
  const agentId = stringValue(result.agentId);
  const status = stringValue(result.status) || "started";
  const pid = numberValue(result.pid);
  const dedicatedWorktree = booleanValue(result.dedicatedWorktree, true);
  const readOnly = booleanValue(result.readOnly, false);
  const singleResponse = booleanValue(result.singleResponse, false);
  const maxSubAgents = numberValue(result.maxSubAgents) ?? 0;
  const worktreePath = stringValue(result.worktreePath);
  const branchName = stringValue(result.branchName);
  const model = formatModel(stringValue(result.provider), stringValue(result.model));
  const thinking = stringValue(result.thinking);
  const allowedTools = arrayOfStrings(result.allowedTools);

  let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("Started sub-agent"))} ${theme.fg("accent", displayName)}`;
  const runtime = [`status: ${status}`, pid !== undefined ? `pid: ${pid}` : undefined, agentId ? `id: ${short(agentId)}` : undefined].filter(
    (item): item is string => Boolean(item),
  );
  text += `\n  ${theme.fg("muted", runtime.join(" · "))}`;
  text += `\n  ${theme.fg("muted", summarizeMode({ dedicatedWorktree, readOnly, singleResponse, maxSubAgents }))}`;
  if (worktreePath) text += `\n  ${theme.fg("dim", `worktree: ${worktreePath}`)}`;
  if (branchName) text += `\n  ${theme.fg("dim", `branch: ${branchName}`)}`;
  text += `\n  ${theme.fg("dim", "Next: message_parallel_agent · get_parallel_agents · control_parallel_agent")}`;

  if (!expanded) return text;

  const details = [
    agentId ? `agent id: ${agentId}` : undefined,
    `display name: ${displayName}`,
    `status: ${status}`,
    `pid: ${pid ?? "none"}`,
    `cwd: ${stringValue(result.cwd) || "?"}`,
    `worktree: ${worktreePath || "none"}`,
    `branch: ${branchName || "current checkout"}`,
    `session id: ${stringValue(result.sessionId) || "none"}`,
    `session file: ${stringValue(result.sessionFile) || "none"}`,
    `requester: ${stringValue(result.requesterAgentId) || "parent session"}`,
    `model: ${model || "?"}${thinking ? ` · thinking: ${thinking}` : ""}`,
    allowedTools ? `allowed tools: ${allowedTools.join(", ")}` : undefined,
  ].filter((line): line is string => Boolean(line));
  text += `\n\n${theme.fg("muted", "Execution details:")}`;
  text += `\n${colorBlock(details.map((line) => `- ${line}`).join("\n"), "  ", "dim", theme)}`;
  return text;
}

function parseStartAgentOutput(value: unknown): { ok?: boolean; result?: unknown } | null {
  const output = asRecord(value);
  if (!output || output.action !== "start_agent") return null;
  return { ok: booleanValue(output.ok, true), result: output.result };
}

function parseStartAgentOutputFromContent(result: ToolResultLike | null): { ok?: boolean; result?: unknown } | null {
  const first = result?.content?.[0];
  if (first?.type !== "text" || !first.text) return null;
  try {
    return parseStartAgentOutput(JSON.parse(first.text));
  } catch {
    return null;
  }
}

function isWaitInitialResponseResult(result: Record<string, unknown>): boolean {
  return Boolean(asRecord(result.agent) && asRecord(result.wait));
}

function isSingleResponseResult(result: Record<string, unknown>): boolean {
  return result.singleResponse === true || typeof result.answer === "string";
}

function fallbackToolText(result: ToolResultLike | null, theme: StartAgentTheme): string {
  const first = result?.content?.[0];
  if (first?.type === "text" && first.text) return first.text;
  if (result?.isError) return `${theme.fg("error", "✗")} ${theme.fg("error", "Failed to start sub-agent")}`;
  return `${theme.fg("success", "✓")} ${theme.fg("success", "start_agent completed")}`;
}

function summarizeStartArgs(args: Partial<StartAgentInput>): { name: string; dedicatedWorktree: boolean; readOnly: boolean; singleResponse: boolean; waitUntil?: "started" | "initial_response"; maxSubAgents: number } {
  const dedicatedWorktree = typeof args.dedicatedWorktree === "boolean" ? args.dedicatedWorktree : true;
  return {
    name: args.name?.trim() || "agent",
    dedicatedWorktree,
    readOnly: typeof args.readOnly === "boolean" ? args.readOnly : !dedicatedWorktree,
    singleResponse: typeof args.singleResponse === "boolean" ? args.singleResponse : false,
    ...(args.waitUntil ? { waitUntil: args.waitUntil } : {}),
    maxSubAgents: numberValue(args.maxSubAgents) ?? 0,
  };
}

function summarizeMode(options: { dedicatedWorktree: boolean; readOnly: boolean; singleResponse: boolean; waitUntil?: "started" | "initial_response"; maxSubAgents: number }): string {
  return [
    options.singleResponse ? "one-shot" : options.waitUntil === "initial_response" ? "wait for initial response" : "background",
    options.dedicatedWorktree ? "dedicated worktree" : "shared checkout",
    options.readOnly ? "read-only" : "write-enabled",
    options.maxSubAgents === 0 ? "no child agents" : `max children: ${options.maxSubAgents}`,
  ].join(" · ");
}

function colorBlock(text: string, prefix: string, color: StartAgentRenderColor, theme: StartAgentTheme): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${theme.fg(color, line)}`)
    .join("\n");
}

function limitMultiline(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split("\n");
  const limitedLines = lines.slice(0, maxLines);
  let limited = limitedLines.join("\n");
  const lineOverflow = lines.length > maxLines;
  const charOverflow = limited.length > maxChars;
  if (charOverflow) limited = `${limited.slice(0, Math.max(0, maxChars - 1))}…`;
  if (lineOverflow && !charOverflow) limited += `\n… ${lines.length - maxLines} more lines`;
  return limited;
}

function truncateOneLine(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatModel(provider: string, model: string): string {
  if (!provider || !model || model.includes("/")) return model;
  return `${provider}/${model}`;
}

function short(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
