import { tasksDbPath } from "../util/paths.js";
import { PiTasksQueueAdapter } from "./pi-tasks-adapter.js";

export function queueAdapterForRepo(repoRoot: string): PiTasksQueueAdapter {
  const adapter = new PiTasksQueueAdapter(tasksDbPath(repoRoot));
  adapter.init();
  return adapter;
}
