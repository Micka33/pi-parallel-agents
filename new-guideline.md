# New guideline: SDK-first sub-agent extension

This guideline updates the sub-agent design around two ideas:

1. expose one creation primitive, `start_agent`, with options instead of separate `start-agent` / `consult-agent` concepts;
2. use Pi's SDK and `SessionManager` APIs for child sessions instead of shelling out to `pi --mode rpc` from scripts such as `scripts/lib/start-agent.mjs` or `scripts/lib/consult-agent.mjs`.

## 1. Public model

The extension should present one way to create a sub-agent:

```text
start_agent(
  prompt,
  dedicatedWorktree = true,
  inheritContext = false,
  systemPrompt?,
  readOnly?,
  singleResponse = false,
  maxSubAgents = 0,
  provider?,
  model?,
  thinkingLevel?,
  allowedTools?
)
```

Recommended defaults:

- `dedicatedWorktree`: `true`; the child gets its own git worktree by default. Set `false` only when the child should run in the requesting agent's checkout.
- `inheritContext`: `false`.
- `readOnly`: default `true` when `dedicatedWorktree = false`, default `false` when `dedicatedWorktree = true`.
- `singleResponse`: `false`.
- `maxSubAgents`: `0`; this is a hard cap and must not be bypassable by child agents.
- `provider`, `model`, `thinkingLevel`: inherit the requesting agent/session settings unless explicitly overridden.
- `allowedTools`: inherit the requesting agent's active tools/resources by default, then apply the read-only policy.
- `systemPrompt`: optional extra or replacement prompt for the child.

There should be no public `consult-agent` primitive. A consult is just:

```text
start_agent(..., dedicatedWorktree = true, readOnly = true, singleResponse = true)
```

optionally with `inheritContext = true` when the child should see the requesting agent's conversation.

## 2. Replace Pi CLI spawning with SDK sessions

Do not start child agents by spawning `pi --mode rpc` and parsing JSONL RPC events.

Instead, create child agents with the SDK:

- `createAgentSession()` for a normal `AgentSession`;
- `createAgentSessionRuntime()` when the child needs runtime-backed session replacement, resume, fork, or clone behavior;
- `SessionManager.create/open/inMemory/forkFrom` for child session files;
- `DefaultResourceLoader` for extensions, skills, prompts, context files, and system prompt control;
- `session.subscribe(...)` for events instead of stdout JSONL parsing;
- `session.prompt(...)`, `session.steer(...)`, `session.followUp(...)`, `session.abort()`, and `session.dispose()` for control.

Use a small Node SDK worker process for every persistent, resumable, or long-lived child agent. The worker imports `@earendil-works/pi-coding-agent` and uses the SDK directly; it must not spawn the `pi` CLI. The worker communicates with the supervisor/requesting agent over a small internal IPC protocol and preserves the current durable state/queue behavior.

Use pure in-process `AgentSession` objects only for `singleResponse`, disposable, or otherwise non-durable children. Persistent and resumable children must run in a supervisor/worker process so they can outlive the launching tool call and be stopped/resumed cleanly.

## 3. SessionManager rules for context inheritance

When `inheritContext = false`:

- create a fresh child session with `SessionManager.create(childCwd)` for persistent agents;
- use `SessionManager.inMemory(childCwd)` for disposable `singleResponse` agents unless a temporary session file is needed for debugging or audit.

When `inheritContext = true`:

- duplicate the requesting agent's active branch into the child session, whether the requester is the root agent or another sub-agent;
- exclude the launch request: the child must not receive the user/assistant/tool context that says “start a sub-agent”, otherwise it may recursively follow the launch instruction;
- inject only the child assignment prompt as the first new child-specific prompt.

Suggested implementation:

1. resolve the requester identity and requester `SessionManager` for the current `start_agent` call;
2. inspect `requesterSessionManager.getBranch()`;
3. identify the current launch turn in that requester session;
4. choose the pre-launch leaf immediately before that launch turn;
5. create a branched session at that pre-launch leaf, for example with `createBranchedSession(preLaunchLeafId)`;
6. move it to the child cwd with `SessionManager.forkFrom(sourceSessionFile, childCwd)` or open it with a cwd override where appropriate;
7. then call `session.prompt(childPrompt)`.

If the requester session is in-memory or cannot be branched to a file, reconstruct the child context from `buildSessionContext()` and append only the safe pre-launch messages into a new child `SessionManager`.

## 4. Resource and tool inheritance

The child should be built with a `DefaultResourceLoader` configured for the child cwd and the same agent directory as the requesting session.

For `dedicatedWorktree = true` children:

- create/use the child worktree path as `cwd`;
- discover project resources from that worktree;
- explicitly include this sub-agent extension path if needed so bridge/control tools are available.

For `dedicatedWorktree = false` children:

- use the requesting agent's cwd;
- keep read-only as the default because the filesystem is shared.

For tools:

- inherit `pi.getActiveTools()` by default;
- if `allowedTools` is specified, use it as an allowlist;
- if `readOnly = true`, intersect the final list with read-only-safe tools plus approved communication/control tools;
- reject inconsistent requests with a clear error, for example when `readOnly = true` but the caller explicitly requests `edit`, `write`, or unrestricted `bash`.

Read-only must be enforced by the actual SDK `tools` list, not only by prompt text.

## 5. `singleResponse` behavior

Add `--single-response` / `singleResponse` with default `false`.

When `singleResponse = true`:

- start the child;
- send exactly one initial prompt;
- wait for the first complete agent run, i.e. the first `agent_end` after that prompt;
- return the final assistant answer and useful metadata to the requesting agent;
- automatically dispose the SDK session;
- automatically clean temporary session files, worktree, and branch unless a debug/keep option is explicitly set;
- do not leave a running child agent behind.

Use `createAgentSession()` directly for `singleResponse` and subscribe to events. Do not use `runPrintMode()`. The extension needs explicit event handling, final-answer extraction, state updates, queue integration, abort handling, and deterministic cleanup timing; `runPrintMode()` is too high-level and CLI-oriented for that.

`singleResponse` replaces the old “consult clone” concept.

## 6. Persistent children

When `singleResponse = false`, the child remains addressable after launch.

The SDK runtime/worker should:

- persist child metadata in SQLite as today;
- subscribe to SDK events and update status (`starting`, `running`, `waiting`, `done`, `crashed`, `stopped`);
- store `sessionFile`, `sessionId`, `cwd`, `dedicatedWorktree`, `readOnly`, `allowedTools`, `model`, `thinkingLevel`, `requesterAgentId`, and `maxSubAgents`;
- implement requester-to-child dialog with `session.steer(...)` and `session.followUp(...)`;
- implement stop with `session.abort()` followed by `session.dispose()` and worker termination if applicable;
- implement resume with `SessionManager.open(existing.sessionFile, ..., childCwd)` and `createAgentSessionRuntime()`.

Child-to-requester questions should keep using explicit queue/bridge tools rather than depending on RPC extension UI requests.

## 7. Hard sub-agent limits

`maxSubAgents` is a capability granted to a child, not a suggestion.

Persist it on every agent row. Before any `start_agent` call succeeds, check:

- who is requesting the child;
- how many non-cleaned direct children that requester already has;
- that requester's `maxSubAgents`.

Default `maxSubAgents = 0` means a child cannot launch further children.

When the limit is exceeded, fail before creating worktrees or sessions. The error should include:

- requester agent/session id;
- configured limit;
- current child count;
- active child ids/statuses;
- how to proceed, e.g. stop/clean an existing child or start the requesting agent with a higher limit.

## 8. Migration from the current implementation

Recommended migration shape:

- Replace public `launch_parallel_agents` / consult-oriented semantics with `start_agent` plus options.
- Remove public `consult` mode; model it as `singleResponse + readOnly + dedicatedWorktree`.
- Replace `scripts/lib/consult-agent.mjs` and `scripts/consult-subagent-clone.sh` with the `singleResponse` code path.
- Replace the `pi --mode rpc` child process in `scripts/lib/start-agent.mjs` with either:
  - an in-process SDK runner for disposable children; or
  - a Node SDK worker process for durable children.
- Keep git worktree creation/cleanup logic, but decouple it from Pi CLI startup.
- Keep SQLite state, queues, cleanup, stop, resume, and review features, but drive them from SDK events instead of RPC stdout.

The main design principle: `start_agent` is the only gate that creates children, enforces permissions, enforces sub-agent quotas, chooses the session inheritance strategy, and decides whether the child is persistent or automatically cleaned after one response.
