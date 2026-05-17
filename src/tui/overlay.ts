import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ParallelAgent } from "../state/types.js";
import { renderAgentDetails } from "./render-agents.js";
import { renderQueueLine } from "./render-queues.js";

export function renderAgentsOverlay(agents: ParallelAgent[], repoRoot: string): string {
  if (agents.length === 0) return "No parallel agents recorded for this repo.";
  const statusCounts = countBy(agents, (agent) => agent.status);
  const blocked = agents.flatMap((agent) => (agent.queue ?? []).filter((question) => question.status === "blocked"));
  const incoming = agents.flatMap((agent) => (agent.queue ?? []).filter((question) => question.direction === "incoming" && question.status === "queued"));
  const guardrails = agents
    .filter((agent) => agent.workspaceMode === "current")
    .map((agent) => `! ${agent.agentId}: current/${agent.accessMode} shares the parent checkout${agent.accessMode === "write" ? " and can modify it" : ""}`);

  return [
    "Parallel agents overlay",
    `Repo: ${repoRoot}`,
    `Status: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(", ")}`,
    "Actions: /agents-open <id> · /agents-consult <id> <question> · /agents-steer <id> <message> · /agents-ask <id> <message> · /agents-retry <id> <question-id> · /agents-review [id] · /agents-stop <id> · /agents-resume <id>",
    guardrails.length ? `Guardrails:\n${guardrails.join("\n")}` : undefined,
    blocked.length ? `Blocked questions:\n${blocked.map(renderQueueLine).join("\n")}` : undefined,
    incoming.length ? `Incoming questions awaiting reply:\n${incoming.map(renderQueueLine).join("\n")}` : undefined,
    "",
    ...agents.map((agent) => renderAgentDetails(agent, repoRoot)),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function showAgentsOverlay(ctx: ExtensionCommandContext, agents: ParallelAgent[], repoRoot: string): void {
  // Keep the UX portable across Pi modes: render multi-agent status, queues, and
  // actionable commands in a notification panel.
  ctx.ui.notify(renderAgentsOverlay(agents, repoRoot), "info");
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
