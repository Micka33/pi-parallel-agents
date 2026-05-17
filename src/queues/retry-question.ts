import { enqueueQueuedDelivery, enqueueSteerDelivery } from "./delivery.js";
import { queueAdapterForRepo } from "./question-router.js";

export async function retryBlockedQuestion(repoRoot: string, agentId: string, questionId: string): Promise<unknown> {
  const adapter = queueAdapterForRepo(repoRoot);
  const question = adapter.getQuestion(questionId);
  if (!question) throw new Error(`Unknown parallel question: ${questionId}`);
  if (question.agent_id !== agentId) throw new Error(`Question ${questionId} belongs to agent ${question.agent_id}, not ${agentId}`);
  if (question.direction !== "outgoing") throw new Error(`Only outgoing questions can be retried: ${questionId}`);
  if (question.status !== "blocked") throw new Error(`Only blocked questions can be retried: ${questionId} is ${question.status}`);
  if (question.mode !== "steer" && question.mode !== "queue") {
    throw new Error(`Cannot retry ${question.mode} question ${questionId}; send a new message instead`);
  }

  const requeued = adapter.requeueQuestion(questionId);
  if (!requeued) throw new Error(`Question disappeared while retrying: ${questionId}`);
  const command = requeued.mode === "steer" ? await enqueueSteerDelivery(repoRoot, requeued) : await enqueueQueuedDelivery(repoRoot, requeued);
  return { ok: true, action: "retry_question", question: requeued, command };
}
