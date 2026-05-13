import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultsFromSettings } from "../config/defaults.js";
import { resolveAgentOptions } from "../config/resolve-agent-options.js";
import { ensureStateInitialized } from "../lifecycle/state.js";
import { startParallelAgent, type StartParallelAgentResult } from "../lifecycle/start-agent.js";
import { StateReader } from "../state/state-reader.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import type { LaunchParallelAgentsInput } from "./schemas.js";

export interface LaunchParallelAgentsFailure {
  name: string;
  error: string;
}

export interface LaunchParallelAgentsOutput {
  launched: StartParallelAgentResult[];
  failed: LaunchParallelAgentsFailure[];
}

export async function launchParallelAgents(params: LaunchParallelAgentsInput, ctx: ExtensionContext): Promise<LaunchParallelAgentsOutput> {
  if (!params.agents?.length) throw new Error("launch_parallel_agents requires at least one agent");

  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  await ensureStateInitialized(repoRoot);
  const reader = new StateReader(stateDbPath(repoRoot));
  const configuredDefaults = defaultsFromSettings(reader.readSettings());
  const parentPrompt = params.parentPrompt ?? extractLastUserPrompt(ctx) ?? "";

  const parentModel = resolveParentModel(ctx);
  const settled = await Promise.allSettled(
    params.agents.map(async (spec) => {
      const resolved = resolveAgentOptions(spec, params, configuredDefaults, parentModel);
      return startParallelAgent({ repoRoot, parentPrompt, options: resolved, ctx });
    }),
  );

  const launched: StartParallelAgentResult[] = [];
  const failed: LaunchParallelAgentsFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const spec = params.agents[index]!;
    if (result.status === "fulfilled") {
      launched.push(result.value);
    } else {
      failed.push({ name: spec.name, error: errorText(result.reason) });
    }
  }

  updateParallelAgentsWidget(ctx, repoRoot);
  return { launched, failed };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveParentModel(ctx: ExtensionContext): { provider?: string; model?: string } {
  const model = ctx.model;
  if (!model) return {};
  return {
    ...(typeof model.provider === "string" && model.provider ? { provider: model.provider } : {}),
    ...(typeof model.id === "string" && model.id ? { model: model.id } : {}),
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
