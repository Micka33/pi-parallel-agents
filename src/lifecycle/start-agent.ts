import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildPrompt } from "../config/task-presets.js";
import type { ResolvedAgentOptions } from "../config/resolve-agent-options.js";
import { resolveChildAllowedTools } from "../security/tool-policy.js";
import { runtimeDir, scriptPath, stateDbPath, tasksDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface StartParallelAgentResult {
  agentId: string;
  displayName: string;
  pid: number | null;
  dedicatedWorktree: boolean;
  readOnly: boolean;
  singleResponse: boolean;
  inheritContext: boolean;
  maxSubAgents: number;
  allowedTools: string[] | null;
  requesterAgentId: string | null;
  cwd: string;
  provider: string | null;
  model: string;
  thinking: string;
  branchName: string | null;
  worktreePath: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  status: string;
}

export interface StartParallelAgentWaitResult {
  agent: StartParallelAgentResult;
  answer: string;
  wait: {
    until: "initial_response";
    status: "completed" | "timeout" | "question";
    timeoutMs?: number;
    question?: {
      questionId: string;
      agentId: string;
      direction: string;
      mode: string;
      status: string;
      message: string;
    };
  };
}

export interface StartAgentInput {
  repoRoot: string;
  parentPrompt: string;
  options: ResolvedAgentOptions;
  ctx: ExtensionContext;
  activeTools?: string[];
}

export async function startParallelAgent(input: StartAgentInput): Promise<StartParallelAgentResult | StartParallelAgentWaitResult> {
  const runtime = runtimeDir(input.repoRoot);
  const tmpDir = join(runtime, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contextPath = join(tmpDir, `context-${suffix}.json`);
  const promptPath = join(tmpDir, `prompt-${suffix}.md`);
  const prompt = buildChildPrompt(input.options, input.options.inheritContext ? "" : input.parentPrompt);
  const parentSessionId = resolveParentSessionId(input.ctx);
  const requesterAgentId = resolveRequesterAgentId(input.ctx);
  const allowedTools = resolveChildAllowedTools({
    inheritedTools: input.activeTools,
    allowedTools: input.options.allowedTools,
    readOnly: input.options.readOnly,
    maxSubAgents: input.options.maxSubAgents,
  });
  const inheritedSession = input.options.inheritContext ? createInheritedSessionFile(input.ctx, tmpDir, suffix) : null;

  writeFileSync(
    contextPath,
    JSON.stringify(
      {
        repoRoot: input.repoRoot,
        parentSessionId,
        requesterAgentId,
        parentPrompt: input.parentPrompt,
        agentPrompt: input.options.prompt,
        name: input.options.name,
        suggestedName: input.options.name,
        provider: input.options.provider,
        model: input.options.model,
        thinking: input.options.thinking,
        thinkingLevel: input.options.thinkingLevel,
        dedicatedWorktree: input.options.dedicatedWorktree,
        readOnly: input.options.readOnly,
        singleResponse: input.options.singleResponse,
        waitUntil: input.options.waitUntil,
        waitTimeoutMs: input.options.waitTimeoutMs,
        inheritContext: input.options.inheritContext,
        inheritedSessionFile: inheritedSession?.sessionFile ?? null,
        inheritedSessionLeafId: inheritedSession?.leafId ?? null,
        maxSubAgents: input.options.maxSubAgents,
        allowedTools,
        systemPrompt: input.options.systemPrompt,
        keep: input.options.keep,
      },
      null,
      2,
    ),
  );
  writeFileSync(promptPath, prompt);

  const args = [
    "--context",
    contextPath,
    "--prompt",
    promptPath,
    "--model",
    input.options.model,
    "--thinking",
    input.options.thinking,
    "--state-db",
    stateDbPath(input.repoRoot),
    "--tasks-db",
    tasksDbPath(input.repoRoot),
  ];
  if (input.options.provider) args.push("--provider", input.options.provider);

  const timeoutMs = resolveStartScriptTimeout(input.options);
  const result = await runJsonScript<StartParallelAgentResult | StartParallelAgentWaitResult>(
    scriptPath("start-parallel-agent.sh"),
    args,
    timeoutMs === undefined ? { cwd: input.repoRoot } : { cwd: input.repoRoot, timeoutMs },
  );
  return result.json;
}

interface InheritedSessionFile {
  sessionFile: string;
  leafId: string;
}

interface BranchEntry {
  type: string;
  id: string;
  parentId: string | null;
  message?: { role?: string };
}

function createInheritedSessionFile(ctx: ExtensionContext, tmpDir: string, suffix: string): InheritedSessionFile | null {
  const branch = (ctx.sessionManager.getBranch?.() ?? []) as BranchEntry[];
  const preLaunchLeafId = findPreLaunchLeafId(branch);
  if (!preLaunchLeafId) return null;

  const inheritedBranch = (ctx.sessionManager.getBranch?.(preLaunchLeafId) ?? []) as BranchEntry[];
  if (inheritedBranch.length === 0) return null;

  const timestamp = new Date().toISOString();
  const sessionId = `parallel-inherited-${randomUUID()}`;
  const sessionFile = join(tmpDir, `inherited-${suffix}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd: ctx.sessionManager.getCwd?.() ?? ctx.cwd,
    parentSession: ctx.sessionManager.getSessionFile?.(),
  };
  writeFileSync(sessionFile, [header, ...inheritedBranch].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { sessionFile, leafId: preLaunchLeafId };
}

function findPreLaunchLeafId(branch: BranchEntry[]): string | null {
  if (branch.length === 0) return null;
  const launchUserIndex = findLastIndex(branch, (entry) => entry.type === "message" && entry.message?.role === "user");
  if (launchUserIndex === -1) return branch.at(-1)?.id ?? null;
  if (launchUserIndex === 0) return null;
  return branch[launchUserIndex - 1]?.id ?? null;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
}

function resolveStartScriptTimeout(options: ResolvedAgentOptions): number | undefined {
  if (options.singleResponse) {
    const value = Number(process.env.PI_PARALLEL_AGENTS_EXTENSION_SINGLE_RESPONSE_TIMEOUT_MS ?? 0);
    return value > 0 ? value : undefined;
  }
  if (options.waitUntil === "initial_response") {
    const startupTimeoutMs = Number(process.env.PI_PARALLEL_AGENTS_EXTENSION_START_TIMEOUT_MS ?? 45_000);
    return options.waitTimeoutMs ? options.waitTimeoutMs + startupTimeoutMs : undefined;
  }
  return Number(process.env.PI_PARALLEL_AGENTS_EXTENSION_START_TIMEOUT_MS ?? 45_000);
}

export function resolveParentSessionId(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (sessionFile) return `pi-session:${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}`;
  return `pi-process:${process.pid}`;
}

export function resolveRequesterAgentId(ctx: ExtensionContext): string {
  return process.env.PI_PARALLEL_AGENTS_AGENT_ID || resolveParentSessionId(ctx);
}
