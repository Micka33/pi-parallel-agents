# pi-parallel-agents

Pi extension and lifecycle scripts for SDK-backed Pi sub-agents.

## Current model

- Primary creation tool: `start_agent(prompt, dedicatedWorktree, inheritContext, systemPrompt, readOnly, singleResponse, waitUntil, waitTimeoutMs, maxSubAgents, provider, model, thinkingLevel, allowedTools)`.
- Persistent child agents run in a small Node SDK worker process using `AgentSessionRuntime`/`SessionManager`.
- One-shot questions are `start_agent` calls with `singleResponse=true`, usually `dedicatedWorktree=true` and `readOnly=true`.

## Tools

- `start_agent`: create one child agent with explicit options.
- `get_parallel_agents`: list persisted child agents with only `agentId`, `displayName`, `sessionId`, and `status`.
- `control_parallel_agent`: `stop`, `resume`, `set_defaults`, `refresh`, `mark_done`, `clean`, `retry_question`, `review_results`; outputs include a top-level `queue` array of parallel questions.
- `message_parallel_agent`: send `steer` or durable `queue` messages to an existing child; returns only `ok`, `action`, `mode`, `question.question_id`, `question.agent_id`, `question.direction`, and `question.message`.
- `reply_parallel_question`: answer a durable question raised by a child.

## Defaults and guardrails

- `dedicatedWorktree`: defaults to `true`.
- `readOnly`: defaults to `false` for dedicated worktrees and `true` for shared/current checkout.
- `singleResponse`: defaults to `false`.
- `waitUntil`: defaults to `started`; use `initial_response` with `singleResponse=false` to block until the first child answer while keeping the child alive.
- `waitTimeoutMs`: optional timeout for `waitUntil=initial_response`; on timeout the child keeps running and the result includes `wait.status="timeout"`.
- `inheritContext`: defaults to `false`; when `true`, the child forks the requester session at the pre-launch leaf so the launch request itself is excluded.
- `maxSubAgents`: defaults to `0` and is enforced before worktree/session creation.
- Provider/model inherit from the requesting session unless overridden; configured fallback model is `gpt-5.5`.
- Thinking level inherits from the requesting session unless overridden; fallback default is `high`.
- Shared-checkout write access is blocked; use shared read-only analysis or a write-capable dedicated worktree.
- Read-only mode is enforced by the actual SDK tool allowlist, not only prompt text.

## State and lifecycle

- SQLite state store: `<repoRoot>/.pi/parallel-agents/state.sqlite`.
- Queue/mirror store: `<repoRoot>/.pi/parallel-agents/tasks.sqlite` unless `PI_TASKS_DB_PATH` is set.
- `state.sqlite` includes child metadata such as `sessionFile`, `cwd`, worktree/branch, read-only mode, allowed tools, requester id, and `maxSubAgents`.
- SDK workers subscribe to session events and update status: `starting`, `running`, `waiting`, `stopped`, `crashed`, `done`, `cleaned`.
- Worker command polling delivers `steer`, `follow_up`, `abort`, and state commands through SDK session APIs.
- `clean` refuses live active agents (`starting`, `running`, `waiting`); stop them first. It only auto-terminates leftover worker PIDs for non-active agents.

## Commands

- `/agents`, `/agents-open <id>`, `/agents-summary [--all|--include-cleaned]`
- `/agents-stop <id>`, `/agents-resume <id>`, `/agents-defaults <model> [thinking]`
- `/agents-clean <id> [--worktree] [--branch] [--session] [--force]`
- `/agents-steer <id> <message>`, `/agents-ask <id> <message>`
- `/agents-retry <id> <question-id>`, `/agents-review [id]`

## Build and test

```bash
npm install
npm run build
npm test
```

The tests use deterministic fake SDK behavior through `tests/fixtures/fake-pi.mjs`/`PI_PARALLEL_AGENTS_FAKE_SDK` and do not call a real model.

## Manual script example

```bash
scripts/start-parallel-agent.sh \
  --context /path/to/context.json \
  --prompt /path/to/prompt.md \
  --model gpt-5.5 \
  --thinking high
```

For deterministic local script tests without calling the naming agent:

```bash
PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT=1 \
PI_PARALLEL_AGENTS_PI_BIN=tests/fixtures/fake-pi.mjs \
scripts/start-parallel-agent.sh ...
```
