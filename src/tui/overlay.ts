import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildResultsReview } from "../review/results-review.js";
import type { ParallelAgent } from "../state/types.js";
import { renderAgentsList } from "./render-agents.js";

export function renderOverlay(repoRoot: string, agents: ParallelAgent[]): string {
  const counts = countBy(agents, (agent) => agent.status);
  const header = `Parallel agents · ${repoRoot} · ${Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" ") || "none"}`;
  const visible = agents.filter((agent) => agent.status !== "cleaned");
  const guardrails = visible
    .filter((agent) => !agent.dedicatedWorktree)
    .map((agent) => `! ${agent.agentId}: shared checkout (${agent.readOnly ? "read-only" : "write"})`);
  const blocked = visible.flatMap((agent) => (agent.queue ?? []).filter((question) => question.status === "blocked").map((question) => `? blocked ${agent.agentId}/${question.question_id}: ${question.message}`));
  const incoming = visible.flatMap((agent) => (agent.queue ?? []).filter((question) => question.direction === "incoming" && question.status === "queued").map((question) => `? reply ${agent.agentId}/${question.question_id}: ${question.message}`));
  const lines = [
    header,
    renderAgentsList(visible, repoRoot),
    guardrails.length ? `Guardrails:\n${guardrails.join("\n")}` : undefined,
    blocked.length ? `Blocked:\n${blocked.join("\n")}` : undefined,
    incoming.length ? `Incoming questions:\n${incoming.join("\n")}` : undefined,
    "Actions: /agents-open <id> · /agents-steer <id> <message> · /agents-ask <id> <message> · /agents-retry <id> <question-id> · /agents-review [id] · /agents-stop <id> · /agents-resume <id>",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function showAgentsOverlay(ctx: ExtensionContext, agents: ParallelAgent[], repoRoot: string): void {
  ctx.ui.notify(renderOverlay(repoRoot, agents), "info");
}

export function notifyReview(ctx: ExtensionContext, repoRoot: string, agentId?: string): void {
  const review = buildResultsReview(repoRoot, agentId);
  ctx.ui.notify(review.markdown, "info");
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
