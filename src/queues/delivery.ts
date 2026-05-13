import { enqueueAgentCommand } from "../lifecycle/agent-command.js";
import type { QueueQuestionRow } from "../state/types.js";

export async function enqueueSteerDelivery(repoRoot: string, question: QueueQuestionRow): Promise<unknown> {
  return enqueueAgentCommand(repoRoot, question.agent_id, "steer", {
    questionId: question.question_id,
    mode: "steer",
    rpc: { type: "steer", message: question.message },
  });
}

export async function enqueueQueuedDelivery(repoRoot: string, question: QueueQuestionRow): Promise<unknown> {
  return enqueueAgentCommand(repoRoot, question.agent_id, "follow_up", {
    questionId: question.question_id,
    mode: "queue",
    rpc: { type: "follow_up", message: question.message },
  });
}

export async function enqueueUiResponseDelivery(repoRoot: string, question: QueueQuestionRow, response: string): Promise<unknown> {
  return enqueueAgentCommand(repoRoot, question.agent_id, "extension_ui_response", {
    questionId: question.question_id,
    response,
    rpc: { type: "extension_ui_response", id: question.question_id, value: response },
  });
}
