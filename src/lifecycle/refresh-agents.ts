import { StateReader } from "../state/state-reader.js";
import { toParallelAgent } from "../state/selectors.js";
import type { ParallelAgent } from "../state/types.js";
import { scriptPath, stateDbPath } from "../util/paths.js";
import { runJsonScript } from "./script-runner.js";

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function annotateProcessLiveness<T extends ParallelAgent>(agents: T[]): Array<T & { processAlive: boolean }> {
  return agents.map((agent) => ({ ...agent, processAlive: isPidAlive(agent.pid) }));
}

export async function refreshParallelAgents(repoRoot: string): Promise<ParallelAgent[]> {
  const reader = new StateReader(stateDbPath(repoRoot));
  const agents = reader.readAgents({ repoRoot }).map((row) => toParallelAgent(row));
  await Promise.all(
    agents.map(async (agent) => {
      if ((agent.status === "starting" || agent.status === "running" || agent.status === "waiting") && !isPidAlive(agent.pid)) {
        await runJsonScript(
          scriptPath("parallel-agent-state.sh"),
          [
            "mark-crashed",
            "--state-db",
            stateDbPath(repoRoot),
            "--agent-id",
            agent.agentId,
            "--last-error",
            `Process ${agent.pid ?? "<none>"} is not alive`,
          ],
          { cwd: repoRoot, timeoutMs: 10_000 },
        );
      }
    }),
  );
  const refreshed = new StateReader(stateDbPath(repoRoot));
  return refreshed.readAgents({ repoRoot }).map((row) => toParallelAgent(row));
}
