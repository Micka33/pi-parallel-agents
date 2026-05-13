import { relative } from "node:path";
import { statusGlyph } from "../state/selectors.js";
import type { ParallelAgent } from "../state/types.js";

export function renderAgentLine(agent: ParallelAgent, repoRoot: string): string {
  const workspace = agent.workspaceMode === "current" ? "current/read-only" : "worktree";
  const modelThinking = `${agent.model ?? "?"}/${agent.thinking ?? "?"}`;
  const cwd = formatPath(agent.cwd, repoRoot);
  const session = agent.sessionId ? `session ${short(agent.sessionId)}` : agent.sessionFile ? "session file" : "no session";
  return `${statusGlyph(agent.status)} ${agent.displayName.padEnd(12)} ${agent.status.padEnd(9)} ${workspace.padEnd(17)} ${modelThinking.padEnd(16)} ${cwd} · ${session}`;
}

export function renderAgentsList(agents: ParallelAgent[], repoRoot: string): string {
  if (agents.length === 0) return "No parallel agents recorded for this repo.";
  return agents.map((agent) => renderAgentLine(agent, repoRoot)).join("\n");
}

export function renderAgentDetails(agent: ParallelAgent, repoRoot: string): string {
  return [
    `${agent.displayName} (${agent.agentId})`,
    `- status: ${agent.status}`,
    `- workspaceMode: ${agent.workspaceMode}`,
    `- accessMode: ${agent.accessMode}`,
    `- cwd: ${formatPath(agent.cwd, repoRoot)}`,
    `- worktree: ${agent.worktreePath ? formatPath(agent.worktreePath, repoRoot) : "none"}`,
    `- branch: ${agent.branchName ?? "current checkout"}`,
    `- model/thinking: ${agent.model ?? "?"}/${agent.thinking ?? "?"}`,
    `- pid: ${agent.pid ?? "none"}`,
    `- sessionId: ${agent.sessionId ?? "none"}`,
    `- sessionFile: ${agent.sessionFile ?? "none"}`,
    `- summary: ${agent.summary ?? "none"}`,
    agent.lastError ? `- lastError: ${agent.lastError}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderAgentsSummary(agents: ParallelAgent[], repoRoot: string): string {
  if (agents.length === 0) return "No parallel agents recorded for this repo.";
  return agents
    .map((agent) => {
      const heading = renderAgentLine(agent, repoRoot);
      return agent.summary ? `${heading}\n  ${agent.summary}` : heading;
    })
    .join("\n");
}

function formatPath(path: string, repoRoot: string): string {
  if (path === repoRoot) return "./";
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function short(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}
