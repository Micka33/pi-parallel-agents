---
name: pi-parallel-agents
description: Use when you should launch, inspect, control, message, or coordinate Pi sub-agents with start_agent, get_parallel_agents, control_parallel_agent, message_parallel_agent, or reply_parallel_question.
---

# pi-parallel-agents

Use `pi-parallel-agents` to create child Pi agents and monitor their state.

## Creation primitive: `start_agent`

`start_agent` is the only creation primitive. It creates one SDK-backed child session and accepts explicit options for worktree isolation, read-only policy, one-shot behavior, nested-agent quota, model, thinking, and tool access.

Defaults:

- `dedicatedWorktree`: `true`.
- `inheritContext`: `false`; when `true`, the child forks the requester session at the pre-launch leaf so the launch request itself is excluded.
- `readOnly`: `false` for dedicated worktrees, `true` for shared/current checkout.
- `singleResponse`: `false`.
- `maxSubAgents`: `0`; children cannot start their own children unless explicitly granted.
- `provider`, `model`, `thinkingLevel`: inherit from the requesting session unless overridden.
- `allowedTools`: inherit active tools by default; read-only mode is enforced by the actual SDK tool list.

Examples:

```json
{
  "prompt": "Inspect the API layer and report risks. Do not modify files.",
  "dedicatedWorktree": false,
  "readOnly": true
}
```

One-shot question:

```json
{
  "prompt": "Independently assess whether this result is safe to merge.",
  "dedicatedWorktree": true,
  "readOnly": true,
  "singleResponse": true
}
```

Sub-agent quota:

```json
{
  "prompt": "Coordinate two read-only scouts, then summarize.",
  "maxSubAgents": 2
}
```

Safety rules:

- Do not request `dedicatedWorktree=false` with write access.
- Do not allow `bash`, `edit`, or `write` when `readOnly=true`.
- Increase `maxSubAgents` only when the user explicitly wants nested delegation.

## Inspecting agents: `get_parallel_agents`

Common calls:

```json
{ "include": ["status", "summary"] }
```

```json
{ "agentId": "api-review", "include": ["status", "logs", "commands", "queues"] }
```

Fields to watch:

- `status`: `starting`, `running`, `waiting`, `stopped`, `crashed`, `done`, or `cleaned`.
- `lastError`: most useful when `status` is `crashed`.
- `dedicatedWorktree` and `readOnly`: confirm isolation and actual SDK tool policy.
- `provider`, `model`, `thinking`: confirm inherited/overridden settings.
- `sessionId`/`sessionFile`: confirms the SDK child session.
- `commands`: queued SDK worker control messages.
- `queue`: incoming questions and outgoing durable messages.

## Control and messaging

Use `control_parallel_agent` for lifecycle actions:

```json
{ "action": "stop", "agentId": "api-review" }
```

```json
{ "action": "resume", "agentId": "api-review" }
```

```json
{ "action": "clean", "agentId": "api-review", "removeWorktree": true, "force": false }
```

Safety rules:

- Stop an agent before cleaning it.
- Do not remove worktrees, branches, sessions, or history unless the user explicitly asked.
- Use `refresh` when status looks stale.

Use `message_parallel_agent` for parent → child communication:

```json
{ "agentId": "api-review", "mode": "steer", "message": "Focus on failing tests only." }
```

```json
{ "agentId": "api-review", "mode": "queue", "message": "After your current turn, run npm test and summarize failures." }
```

- `steer` queues immediate SDK steering.
- `queue` persists a durable follow-up delivered by the SDK worker when alive/resumed.
- For isolated one-shot questions, use `start_agent` with `singleResponse=true`.

Use `reply_parallel_question` for child → parent questions:

```json
{ "agentId": "api-review", "questionId": "question-id", "response": "Use option B and keep public API stable." }
```

## Recommended workflow

1. Decide whether delegation is useful.
2. Use `start_agent` for every child you create.
3. Prefer `dedicatedWorktree=false, readOnly=true` for quick analysis in the current checkout.
4. Use dedicated worktrees for write-capable implementation.
5. Use `singleResponse=true` for one-shot questions.
6. Immediately inspect with `get_parallel_agents` for persistent children.
7. Use `control_parallel_agent action=review_results` before final reporting when several children produced summaries or blockers.
