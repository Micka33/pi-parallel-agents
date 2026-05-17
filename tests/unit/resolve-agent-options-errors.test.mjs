import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentOptions } from "../../dist/src/config/resolve-agent-options.js";

const configuredDefaults = { model: "configured-model", thinking: "high" };

test("resolveAgentOptions defaults worktree/write and omits empty provider", () => {
  const resolved = resolveAgentOptions({ name: "child", prompt: "task" }, {}, configuredDefaults);
  assert.deepEqual(resolved, {
    name: "child",
    prompt: "task",
    workspaceMode: "worktree",
    accessMode: "write",
    model: "configured-model",
    thinking: "high",
  });
});

test("resolveAgentOptions rejects invalid workspace and access combinations", () => {
  assert.throws(
    () => resolveAgentOptions({ name: "child", prompt: "task", workspaceMode: "invalid" }, {}, configuredDefaults),
    /Invalid workspaceMode/,
  );
  assert.throws(
    () => resolveAgentOptions({ name: "child", prompt: "task", accessMode: "invalid" }, {}, configuredDefaults),
    /Invalid accessMode/,
  );
  assert.throws(
    () => resolveAgentOptions({ name: "child", prompt: "task", workspaceMode: "current", accessMode: "write" }, {}, configuredDefaults),
    /current\/write is not enabled/,
  );
});
