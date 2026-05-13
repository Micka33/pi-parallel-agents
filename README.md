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
