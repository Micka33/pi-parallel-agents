import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { enqueueUiResponseDelivery } from "../queues/delivery.js";
import { queueAdapterForRepo } from "../queues/question-router.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot } from "../util/paths.js";
import type { ReplyParallelQuestionInput } from "./schemas.js";

export async function replyParallelQuestion(params: ReplyParallelQuestionInput, ctx: ExtensionContext): Promise<unknown> {
  const repoRoot = resolveRepoRoot(params.repoRoot ?? ctx.cwd);
  const adapter = queueAdapterForRepo(repoRoot);
  let question = adapter.getQuestion(params.questionId);
  if (!question) {
    question = adapter.createQuestion({
      questionId: params.questionId,
      agentId: params.agentId,
      direction: "incoming",
      mode: "reply",
      status: "queued",
      message: "Synthetic question created while replying.",
      metadata: { createdBy: "reply_parallel_question" },
    });
  }
  if (question.agent_id !== params.agentId) throw new Error(`Question ${params.questionId} belongs to ${question.agent_id}, not ${params.agentId}`);

  const answered = adapter.answerQuestion(params.questionId, params.response, params.status ?? "answered") ?? question;
  const command = await enqueueUiResponseDelivery(repoRoot, answered, params.response);
  updateParallelAgentsWidget(ctx, repoRoot);
  return { ok: true, action: "reply", question: answered, command };
}
