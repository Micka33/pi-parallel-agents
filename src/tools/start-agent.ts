import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { buildChildPrompt } from "../config/task-presets.js";
import { defaultsFromSettings } from "../config/defaults.js";
import { resolveStartAgentOptions, type ResolvedAgentOptions } from "../config/resolve-agent-options.js";
import { ensureStateInitialized } from "../lifecycle/state.js";
import { resolveRequesterAgentId, startParallelAgent } from "../lifecycle/start-agent.js";
import { resolveChildAllowedTools } from "../security/tool-policy.js";
import { StateReader } from "../state/state-reader.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import type { StartAgentInput } from "./schemas.js";

export interface StartAgentOutput {
  ok: boolean;
  action: "start_agent";
  singleResponse: boolean;
  result: unknown;
}

export async function startAgent(params: StartAgentInput, ctx: ExtensionContext, activeTools?: string[], parentThinkingLevel?: string): Promise<StartAgentOutput> {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  await ensureStateInitialized(repoRoot);
  const reader = new StateReader(stateDbPath(repoRoot));
  const configuredDefaults = defaultsFromSettings(reader.readSettings());
  const resolved = resolveStartAgentOptions(params, {}, configuredDefaults, resolveParentModel(ctx, parentThinkingLevel));
  const parentPrompt = extractLastUserPrompt(ctx) ?? "";

  if (isNarrowInlineSingleResponse(resolved)) {
    assertRequesterCanStartChild(reader, resolveRequesterAgentId(ctx));
    const result = await runInlineSingleResponse(resolved, repoRoot, ctx, activeTools, parentPrompt);
    updateParallelAgentsWidget(ctx, repoRoot);
    return { ok: true, action: "start_agent", singleResponse: true, result };
  }

  const input = { repoRoot, parentPrompt, options: resolved, ctx };
  const result = await startParallelAgent(activeTools ? { ...input, activeTools } : input);
  updateParallelAgentsWidget(ctx, repoRoot);
  return { ok: true, action: "start_agent", singleResponse: resolved.singleResponse, result };
}

function isNarrowInlineSingleResponse(options: ResolvedAgentOptions): boolean {
  return options.singleResponse && !options.dedicatedWorktree && options.readOnly && options.maxSubAgents === 0;
}

function assertRequesterCanStartChild(reader: StateReader, requesterAgentId: string): void {
  const requester = reader.readAgents({ agentId: requesterAgentId })[0];
  if (!requester) return;
  const limit = Number(requester.max_sub_agents ?? 0);
  const children = reader.readAgents().filter((agent) => agent.requester_agent_id === requesterAgentId && agent.status !== "cleaned");
  if (children.length < limit) return;
  const active = children.map((child) => ({ agentId: child.agent_id, status: child.status }));
  throw new Error(
    `Sub-agent limit exceeded for requester ${requesterAgentId}: configured limit=${limit}, current child count=${children.length}, active children=${JSON.stringify(active)}. Stop/clean an existing child or start the requester with a higher maxSubAgents.`,
  );
}

async function runInlineSingleResponse(
  options: ResolvedAgentOptions,
  cwd: string,
  ctx: ExtensionContext,
  activeTools: string[] | undefined,
  parentPrompt: string,
): Promise<unknown> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    appendSystemPrompt: options.systemPrompt ? [options.systemPrompt] : [],
  });
  await loader.reload();

  const tools = resolveChildAllowedTools({ inheritedTools: activeTools, allowedTools: options.allowedTools, readOnly: true, maxSubAgents: 0 });
  const model = resolveModelOverride(ctx, options);
  const sessionManager = createInlineSessionManager(ctx, cwd, options.inheritContext);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager,
    ...(model ? { model } : {}),
    thinkingLevel: options.thinkingLevel as ThinkingLevel,
    ...(tools !== undefined ? { tools } : {}),
  });

  let answer = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") answer = extractAssistantText(event.message) || answer;
    if (event.type === "agent_end") answer = extractAssistantText(event.messages) || answer;
  });

  try {
    const prompt = buildChildPrompt(options, options.inheritContext ? "" : parentPrompt);
    await session.prompt(prompt);
    answer = answer || extractAssistantText(session.messages);
    return {
      ok: true,
      action: "start_agent",
      singleResponse: true,
      inline: true,
      answer,
      metadata: {
        cwd,
        model: session.model ? `${session.model.provider}/${session.model.id}` : null,
        thinking: session.thinkingLevel,
        readOnly: true,
        dedicatedWorktree: false,
        inheritContext: options.inheritContext,
      },
      cleanup: { sessionRemoved: true, worktreeRemoved: false, branchRemoved: false, kept: false },
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}

function createInlineSessionManager(ctx: ExtensionContext, cwd: string, inheritContext: boolean): SessionManager {
  const sessionManager = SessionManager.inMemory(cwd);
  if (!inheritContext) return sessionManager;

  const branch = (ctx.sessionManager.getBranch?.() ?? []) as InlineBranchEntry[];
  const preLaunchLeafId = findPreLaunchLeafId(branch);
  if (!preLaunchLeafId) return sessionManager;

  const inheritedBranch = (ctx.sessionManager.getBranch?.(preLaunchLeafId) ?? []) as InlineBranchEntry[];
  for (const entry of inheritedBranch) appendInlineInheritedEntry(sessionManager, entry);
  return sessionManager;
}

interface InlineBranchEntry {
  type: string;
  id: string;
  message?: unknown;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
}

function appendInlineInheritedEntry(sessionManager: SessionManager, entry: InlineBranchEntry): void {
  if (entry.type === "message" && entry.message) {
    sessionManager.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
    return;
  }
  if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
    sessionManager.appendThinkingLevelChange(entry.thinkingLevel);
    return;
  }
  if (entry.type === "model_change" && entry.provider && entry.modelId) {
    sessionManager.appendModelChange(entry.provider, entry.modelId);
  }
}

function findPreLaunchLeafId(branch: InlineBranchEntry[]): string | null {
  if (branch.length === 0) return null;
  const launchUserIndex = findLastIndex(branch, (entry) => entry.type === "message" && isUserMessage(entry.message));
  if (launchUserIndex === -1) return branch.at(-1)?.id ?? null;
  if (launchUserIndex === 0) return null;
  return branch[launchUserIndex - 1]?.id ?? null;
}

function isUserMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && "role" in message && (message as { role?: unknown }).role === "user");
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

function resolveModelOverride(ctx: ExtensionContext, options: ResolvedAgentOptions): Model<any> | undefined {
  if (options.provider) return ctx.modelRegistry.find(options.provider, options.model);
  if (options.model && ctx.model?.id !== options.model) return ctx.modelRegistry.getAll().find((model) => model.id === options.model);
  return ctx.model;
}

function resolveParentModel(ctx: ExtensionContext, thinkingLevel?: string): { provider?: string; model?: string; thinkingLevel?: string } {
  const model = ctx.model;
  return {
    ...(model && typeof model.provider === "string" && model.provider ? { provider: model.provider } : {}),
    ...(model && typeof model.id === "string" && model.id ? { model: model.id } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

function extractLastUserPrompt(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { message?: { role?: string; content?: unknown }; type?: string; content?: unknown };
    const message = entry.message;
    if (message?.role === "user") return contentToText(message.content);
  }
  return undefined;
}

function contentToText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function extractAssistantText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (typeof value !== "object") return "";
  const object = value as { role?: string; text?: string; content?: unknown; messages?: unknown; message?: unknown };
  if (object.role && object.role !== "assistant") return "";
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  if (Array.isArray(object.content)) return object.content.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (Array.isArray(object.messages)) return object.messages.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (object.message) return extractAssistantText(object.message);
  return "";
}
