---
description: Dispatch a coding task to the cbx orchestrator (runs in background with tests + review).
argument-hint: "[task description]"
---

Dispatch the following task to cbx and track it to completion.

Call `mcp__cbx__cbx_start` with:
- `task`: `$ARGUMENTS`
- `workspace`: omit (defaults to the current project via CBX_WORKSPACE)
- `context_snapshot`: before dispatching, extract only the context needed to execute safely: goal clarifications, current plan, relevant file paths and command outputs, and constraints or decisions from this conversation. Omit unrelated chat history. Omit or pass an empty string if there is no relevant context — an empty snapshot is not persisted and the worker will not read it. Secrets are auto-redacted when `governance.redactFields` / `governance.redactPatterns` are configured in `.cbx.json`, but do not rely on this as the sole defense — exclude secrets at the source.
- `task_contract`: for non-trivial work, pass `goal`, `acceptance_criteria`, `non_goals`, `constraints`, `relevant_files`, `decisions`, `rejected_options`, and `assumptions`. This enables a plan-only understanding handshake; blocking questions stop as `needs_fix` instead of being guessed.

You will receive `{ job_id, status: "queued" }`. Then:
1. Poll with an incremental event cursor (avoids re-sending history each round):
   - `offset = 0`
   - loop:
     1. `mcp__cbx__cbx_logs` with `{ job_id, since: offset }` → returns `{ events: [...], next_offset }`. Save `offset = next_offset`.
     2. Surface key events to the user — `process_started`, `process_finished`, test exit, `review_verdict`. Do NOT dump the full event list.
     3. `mcp__cbx__cbx_status` once to check for a terminal status (`done` / `failed` / `needs_fix` / `review_failed` / `cancelled`). Terminal → break.
     4. Not terminal → wait a few seconds (backoff up to ~15s for long tasks) and loop.
2. On `done`, call `mcp__cbx__cbx_result`, then use `mcp__cbx__cbx_artifact` to read `handback.md`, `complete.patch`, `test.log`, and `review.md` when review was requested. Verify the result against these artifacts before summarizing; never infer changes from status metadata alone.
3. On `needs_fix` / `review_failed`, read `mcp__cbx__cbx_review`, `mcp__cbx__cbx_logs`, and the available evidence artifacts. For `awaiting_clarification`, `baseline_drift`, or `dirty_baseline`, update `context_snapshot`. An isolated job with a dirty creation baseline pauses as `needs_fix / dirty_baseline` before any worktree is created; commit or clean those changes first. A non-isolated job pauses only when its dirty content fingerprint has changed. Set `refresh_baseline: true` only after confirming the current HEAD and dirty state are the intended new baseline, then call `/cbx-continue`.

Do not block on a single poll; the task runs in a detached worker. Report the `job_id` to the user immediately so they can inspect it via `/cbx-status` if needed.
