import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentOptions } from "../../dist/src/config/resolve-agent-options.js";

const configuredDefaults = { model: "configured-model", thinking: "high" };

test("resolveAgentOptions inherits parent provider/model when no override is provided", () => {
  const resolved = resolveAgentOptions(
    { name: "child", prompt: "task", workspaceMode: "current" },
    {},
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model" },
  );

  assert.equal(resolved.provider, "parent-provider");
  assert.equal(resolved.model, "parent-model");
  assert.equal(resolved.thinking, "high");
  assert.equal(resolved.accessMode, "read_only");
});

test("resolveAgentOptions honors launch defaults over parent provider/model", () => {
  const resolved = resolveAgentOptions(
    { name: "child", prompt: "task", workspaceMode: "current" },
    { defaultProvider: "launch-provider", defaultModel: "launch-model", defaultThinking: "medium" },
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model" },
  );

  assert.equal(resolved.provider, "launch-provider");
  assert.equal(resolved.model, "launch-model");
  assert.equal(resolved.thinking, "medium");
});

test("resolveAgentOptions honors per-agent overrides over launch defaults and parent model", () => {
  const resolved = resolveAgentOptions(
    {
      name: "child",
      prompt: "task",
      workspaceMode: "current",
      provider: "agent-provider",
      model: "agent-model",
      thinking: "low",
    },
    { defaultProvider: "launch-provider", defaultModel: "launch-model", defaultThinking: "medium" },
    configuredDefaults,
    { provider: "parent-provider", model: "parent-model" },
  );

  assert.equal(resolved.provider, "agent-provider");
  assert.equal(resolved.model, "agent-model");
  assert.equal(resolved.thinking, "low");
});
