import { queueAdapterForRepo } from "../queues/question-router.js";
import { toParallelAgent } from "../state/selectors.js";
import { StateReader } from "../state/state-reader.js";
import type { ParallelAgent, QueueQuestionRow } from "../state/types.js";
import { stateDbPath } from "../util/paths.js";

export interface ResultsReview {
  ok: true;
  action: "review_results";
  repoRoot: string;
  count: number;
  statusCounts: Record<string, number>;
  agents: Array<{
    agentId: string;
    displayName: string;
    status: string;
    workspaceMode: string;
    accessMode: string;
    summary: string | null;
    diffSummary: string | null;
    testsJson: string | null;
    blockedQuestions: number;
    unansweredIncoming: number;
    deliveredOutgoing: number;
    lastError: string | null;
  }>;
  blockedQuestions: QueueQuestionRow[];
  recommendations: string[];
  markdown: string;
}

export function buildResultsReview(repoRoot: string, agentId?: string): ResultsReview {
  const reader = new StateReader(stateDbPath(repoRoot));
  const queueAdapter = queueAdapterForRepo(repoRoot);
  const rows = reader.readAgents(agentId ? { agentId } : { repoRoot });
  const agents = rows.map((row) => toParallelAgent(row, undefined, undefined, queueAdapter.listQuestions({ agentId: row.agent_id })));
  const statusCounts = countBy(agents, (agent) => agent.status);
  const blockedQuestions = agents.flatMap((agent) => (agent.queue ?? []).filter((question) => question.status === "blocked"));
  const summaries = agents.map((agent) => summarizeAgent(agent));
  const recommendations = buildRecommendations(agents, blockedQuestions);
  const markdown = renderReviewMarkdown(repoRoot, summaries, statusCounts, blockedQuestions, recommendations);

  return {
    ok: true,
    action: "review_results",
    repoRoot,
    count: agents.length,
    statusCounts,
    agents: summaries,
    blockedQuestions,
    recommendations,
    markdown,
  };
}

function summarizeAgent(agent: ParallelAgent): ResultsReview["agents"][number] {
  const queue = agent.queue ?? [];
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    status: agent.status,
    workspaceMode: agent.workspaceMode,
    accessMode: agent.accessMode,
    summary: agent.summary,
    diffSummary: agent.diffSummary,
    testsJson: agent.testsJson,
    blockedQuestions: queue.filter((question) => question.status === "blocked").length,
    unansweredIncoming: queue.filter((question) => question.direction === "incoming" && question.status === "queued").length,
    deliveredOutgoing: queue.filter((question) => question.direction === "outgoing" && question.status === "delivered").length,
    lastError: agent.lastError,
  };
}

function buildRecommendations(agents: ParallelAgent[], blockedQuestions: QueueQuestionRow[]): string[] {
  const recommendations: string[] = [];
  if (blockedQuestions.length) recommendations.push(`Retry or cancel ${blockedQuestions.length} blocked question(s) with /agents-retry <agent-id> <question-id>.`);
  const waitingWithoutSummary = agents.filter((agent) => (agent.status === "waiting" || agent.status === "stopped") && !agent.summary);
  if (waitingWithoutSummary.length) recommendations.push(`Ask ${waitingWithoutSummary.length} idle agent(s) for a final summary, then mark them done.`);
  const running = agents.filter((agent) => agent.status === "running" || agent.status === "starting");
  if (running.length) recommendations.push(`Wait for ${running.length} active agent(s) or inspect them with /agents-open.`);
  const currentWrite = agents.filter((agent) => agent.workspaceMode === "current" && agent.accessMode === "write");
  if (currentWrite.length) recommendations.push("Audit current/write agents carefully: they share the parent checkout.");
  const doneWithDiff = agents.filter((agent) => agent.status === "done" && agent.diffSummary);
  if (doneWithDiff.length) recommendations.push(`Review diff summaries from ${doneWithDiff.length} completed agent(s) before merging.`);
  if (!recommendations.length) recommendations.push("No immediate follow-up detected. Review summaries and tests, then clean evidence when no longer needed.");
  return recommendations;
}

function renderReviewMarkdown(
  repoRoot: string,
  agents: ResultsReview["agents"],
  statusCounts: Record<string, number>,
  blockedQuestions: QueueQuestionRow[],
  recommendations: string[],
): string {
  const lines = [
    `# Parallel agents review`,
    "",
    `Repo: ${repoRoot}`,
    `Agents: ${agents.length}`,
    `Status: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
    "",
    "## Agents",
  ];

  for (const agent of agents) {
    lines.push(
      `- ${agent.displayName} (${agent.agentId}): ${agent.status}, ${agent.workspaceMode}/${agent.accessMode}`,
      `  - summary: ${agent.summary ?? "none"}`,
      `  - diff: ${agent.diffSummary ?? "none"}`,
      `  - tests: ${agent.testsJson ?? "none"}`,
      `  - queues: blocked=${agent.blockedQuestions}, unansweredIncoming=${agent.unansweredIncoming}, deliveredOutgoing=${agent.deliveredOutgoing}`,
    );
    if (agent.lastError) lines.push(`  - lastError: ${agent.lastError}`);
  }

  lines.push("", "## Blocked questions");
  if (!blockedQuestions.length) lines.push("- none");
  for (const question of blockedQuestions) {
    lines.push(`- ${question.agent_id}/${question.question_id}: ${question.mode} · ${question.message}`);
  }

  lines.push("", "## Recommendations");
  for (const recommendation of recommendations) lines.push(`- ${recommendation}`);
  return lines.join("\n");
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
