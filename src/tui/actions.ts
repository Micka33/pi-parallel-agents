import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { messageParallelAgent } from "../tools/message-parallel-agent.js";

export async function steerFromOverlay(ctx: ExtensionCommandContext, agentId: string, message: string): Promise<unknown> {
  return messageParallelAgent({ agentId, mode: "steer", message }, ctx);
}

export async function queueFromOverlay(ctx: ExtensionCommandContext, agentId: string, message: string): Promise<unknown> {
  return messageParallelAgent({ agentId, mode: "queue", message }, ctx);
}
