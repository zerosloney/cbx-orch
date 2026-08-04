---
description: Dispatch a coding task to the cbx orchestrator (runs in background with tests + review).
argument-hint: "[task description]"
---

Dispatch the following task to cbx and track it to completion.

Call `mcp__cbx__cbx_start` with:
- `task`: `$ARGUMENTS`
- `workspace`: omit (defaults to the current project via CBX_WORKSPACE)
- `context_snapshot`: before dispatching, extract only the context needed to execute safely: goal clarifications, current plan, relevant file paths and command outputs, and constraints or decisions from this conversation. Omit unrelated chat history. Omit or pass an empty string if there is no relevant context — an empty snapshot is not persisted and the worker will not read it. Secrets are auto-redacted when `governance.redactFields` / `governance.redactPatterns` are configured in `.cbx.json`, but do not rely on this as the sole defense — exclude secrets at the source.

You will receive `{ job_id, status: "queued" }`. Then:
1. Poll `mcp__cbx__cbx_status` with that `job_id` every few seconds until `status` reaches a terminal value (`done`, `failed`, `needs_fix`, `review_failed`, `cancelled`).
2. On `done`, call `mcp__cbx__cbx_result` and summarize the changes, test result, and review verdict for the user.
3. On `needs_fix` / `review_failed`, read `mcp__cbx__cbx_review` and `mcp__cbx__cbx_logs`, then either call `/cbx-continue` or report the failure cause.

Do not block on a single poll; the task runs in a detached worker. Report the `job_id` to the user immediately so they can inspect it via `/cbx-status` if needed.
