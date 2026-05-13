import type { ParallelAgent } from "../state/types.js";

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
