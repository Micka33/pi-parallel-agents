import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsStopCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const agentId = args.trim();
  if (!agentId) {
    ctx.ui.notify("Usage: /agents-stop <agent-id>", "warning");
    return;
  }
  const result = await controlParallelAgent({ action: "stop", agentId }, ctx);
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}
