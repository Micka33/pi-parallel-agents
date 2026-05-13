import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanParallelAgent } from "../lifecycle/clean-agent.js";
import { refreshParallelAgents } from "../lifecycle/refresh-agents.js";
import { resumeParallelAgent } from "../lifecycle/resume-agent.js";
import { runJsonScript } from "../lifecycle/script-runner.js";
import { stopParallelAgent } from "../lifecycle/stop-agent.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot, scriptPath, stateDbPath } from "../util/paths.js";
import type { ControlParallelAgentInput } from "./schemas.js";

export async function controlParallelAgent(params: ControlParallelAgentInput, ctx: ExtensionContext): Promise<unknown> {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  switch (params.action) {
    case "stop": {
      const agentId = requireAgentId(params);
      const result = await stopParallelAgent(repoRoot, agentId);
      updateParallelAgentsWidget(ctx, repoRoot);
      return result;
    }
    case "resume": {
      const agentId = requireAgentId(params);
      const result = await resumeParallelAgent(repoRoot, agentId);
      updateParallelAgentsWidget(ctx, repoRoot);
      return result;
    }
    case "set_defaults": {
      if (params.model === undefined && params.thinking === undefined) throw new Error("set_defaults requires model or thinking");
      const args = ["set-defaults", "--state-db", stateDbPath(repoRoot)];
      if (params.model !== undefined) args.push("--model", params.model);
      if (params.thinking !== undefined) args.push("--thinking", params.thinking);
      const result = await runJsonScript(scriptPath("parallel-agent-state.sh"), args, { cwd: repoRoot, timeoutMs: 10_000 });
      updateParallelAgentsWidget(ctx, repoRoot);
      return result.json;
    }
    case "refresh": {
      const agents = await refreshParallelAgents(repoRoot);
      updateParallelAgentsWidget(ctx, repoRoot);
      return { ok: true, action: "refresh", agents, count: agents.length };
    }
    case "mark_done": {
      const agentId = requireAgentId(params);
      const args = ["mark-done", "--state-db", stateDbPath(repoRoot), "--agent-id", agentId];
      if (params.summary !== undefined) args.push("--summary", params.summary);
      if (params.diffSummary !== undefined) args.push("--diff-summary", params.diffSummary);
      if (params.testsJson !== undefined) args.push("--tests-json", params.testsJson);
      const result = await runJsonScript(scriptPath("parallel-agent-state.sh"), args, { cwd: repoRoot, timeoutMs: 10_000 });
      updateParallelAgentsWidget(ctx, repoRoot);
      return result.json;
    }
    case "clean": {
      const agentId = requireAgentId(params);
      const cleanOptions: Parameters<typeof cleanParallelAgent>[2] = {};
      if (params.removeWorktree !== undefined) cleanOptions.removeWorktree = params.removeWorktree;
      if (params.removeBranch !== undefined) cleanOptions.removeBranch = params.removeBranch;
      if (params.removeSession !== undefined) cleanOptions.removeSession = params.removeSession;
      if (params.deleteHistory !== undefined) cleanOptions.deleteHistory = params.deleteHistory;
      if (params.force !== undefined) cleanOptions.force = params.force;
      const result = await cleanParallelAgent(repoRoot, agentId, cleanOptions);
      updateParallelAgentsWidget(ctx, repoRoot);
      return result;
    }
    default:
      throw new Error(`Unsupported control action: ${(params as { action: string }).action}`);
  }
}

function requireAgentId(params: ControlParallelAgentInput): string {
  if (!params.agentId) throw new Error(`${params.action} requires agentId`);
  return params.agentId;
}
