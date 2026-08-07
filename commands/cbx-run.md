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
- `approval_before_complete`: set `true` to pause for approval (`awaiting_approval / before_complete`) after tests + review + completion evidence gate have passed, but before finalizing `done`. Resolved via `mcp__cbx__cbx_approve`. Requires `approval.beforeComplete` semantics; pairs with `approval.beforeRun`.
- `adaptive`: object `{ enabled, max_rounds, manager_executor }` to let a separate manager CLI decide each round which stage runs. Requires `review: true`. See the `cbx-orchestration` skill's Adaptive mode section before enabling.

You will receive `{ job_id, status: "queued" }`. Then:
1. Poll with an incremental event cursor (avoids re-sending history each round):
   - `offset = 0`
   - loop:
     1. `mcp__cbx__cbx_logs` with `{ job_id, since: offset }` → returns `{ events: [...], next_offset }`. Save `offset = next_offset`.
     2. Surface key events to the user — `process_started`, `process_finished`, test exit, `review_verdict`. Do NOT dump the full event list.
     3. `mcp__cbx__cbx_status` once to check for a terminal status (`done` / `failed` / `needs_fix` / `review_failed` / `cancelled`) or a waiting status (`awaiting_approval`). Terminal or waiting → break.
     4. Not terminal → wait a few seconds (backoff up to ~15s for long tasks) and loop.
2. On `awaiting_approval`, surface it to the user and call `mcp__cbx__cbx_approve` only after explicit confirmation (do not auto-approve). The `before_run` gate fires before any executor runs; the `before_complete` gate fires after the completion evidence gate has passed.
3. On `done`, call `mcp__cbx__cbx_result`, then use `mcp__cbx__cbx_artifact` to read `handback.md`, `complete.patch`, `test.log`, and `review.md` when review was requested. Verify the result against these artifacts before summarizing; never infer changes from status metadata alone.
4. On `needs_fix` / `review_failed`, read `mcp__cbx__cbx_review`, `mcp__cbx__cbx_logs`, and the available evidence artifacts, then branch on `phase`:
   - `awaiting_clarification` / `context_handshake`: update `context_snapshot` (and refine `task_contract` for ambiguity); call `/cbx-continue`.
   - `baseline_drift` / `dirty_baseline`: an isolated job with a dirty creation baseline pauses before any worktree is created; commit or clean those changes first. A non-isolated job pauses only when its dirty content fingerprint has changed. Set `refresh_baseline: true` only after confirming the current HEAD and dirty state are the intended new baseline, then call `/cbx-continue`.
   - `dependency_guard`: a stage mutated `package.json` / lock files while `dependencyGuard` was on. Confirm with the user whether the change is intended; restore the files and `/cbx-continue`, or re-dispatch with `dependencyGuard: false`.
   - `verification_gate`: completion evidence gate failed (worktree not clean, criteria not all verified, or evidence incomplete). Read `verified-progress.json` / `audit.json` via MCP resources, address the named condition, then `/cbx-continue`.
   - `repeated_failure`: same root cause hit 3+ times. **Do not** auto-continue — escalate to the user.
   - `adaptive_ask` / `adaptive_blocked` / `adaptive_max_rounds` / `adaptive_manager_*` / `adaptive_state`: only reached under `adaptive.enabled`. See the skill's Adaptive mode section; `adaptive_max_rounds` can be extended via `/cbx-continue` with `extra_rounds`.

Do not block on a single poll; the task runs in a detached worker. Report the `job_id` to the user immediately so they can inspect it via `/cbx-status` if needed.
