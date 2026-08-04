---
description: Dispatch a coding task to the cbx orchestrator (runs in background with tests + review).
argument-hint: "[task description]"
---

Dispatch the following task to cbx and track it to completion.

Call `mcp__cbx__cbx_start` with:
- `task`: `$ARGUMENTS`
- `workspace`: omit (defaults to the current project via CBX_WORKSPACE)

You will receive `{ job_id, status: "queued" }`. Then:
1. Poll `mcp__cbx__cbx_status` with that `job_id` every few seconds until `status` reaches a terminal value (`done`, `failed`, `needs_fix`, `review_failed`, `cancelled`).
2. On `done`, call `mcp__cbx__cbx_result` and summarize the changes, test result, and review verdict for the user.
3. On `needs_fix` / `review_failed`, read `mcp__cbx__cbx_review` and `mcp__cbx__cbx_logs`, then either call `/cbx-continue` or report the failure cause.

Do not block on a single poll; the task runs in a detached worker. Report the `job_id` to the user immediately so they can inspect it via `/cbx-status` if needed.
