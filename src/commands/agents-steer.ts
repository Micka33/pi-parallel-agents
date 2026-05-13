import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { messageParallelAgent } from "../tools/message-parallel-agent.js";

export async function agentsSteerCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { agentId, message } = parseAgentMessage(args);
  if (!agentId || !message) {
    ctx.ui.notify("Usage: /agents-steer <agent-id> <message>", "warning");
    return;
  }
  const result = await messageParallelAgent({ agentId, mode: "steer", message }, ctx);
  ctx.ui.notify(JSON.stringify(result, null, 2), "info");
}

function parseAgentMessage(args: string): { agentId?: string | undefined; message?: string | undefined } {
  const trimmed = args.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return { agentId: trimmed || undefined };
  return { agentId: trimmed.slice(0, firstSpace), message: trimmed.slice(firstSpace).trim() };
}
