---
name: pi-parallel-agents
description: Use when you should launch, inspect, control, message, or coordinate Pi sub-agents with launch_parallel_agents, get_parallel_agents, control_parallel_agent, message_parallel_agent, or reply_parallel_question.
---

# pi-parallel-agents

Use the `pi-parallel-agents` tools to split work across child Pi agents and monitor their state.

## Before choosing a model

- Prefer inheriting the parent session provider/model unless the user explicitly asks for another model.
- Run or recommend `pi --list-models` when selecting an explicit model.
- Pi thinking levels are: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Not every model uses thinking levels. In `pi --list-models`, models without `thinking: yes` do not use them.
- Do not pass non-Pi thinking names such as `none`; use `off` for no Pi thinking.

## `launch_parallel_agents`

Use this tool when several investigations or implementation paths can run independently.

Defaults:

- `repoRoot`: current Pi session workspace/repo. Pass it explicitly when the target repo isn't the current one.
- `defaultProvider`: parent session provider.
- `defaultModel`: parent session model, then configured fallback `gpt-5.5`.
- `defaultThinking`: `high`.
- Per-agent `provider`, `model`, and `thinking` override launch defaults.
- Per-agent `workspaceMode`: `worktree` by default.
- Per-agent `accessMode`: `write` for `worktree`; `read_only` for `current`.
- `current/write` is not enabled; use `current/read_only` or a worktree.

Workspace guidance:

- Use `current/read_only` for analysis, validation, review, or questions that must not modify files.
- Use `worktree/write` for implementation work. Worktrees are created under `../pi/<worktree-name>`.
- `worktree` requires a git repository. If the current session root is not a git repo, pass `repoRoot` pointing at one or use `workspaceMode: "current"`.

Minimal safe launch:

```json
{
  "parentPrompt": "Original user request or orchestration context.",
  "agents": [
    {
      "name": "api-review",
      "prompt": "Inspect the API layer and report risks. Do not modify files.",
      "workspaceMode": "current",
      "accessMode": "read_only"
    }
  ]
}
```

Explicit model launch after checking `pi --list-models`:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.4",
  "defaultThinking": "low",
  "agents": [
    {
      "name": "grammar-check",
      "prompt": "Answer the grammar question concisely.",
      "workspaceMode": "current",
      "accessMode": "read_only"
    }
  ]
}
```

The result is fail-soft:

- `launched[]` contains child agents that started.
- `failed[]` contains per-agent launch errors.
- One failed child should not hide successful launches.

## `get_parallel_agents`

Use this tool to inspect child agents after launching or when the widget shows stale/crashed/waiting agents.

Common calls:

```json
{ "include": ["status", "summary"] }
```

```json
{ "agentId": "api-review", "include": ["status", "logs"] }
```

```json
{
  "repoRoot": "/absolute/path/to/nested/repo",
  "include": ["status", "summary", "logs"]
}
```

Fields to watch:

- `status`: `starting`, `running`, `waiting`, `stopped`, `crashed`, `done`, or `cleaned`.
- `lastError`: most useful when `status` is `crashed` or a model/provider call failed.
- `provider`, `model`, `thinking`: confirm inherited or overridden runtime settings.
- `sessionId`/`sessionFile`: confirms the child Pi session was created.
- `events`: present when `include` contains `logs`; use it to diagnose startup/API errors.
- `commands`: present when `include` contains `commands`; use it to verify queued RPC delivery.
- `queue`: present when `include` contains `queues`; use it to find incoming questions or outgoing durable messages.

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
- Do not set `removeWorktree`, `removeBranch`, `removeSession`, or `deleteHistory` unless the user explicitly asked.
- Use `refresh` when status looks stale; dead running/waiting PIDs are marked `crashed`.
- Use `set_defaults` only after checking the model/thinking combination with `pi --list-models` when changing explicit defaults.

Use `message_parallel_agent` for parent → child communication:

```json
{ "agentId": "api-review", "mode": "steer", "message": "Focus on failing tests only." }
```

```json
{ "agentId": "api-review", "mode": "queue", "message": "After your current turn, run npm test and summarize failures." }
```

```json
{ "agentId": "api-review", "mode": "consult", "message": "Independently assess whether this result is safe to merge." }
```

- `steer` is immediate guidance delivered over RPC when the child supervisor is alive.
- `queue` persists a durable follow-up in `tasks.sqlite`; it is delivered when the child is alive or resumed.
- `consult` creates a temporary read-only clone from a worktree agent and returns an answer without sending the question to the source child session. Use it only for `workspaceMode = "worktree"`; it is refused for `current` agents.
- For consult debugging only, `debug: true` keeps the temporary clone/session. Do not use it unless you need evidence.

Use `control_parallel_agent` to retry blocked questions or review results:

```json
{ "action": "retry_question", "agentId": "api-review", "questionId": "blocked-question-id" }
```

```json
{ "action": "review_results" }
```

- `retry_question` only applies to blocked outgoing `steer`/`queue` questions.
- `review_results` returns consolidated summaries, queue blockers, and recommendations before final user reporting.

Use `reply_parallel_question` for child → parent questions:

```json
{ "agentId": "api-review", "questionId": "question-id", "response": "Use option B and keep public API stable." }
```

## Recommended workflow

1. Decide whether work is independent enough for child agents.
2. If overriding model/thinking, check `pi --list-models` and use only Pi thinking levels.
3. Launch with short unique `name` values and a clear `parentPrompt`.
4. Prefer `current/read_only` for quick checks; use `worktree` only for write work in a git repo.
5. Immediately call `get_parallel_agents` with `include: ["status"]`; add `"logs"` for failures.
6. Use `mode: "consult"` when you need an isolated second opinion from a worktree child without polluting that child's context.
7. Use `control_parallel_agent action=review_results` before final reporting when several children produced summaries or blocked queues.
8. Summarize useful child results for the user and ignore stale test/crashed agents unless cleanup is requested.
