import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consultParallelAgent } from "../lifecycle/consult-agent.js";
import { queueAdapterForRepo } from "../queues/question-router.js";
import { createQuestionId, sanitizeQuestionId } from "../queues/question-ids.js";
import { enqueueQueuedDelivery, enqueueSteerDelivery } from "../queues/delivery.js";
import { StateReader } from "../state/state-reader.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import { errorMessage } from "../util/errors.js";
import type { MessageParallelAgentInput } from "./schemas.js";

export async function messageParallelAgent(params: MessageParallelAgentInput, ctx: ExtensionContext): Promise<unknown> {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  const reader = new StateReader(stateDbPath(repoRoot));
  const agent = reader.readAgents({ agentId: params.agentId })[0];
  if (!agent) throw new Error(`Unknown parallel agent: ${params.agentId}`);
  if (agent.status === "cleaned") throw new Error(`Cannot message cleaned agent: ${params.agentId}`);
  if (params.mode === "consult" && agent.workspace_mode !== "worktree") {
    throw new Error(`mode=consult requires workspaceMode=worktree; agent ${params.agentId} uses ${agent.workspace_mode}`);
  }

  const adapter = queueAdapterForRepo(repoRoot);
  const question = adapter.createQuestion({
    questionId: params.questionId ? sanitizeQuestionId(params.questionId) : createQuestionId(params.agentId, params.mode),
    agentId: params.agentId,
    direction: "outgoing",
    mode: params.mode,
    status: "queued",
    message: params.message,
    metadata: { repoRoot, createdBy: "message_parallel_agent", ...(params.mode === "consult" ? { consult: { thinking: params.thinking ?? "xhigh" } } : {}) },
  });

  if (params.mode === "consult") {
    try {
      const consultOptions: Parameters<typeof consultParallelAgent>[2] = { question: params.message };
      if (params.thinking !== undefined) consultOptions.thinking = params.thinking;
      if (params.timeoutMs !== undefined) consultOptions.timeoutMs = params.timeoutMs;
      if (params.debug !== undefined) consultOptions.debug = params.debug;
      const consult = await consultParallelAgent(repoRoot, params.agentId, consultOptions);
      const answered = adapter.answerQuestion(question.question_id, consult.answer, "answered") ?? question;
      updateParallelAgentsWidget(ctx, repoRoot);
      return { ok: true, action: "message", mode: params.mode, question: answered, consult };
    } catch (error) {
      adapter.answerQuestion(question.question_id, errorMessage(error), "blocked");
      updateParallelAgentsWidget(ctx, repoRoot);
      throw error;
    }
  }

  const command = params.mode === "steer" ? await enqueueSteerDelivery(repoRoot, question) : await enqueueQueuedDelivery(repoRoot, question);
  updateParallelAgentsWidget(ctx, repoRoot);
  return { ok: true, action: "message", mode: params.mode, question, command };
}
