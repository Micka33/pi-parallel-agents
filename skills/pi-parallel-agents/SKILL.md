---
name: pi-parallel-agents
description: Use when deciding whether to delegate work to Pi sub-agents, especially read-only current-worktree scouts, investigating, context-inheriting children, or when launching, inspecting, messaging, resuming, stopping, cleaning, or coordinating sub-agents with start_agent, get_parallel_agents, control_parallel_agent, message_parallel_agent, or reply_parallel_question.
---

# pi-parallel-agents

Use sub-agents when delegation prevents context loading or adds useful independence or parallelism.

## When to use

Delegate when:

- Investigating
- The user asks for parallel work, a second opinion, review, scouting, or independent validation.
- A small targeted update needs quick code discovery before the parent edits.
- Investigation and implementation can be separated.
- Multiple areas can be inspected independently.
- for “inspect and verify behavior/docs” question, prefer a read-only one-shot sub-agent unless the answer is truly trivial.

For small targeted updates, prefer a read-only current-worktree scout and let the parent apply edits:

```json
{
  "prompt": "Find the minimal safe change for the requested update. Report exact files and edits; do not modify files.",
  "dedicatedWorktree": false,
  "readOnly": true,
  "singleResponse": true
}
```

Use `inheritContext=false` when the prompt is self-contained. Use `inheritContext=true` only when the child needs prior conversation, earlier tool output, or unstated user preferences:

```json
{
  "prompt": "Using the existing discussion context, identify the minimal files to update. Do not modify files.",
  "dedicatedWorktree": false,
  "readOnly": true,
  "singleResponse": true,
  "inheritContext": true
}
```

## Starting agents

Use `start_agent` as the only creation primitive.

Key options:

- `dedicatedWorktree=false, readOnly=true`: shared/current checkout, investigation only.
- `dedicatedWorktree=true`: isolated worktree; required for child writes.
- `singleResponse=true`: one-shot answer, then cleanup/dispose.
- `waitUntil="initial_response"`: for `singleResponse=false`, block the parent until the child's first; pair with `waitTimeoutMs` when a bounded wait is needed.
- `inheritContext=true`: fork requester context before the launch turn.
- `maxSubAgents`: default `0`; increase only when nested delegation is explicitly wanted.

Safety:

- Never request shared checkout write access (`dedicatedWorktree=false, readOnly=false`).
- Do not allow `bash`, `edit`, or `write` with `readOnly=true`.
- Prefer one-shot read-only children for quick analysis.

## Inspecting and coordinating

- `get_parallel_agents`: compact list of existing agents (`agentId`, `displayName`, `sessionId`, `status`).
- `control_parallel_agent`: `stop`, `resume`, `refresh`, `mark_done`, `clean`, `retry_question`, `review_results`, `set_defaults`.
- `message_parallel_agent`: parent → child communication.
  - `mode="queue"`: durable follow-up prompt; automatically resumes `done` or `stopped` agents when needed.
  - `mode="steer"`: immediate steering for a live agent.
- `reply_parallel_question`: answer child → parent questions.

Cleaning rules:

- `clean` refuses live active agents (`starting`, `running`, `waiting`); stop them first. It may stop leftover worker PIDs for non-active agents.
- Do not remove worktrees, branches, sessions, or history unless the user explicitly asks.

Before summarizing multiple child outputs, use `control_parallel_agent` with `action="review_results"`.
