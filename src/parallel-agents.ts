import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerParallelAgentCommands } from "./commands/index.js";
import { ensureStateInitialized } from "./lifecycle/state.js";
import { registerParallelAgentTools } from "./tools/index.js";
import { updateParallelAgentsWidget } from "./tui/widget.js";
import { resolveRepoRoot } from "./util/paths.js";
import { errorMessage } from "./util/errors.js";

export default function parallelAgentsExtension(pi: ExtensionAPI): void {
  let activeRepoRoot: string | undefined;

  registerParallelAgentTools(pi);
  registerParallelAgentCommands(pi, { getRepoRoot: () => activeRepoRoot });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const repoRoot = resolveRepoRoot(ctx.cwd);
      activeRepoRoot = repoRoot;
      await ensureStateInitialized(repoRoot);
      updateParallelAgentsWidget(ctx, repoRoot);
    } catch (error) {
      ctx.ui.notify(`parallel-agents init failed: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      updateParallelAgentsWidget(ctx);
    } catch {
      // Widget refresh is best-effort.
    }
  });
}
