import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildPrompt } from "../config/task-presets.js";
import type { ResolvedAgentOptions } from "../config/resolve-agent-options.js";
import { runtimeDir, scriptPath, stateDbPath, tasksDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export interface StartParallelAgentResult {
  agentId: string;
  displayName: string;
  pid: number | null;
  workspaceMode: "worktree" | "current";
  accessMode: "read_only" | "write";
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

export interface StartAgentInput {
  repoRoot: string;
  parentPrompt: string;
  options: ResolvedAgentOptions;
  ctx: ExtensionContext;
}

export async function startParallelAgent(input: StartAgentInput): Promise<StartParallelAgentResult> {
  const runtime = runtimeDir(input.repoRoot);
  const tmpDir = join(runtime, "tmp");
  mkdirSync(tmpDir, { recursive: true });

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const contextPath = join(tmpDir, `context-${suffix}.json`);
  const promptPath = join(tmpDir, `prompt-${suffix}.md`);
  const prompt = buildChildPrompt(input.options, input.parentPrompt);
  const parentSessionId = resolveParentSessionId(input.ctx);

  writeFileSync(
    contextPath,
    JSON.stringify(
      {
        repoRoot: input.repoRoot,
        parentSessionId,
        parentPrompt: input.parentPrompt,
        agentPrompt: input.options.prompt,
        name: input.options.name,
        suggestedName: input.options.name,
        provider: input.options.provider,
        model: input.options.model,
        thinking: input.options.thinking,
        workspaceMode: input.options.workspaceMode,
        accessMode: input.options.accessMode,
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
    "--workspace-mode",
    input.options.workspaceMode,
    "--access-mode",
    input.options.accessMode,
    "--state-db",
    stateDbPath(input.repoRoot),
    "--tasks-db",
    tasksDbPath(input.repoRoot),
  ];
  if (input.options.provider) args.push("--provider", input.options.provider);

  const result = await runJsonScript<StartParallelAgentResult>(scriptPath("start-parallel-agent.sh"), args, {
    cwd: input.repoRoot,
    timeoutMs: Number(process.env.PI_PARALLEL_AGENTS_EXTENSION_START_TIMEOUT_MS ?? 45_000),
  });
  return result.json;
}

function resolveParentSessionId(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (sessionFile) return `pi-session:${createHash("sha256").update(sessionFile).digest("hex").slice(0, 16)}`;
  return `pi-process:${process.pid}`;
}
