# Parallel-agent question routing

When a child agent needs input from the parent/orchestrator, it should emit an `extension_ui_request` event or call the durable queue tools with a concise question. The parent can answer with `reply_parallel_question`, which persists the answer and sends an `extension_ui_response` back to the child session when the child RPC supervisor is running.
