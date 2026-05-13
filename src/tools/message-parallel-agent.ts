import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queueAdapterForRepo } from "../queues/question-router.js";
import { createQuestionId, sanitizeQuestionId } from "../queues/question-ids.js";
import { enqueueQueuedDelivery, enqueueSteerDelivery } from "../queues/delivery.js";
import { StateReader } from "../state/state-reader.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import type { MessageParallelAgentInput } from "./schemas.js";

export async function messageParallelAgent(params: MessageParallelAgentInput, ctx: ExtensionContext): Promise<unknown> {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  const reader = new StateReader(stateDbPath(repoRoot));
  const agent = reader.readAgents({ agentId: params.agentId })[0];
  if (!agent) throw new Error(`Unknown parallel agent: ${params.agentId}`);
  if (agent.status === "cleaned") throw new Error(`Cannot message cleaned agent: ${params.agentId}`);

  const adapter = queueAdapterForRepo(repoRoot);
  const question = adapter.createQuestion({
    questionId: params.questionId ? sanitizeQuestionId(params.questionId) : createQuestionId(params.agentId, params.mode),
    agentId: params.agentId,
    direction: "outgoing",
    mode: params.mode,
    status: "queued",
    message: params.message,
    metadata: { repoRoot, createdBy: "message_parallel_agent" },
  });

  const command = params.mode === "steer" ? await enqueueSteerDelivery(repoRoot, question) : await enqueueQueuedDelivery(repoRoot, question);
  updateParallelAgentsWidget(ctx, repoRoot);
  return { ok: true, action: "message", mode: params.mode, question, command };
}
