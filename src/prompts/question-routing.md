# Parallel-agent question routing

When a child agent needs input from the parent/orchestrator, it should ask through the durable queue tools with a concise question. The parent can answer with `reply_parallel_question`, which persists the answer and sends the response back through the SDK worker when the child session is running or resumed.
