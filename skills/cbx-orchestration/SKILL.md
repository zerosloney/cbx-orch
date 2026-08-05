---
name: cbx-orchestration
description: Delegate coding work to the cbx orchestrator for durable, queued, test-verified, and reviewed task execution via codebuddy/opencode/omp/cline.
---

# cbx Orchestration

Use this skill when the user wants to offload a coding task to a background coding-agent CLI (codebuddy / opencode / omp / cline) with durable persistence — so the task survives crashes, runs tests, gets reviewed, and leaves a full audit trail on disk.

## When to reach for cbx

Prefer cbx when ANY of these hold:
- The task spans multiple files or has non-obvious sequencing.
- The user wants tests run and an independent review before accepting changes.
- The task is long-running and the user prefers it in the background rather than blocking this session.
- The user explicitly mentions cbx, "orchestrator", "pipeline", "委派", "编排", or asks to run a coding CLI (codebuddy/opencode/omp/cline).

Do NOT use cbx for:
- Single-file edits or trivial fixes you can do inline faster.
- Tasks that require interactive Q&A with the user mid-execution (cbx runs non-interactively).

## Execution mode: background (MCP) vs realtime (CLI)

cbx supports two execution modes. Pick one before dispatching a task:

| Mode | Trigger | Mechanism | Feedback |
|---|---|---|---|
| **Background (MCP)** | Long tasks, batch jobs, user not watching, fire-and-forget | `cbx_start` MCP tool + detached worker + poll `cbx_logs` with cursor | Incremental, polled |
| **Realtime (CLI)** | User wants to watch progress live, short-to-medium tasks, debugging | `cbx start` CLI + `tail -f events.ndjson` | Streamed to stdout |

Choose **background** when the user says "后台"/"background"/"异步"/"不用盯"/"批量", or dispatches several tasks at once.
Choose **realtime** when the user says "实时"/"live"/"看进展"/"流式"/"前台"/"盯着", or the task is short enough that polling overhead outweighs its value.

## ZCode tool names

cbx's MCP server is registered under the name `cbx`. In ZCode its tools appear as `mcp__cbx__cbx_*`:
- `mcp__cbx__cbx_start` — create + enqueue a task (runs in a detached worker)
- `mcp__cbx__cbx_status` — read job status / phase / attempt
- `mcp__cbx__cbx_result` — read structured result (exit codes, review verdict, artifact list)
- `mcp__cbx__cbx_artifact` — read an allowlisted evidence artifact (`handback.md`, `complete.patch`, `test.log`, `review.md`, `understanding.json`)
- `mcp__cbx__cbx_review` — read the review report
- `mcp__cbx__cbx_continue` — re-queue a job to fix review/test failures
- `mcp__cbx__cbx_cancel` / `mcp__cbx__cbx_approve` — lifecycle control
- `mcp__cbx__cbx_list` / `mcp__cbx__cbx_queue` / `mcp__cbx__cbx_logs` / `mcp__cbx__cbx_retry` / queue pause/resume

`workspace` is optional on every tool — it defaults to the current project via the `CBX_WORKSPACE` env var injected by the plugin.

## Background mode workflow (MCP tools)

1. **Start**: `cbx_start` with `task` (and optional `test_command`, `executor`, `review_executor`, `review`, `isolated`). For non-trivial tasks also pass `task_contract` with goal, acceptance criteria, non-goals, constraints, relevant files, decisions/rejections, and assumptions. This creates a plan-only `understanding.json` handshake; blocking ambiguity stops as `needs_fix`. Returns `{ job_id, status: "queued" }`. Give the user the `job_id` immediately.
2. **Poll** (incremental, low-cost): the worker writes events to `events.ndjson` as it runs; stream them back with a line cursor so this session only pays for new events each round:
   - `offset = 0`
   - loop:
     1. `cbx_logs` with `{ job_id, since: offset }` → returns `{ events: [...], next_offset }`. Save `offset = next_offset`.
     2. Surface key events to the user — `process_started`, `process_finished`, `test` exit, `review_verdict`. Do NOT dump the full event list.
     3. `cbx_status` once to check for a terminal status (`done` / `failed` / `needs_fix` / `review_failed` / `cancelled`). Terminal → break.
     4. Not terminal → wait a few seconds (backoff up to ~15s for long tasks) and loop.
   - Omitting `since` returns the legacy full `{ logs: string }` shape — use it only for one-shot full reads, not in the poll loop.
3. **Collect**: on `done`, call `cbx_result`, then read `handback.md`, `complete.patch`, `test.log`, and (when requested) `review.md` with `cbx_artifact`. Compare these primary artifacts before summarizing; `result.json` alone is not sufficient evidence. On failure, read the available evidence plus `cbx_review` + `cbx_logs`.
4. **Rework** (if needed): `cbx_continue` with a fix message and refreshed `context_snapshot` re-queues the job. For `baseline_drift` or `dirty_baseline`, use `refresh_baseline: true` only after the main Agent confirms the current HEAD and dirty state are intended. An isolated dirty baseline must be committed or cleaned first.

## Realtime mode workflow (CLI streaming)

Use the Bash tool to stream events live. The worker appends each event line to `events.ndjson` as it runs; `tail -f` surfaces them in real time without polling.

1. **Enqueue** (detached worker starts immediately):
   ```bash
   JOB=$(cbx start --workspace . --task "实现用户登录" --executor cline --review)
   JOB_ID=$(echo "$JOB" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
   echo "job_id=$JOB_ID"
   ```
   Pass the same flags as you would to `cbx_start` (`--executor`, `--test`, `--review`, `--isolated`, `--timeout-ms`, `--max-retries`). For a structured contract, write it to a temp file and pass `--task-file`.

2. **Stream** until a terminal event arrives:
   ```bash
   tail -f ".cbx/jobs/$JOB_ID/events.ndjson" | grep -m1 -E '"status":"(done|failed|needs_fix|review_failed|cancelled)"'
   ```
   `grep -m1` stops after the first matching terminal-status event. To watch the full stream instead, drop `| grep ...` and tell the user to interrupt when done.

3. **Collect** artifacts via CLI (same evidence as background mode):
   ```bash
   cbx result "$JOB_ID" --workspace .
   cbx review "$JOB_ID" --workspace .
   ```
   Or read the files directly: `handback.md`, `complete.patch`, `test.log`, `review.md` under `.cbx/jobs/$JOB_ID/`.

4. **Rework**: `cbx continue "$JOB_ID" --message "..."` re-queues; stream again with `tail -f`.

The `job_id` is available from step 1, so the user can inspect it via `/cbx-status` while the stream runs.

## Executor choice

| executor | binary | notes |
|---|---|---|
| `codebuddy` (default) | `codebuddy` / `cbc` | Tencent CodeBuddy CLI |
| `opencode` | `opencode` | OpenCode CLI |
| `omp` | `omp` (alias `oh-my-pi`) | Oh My Pi coding agent (no documented permission flag yet) |
| `cline` | `cline` | Cline coding agent (headless `--json`; auto/dontAsk enable auto-approve, restricted modes disable it, plan adds `--plan`) |

Override per-task via `cbx_start`'s `executor` argument, or globally via the plugin's `userConfig.executor`.
Set `review_executor` (or `.cbx.json` `reviewExecutor`) to use a different reviewer; otherwise review remains backward-compatible and uses `executor`.

## Stage chain: multi-tool handoff in a single job

cbx supports a **stage chain** — multiple executors接力 within one job, sharing a worktree. Each stage's `handback.md` is automatically fed forward to the next stage's prompt. This is cleaner than chaining separate jobs because all stages share one worktree, one diff, and one result.

**When to use stages**: different tools have different strengths (e.g. codebuddy scaffolds fast, opencode implements deep logic, cline reviews on free quota). Stages let each tool do its best part within a single atomic task.

### Via MCP (`cbx_start`)

Pass `stages` in `task_contract`:

```json
{
  "task": "实现用户认证模块",
  "task_contract": {
    "goal": "完整的认证系统",
    "acceptance_criteria": ["npm test 通过"],
    "stages": [
      { "name": "scaffold", "executor": "codebuddy", "task": "搭建目录结构和接口骨架", "skip_review": true },
      { "name": "implement", "executor": "opencode", "task": "实现核心逻辑" },
      { "name": "audit", "executor": "codebuddy", "task": "安全审计和边界加固", "review_executor": "cline" }
    ]
  }
}
```

Each stage runs sequentially in the same worktree:
- Stage N's `handback.md` is injected into stage N+1's prompt
- Each stage can override `executor`, `review_executor`, and `skip_review`
- Per-stage handback copies are saved as `stage-N-<name>-handback.md`
- `result.json` includes a `stages` array with per-stage exit codes and review verdicts

If a stage fails (executor error, test failure, or review FAIL), the job stops at that stage with `needs_fix` / `failed` / `review_failed`. Earlier stages' artifacts are preserved.

### Stage fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Stage identifier (used in phase, events, artifact filenames) |
| `executor` | yes | Which CLI runs this stage (`codebuddy` / `opencode` / `omp` / `cline` / plugin path) |
| `task` | yes | Stage-specific instructions |
| `review_executor` | no | Independent reviewer override; falls back to the job-level `review_executor`, then the stage's `executor` |
| `skip_review` | no | Skip review for this stage (default: follows job-level `review` flag) |

### Without stages (backward compat)

If `task_contract.stages` is absent, cbx runs a single synthetic `implementation` stage using the job-level `executor` and `review_executor`. Existing jobs and workflows are unaffected.

## Isolation

`isolated: true` (default in the plugin) runs each task in a fresh git worktree under `.<repo>.cbx-worktrees/<job-id>`, so the main workspace is never polluted. `auto_branch` + `auto_commit` further commit results on a `cbx/<job-id>` branch. Keep isolation ON unless the task must touch the working tree directly.

## Safety notes

- cbx stores everything under `<workspace>/.cbx/jobs/<job-id>/` — request.md, events.ndjson, test.log, diff.patch, review.md, result.json. Inspect any of it via the corresponding tool.
- Job creation records commit, branch, dirty state, and a dirty content fingerprint. With `isolated: true`, a dirty creation baseline pauses as `needs_fix / dirty_baseline` before worktree creation so uncommitted content cannot be silently omitted; commit or clean it, then confirm with `refresh_baseline: true`. Once clean, the worktree is created from the fixed commit. Non-isolated jobs pause on HEAD drift or when the dirty content fingerprint changes, but may run when the recorded dirty content is unchanged.
- The review agent runs in the same worktree; cbx detects if the reviewer mutated files and fails the job rather than delivering untested code.
- Test commands run in the worktree; cbx applies a basic destructive-command blocklist but does not guarantee safety of arbitrary commands.
