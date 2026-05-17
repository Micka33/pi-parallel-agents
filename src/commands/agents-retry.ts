import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { controlParallelAgent } from "../tools/control-parallel-agent.js";

export async function agentsRetryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [agentId, questionId] = args.trim().split(/\s+/, 2);
  if (!agentId || !questionId) {
    ctx.ui.notify("Usage: /agents-retry <agent-id> <question-id>", "warning");
    return;
  }
  const result = await controlParallelAgent({ action: "retry_question", agentId, questionId }, ctx);
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}
