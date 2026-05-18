import test from "node:test";
import assert from "node:assert/strict";
import { resolveStartAgentOptions } from "../../dist/src/config/resolve-agent-options.js";

const configuredDefaults = { model: "configured-model", thinking: "high" };

test("resolveStartAgentOptions defaults dedicated worktree/write and omits empty provider", () => {
  const resolved = resolveStartAgentOptions({ name: "child", prompt: "task" }, {}, configuredDefaults);
  assert.deepEqual(resolved, {
    name: "child",
    prompt: "task",
    model: "configured-model",
    thinking: "high",
  });
  assert.equal(resolved.dedicatedWorktree, true);
  assert.equal(resolved.readOnly, false);
});

test("resolveStartAgentOptions covers SDK-first defaults, hidden metadata, and validation", () => {
  const resolved = resolveStartAgentOptions(
    {
      name: "  nested   child  ",
      prompt: "task",
      dedicatedWorktree: false,
      singleResponse: true,
      maxSubAgents: 2,
      allowedTools: ["read", "read", "", "grep"],
      systemPrompt: "extra system",
      keep: true,
    },
    { defaultProvider: "default-provider", defaultModel: "default-model", defaultThinking: "low" },
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model" },
  );

  assert.deepEqual(resolved, {
    name: "nested child",
    prompt: "task",
    provider: "default-provider",
    model: "default-model",
    thinking: "low",
  });
  assert.equal(resolved.dedicatedWorktree, false);
  assert.equal(resolved.readOnly, true);
  assert.equal(resolved.singleResponse, true);
  assert.equal(resolved.maxSubAgents, 2);
  assert.equal(resolved.keep, true);
  assert.equal(resolved.thinkingLevel, "low");
  assert.deepEqual(resolved.allowedTools, ["read", "grep"]);
  assert.equal(resolved.systemPrompt, "extra system");

  assert.throws(() => resolveStartAgentOptions({ prompt: "" }, {}, configuredDefaults), /non-empty prompt/);
  assert.throws(() => resolveStartAgentOptions({ prompt: "task", maxSubAgents: -1 }, {}, configuredDefaults), /maxSubAgents/);
  assert.throws(() => resolveStartAgentOptions({ prompt: "task", dedicatedWorktree: false, readOnly: false }, {}, configuredDefaults), /dedicatedWorktree=false/);
  const parentFallback = resolveStartAgentOptions({ name: "   ", prompt: "task" }, {}, configuredDefaults, {
    provider: "parent-provider",
    model: "parent-model",
    thinkingLevel: "medium",
  });
  assert.deepEqual(parentFallback, {
    name: "agent",
    prompt: "task",
    provider: "parent-provider",
    model: "parent-model",
    thinking: "medium",
  });
  assert.equal(parentFallback.dedicatedWorktree, true);
  assert.equal(parentFallback.readOnly, false);

  const explicit = resolveStartAgentOptions(
    { name: "child", prompt: "task", dedicatedWorktree: true, readOnly: false, inheritContext: true, provider: "spec-provider", model: "spec-model", thinkingLevel: "xhigh" },
    {},
    configuredDefaults,
  );
  assert.equal(explicit.inheritContext, true);
  assert.equal(explicit.provider, "spec-provider");
  assert.equal(explicit.model, "spec-model");
  assert.equal(explicit.thinkingLevel, "xhigh");

  const readOnlyNoTools = resolveStartAgentOptions({ prompt: "task", readOnly: true }, {}, configuredDefaults);
  assert.equal(readOnlyNoTools.readOnly, true);
  assert.equal(readOnlyNoTools.allowedTools, undefined);

  const emptyAllowedTools = resolveStartAgentOptions({ prompt: "task", provider: "", systemPrompt: "", allowedTools: [], singleResponse: false, inheritContext: false, keep: false }, {}, configuredDefaults);
  assert.deepEqual(emptyAllowedTools, {
    name: "agent",
    prompt: "task",
    model: "configured-model",
    thinking: "high",
  });
  assert.deepEqual(emptyAllowedTools.allowedTools, []);
  assert.equal(emptyAllowedTools.systemPrompt, undefined);

  assert.throws(() => resolveStartAgentOptions({}, {}, configuredDefaults), /non-empty prompt/);
  assert.throws(() => resolveStartAgentOptions({ prompt: "task", maxSubAgents: 1.2 }, {}, configuredDefaults), /maxSubAgents/);
  assert.throws(() => resolveStartAgentOptions({ prompt: "task", readOnly: true, allowedTools: ["read", "edit"] }, {}, configuredDefaults), /mutating tools: edit/);
});
