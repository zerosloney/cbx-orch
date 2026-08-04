---
name: cbx-orchestration
description: Delegate coding work to the cbx orchestrator for durable, queued, test-verified, and reviewed task execution via codebuddy/opencode/pi/omp.
---

# cbx Orchestration

Use this skill when the user wants to offload a coding task to a background coding-agent CLI (codebuddy / opencode / pi / omp) with durable persistence — so the task survives crashes, runs tests, gets reviewed, and leaves a full audit trail on disk.

## When to reach for cbx

Prefer cbx when ANY of these hold:
- The task spans multiple files or has non-obvious sequencing.
- The user wants tests run and an independent review before accepting changes.
- The task is long-running and the user prefers it in the background rather than blocking this session.
- The user explicitly mentions cbx, "orchestrator", "pipeline", "委派", "编排", or asks to run a coding CLI (codebuddy/opencode/pi/omp).

Do NOT use cbx for:
- Single-file edits or trivial fixes you can do inline faster.
- Tasks that require interactive Q&A with the user mid-execution (cbx runs non-interactively).

## ZCode tool names

cbx's MCP server is registered under the name `cbx`. In ZCode its tools appear as `mcp__cbx__cbx_*`:
- `mcp__cbx__cbx_start` — create + enqueue a task (runs in a detached worker)
- `mcp__cbx__cbx_status` — read job status / phase / attempt
- `mcp__cbx__cbx_result` — read structured result (exit codes, review verdict, artifact list)
- `mcp__cbx__cbx_review` — read the review report
- `mcp__cbx__cbx_continue` — re-queue a job to fix review/test failures
- `mcp__cbx__cbx_cancel` / `mcp__cbx__cbx_approve` — lifecycle control
- `mcp__cbx__cbx_list` / `mcp__cbx__cbx_queue` / `mcp__cbx__cbx_logs` / `mcp__cbx__cbx_retry` / queue pause/resume

`workspace` is optional on every tool — it defaults to the current project via the `CBX_WORKSPACE` env var injected by the plugin.

## Default workflow

1. **Start**: `cbx_start` with `task` (and optional `test_command`, `executor`, `review`, `isolated`). Returns `{ job_id, status: "queued" }`. Give the user the `job_id` immediately.
2. **Poll** (incremental, low-cost): the worker writes events to `events.ndjson` as it runs; stream them back with a line cursor so this session only pays for new events each round:
   - `offset = 0`
   - loop:
     1. `cbx_logs` with `{ job_id, since: offset }` → returns `{ events: [...], next_offset }`. Save `offset = next_offset`.
     2. Surface key events to the user — `process_started`, `process_finished`, `test` exit, `review_verdict`. Do NOT dump the full event list.
     3. `cbx_status` once to check for a terminal status (`done` / `failed` / `needs_fix` / `review_failed` / `cancelled`). Terminal → break.
     4. Not terminal → wait a few seconds (backoff up to ~15s for long tasks) and loop.
   - Omitting `since` returns the legacy full `{ logs: string }` shape — use it only for one-shot full reads, not in the poll loop.
3. **Collect**: on `done`, call `cbx_result` and summarize the diff, test result, and review verdict. On failure, call `cbx_review` + `cbx_logs` to diagnose.
4. **Rework** (if needed): `cbx_continue` with a fix message re-queues the job.

## Executor choice

| executor | binary | notes |
|---|---|---|
| `codebuddy` (default) | `codebuddy` / `cbc` | Tencent CodeBuddy CLI |
| `opencode` | `opencode` | OpenCode CLI |
| `pi` | `pi` (alias `oh-my-pi`) | Pi coding agent |
| `omp` | `omp` | omp (no documented permission flag yet) |

Override per-task via `cbx_start`'s `executor` argument, or globally via the plugin's `userConfig.executor`.

## Isolation

`isolated: true` (default in the plugin) runs each task in a fresh git worktree under `.<repo>.cbx-worktrees/<job-id>`, so the main workspace is never polluted. `auto_branch` + `auto_commit` further commit results on a `cbx/<job-id>` branch. Keep isolation ON unless the task must touch the working tree directly.

## Safety notes

- cbx stores everything under `<workspace>/.cbx/jobs/<job-id>/` — request.md, events.ndjson, test.log, diff.patch, review.md, result.json. Inspect any of it via the corresponding tool.
- The review agent runs in the same worktree; cbx detects if the reviewer mutated files and fails the job rather than delivering untested code.
- Test commands run in the worktree; cbx applies a basic destructive-command blocklist but does not guarantee safety of arbitrary commands.
