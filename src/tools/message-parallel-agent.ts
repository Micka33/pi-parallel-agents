import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queueAdapterForRepo } from "../queues/question-router.js";
import { createQuestionId, sanitizeQuestionId } from "../queues/question-ids.js";
import { enqueueQueuedDelivery, enqueueSteerDelivery } from "../queues/delivery.js";
import { resumeParallelAgent } from "../lifecycle/resume-agent.js";
import { StateReader } from "../state/state-reader.js";
import { updateParallelAgentsWidget } from "../tui/widget.js";
import { resolveRepoRoot, stateDbPath } from "../util/paths.js";
import type { MessageParallelAgentInput } from "./schemas.js";

export interface MessageParallelAgentOutput {
  ok: true;
  action: "message";
  mode: MessageParallelAgentInput["mode"];
  question: {
    question_id: string;
    agent_id: string;
    direction: "outgoing";
    message: string;
  };
  resumed?: {
    agentId: string;
    status: string;
    pid: number | null;
    sessionId: string | null;
  };
}

export async function messageParallelAgent(params: MessageParallelAgentInput, ctx: ExtensionContext): Promise<MessageParallelAgentOutput> {
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

  if (params.mode === "steer") {
    await enqueueSteerDelivery(repoRoot, question);
  } else {
    await enqueueQueuedDelivery(repoRoot, question);
  }

  const resumed = shouldAutoResumeForMessage(agent.status) ? await resumeParallelAgent(repoRoot, params.agentId) : null;
  updateParallelAgentsWidget(ctx, repoRoot);
  return {
    ok: true,
    action: "message",
    mode: params.mode,
    question: {
      question_id: question.question_id,
      agent_id: question.agent_id,
      direction: "outgoing",
      message: question.message,
    },
    ...(resumed
      ? {
          resumed: {
            agentId: resumed.agentId,
            status: resumed.status,
            pid: resumed.pid,
            sessionId: resumed.sessionId,
          },
        }
      : {}),
  };
}

function shouldAutoResumeForMessage(status: string): boolean {
  return status === "done" || status === "stopped";
}
