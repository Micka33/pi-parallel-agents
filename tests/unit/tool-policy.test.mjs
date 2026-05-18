import test from "node:test";
import assert from "node:assert/strict";
import { resolveChildAllowedTools } from "../../dist/src/security/tool-policy.js";

test("resolveChildAllowedTools treats explicit empty allowedTools as an empty allowlist", () => {
  assert.deepEqual(resolveChildAllowedTools({ inheritedTools: ["read", "bash"], allowedTools: [], readOnly: false, maxSubAgents: 0 }), []);
  assert.deepEqual(resolveChildAllowedTools({ inheritedTools: ["read", "bash"], allowedTools: [], readOnly: true, maxSubAgents: 0 }), []);
});

test("resolveChildAllowedTools inherits, dedupes, and applies read-only policy", () => {
  assert.deepEqual(resolveChildAllowedTools({ inheritedTools: [" read ", "read", ""], allowedTools: undefined, readOnly: false, maxSubAgents: 0 }), ["read"]);

  const defaultReadOnly = resolveChildAllowedTools({ inheritedTools: undefined, allowedTools: undefined, readOnly: true, maxSubAgents: 0 });
  assert.deepEqual(defaultReadOnly, ["read", "grep", "find", "ls", "get_parallel_agents", "message_parallel_agent", "reply_parallel_question", "control_parallel_agent"]);

  assert.deepEqual(
    resolveChildAllowedTools({ inheritedTools: ["read", "bash", "start_agent", "message_parallel_agent"], allowedTools: undefined, readOnly: true, maxSubAgents: 1 }),
    ["read", "start_agent", "message_parallel_agent"],
  );
});

test("resolveChildAllowedTools rejects explicit mutating tools in read-only mode", () => {
  assert.throws(
    () => resolveChildAllowedTools({ inheritedTools: undefined, allowedTools: ["read", "edit"], readOnly: true, maxSubAgents: 0 }),
    /mutating tools: edit/,
  );
});
