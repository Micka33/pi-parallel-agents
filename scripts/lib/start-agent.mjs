#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  appendEvent,
  assertRequesterCanStartChild,
  claimQueuedAgentCommands,
  completeAgentCommand,
  getAgent,
  initializeState,
  listAgents,
  openStateDb,
  setAgentStatus,
  upsertAgent,
} from "./state-db.mjs";
import { answerQuestion, createQuestion, getQuestion, listQuestions, markQuestionBlocked, markQuestionDelivered, openQueueDb } from "./queue-db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoScriptRoot = resolve(__dirname, "..", "..");

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_THINKING = "high";
const EXTENSION_TOOLS = ["start_agent", "get_parallel_agents", "message_parallel_agent", "reply_parallel_question", "control_parallel_agent"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", ...EXTENSION_TOOLS];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", ...EXTENSION_TOOLS];
const READ_ONLY_TOOL_ALLOWLIST = new Set(READ_ONLY_TOOLS);
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
const MAX_EVENT_PAYLOAD = 24_000;

async function start() {
  const { options } = parseArgs(process.argv.slice(2));
  if (Object.prototype.hasOwnProperty.call(options, "resume-session")) {
    await startResume(options);
    return;
  }

  const contextPath = required(options, "context");
  const promptPath = required(options, "prompt");
  const context = readJsonFile(contextPath);
  const promptText = readFileSync(promptPath, "utf8");

  const repoRoot = resolveRepoRoot(context.repoRoot ? resolve(String(context.repoRoot)) : process.cwd());
  const runtimeDir = resolve(repoRoot, ".pi", "parallel-agents");
  const stateDb = resolve(String(options["state-db"] ?? process.env.PI_PARALLEL_AGENTS_DB_PATH ?? join(runtimeDir, "state.sqlite")));
  const tasksDb = resolve(String(options["tasks-db"] ?? process.env.PI_TASKS_DB_PATH ?? join(runtimeDir, "tasks.sqlite")));
  const model = String(options.model ?? context.model ?? DEFAULT_MODEL);
  const thinking = String(options.thinking ?? context.thinkingLevel ?? context.thinking ?? DEFAULT_THINKING);
  const provider = optionalString(options.provider ?? context.provider);
  const dedicatedWorktree = boolOption(options["dedicated-worktree"] ?? context.dedicatedWorktree, true);
  if (dedicatedWorktree) assertGitRepository(repoRoot);
  const readOnly = boolOption(options["read-only"] ?? context.readOnly, !dedicatedWorktree);
  const singleResponse = boolOption(context.singleResponse, false);
  const waitUntil = normalizeWaitUntil(context.waitUntil, singleResponse);
  const waitTimeoutMs = positiveNumber(context.waitTimeoutMs);
  const inheritContext = boolOption(context.inheritContext, false);
  const inheritedSessionFile = inheritContext ? optionalString(context.inheritedSessionFile) : undefined;
  const inheritedSessionLeafId = inheritContext ? optionalString(context.inheritedSessionLeafId) : undefined;
  const maxSubAgents = nonNegativeInteger(context.maxSubAgents ?? 0, "maxSubAgents");
  const allowedTools = normalizeAllowedTools(context.allowedTools, readOnly, maxSubAgents);
  const systemPrompt = optionalString(context.systemPrompt);
  const keep = boolOption(context.keep, false);
  const parentSessionId = String(context.parentSessionId ?? process.env.PI_PARENT_SESSION_ID ?? "unknown-parent-session");
  const requesterAgentId = optionalString(context.requesterAgentId ?? process.env.PI_PARALLEL_AGENTS_AGENT_ID) ?? parentSessionId;
  const requestedName = String(context.name ?? context.suggestedName ?? context.agentName ?? "agent");
  const parentPrompt = String(context.parentPrompt ?? "");
  const agentPrompt = String(context.agentPrompt ?? promptText);

  if (!dedicatedWorktree && !readOnly) {
    throw new Error("dedicatedWorktree=false with readOnly=false is blocked; use a dedicated worktree for write access.");
  }

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(runtimeDir, "tmp"), { recursive: true });
  mkdirSync(join(runtimeDir, "logs", "agents"), { recursive: true });

  const db = openStateDb(stateDb);
  try {
    initializeState(db);
    assertRequesterCanStartChild(db, requesterAgentId);

    const existingAgents = listAgents(db, { repoRoot });
    const usedAgentIds = new Set(existingAgents.map((agent) => agent.agent_id));
    const naming = dedicatedWorktree ? await proposeNames({ repoRoot, requestedName, parentPrompt, agentPrompt, provider, model }) : {};
    const displayName = safeDisplayName(naming.displayName ?? requestedName);
    const agentId = dedupeSlug(sanitizeSlug(displayName, "agent"), usedAgentIds);

    let cwd = repoRoot;
    let worktreePath = null;
    let branchName = null;

    if (dedicatedWorktree) {
      const baseName = sanitizeSlug(naming.worktreeName ?? requestedName, `agent-${Date.now()}`);
      const branchBaseName = sanitizeBranchName(naming.branchName ?? baseName, baseName);
      const worktreeBase = join(dirname(repoRoot), "pi");
      mkdirSync(worktreeBase, { recursive: true });
      const worktreeName = dedupeWorktreeName(worktreeBase, baseName, repoRoot);
      worktreePath = join(worktreeBase, worktreeName);
      branchName = dedupeBranchName(repoRoot, branchBaseName);
      createWorktree(repoRoot, worktreePath, branchName);
      cwd = worktreePath;
    }

    const agent = {
      agent_id: agentId,
      parent_session_id: parentSessionId,
      requester_agent_id: requesterAgentId,
      display_name: displayName,
      repo_root: repoRoot,
      status: "starting",
      dedicated_worktree: dedicatedWorktree ? 1 : 0,
      read_only: readOnly ? 1 : 0,
      single_response: singleResponse ? 1 : 0,
      inherit_context: inheritContext ? 1 : 0,
      max_sub_agents: maxSubAgents,
      allowed_tools_json: allowedTools ? JSON.stringify(allowedTools) : null,
      system_prompt: systemPrompt ?? null,
      pid: null,
      cwd,
      worktree_path: worktreePath,
      branch_name: branchName,
      provider: provider ?? null,
      model,
      thinking,
      session_id: null,
      session_file: null,
      summary: null,
      diff_summary: null,
      tests_json: null,
      last_error: null,
    };

    upsertAgent(db, agent);
    appendEvent(db, {
      agentId,
      eventType: "start_requested",
      payloadJson: JSON.stringify({ dedicatedWorktree, readOnly, singleResponse, waitUntil, waitTimeoutMs: waitTimeoutMs ?? null, inheritContext, inheritedSessionLeafId: inheritedSessionLeafId ?? null, inheritedSessionFile: inheritedSessionFile ?? null, maxSubAgents, model, thinking, provider, cwd, worktreePath, branchName }),
    });

    const configPath = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-sdk-worker.json`);
    const resultFile = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-start-result.json`);
    const eventLog = join(runtimeDir, "logs", "agents", `${agentId}.events.jsonl`);
    const config = {
      agent,
      repoRoot,
      stateDb,
      tasksDb,
      promptText,
      provider,
      model,
      thinking,
      dedicatedWorktree,
      readOnly,
      singleResponse,
      waitUntil,
      waitTimeoutMs,
      inheritContext,
      inheritedSessionFile,
      inheritedSessionLeafId,
      maxSubAgents,
      allowedTools,
      systemPrompt,
      keep,
      cwd,
      resume: false,
      sessionFile: null,
      resultFile,
      eventLog,
      extensionPath: resolveExtensionPath(),
      startTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_START_TIMEOUT_MS || 30_000),
      commandTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_COMMAND_TIMEOUT_MS || 20_000),
      singleResponseTimeoutMs: positiveNumber(process.env.PI_PARALLEL_AGENTS_SINGLE_RESPONSE_TIMEOUT_MS),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (singleResponse) {
      const single = await runSingleResponseWorker({ configPath, config, agentId, db });
      process.stdout.write(JSON.stringify(single, null, 2) + "\n");
      return;
    }

    const worker = spawn(process.execPath, [__filename, "--supervise", configPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_SUPERVISOR: "1",
        PI_PARALLEL_AGENTS_AGENT_ID: agentId,
      },
    });
    worker.unref();

    const result = await waitForResultFile(resultFile, startResultTimeoutMs(config));
    if (!result.ok) {
      const errorMessage = result.error?.message ?? JSON.stringify(result.error ?? result);
      setAgentStatus(db, { agentId, status: "crashed", pid: null, lastError: errorMessage });
      throw new Error(`Failed to start parallel agent ${agentId}: ${errorMessage}`);
    }

    const output = result.wait ? { agent: result.agent, answer: result.answer ?? "", wait: result.wait } : result.agent;
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    db.close();
  }
}

async function startResume(options) {
  const stateDb = resolve(String(options["state-db"] ?? process.env.PI_PARALLEL_AGENTS_DB_PATH ?? required(options, "state-db")));
  const agentId = optionalString(options["agent-id"]) ?? optionalString(options["resume-session"]);
  if (!agentId) throw new Error("Missing --agent-id for --resume-session");

  const db = openStateDb(stateDb);
  try {
    initializeState(db);
    const existing = getAgent(db, agentId);
    if (!existing) throw new Error(`Unknown agent: ${agentId}`);
    if (existing.pid && isPidAlive(Number(existing.pid))) {
      const agent = existing.status === "done" || existing.status === "stopped"
        ? setAgentStatus(db, { agentId, status: "waiting", pid: Number(existing.pid), lastError: null })
        : existing;
      process.stdout.write(JSON.stringify(toStartResult(agent), null, 2) + "\n");
      return;
    }

    const repoRoot = resolve(String(existing.repo_root));
    const runtimeDir = resolve(repoRoot, ".pi", "parallel-agents");
    const tasksDb = resolve(String(options["tasks-db"] ?? process.env.PI_TASKS_DB_PATH ?? join(runtimeDir, "tasks.sqlite")));
    const promptPath = optionalString(options.prompt);
    const promptText = promptPath ? readFileSync(promptPath, "utf8") : null;
    const resumedAgent = upsertAgent(db, { agent_id: agentId, status: "starting", pid: null, last_error: null });
    appendEvent(db, {
      agentId,
      eventType: "resume_requested",
      payloadJson: JSON.stringify({ sessionFile: resumedAgent.session_file, cwd: resumedAgent.cwd }),
    });

    mkdirSync(join(runtimeDir, "tmp"), { recursive: true });
    mkdirSync(join(runtimeDir, "logs", "agents"), { recursive: true });
    const configPath = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-resume-sdk-worker.json`);
    const resultFile = join(runtimeDir, "tmp", `${agentId}-${Date.now()}-resume-result.json`);
    const eventLog = join(runtimeDir, "logs", "agents", `${agentId}.events.jsonl`);
    const allowedTools = parseAllowedTools(resumedAgent.allowed_tools_json) ?? defaultTools(Boolean(resumedAgent.read_only), Number(resumedAgent.max_sub_agents ?? 0));
    const config = {
      agent: resumedAgent,
      repoRoot,
      stateDb,
      tasksDb,
      promptText,
      provider: resumedAgent.provider,
      model: resumedAgent.model ?? DEFAULT_MODEL,
      thinking: resumedAgent.thinking ?? DEFAULT_THINKING,
      dedicatedWorktree: Boolean(resumedAgent.dedicated_worktree),
      readOnly: Boolean(resumedAgent.read_only),
      singleResponse: Boolean(resumedAgent.single_response),
      inheritContext: Boolean(resumedAgent.inherit_context),
      maxSubAgents: Number(resumedAgent.max_sub_agents ?? 0),
      allowedTools,
      systemPrompt: resumedAgent.system_prompt,
      keep: false,
      cwd: resumedAgent.cwd,
      resume: true,
      sessionFile: resumedAgent.session_file,
      resultFile,
      eventLog,
      extensionPath: resolveExtensionPath(),
      startTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_START_TIMEOUT_MS || 30_000),
      commandTimeoutMs: Number(process.env.PI_PARALLEL_AGENTS_COMMAND_TIMEOUT_MS || 20_000),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const worker = spawn(process.execPath, [__filename, "--supervise", configPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PI_PARALLEL_AGENTS_SUPERVISOR: "1",
        PI_PARALLEL_AGENTS_AGENT_ID: agentId,
      },
    });
    worker.unref();

    const result = await waitForResultFile(resultFile, config.startTimeoutMs);
    if (!result.ok) {
      const errorMessage = result.error?.message ?? JSON.stringify(result.error ?? result);
      setAgentStatus(db, { agentId, status: "crashed", pid: null, lastError: errorMessage });
      throw new Error(`Failed to resume parallel agent ${agentId}: ${errorMessage}`);
    }
    process.stdout.write(JSON.stringify(result.agent, null, 2) + "\n");
  } finally {
    db.close();
  }
}

async function runSingleResponseWorker({ configPath, config, agentId, db }) {
  const worker = spawn(process.execPath, [__filename, "--supervise", configPath], {
    detached: false,
    stdio: "ignore",
    env: {
      ...process.env,
      PI_PARALLEL_AGENTS_SUPERVISOR: "1",
      PI_PARALLEL_AGENTS_AGENT_ID: agentId,
    },
  });

  try {
    const result = await waitForResultFile(config.resultFile, config.singleResponseTimeoutMs);
    if (!result.ok) {
      const errorMessage = result.error?.message ?? JSON.stringify(result.error ?? result);
      setAgentStatus(db, { agentId, status: "crashed", pid: null, lastError: errorMessage });
      throw new Error(`Failed to complete single-response parallel agent ${agentId}: ${errorMessage}`);
    }
    return result.result;
  } catch (error) {
    await terminateSingleResponseWorker(worker);
    cleanupInterruptedSingleResponse(config, db, error.message);
    throw error;
  }
}

async function terminateSingleResponseWorker(worker) {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  try {
    worker.kill("SIGTERM");
  } catch {}
  const exited = await waitForWorkerExit(worker, Number(process.env.PI_PARALLEL_AGENTS_WORKER_TERMINATE_GRACE_MS || 5000));
  if (exited) return;
  try {
    worker.kill("SIGKILL");
  } catch {}
  await waitForWorkerExit(worker, 1000);
}

function waitForWorkerExit(worker, timeoutMs) {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      worker.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    worker.once("exit", onExit);
    if (worker.exitCode !== null || worker.signalCode !== null) {
      worker.off("exit", onExit);
      clearTimeout(timeout);
      resolvePromise(true);
    }
  });
}

function cleanupInterruptedSingleResponse(config, db, reason) {
  if (!config.singleResponse) return;
  const cleanup = { worktreeRemoved: false, branchRemoved: false, sessionRemoved: false, inheritedSessionRemoved: false, kept: Boolean(config.keep) };
  const latest = getAgent(db, config.agent.agent_id) ?? config.agent;
  const cleanupConfig = { ...config, agent: { ...config.agent, ...latest } };
  let cleanupError = null;
  if (!config.keep) {
    try {
      cleanupSingleResponse(cleanupConfig, latest.session_file ?? null, cleanup);
    } catch (error) {
      cleanupError = serializeError(error);
    }
  }
  try {
    if (latest.status !== "cleaned" && latest.status !== "done") {
      upsertAgent(db, {
        agent_id: config.agent.agent_id,
        pid: null,
        status: "crashed",
        session_file: config.keep ? latest.session_file ?? null : null,
        last_error: latest.last_error ?? (reason ? `singleResponse interrupted: ${reason}` : "singleResponse interrupted"),
      });
    }
  } catch {}
  try {
    appendEvent(db, {
      agentId: config.agent.agent_id,
      eventType: "single_response_interrupted",
      payloadJson: JSON.stringify({ reason, cleanup, cleanupError }),
    });
  } catch {}
}

async function superviseSdk(configPath) {
  if (!configPath) throw new Error("Missing supervisor config path");
  const config = readJsonFile(configPath);
  const db = openStateDb(config.stateDb);
  const queueDb = openQueueDb(config.tasksDb);
  let sessionBundle = null;
  let commandPollTimer = null;
  let commandPollRunning = false;
  let promptPromise = null;
  let started = false;
  let resultWritten = false;
  let finalAnswer = "";
  let shuttingDown = false;

  const failStart = (error) => {
    const serialized = serializeError(error);
    try {
      setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: serialized.message });
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "start_failed", payloadJson: JSON.stringify(serialized) });
    } catch {}
    writeResult(config.resultFile, { ok: false, error: serialized });
    resultWritten = true;
  };

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (commandPollTimer) clearInterval(commandPollTimer);
    try {
      if (sessionBundle?.session?.isStreaming) await sessionBundle.session.abort();
    } catch {}
    try {
      await sessionBundle?.dispose?.();
    } catch {}
    cleanupInterruptedSingleResponse(config, db, reason);
    try {
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "worker_shutdown", payloadJson: JSON.stringify({ reason }) });
    } catch {}
    try {
      queueDb.close();
    } catch {}
    try {
      db.close();
    } catch {}
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  try {
    initializeState(db);
    appendEvent(db, { agentId: config.agent.agent_id, eventType: "sdk_worker_start", payloadJson: JSON.stringify({ workerPid: process.pid, singleResponse: Boolean(config.singleResponse) }) });

    if (config.singleResponse) {
      const single = await runSingleResponse(config, db, queueDb);
      writeResult(config.resultFile, { ok: true, result: single });
      try {
        queueDb.close();
      } catch {}
      try {
        db.close();
      } catch {}
      return;
    }

    sessionBundle = await createWorkerSession(config);
    await bindWorkerSessionExtensions(sessionBundle, db, queueDb, config);
    const session = sessionBundle.session;

    session.subscribe((event) => {
      appendEventLog(config.eventLog, event);
      if (event.type === "turn_end") finalAnswer = extractAssistantText(event.message) || finalAnswer;
      if (event.type === "agent_end") finalAnswer = extractAssistantText(event.messages) || finalAnswer;
      handleSdkEvent(db, queueDb, config.agent.agent_id, event, process.pid);
    });

    if (config.promptText) {
      promptPromise = startPrompt(session, config.promptText, config.startTimeoutMs);
      promptPromise.catch((error) => {
        try {
          setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: error.message });
          appendEvent(db, { agentId: config.agent.agent_id, eventType: "prompt_failed", payloadJson: JSON.stringify(serializeError(error)) });
        } catch {}
      });
      await promptPromise.accepted;
    }

    const status = config.promptText || session.isStreaming ? "running" : "waiting";
    started = true;
    const updatedAgent = upsertAgent(db, {
      agent_id: config.agent.agent_id,
      pid: process.pid,
      status,
      session_id: session.sessionId ?? null,
      session_file: session.sessionFile ?? null,
      last_error: null,
    });
    appendEvent(db, {
      agentId: config.agent.agent_id,
      eventType: "sdk_started",
      payloadJson: JSON.stringify({ pid: process.pid, sessionId: session.sessionId ?? null, sessionFile: session.sessionFile ?? null, status }),
    });
    const startCommandPolling = () => {
      if (commandPollTimer) return;
      commandPollTimer = setInterval(async () => {
        if (commandPollRunning) return;
        commandPollRunning = true;
        try {
          await deliverQueuedCommands(db, queueDb, config, session);
        } catch (error) {
          appendEventSafe(db, config.agent.agent_id, "command_poll_error", serializeError(error));
        } finally {
          commandPollRunning = false;
        }
      }, Number(process.env.PI_PARALLEL_AGENTS_COMMAND_POLL_MS || 250));
      void deliverQueuedCommands(db, queueDb, config, session).catch((error) => {
        appendEventSafe(db, config.agent.agent_id, "command_poll_error", serializeError(error));
      });
    };

    if (shouldWaitForInitialResponse(config)) {
      startCommandPolling();
      const wait = await waitForInitialResponse({ config, queueDb, promptPromise });
      if (wait.status === "completed") finalAnswer = finalAnswer || extractAssistantText(session.messages) || "";
      if (wait.status === "question") setAgentStatus(db, { agentId: config.agent.agent_id, status: "waiting", pid: process.pid, lastError: null });
      const latestAgent = getAgent(db, config.agent.agent_id) ?? updatedAgent;
      appendEvent(db, {
        agentId: config.agent.agent_id,
        eventType: "wait_initial_response_done",
        payloadJson: JSON.stringify({ status: wait.status, answerBytes: Buffer.byteLength(finalAnswer, "utf8") }),
      });
      writeResult(config.resultFile, { ok: true, agent: toStartResult(latestAgent), answer: wait.status === "completed" ? finalAnswer : "", wait });
      resultWritten = true;
    } else {
      writeResult(config.resultFile, { ok: true, agent: toStartResult(updatedAgent) });
      resultWritten = true;
      startCommandPolling();
    }
  } catch (error) {
    if (!started) failStart(error);
    else {
      const serialized = serializeError(error);
      setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: serialized.message });
      appendEvent(db, { agentId: config.agent.agent_id, eventType: "worker_error", payloadJson: JSON.stringify(serialized) });
      if (!resultWritten) writeResult(config.resultFile, { ok: false, error: serialized });
      try {
        queueDb.close();
      } catch {}
      db.close();
    }
  }
}

function shouldWaitForInitialResponse(config) {
  return !config.singleResponse && config.waitUntil === "initial_response";
}

async function waitForInitialResponse({ config, queueDb, promptPromise }) {
  if (!promptPromise) return { until: "initial_response", status: "completed" };

  let promptOutcome = null;
  promptPromise.then(
    () => {
      promptOutcome = { status: "completed" };
    },
    (error) => {
      promptOutcome = { status: "failed", error };
    },
  );

  const timeoutMs = positiveNumber(config.waitTimeoutMs);
  const startedAt = Date.now();
  const pollMs = Number(process.env.PI_PARALLEL_AGENTS_WAIT_POLL_MS || 100);

  while (!promptOutcome) {
    const question = findQueuedIncomingQuestion(queueDb, config.agent.agent_id);
    if (question) {
      return { until: "initial_response", status: "question", question: toPublicQuestion(question) };
    }
    if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
      return { until: "initial_response", status: "timeout", timeoutMs };
    }
    await sleep(pollMs);
  }

  if (promptOutcome.status === "failed") throw promptOutcome.error;
  return { until: "initial_response", status: "completed" };
}

function findQueuedIncomingQuestion(queueDb, agentId) {
  if (!queueDb) return null;
  return listQuestions(queueDb, { agentId, direction: "incoming", status: "queued", limit: 1 })[0] ?? null;
}

function toPublicQuestion(question) {
  return {
    questionId: question.question_id,
    agentId: question.agent_id,
    direction: question.direction,
    mode: question.mode,
    status: question.status,
    message: question.message,
  };
}

async function runSingleResponse(config, db, queueDb) {
  const cleanup = { worktreeRemoved: false, branchRemoved: false, sessionRemoved: false, inheritedSessionRemoved: false, kept: Boolean(config.keep) };
  const restoreAgentIdentity = installAgentIdentity(config.agent.agent_id);
  let sessionBundle = null;
  let commandPollTimer = null;
  let commandPollPromise = null;
  let finalAnswer = "";
  try {
    sessionBundle = await createWorkerSession(config);
    await bindWorkerSessionExtensions(sessionBundle, db, queueDb, config);
    const session = sessionBundle.session;
    const pollQueuedCommands = () => {
      if (!queueDb || commandPollPromise) return commandPollPromise;
      commandPollPromise = (async () => {
        try {
          await deliverQueuedCommands(db, queueDb, config, session);
        } catch (error) {
          appendEventSafe(db, config.agent.agent_id, "single_response_command_poll_error", serializeError(error));
        } finally {
          commandPollPromise = null;
        }
      })();
      return commandPollPromise;
    };
    if (queueDb) {
      commandPollTimer = setInterval(() => {
        void pollQueuedCommands();
      }, Number(process.env.PI_PARALLEL_AGENTS_COMMAND_POLL_MS || 250));
      void pollQueuedCommands();
    }

    session.subscribe((event) => {
      appendEventLog(config.eventLog, event);
      if (event.type === "turn_end") finalAnswer = extractAssistantText(event.message) || finalAnswer;
      if (event.type === "agent_end") finalAnswer = extractAssistantText(event.messages) || finalAnswer;
      handleSdkEvent(db, queueDb, config.agent.agent_id, event, null);
    });

    upsertAgent(db, {
      agent_id: config.agent.agent_id,
      pid: null,
      status: "running",
      session_id: session.sessionId ?? null,
      session_file: session.sessionFile ?? null,
      last_error: null,
    });
    await session.prompt(config.promptText ?? "");
    finalAnswer = finalAnswer || extractAssistantText(session.messages) || "";
    const sessionFile = session.sessionFile ?? null;
    const sessionId = session.sessionId ?? null;
    await sessionBundle.dispose?.();
    sessionBundle = null;

    if (!config.keep) cleanupSingleResponse(config, sessionFile, cleanup);
    const status = config.keep ? "done" : "cleaned";
    upsertAgent(db, { agent_id: config.agent.agent_id, pid: null, status, session_id: sessionId, session_file: config.keep ? sessionFile : null, last_error: null });
    appendEvent(db, {
      agentId: config.agent.agent_id,
      eventType: "single_response_done",
      payloadJson: JSON.stringify({ answerBytes: Buffer.byteLength(finalAnswer, "utf8"), cleanup }),
    });

    return {
      ok: true,
      action: "start_agent",
      singleResponse: true,
      agentId: config.agent.agent_id,
      answer: finalAnswer,
      metadata: {
        cwd: config.cwd,
        provider: config.provider ?? null,
        model: config.model,
        thinking: config.thinking,
        sessionId,
        sessionFile: config.keep ? sessionFile : null,
        worktreePath: config.keep ? config.agent.worktree_path : null,
        branchName: config.keep ? config.agent.branch_name : null,
        dedicatedWorktree: config.dedicatedWorktree,
        readOnly: config.readOnly,
      },
      cleanup,
    };
  } catch (error) {
    try {
      upsertAgent(db, { agent_id: config.agent.agent_id, pid: null, status: "crashed", last_error: error.message });
    } catch {}
    if (!config.keep) cleanupSingleResponse(config, null, cleanup);
    throw error;
  } finally {
    if (commandPollTimer) clearInterval(commandPollTimer);
    try {
      await commandPollPromise;
    } catch {}
    try {
      await sessionBundle?.dispose?.();
    } catch {}
    restoreAgentIdentity();
  }
}

function installAgentIdentity(agentId) {
  const previous = process.env.PI_PARALLEL_AGENTS_AGENT_ID;
  process.env.PI_PARALLEL_AGENTS_AGENT_ID = agentId;
  return () => {
    if (previous === undefined) delete process.env.PI_PARALLEL_AGENTS_AGENT_ID;
    else process.env.PI_PARALLEL_AGENTS_AGENT_ID = previous;
  };
}

async function createWorkerSession(config) {
  const tools = normalizeAllowedTools(config.allowedTools, config.readOnly, config.maxSubAgents) ?? defaultTools(config.readOnly, config.maxSubAgents);
  if (shouldUseFakeSdk(config)) {
    const session = new FakeSdkSession({ ...config, tools });
    return { session, dispose: async () => session.dispose() };
  }

  const {
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    getAgentDir,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent");

  const agentDir = getAgentDir();
  const additionalExtensionPaths = shouldPassExplicitExtension(config) ? [config.extensionPath] : [];
  const appendSystemPrompt = config.systemPrompt ? [String(config.systemPrompt)] : [];

  const createRuntime = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths,
        appendSystemPrompt,
      },
    });
    const model = resolveSdkModel(services.modelRegistry, config.provider, config.model);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        ...(model ? { model } : {}),
        thinkingLevel: config.thinking,
        tools,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const sessionManager = createWorkerSessionManager(SessionManager, config);
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: config.cwd, agentDir, sessionManager });
  return { session: runtime.session, runtime, dispose: async () => runtime.dispose() };
}

async function bindWorkerSessionExtensions(sessionBundle, db, queueDb, config) {
  const bindSession = async (session) => {
    if (typeof session?.bindExtensions !== "function") return;
    await session.bindExtensions({
      uiContext: createQueueBackedUiContext({ db, queueDb, config }),
    });
  };
  if (typeof sessionBundle.runtime?.setRebindSession === "function") {
    sessionBundle.runtime.setRebindSession(bindSession);
  }
  await bindSession(sessionBundle.session);
}

function createQueueBackedUiContext({ db, queueDb, config }) {
  const agentId = config.agent.agent_id;
  let editorText = "";

  const askDialog = async ({ method, title, message, options, placeholder, prefill, opts }) => {
    if (!queueDb) return undefined;
    const questionId = createUiQuestionId(agentId, method, opts?.requestId);
    const questionMessage = formatUiQuestionMessage({ method, title, message, options, placeholder, prefill });
    createQuestion(queueDb, {
      questionId,
      agentId,
      direction: "incoming",
      mode: "reply",
      status: "queued",
      message: questionMessage,
      metadataJson: JSON.stringify({ transport: "ui_context", method, title, message: message ?? null, options: options ?? null, placeholder: placeholder ?? null, prefill: prefill ?? null, timeoutMs: opts?.timeout ?? null }),
    });
    appendEventSafe(db, agentId, "ui_context_question_queued", { questionId, method });
    return waitForUiQuestionAnswer(queueDb, questionId, opts);
  };

  return {
    select: async (title, options, opts) => {
      const response = await askDialog({ method: "select", title, options, opts });
      return response === undefined ? undefined : String(response);
    },
    confirm: async (title, message, opts) => parseConfirmResponse(await askDialog({ method: "confirm", title, message, opts })),
    input: (title, placeholder, opts) => askDialog({ method: "input", title, placeholder, opts }),
    notify: (message, type) => appendEventSafe(db, agentId, "ui_notify", { message, type: type ?? "info" }),
    onTerminalInput: () => () => {},
    setStatus: (key, text) => appendEventSafe(db, agentId, "ui_status", { key, text: text ?? null }),
    setWorkingMessage: (message) => appendEventSafe(db, agentId, "ui_working_message", { message: message ?? null }),
    setWorkingVisible: (visible) => appendEventSafe(db, agentId, "ui_working_visible", { visible: Boolean(visible) }),
    setWorkingIndicator: (options) => appendEventSafe(db, agentId, "ui_working_indicator", { options: options ?? null }),
    setHiddenThinkingLabel: (label) => appendEventSafe(db, agentId, "ui_hidden_thinking_label", { label: label ?? null }),
    setWidget: (key, content, options) => appendEventSafe(db, agentId, "ui_widget", { key, content: Array.isArray(content) ? content : content ? "<component>" : null, options: options ?? null }),
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => appendEventSafe(db, agentId, "ui_title", { title }),
    custom: (_factory, options) => askDialog({ method: "custom", title: "Custom UI request", message: "A worker extension requested custom UI that must be handled by the parent.", opts: options }),
    pasteToEditor: (text) => {
      editorText += String(text ?? "");
    },
    setEditorText: (text) => {
      editorText = String(text ?? "");
    },
    getEditorText: () => editorText,
    editor: (title, prefill, opts) => askDialog({ method: "editor", title, prefill, opts }),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {},
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Themes are unavailable in SDK worker UI context" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

function createUiQuestionId(agentId, method, requestedId) {
  const raw = optionalString(requestedId) ?? `${agentId}-${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return String(raw).replace(/\s+/g, "-").slice(0, 200) || `ui-${Date.now()}`;
}

function formatUiQuestionMessage({ method, title, message, options, placeholder, prefill }) {
  const lines = [`${title ?? "Worker UI request"}`];
  if (message) lines.push(String(message));
  if (placeholder) lines.push(`Placeholder: ${placeholder}`);
  if (Array.isArray(options) && options.length > 0) lines.push(`Options:\n${options.map((option) => `- ${option}`).join("\n")}`);
  if (prefill) lines.push(`Prefill:\n${prefill}`);
  lines.push(`UI method: ${method}`);
  return lines.filter(Boolean).join("\n\n");
}

async function waitForUiQuestionAnswer(queueDb, questionId, opts = {}) {
  const timeoutMs = positiveNumber(opts.timeout);
  const startedAt = Date.now();
  while (true) {
    if (opts.signal?.aborted) {
      answerQuestion(queueDb, { questionId, response: "aborted", status: "canceled" });
      return undefined;
    }
    const question = getQuestion(queueDb, questionId);
    if (question?.status === "answered" || question?.status === "done") return question.response ?? undefined;
    if (question?.status === "canceled") return undefined;
    if (question?.status === "blocked") throw new Error(`UI question ${questionId} was blocked${question.response ? `: ${question.response}` : ""}`);
    if (timeoutMs && Date.now() - startedAt >= timeoutMs) {
      answerQuestion(queueDb, { questionId, response: `Timed out after ${timeoutMs}ms`, status: "canceled" });
      return undefined;
    }
    await sleep(Number(process.env.PI_PARALLEL_AGENTS_UI_POLL_MS || 100));
  }
}

function parseConfirmResponse(response) {
  if (response === undefined || response === null) return false;
  const normalized = String(response).trim().toLowerCase();
  return normalized === "true" || normalized === "yes" || normalized === "y" || normalized === "1" || normalized === "ok" || normalized === "confirmed";
}

function createWorkerSessionManager(SessionManager, config) {
  if (config.resume && config.sessionFile) return SessionManager.open(config.sessionFile, undefined, config.cwd);
  if (config.inheritContext && config.inheritedSessionFile) {
    if (!existsSync(config.inheritedSessionFile)) throw new Error(`Cannot inherit context; source session file does not exist: ${config.inheritedSessionFile}`);
    return SessionManager.forkFrom(config.inheritedSessionFile, config.cwd);
  }
  if (config.singleResponse && !config.keep && !config.dedicatedWorktree) return SessionManager.inMemory(config.cwd);
  return SessionManager.create(config.cwd);
}

function resolveSdkModel(modelRegistry, provider, modelId) {
  if (!modelId) return undefined;
  if (provider) {
    const found = modelRegistry.find(String(provider), String(modelId));
    if (!found) throw new Error(`Model not found: ${provider}/${modelId}`);
    return found;
  }
  return modelRegistry.getAll().find((model) => model.id === modelId);
}

function startPrompt(session, promptText, timeoutMs) {
  let resolveAccepted;
  let rejectAccepted;
  const accepted = new Promise((resolvePromise, rejectPromise) => {
    resolveAccepted = resolvePromise;
    rejectAccepted = rejectPromise;
  });
  const timeout = setTimeout(() => rejectAccepted(new Error(`Timed out waiting for SDK prompt preflight after ${timeoutMs}ms`)), timeoutMs);
  const run = session.prompt(promptText, {
    preflightResult: (success) => {
      clearTimeout(timeout);
      if (success) resolveAccepted();
      else rejectAccepted(new Error("SDK prompt preflight rejected the initial prompt"));
    },
  });
  run.accepted = accepted;
  return run;
}

async function deliverQueuedCommands(db, queueDb, config, session) {
  const commands = claimQueuedAgentCommands(db, { agentId: config.agent.agent_id, limit: 10 });
  for (const command of commands) {
    let payload;
    try {
      payload = JSON.parse(command.payload_json);
    } catch (error) {
      completeAgentCommand(db, { commandId: command.id, status: "failed", lastError: `Invalid command payload JSON: ${error.message}` });
      continue;
    }

    const sdkCommand = normalizeSdkCommand(command.command_type, payload);
    const questionId = typeof payload.questionId === "string" ? payload.questionId : undefined;
    try {
      const response = await executeSdkCommand(session, sdkCommand);
      completeAgentCommand(db, { commandId: command.id, status: "succeeded", responseJson: response });
      if (questionId && (sdkCommand.type === "steer" || sdkCommand.type === "follow_up" || sdkCommand.type === "prompt")) markQuestionDelivered(queueDb, questionId);
      if (questionId && sdkCommand.type === "extension_ui_response" && typeof payload.response === "string") {
        answerQuestion(queueDb, { questionId, response: payload.response, status: "answered" });
      }
      if (sdkCommand.type === "get_state" && response.data) updateAgentFromState(db, config.agent.agent_id, response.data, process.pid);
    } catch (error) {
      completeAgentCommand(db, { commandId: command.id, status: "failed", lastError: error.message });
      if (questionId) markQuestionBlocked(queueDb, questionId, error.message);
    }
  }
}

function normalizeSdkCommand(commandType, payload) {
  const sdkCommand = payload.command && typeof payload.command === "object" ? { ...payload.command } : { ...payload };
  delete sdkCommand.questionId;
  delete sdkCommand.mode;
  if (!sdkCommand.type) sdkCommand.type = commandType;
  if (sdkCommand.type === "follow_up") sdkCommand.type = "follow_up";
  return sdkCommand;
}

async function executeSdkCommand(session, command) {
  switch (command.type) {
    case "steer":
      await session.steer(String(command.message ?? ""));
      return { ok: true, command: "steer" };
    case "follow_up":
    case "queue":
      await session.followUp(String(command.message ?? ""));
      return { ok: true, command: "follow_up" };
    case "prompt":
      void session.prompt(String(command.message ?? "")).catch(() => {});
      return { ok: true, command: "prompt" };
    case "abort":
      await session.abort();
      return { ok: true, command: "abort" };
    case "get_state":
      return { ok: true, command: "get_state", data: getSessionState(session) };
    case "set_thinking_level":
      session.setThinkingLevel(String(command.level ?? "high"));
      return { ok: true, command: "set_thinking_level" };
    case "extension_ui_response":
      return { ok: true, command: "extension_ui_response", fireAndForget: true };
    default:
      throw new Error(`Unsupported SDK command: ${command.type}`);
  }
}

function getSessionState(session) {
  return {
    model: session.model ? { id: session.model.id, provider: session.model.provider } : null,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: Boolean(session.isCompacting),
    sessionFile: session.sessionFile ?? null,
    sessionId: session.sessionId ?? null,
    tools: Array.isArray(session.tools) ? session.tools : null,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    pendingMessageCount: session.pendingMessageCount ?? 0,
  };
}

function updateAgentFromState(db, agentId, state, pid) {
  const status = state.isStreaming ? "running" : "waiting";
  upsertAgent(db, {
    agent_id: agentId,
    status,
    pid,
    session_id: state.sessionId ?? null,
    session_file: state.sessionFile ?? null,
    last_error: null,
  });
}

function handleSdkEvent(db, queueDb, agentId, event, pid) {
  const type = event.type || "unknown";
  if (type !== "message_update") appendEventSafe(db, agentId, `sdk_${type}`, event);
  if (type === "agent_start" || type === "turn_start") {
    setAgentStatus(db, { agentId, status: "running", pid });
  } else if (type === "agent_end") {
    setAgentStatus(db, { agentId, status: "waiting", pid });
  } else if (queueDb && type === "extension_ui_request" && isDialogUiRequest(event)) {
    const question = questionFromUiRequest(agentId, event);
    createQuestion(queueDb, question);
    appendEventSafe(db, agentId, "ui_request_queued", { questionId: question.questionId, method: event.method ?? null });
    setAgentStatus(db, { agentId, status: "waiting", pid });
  }
}

function isDialogUiRequest(event) {
  return event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor";
}

function questionFromUiRequest(agentId, event) {
  const rawId = event.id ?? event.requestId ?? event.uiRequestId ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const questionId = String(rawId).slice(0, 200) || `question-${Date.now()}`;
  const message = String(event.message ?? event.prompt ?? event.title ?? event.text ?? JSON.stringify(event));
  return {
    questionId,
    agentId,
    direction: "incoming",
    mode: "queue",
    status: "queued",
    message,
    metadataJson: JSON.stringify(event),
  };
}

function cleanupSingleResponse(config, sessionFile, cleanup) {
  if (sessionFile) {
    rmSync(sessionFile, { force: true });
    cleanup.sessionRemoved = true;
  }
  if (config.inheritedSessionFile) {
    rmSync(config.inheritedSessionFile, { force: true });
    cleanup.inheritedSessionRemoved = true;
  }
  if (config.agent.worktree_path && existsSync(config.agent.worktree_path)) {
    removeWorktree(config.repoRoot, config.agent.worktree_path);
    cleanup.worktreeRemoved = true;
  }
  if (config.agent.branch_name && branchExists(config.repoRoot, config.agent.branch_name)) {
    deleteBranch(config.repoRoot, config.agent.branch_name);
    cleanup.branchRemoved = true;
  }
}

function removeWorktree(repoRoot, worktreePath) {
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktreePath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git worktree remove failed: ${result.stderr || result.stdout}`);
}

function deleteBranch(repoRoot, branchName) {
  const result = spawnSync("git", ["-C", repoRoot, "branch", "-D", branchName], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git branch delete failed: ${result.stderr || result.stdout}`);
}

function extractAssistantText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (typeof value !== "object") return "";
  if (value.role && value.role !== "assistant") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return value.content.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (Array.isArray(value.messages)) return value.messages.map(extractAssistantText).filter(Boolean).join("\n").trim();
  if (value.message) return extractAssistantText(value.message);
  return "";
}

class FakeSdkSession {
  constructor(config) {
    this.cwd = config.cwd;
    this._listeners = new Set();
    this._isStreaming = false;
    this._thinkingLevel = config.thinking ?? DEFAULT_THINKING;
    this._model = { id: config.model ?? "fake-model", provider: config.provider ?? "fake" };
    this.sessionId = `fake-session-${process.pid}`;
    const sessionDir = resolve(config.cwd, ".pi", "fake-sessions");
    mkdirSync(sessionDir, { recursive: true });
    this.sessionFile = join(sessionDir, `${this.sessionId}.jsonl`);
    writeFileSync(this.sessionFile, JSON.stringify({ sessionId: this.sessionId, pid: process.pid }) + "\n");
    this.messages = [];
    this.tools = config.tools ?? null;
    this.pendingMessageCount = 0;
    this.isCompacting = false;
    this._uiContext = null;
  }

  get isStreaming() {
    return this._isStreaming;
  }

  get thinkingLevel() {
    return this._thinkingLevel;
  }

  get model() {
    return this._model;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  async bindExtensions(bindings = {}) {
    this._uiContext = bindings.uiContext ?? null;
  }

  async prompt(message, options = {}) {
    options.preflightResult?.(true);
    this._isStreaming = true;
    this._emit({ type: "agent_start" });
    const text = String(message ?? "");
    const uiResponsePromise = text.includes("ASK_UI")
      ? this._requestUiInput({ id: "ui-test", title: "Need input", placeholder: "Need input" })
      : null;
    if (text.includes("FIRE_AND_FORGET_UI")) {
      if (this._uiContext?.setWidget) this._uiContext.setWidget("fire-and-forget-test", ["ignore me"]);
      else setTimeout(() => this._emit({ type: "extension_ui_request", id: "fire-and-forget-test", method: "setWidget", widgetKey: "fake", widgetLines: ["ignore me"] }), 50);
    }
    const uiResponse = uiResponsePromise ? await uiResponsePromise : null;
    await sleep(text.includes("SLOW_RESPONSE") ? 5000 : 200);
    const answerText = text.includes("REPORT_AGENT_ID")
      ? `agent id ${process.env.PI_PARALLEL_AGENTS_AGENT_ID ?? "none"}`
      : uiResponse
        ? `ui answer ${uiResponse}`
        : "fake done";
    const assistant = { role: "assistant", content: [{ type: "text", text: answerText }], model: this._model.id, provider: this._model.provider, stopReason: "stop" };
    this._emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    this.messages.push(assistant);
    this._emit({ type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] });
    this._isStreaming = false;
    this._emit({ type: "agent_end", messages: [assistant] });
  }

  async steer() {}
  async followUp() {}
  async abort() {
    this._isStreaming = false;
    this._emit({ type: "agent_end", messages: [] });
  }
  setThinkingLevel(level) {
    this._thinkingLevel = level;
  }
  dispose() {
    this._listeners.clear();
  }

  _requestUiInput({ id, title, placeholder }) {
    if (this._uiContext?.input) return this._uiContext.input(title, placeholder, { requestId: id });
    setTimeout(() => this._emit({ type: "extension_ui_request", id, method: "input", title, prompt: placeholder }), 50);
    return Promise.resolve(undefined);
  }

  _emit(event) {
    for (const listener of this._listeners) listener(event);
  }
}

function shouldUseFakeSdk(config) {
  if (process.env.PI_PARALLEL_AGENTS_FAKE_SDK === "1") return true;
  if (String(config.model ?? "").startsWith("fake")) return true;
  return false;
}

function defaultTools(readOnly, maxSubAgents) {
  const tools = readOnly ? READ_ONLY_TOOLS : WRITE_TOOLS;
  return maxSubAgents > 0 ? [...tools] : tools.filter((tool) => tool !== "start_agent");
}

function normalizeAllowedTools(value, readOnly, maxSubAgents) {
  const parsed = Array.isArray(value) ? value : parseAllowedTools(value);
  const tools = parsed ? Array.from(new Set(parsed.map((tool) => String(tool).trim()).filter(Boolean))) : null;
  if (!tools) return null;
  if (readOnly) {
    const rejected = tools.filter((tool) => MUTATING_TOOLS.has(tool));
    if (rejected.length > 0) throw new Error(`readOnly=true cannot explicitly allow mutating tools: ${rejected.join(", ")}`);
    return tools.filter((tool) => READ_ONLY_TOOL_ALLOWLIST.has(tool) && (tool !== "start_agent" || maxSubAgents > 0));
  }
  return maxSubAgents > 0 ? tools : tools.filter((tool) => tool !== "start_agent");
}

function parseAllowedTools(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function shouldPassExplicitExtension(config) {
  if (!config.extensionPath) return false;
  if (config.cwd === config.repoRoot && existsSync(join(config.cwd, ".pi", "extensions"))) return false;
  return true;
}

function resolveExtensionPath() {
  if (process.env.PI_PARALLEL_AGENTS_EXTENSION_PATH) return resolve(process.env.PI_PARALLEL_AGENTS_EXTENSION_PATH);
  const sourcePath = join(repoScriptRoot, "src", "parallel-agents.ts");
  if (existsSync(sourcePath)) return sourcePath;
  const distPath = join(repoScriptRoot, "dist", "src", "parallel-agents.js");
  if (existsSync(distPath)) return distPath;
  return null;
}

async function proposeNames({ repoRoot, requestedName, parentPrompt, agentPrompt, provider, model }) {
  const fallback = {
    displayName: requestedName,
    worktreeName: `agent-${sanitizeSlug(requestedName, "agent")}`,
    branchName: `agent-${sanitizeSlug(requestedName, "agent")}`,
  };

  if (process.env.PI_PARALLEL_AGENTS_NAMING_JSON) {
    try {
      return { ...fallback, ...JSON.parse(process.env.PI_PARALLEL_AGENTS_NAMING_JSON) };
    } catch {}
  }

  if (process.env.PI_PARALLEL_AGENTS_DISABLE_NAMING_AGENT === "1") return fallback;

  const piBin = process.env.PI_PARALLEL_AGENTS_PI_BIN || "pi";
  const namingPrompt = buildNamingPrompt({ repoRoot, requestedName, parentPrompt, agentPrompt });
  const args = [];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  args.push("--thinking", "off", "--no-tools", "-p", namingPrompt);
  const result = spawnSync(piBin, args, { cwd: repoRoot, encoding: "utf8", timeout: Number(process.env.PI_PARALLEL_AGENTS_NAMING_TIMEOUT_MS || 60_000) });
  if (result.status !== 0 || result.error) return fallback;
  const parsed = parseFirstJsonObject(result.stdout);
  return parsed ? { ...fallback, ...parsed } : fallback;
}

function buildNamingPrompt({ repoRoot, requestedName, parentPrompt, agentPrompt }) {
  let template = "";
  const templatePath = join(repoScriptRoot, "src", "prompts", "naming-agent.md");
  if (existsSync(templatePath)) template = readFileSync(templatePath, "utf8");
  return `${template}\n\nContext JSON:\n${JSON.stringify(
    {
      repoRoot,
      repoName: basename(repoRoot),
      suggestedName: requestedName,
      parentPrompt,
      agentPrompt,
      existingWorktrees: listWorktreeBasenames(repoRoot),
    },
    null,
    2,
  )}\n\nReturn only the JSON object.`;
}

function parseFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function createWorktree(repoRoot, worktreePath, branchName) {
  if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }
}

function dedupeWorktreeName(worktreeBase, baseName, repoRoot) {
  const existing = new Set(listWorktreeBasenames(repoRoot));
  let candidate = baseName;
  let suffix = 2;
  while (existing.has(candidate) || existsSync(join(worktreeBase, candidate))) {
    candidate = `${baseName}-${suffix++}`;
  }
  return candidate;
}

function listWorktreeBasenames(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => basename(line.slice("worktree ".length).trim()))
    .filter(Boolean);
}

function dedupeBranchName(repoRoot, baseName) {
  let candidate = baseName;
  let suffix = 2;
  while (branchExists(repoRoot, candidate)) candidate = `${baseName}-${suffix++}`;
  return candidate;
}

function branchExists(repoRoot, branchName) {
  const result = spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
  return result.status === 0;
}

function resolveRepoRoot(cwd) {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return resolve(result.stdout.trim());
  return resolve(cwd);
}

function assertGitRepository(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `dedicatedWorktree=true requires a git repository, but ${repoRoot} is not inside one. ` +
        "Pass repoRoot pointing at a git repository or use dedicatedWorktree=false.",
    );
  }
}


function boolOption(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "false" && value !== "0";
  return Boolean(value);
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer; got ${value}`);
  return number;
}

function positiveNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeWaitUntil(value, singleResponse = false) {
  const waitUntil = optionalString(value) ?? (singleResponse ? "initial_response" : "started");
  if (waitUntil !== "started" && waitUntil !== "initial_response") throw new Error(`waitUntil must be 'started' or 'initial_response'; got ${value}`);
  if (singleResponse && waitUntil === "started") throw new Error("singleResponse=true always waits for the response; omit waitUntil or use waitUntil='initial_response'.");
  return waitUntil;
}

function startResultTimeoutMs(config) {
  if (!shouldWaitForInitialResponse(config)) return config.startTimeoutMs;
  const waitTimeoutMs = positiveNumber(config.waitTimeoutMs);
  return waitTimeoutMs ? waitTimeoutMs + Number(config.startTimeoutMs ?? 0) : undefined;
}

function sanitizeSlug(input, fallback) {
  const sanitized = String(input ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80);
  return sanitized || fallback;
}

function sanitizeBranchName(input, fallback) {
  const sanitized = sanitizeSlug(input, fallback).replace(/\.lock$/u, "").replace(/\.\./gu, "-");
  const result = spawnSync("git", ["check-ref-format", "--branch", sanitized], { encoding: "utf8" });
  return result.status === 0 ? sanitized : sanitizeSlug(fallback, "parallel-agent");
}

function safeDisplayName(input) {
  return String(input ?? "agent").trim().replace(/\s+/g, " ").slice(0, 80) || "agent";
}

function dedupeSlug(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function toStartResult(row) {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    pid: row.pid,
    dedicatedWorktree: Boolean(row.dedicated_worktree),
    readOnly: Boolean(row.read_only),
    singleResponse: Boolean(row.single_response),
    inheritContext: Boolean(row.inherit_context),
    maxSubAgents: Number(row.max_sub_agents ?? 0),
    allowedTools: parseAllowedTools(row.allowed_tools_json),
    requesterAgentId: row.requester_agent_id,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    thinking: row.thinking,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    status: row.status,
  };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") throw new Error(`Missing --${key}`);
  return String(value);
}

function optionalString(value) {
  if (value === undefined || value === null || value === true || value === "") return undefined;
  return String(value);
}

function waitForResultFile(path, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const interval = setInterval(() => {
      if (existsSync(path)) {
        clearInterval(interval);
        try {
          const result = readJsonFile(path);
          rmSync(path, { force: true });
          resolvePromise(result);
        } catch (error) {
          rejectPromise(error);
        }
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        rejectPromise(new Error(`Timed out waiting for supervisor result file: ${path}`));
      }
    }, 100);
  });
}

function writeResult(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function appendEventLog(path, event) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(event) + "\n", { flag: "a" });
}

function appendEventSafe(db, agentId, eventType, payload) {
  try {
    appendEvent(db, { agentId, eventType, payloadJson: truncate(JSON.stringify(payload), MAX_EVENT_PAYLOAD) });
  } catch {}
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

if (process.argv[2] === "--supervise") {
  superviseSdk(process.argv[3]).catch((error) => {
    try {
      const configPath = process.argv[3];
      const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : null;
      if (config?.resultFile) writeResult(config.resultFile, { ok: false, error: serializeError(error) });
      if (config?.stateDb && config?.agent?.agent_id) {
        const db = openStateDb(config.stateDb);
        try {
          setAgentStatus(db, { agentId: config.agent.agent_id, status: "crashed", pid: null, lastError: error.message });
        } finally {
          db.close();
        }
      }
    } catch {}
    process.exit(1);
  });
} else {
  start().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
