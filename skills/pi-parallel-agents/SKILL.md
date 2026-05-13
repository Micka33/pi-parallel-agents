---
name: pi-parallel-agents
description: Use when you should launch, inspect, or coordinate Pi sub-agents
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

## Recommended workflow

1. Decide whether work is independent enough for child agents.
2. If overriding model/thinking, check `pi --list-models` and use only Pi thinking levels.
3. Launch with short unique `name` values and a clear `parentPrompt`.
4. Prefer `current/read_only` for quick checks; use `worktree` only for write work in a git repo.
5. Immediately call `get_parallel_agents` with `include: ["status"]`; add `"logs"` for failures.
6. Summarize useful child results for the user and ignore stale test/crashed agents unless cleanup is requested.
