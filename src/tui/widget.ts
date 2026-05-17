import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WIDGET_KEY } from "../constants.js";
import { StateReader } from "../state/state-reader.js";
import { toParallelAgent } from "../state/selectors.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import { renderAgentLine } from "./render-agents.js";

export function updateParallelAgentsWidget(ctx: ExtensionContext, repoRoot = resolveRepoRoot(ctx.cwd)): void {
  const reader = new StateReader(stateDbPath(repoRoot));
  const agents = reader
    .readAgents({ repoRoot })
    .map((row) => toParallelAgent(row))
    .filter((agent) => agent.status !== "cleaned");
  if (agents.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  const lines = ["Parallel agents", ...agents.map((agent) => renderAgentLine(agent, repoRoot))];
  ctx.ui.setWidget(WIDGET_KEY, lines);
}
