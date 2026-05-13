# pi-parallel-agents

Pi extension and lifecycle scripts for launching parallel Pi sub-agents.

## Version 1 livrables

- Pi extension entrypoint: `src/parallel-agents.ts`
- Tools: `launch_parallel_agents`, `get_parallel_agents`
- Commands: `/agents`, `/agents-open <id>`, `/agents-summary` (`/agents-open` autocompletes known agent IDs in the Pi UI)
- Skill: `skills/pi-parallel-agents/SKILL.md` documents `launch_parallel_agents`, `get_parallel_agents`, defaults, model selection, and Pi thinking levels
- Minimal widget above the editor with status, workspace, model/thinking, cwd and session
- SQLite state store: `<repoRoot>/.pi/parallel-agents/state.sqlite`
- Lifecycle scripts:
  - `scripts/start-parallel-agent.sh`
  - `scripts/parallel-agent-state.sh`
- Workspace modes:
  - `worktree` (default): creates `../pi/<worktree-name>` and a branch
  - `current`: runs in the repo checkout with `read_only` access by default
- Provider/model defaults: child agents inherit the parent session `provider/model` unless an agent override or launch default is provided; fallback is `model = gpt-5.5`
- Thinking default: `high`, unless an agent override or launch default is provided
- Optional `launch_parallel_agents.repoRoot` lets a parent session launch agents from a nested git repo/workspace
- `launch_parallel_agents` returns partial results as `{ launched, failed }` so one failed child does not hide other launch attempts

## Version 2 livrables

- Lifecycle control:
  - `scripts/stop-parallel-agent.sh`
  - `scripts/clean-parallel-agent.sh`
  - `scripts/start-parallel-agent.sh --resume-session --agent-id <id>`
- Tools:
  - `control_parallel_agent` with `stop`, `resume`, `set_defaults`, `refresh`, `mark_done`, `clean`
  - `message_parallel_agent` with `mode = "steer" | "queue"`
  - `reply_parallel_question`
- Commands:
  - `/agents-stop <id>`
  - `/agents-resume <id>`
  - `/agents-defaults <model> [thinking]`
  - `/agents-clean <id> [--worktree] [--branch] [--session] [--force]`
  - `/agents-steer <id> <message>`
  - `/agents-ask <id> <message>`
- Durable state:
  - `state.sqlite` now includes `agent_commands` for supervisor-delivered RPC commands
  - `tasks.sqlite` includes `parallel_questions` plus `pi-tasks`-compatible `task_lists`/`tasks` rows for durable incoming/outgoing queues
- Child RPC supervisors poll queued commands and deliver `steer`, `follow_up`, and `extension_ui_response` messages when the child process is alive or resumed.
- `/agents` and `/agents-open` show queue/command details and actionable command hints.

## Build and test

```bash
npm install
npm run build
npm test
```

The tests use `tests/fixtures/fake-pi-rpc.mjs` and do not call a real model.

## Manual script example

```bash
scripts/start-parallel-agent.sh \
  --context /path/to/context.json \
  --prompt /path/to/prompt.md \
  --model gpt-5.5 \
  --thinking high \
  --workspace-mode worktree
```

For deterministic local script tests without calling the naming agent:

```bash
PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT=1 \
PI_PARALLEL_AGENTS_PI_BIN=tests/fixtures/fake-pi-rpc.mjs \
scripts/start-parallel-agent.sh ...
```
