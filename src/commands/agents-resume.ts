import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsResumeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const agentId = args.trim();
  if (!agentId) {
    ctx.ui.notify("Usage: /agents-resume <agent-id>", "warning");
    return;
  }
  const result = await controlParallelAgent({ action: "resume", agentId }, ctx);
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}
