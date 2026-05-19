import test from "node:test";
import assert from "node:assert/strict";
import { resolveStartAgentOptions } from "../../dist/src/config/resolve-agent-options.js";

const configuredDefaults = { model: "configured-model", thinking: "high" };

test("resolveStartAgentOptions inherits parent provider/model/thinking when no override is provided", () => {
  const resolved = resolveStartAgentOptions(
    { name: "child", prompt: "task", dedicatedWorktree: false },
    {},
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model", thinkingLevel: "medium" },
  );

  assert.equal(resolved.provider, "parent-provider");
  assert.equal(resolved.model, "parent-model");
  assert.equal(resolved.thinking, "medium");
  assert.equal(resolved.readOnly, true);
});

test("resolveStartAgentOptions honors start defaults over parent provider/model/thinking", () => {
  const resolved = resolveStartAgentOptions(
    { name: "child", prompt: "task", dedicatedWorktree: false },
    { defaultProvider: "default-provider", defaultModel: "default-model", defaultThinking: "medium" },
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model", thinkingLevel: "xhigh" },
  );

  assert.equal(resolved.provider, "default-provider");
  assert.equal(resolved.model, "default-model");
  assert.equal(resolved.thinking, "medium");
});

test("resolveStartAgentOptions honors per-agent overrides over start defaults and parent model", () => {
  const resolved = resolveStartAgentOptions(
    {
      name: "child",
      prompt: "task",
      dedicatedWorktree: false,
      provider: "agent-provider",
      model: "agent-model",
      thinkingLevel: "low",
      maxSubAgents: 1,
      allowedTools: ["read", "grep"],
    },
    { defaultProvider: "default-provider", defaultModel: "default-model", defaultThinking: "medium" },
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model" },
  );

  assert.equal(resolved.provider, "agent-provider");
  assert.equal(resolved.model, "agent-model");
  assert.equal(resolved.thinking, "low");
  assert.equal(resolved.maxSubAgents, 1);
  assert.deepEqual(resolved.allowedTools, ["read", "grep"]);
});

test("resolveStartAgentOptions supports waiting for a persistent initial response", () => {
  const resolved = resolveStartAgentOptions(
    { name: "child", prompt: "task", waitUntil: "initial_response", waitTimeoutMs: 5000 },
    {},
    configuredDefaults,
  );

  assert.equal(resolved.singleResponse, false);
  assert.equal(resolved.waitUntil, "initial_response");
  assert.equal(resolved.waitTimeoutMs, 5000);
});
