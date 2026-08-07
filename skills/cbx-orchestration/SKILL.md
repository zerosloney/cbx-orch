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

### Quick decision (use this before dispatching)

Tick at least one box per axis. If every axis points to "use cbx", dispatch it. If any axis points away, prefer inline work.

| Axis | Use cbx | Stay inline |
|---|---|---|
| Scope | multi-file or cross-module | single file, < 50 lines |
| Verification | user wants tests + review | trivial enough to verify by re-read |
| Duration | long-running (>2 min) | quick fix |
| Mode preference | background OK ("后台"/"异步"/"fire-and-forget") | user needs to watch live ("实时"/"流式") |

If two or more axes point to "use cbx", dispatch. If unsure, ask the user whether they want background processing.

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

1. **Start**: `cbx_start` with `task` (and optional `test_command`, `executor`, `review_executor`, `review`, `isolated`, `approval_before_complete`, `adaptive`). For non-trivial tasks also pass `task_contract` with goal, acceptance criteria, non-goals, constraints, relevant files, decisions/rejections, and assumptions. This creates a plan-only `understanding.json` handshake; blocking ambiguity stops as `needs_fix`. Returns `{ job_id, status: "queued" }`. Give the user the `job_id` immediately.
2. **Poll** (incremental, low-cost): the worker writes events to `events.ndjson` as it runs; stream them back with a line cursor so this session only pays for new events each round:
   - `offset = 0`
   - loop:
     1. `cbx_logs` with `{ job_id, since: offset }` → returns `{ events: [...], next_offset }`. Save `offset = next_offset`.
     2. Surface key events to the user — `process_started`, `process_finished`, `test` exit, `review_verdict`. Do NOT dump the full event list.
     3. `cbx_status` once to check for a terminal status (`done` / `failed` / `needs_fix` / `review_failed` / `cancelled`). Terminal → break.
     4. Not terminal → wait a few seconds (backoff up to ~15s for long tasks) and loop.
   - Omitting `since` returns the legacy full `{ logs: string }` shape — use it only for one-shot full reads, not in the poll loop.
3. **Collect**: on `done`, call `cbx_result`, then read `handback.md`, `complete.patch`, `test.log`, and (when requested) `review.md` with `cbx_artifact`. Compare these primary artifacts before summarizing; `result.json` alone is not sufficient evidence. On failure, read the available evidence plus `cbx_review` + `cbx_logs`.
4. **Rework** (if needed): `cbx_continue` with a fix message and refreshed `context_snapshot` re-queues the job. For `baseline_drift` or `dirty_baseline`, use `refresh_baseline: true` only after the main Agent confirms the current HEAD and dirty state are intended. An isolated dirty baseline must be committed or cleaned first. For the `adaptive_max_rounds` Human Gate (only reached when `adaptive.enabled=true`), pass `extra_rounds` (1–100) to extend the round budget; any other phase rejects `extra_rounds`.

### Task contract template

For non-trivial tasks, pass `task_contract` to `cbx_start`. This enables a plan-only `understanding.json` handshake — blocking ambiguity stops as `needs_fix / awaiting_clarification` instead of being guessed. Always fill at least `goal`, `acceptance_criteria`, and `constraints`; the rest are optional but recommended.

```json
{
  "task_contract": {
    "goal": "实现用户登录功能（POST /api/auth/login）",
    "acceptance_criteria": [
      "npm test 通过（覆盖率 ≥ 80%）",
      "新接口出现在 OpenAPI 文档里",
      "密码字段不回显到日志"
    ],
    "non_goals": [
      "不做 SSO/三方登录",
      "不改现有用户表 schema"
    ],
    "constraints": [
      "禁止在源代码里硬编码任何 secret",
      "只能改 src/auth/ 下的文件"
    ],
    "relevant_files": [
      "src/auth/login.ts",
      "src/middleware/session.ts",
      "tests/auth/login.test.ts"
    ],
    "decisions": [
      "采用 JWT 而非 session cookie（理由：API 端要 stateless）"
    ],
    "rejected_options": [
      "不用 Passport.js（理由：依赖过重，需求里没要求三方登录）"
    ],
    "assumptions": [
      "假设 Node.js ≥ 20 且测试框架是 Vitest",
      "假设 rate-limit 需求不在本次范围"
    ]
  }
}
```

Field reference:

| Field | Purpose |
|---|---|
| `goal` | One-sentence description of what success looks like. |
| `acceptance_criteria` | Verifiable, testable conditions (the worker checks these before declaring done). |
| `non_goals` | Explicitly out of scope — prevents scope creep and contradictory reviews. |
| `constraints` | Hard rules (file boundaries, dependency limits, security/compliance). |
| `relevant_files` | Starting points the executor should read. Reduces wandering. |
| `decisions` | Choices already made; saves a round-trip. |
| `rejected_options` | Alternatives considered and why they're off the table. |
| `assumptions` | Things the worker is allowed to take for granted. |

Keep `acceptance_criteria` short and verifiable. Long lists dilute the review signal; aim for 3–6 items.

## Job status decision tree

When polling reaches a terminal status, branch on it. **Do not** call `cbx_continue` blindly on any failure — different statuses need different fixes.

`cbx_status` returns both a `status` (the coarse state machine) and a `phase` (the fine-grained reason). The statuses below are the terminal values of `status`; the `phase` column disambiguates cases that share `needs_fix`.

| Status | Phase | Meaning | Agent action |
|---|---|---|---|
| `done` | — | Tests passed, review (if requested) passed, completion gate cleared. | `cbx_result` + read `handback.md`, `complete.patch`, `test.log`, `review.md` via `cbx_artifact`. Summarize for the user. |
| `awaiting_approval` | `before_run` | Config has `approval.beforeRun: true`. | Call `cbx_approve` after user confirms, or `cbx_cancel` if declined. Do not auto-approve. |
| `awaiting_approval` | `before_complete` | Config has `approval.beforeComplete: true`; tests + review already passed and the completion evidence gate cleared. `pendingCompletion` holds the artifact SHA-256 snapshot awaiting sign-off. | Call `cbx_approve` to finalize `done`, or `cbx_cancel`. If the worktree/evidence has drifted since the gate ran, the approve path fails to `needs_fix / completion_evidence_stale` — re-run verification instead of re-approving. |
| `needs_fix` | `awaiting_clarification` | `task_contract` had a blocking ambiguity (`humanGate.reason=needs_input`). | Read `understanding.json` via `cbx_artifact`; ask the user the unanswered question, then `cbx_continue` with refined `task_contract`. |
| `needs_fix` | `context_handshake` | Executor failed to produce a valid `understanding.json` (crash, missing file, malformed JSON). | Read `cbx_logs` for the executor error. Usually a prompt/format issue — fix the contract or executor and `cbx_continue`. |
| `needs_fix` | `baseline_drift` | HEAD moved or dirty-content fingerprint changed since the job was created. | Confirm with the user that the new HEAD is intended. If yes, `cbx_continue` with `refresh_baseline: true`. If no, ask them to clean up first. |
| `needs_fix` | `dirty_baseline` (isolated only) | Job creation saw uncommitted changes; cbx refused to silently include them. | Ask the user to commit or `git restore` the dirty files. Then `cbx_continue` with `refresh_baseline: true`. |
| `needs_fix` | `reviewing` | Review verdict is FAIL but tests passed (`humanGate.reason=semantic_conflict` or plain FAIL). | Read `review.md` via `cbx_artifact`. For `semantic_conflict` the failure is a contract/semantic issue needing main-agent judgment. Build a specific fix message and call `cbx_continue`. |
| `needs_fix` | `dependency_guard` | `dependencyGuard` was on and a stage mutated `package.json` / lock files without authorization. | Ask the user if the dependency change is intended. If no, instruct the worker to restore the files (the phase includes which files changed) and `cbx_continue`; if yes, re-dispatch with `--no-dependency-guard` or set `dependencyGuard: false`. |
| `needs_fix` | `verification_gate` | Completion evidence gate failed: worktree not clean, acceptance criteria not all verified, or test/review evidence incomplete. | Read `verified-progress.json` / `audit.json` via MCP resources, plus `test.log` and `review.md`. The phase error names which condition failed; address it and `cbx_continue`. |
| `needs_fix` | `repeated_failure` | Same normalized failure reason hit 3+ times (`humanGate.reason=repeated_failure`). cbx stopped auto-retrying. | **Do not** blindly `cbx_continue` — the error recurs. Escalate to the user; a human decision is required before another attempt. |
| `needs_fix` | `adaptive_ask` | Adaptive manager returned `{"action":"ask"}` (`humanGate.reason=needs_input`). | Read `manager-context.json` + `candidate.json` via MCP resources; surface the manager's questions to the user, then `cbx_continue` with answers in `context_snapshot`. |
| `needs_fix` | `adaptive_blocked` | Adaptive manager returned `{"action":"blocked"}` with a reason. | Read the blocked reason in `cbx_status` / `candidate.json`. Usually needs a human decision or a scope change; do not auto-continue. |
| `needs_fix` | `adaptive_max_rounds` | Adaptive loop exhausted `maxRounds` (`humanGate.reason=max_rounds`). | Either accept the current state and stop, or `cbx_continue` with `extra_rounds` (1–100) to extend the budget. Confirm with the user before extending. |
| `needs_fix` | `adaptive_manager_decision` / `adaptive_manager_safety` / `adaptive_state` | Adaptive manager produced invalid JSON, tried to mutate the worktree, or the persisted `adaptiveRound` is corrupt. | Read `cbx_logs`. For `safety`, the manager tried to edit files — check whether `manager_executor` is misconfigured. For `decision`, the manager output did not parse; tighten the task. |
| `needs_fix` | (other) | Worker self-reported a blocker it cannot resolve (missing dep, etc.). | Read the latest events via `cbx_logs`; usually requires user input. |
| `failed` | (test) | Test command exited non-zero. | Read `test.log` via `cbx_artifact`. Build a targeted fix message and call `cbx_continue`. |
| `failed` | (executor) | Executor process crashed or timed out. | Read the executor's stdout/stderr in `cbx_logs` (`process_finished` events). Often a transient issue — `cbx_retry` may be simpler than a fresh `cbx_continue`. |
| `failed` | `git_commit` | Auto-commit failed during finalize (e.g. hooks rejected, identity missing). | Read the error in `cbx_status`. Fix the git issue, then `cbx_continue`. |
| `review_failed` | `reviewing` | Review phase itself errored (reviewer CLI unavailable, etc.). | Check executor availability. If it is, `cbx_retry` once; otherwise ask the user to switch `review_executor`. |
| `cancelled` | — | User or agent called `cbx_cancel`. | **Do not** `cbx_continue` a cancelled job — the queue entry is marked cancelled and the executor will reject the re-queue. Create a new job via `cbx_start` instead. |

Phase values that surface under `needs_fix` but resolve via a **Human Gate** (`before_run`, `needs_input`, `semantic_conflict`, `repeated_failure`, `max_rounds`, `completion`) carry a `humanGate` object on `state.json` / `result.json` with `status` (`waiting`/`resolved`) and `instructions`. Gate resolution happens through `cbx_approve` or `cbx_continue` — do not edit `humanGate` directly.

Rules of thumb:
- Always read primary artifacts (`handback.md`, `complete.patch`, `test.log`, `review.md`) before summarizing. `result.json` is metadata, not evidence.
- Never auto-loop on `cbx_continue`. After 2 consecutive failures with the same root cause, stop and ask the user — the next fix probably needs a human decision, not another retry. (cbx itself promotes 3 same-root-cause failures to `needs_fix / repeated_failure`.)
- `cancelled` is sticky. Always start a new job.

## Adaptive mode

Adaptive mode replaces a fixed stage list with a **manager executor** that decides each round what to run. Use it when the task is too open-ended to pre-plan as a stage chain — the manager picks the next stage based on verified progress so far.

### When to use adaptive (vs a fixed stage chain)

| Situation | Use |
|---|---|
| You know the phases up front (scaffold → impl → audit) | Fixed stage chain (`task_contract.stages`) |
| The path is unknown and the next step depends on what the previous stage found | Adaptive |
| You want a separate "planner" CLI that does not touch the worktree, only decides | Adaptive (`manager_executor`) |
| Single straightforward task | Neither — single stage, no manager |

The manager **never edits files**. It reads a minimal projection context pack (`manager-context.json`) and writes a strict-JSON decision to `candidate.json`. cbx validates the decision, runs the chosen stage, then loops. A deterministic completion gate (verified progress + clean worktree + evidence) still gates `done` — the manager saying `done` is necessary but not sufficient.

### Enabling adaptive

```json
{
  "task": "重构认证模块，分步推进，每步独立验证",
  "test_command": "npm test",
  "review": true,
  "adaptive": { "enabled": true, "max_rounds": 8, "manager_executor": "codebuddy" }
}
```

`adaptive.enabled=true` **requires** `review=true` — completion is gated on structured review evidence, so review cannot be off in adaptive mode. CLI equivalents: `--adaptive` / `--no-adaptive` / `--adaptive-max-rounds N` / `--manager-executor <cli>`. In `.cbx.json`: `adaptive` (`enabled`, `maxRounds` default 8, max 100, `managerExecutor` defaulting to the job executor). MCP `cbx_start` takes the same shape with snake_case (`max_rounds`, `manager_executor`).

### Manager decision shape (`candidate.json`)

The manager writes exactly one of:

```json
{"action":"execute","stage":{"name":"...","executor":"...","task":"...","reviewExecutor":"...","skip_review":false}}
{"action":"ask","questions":["..."]}
{"action":"blocked","reason":"..."}
{"action":"done"}
```

- `execute` → cbx runs that stage (executor/review/skip overrides honored), then loops back to the manager.
- `ask` → pauses as `needs_fix / adaptive_ask` with the questions surfaced via Human Gate.
- `blocked` → pauses as `needs_fix / adaptive_blocked`; needs a human decision.
- `done` → cbx runs the completion gate; if it passes, the job finishes. If the gate fails, the job lands in `needs_fix / verification_gate`.

### Hitting the round limit

After `maxRounds` rounds without `done`, the job pauses at `needs_fix / adaptive_max_rounds` (`humanGate.reason=max_rounds`). Two honest options, both requiring user confirmation:

- Accept the current state — read `result.json` / artifacts and report to the user.
- Extend the budget: `cbx_continue` with `extra_rounds` (1–100). The cumulative cap is 100; `extra_rounds` is rejected on any other phase.

### Artifacts adaptive adds

Beyond the standard artifacts, adaptive jobs produce `manager-context.json`, `candidate.json`, `audit.json`, `verified-progress.json` per round, plus `executor-context.json` / `auditor-context.json` projections. These are readable via MCP `resources/read` / `resources/list`. Use them to understand why the manager chose a given stage when debugging.

## Approval gates

cbx supports two independent approval gates, both driven by the same `cbx approve` / MCP `cbx_approve` entry and both surfaced as `awaiting_approval`:

| Gate | Config | Phase | When it fires |
|---|---|---|---|
| Before run | `approval.beforeRun` | `before_run` | Before any executor runs. The job sits in the queue until approved. |
| Before complete | `approval.beforeComplete` | `before_complete` | After tests + review + completion evidence gate have all passed, just before finalizing `done`. `pendingCompletion` holds the artifact SHA-256 snapshot awaiting sign-off. |

If evidence or the worktree drifts between the gate and the approve, the approve path lands in `needs_fix / completion_evidence_stale` rather than finalizing — re-run verification instead of re-approving.

`cbx approve` only launches the worker when the resulting state is `queued`; calling it on an already-running or terminal job is a no-op for the launch step.

## Review configuration

cbx runs an independent review after tests pass (when `review: true`). The review verdict decides whether `done` is reached. Configure it at two levels:

### Project config (`.cbx.json`)

```json
{
  "review": true,
  "review_executor": "opencode",
  "reviewRules": "重点检查鉴权、数据校验、回归测试和错误处理是否显式。"
}
```

| Field | Effect |
|---|---|
| `review` | Master switch (default true). `false` skips the entire review phase. |
| `review_executor` | Reviewer CLI. Falls back through: stage-level `review_executor` → this job-level value → the executor itself. Set this to avoid self-review bias. |
| `reviewRules` | Free-form text injected into the reviewer's prompt. Empty = default behavior. |

### Per-job override (MCP `cbx_start`)

```json
{
  "executor": "codebuddy",
  "review_executor": "cline",
  "review": true,
  "review_rules": "本次只关注安全漏洞和硬编码 secret。"
}
```

Note the snake_case `review_rules` for the MCP argument vs `reviewRules` in `.cbx.json` — cbx normalizes both. CLI flag is `--review-rules`.

### Per-stage override (stage chain)

Inside `task_contract.stages[i]`:
- `review_executor` — independent reviewer for that stage only.
- `skip_review: true` — skip review for that stage (e.g. a fast scaffold step).

### Common configurations

- **Single-CLI, default behavior** (simplest): just `"review": true`. Reviewer = executor.
- **Two-CLI split** (recommended for production): executor writes, different CLI reviews.
  ```json
  { "executor": "codebuddy", "review_executor": "opencode" }
  ```
- **Skip review for fast scaffolding**:
  ```json
  { "task_contract": { "stages": [
    { "name": "scaffold", "skip_review": true },
    { "name": "implement" }
  ]}}
  ```

### Review verdict

`cbx_artifact review.md` returns the full report. cbx parses the first line for `VERDICT: PASS` or `VERDICT: FAIL` (case-insensitive). PASS → stage passes; FAIL → `needs_fix`. An unparsable verdict is handled differently by the two review paths: the stop-gate (`cbx_review_gate`) fails open and records `UNKNOWN`; the in-stage review (when `review: true`) treats it as FAIL and re-queues. There is no separate WARN verdict.

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

### When to use stages (vs single stage + `review_executor`)

Pick stages when stages add real value. Otherwise a single stage with `review_executor` is simpler.

| Situation | Use |
|---|---|
| Write code, then independently review it | Single stage + `review_executor` |
| Same tool, multiple passes (e.g. implement → refactor → test) | Single stage with a thorough `task` |
| Different tools, each owning a distinct phase (scaffold → deep impl → security audit) | Stage chain |
| User explicitly says "先 X 再 Y" / "分步做" / "分阶段" | Stage chain |
| Quota splitting — one CLI has the free tier, another does not | Stage chain, picking executors per stage |
| Need a fast scaffold step before a slow review step | Stage chain with `skip_review: true` on scaffold |

Rule of thumb: **if a stage needs its own review verdict and a different reviewer, it's a real stage**. If it's just "more prompts in the same call", keep it in one stage with a longer task description.

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

## End-to-end example

A user asks: **"帮我实现用户登录接口，跑通测试 + 安全审查"**. Here is the full agent flow.

### 1. Decide to use cbx

Run the quick decision checklist. This task is multi-file (auth + middleware + tests), needs tests + review, and the user is fine with background — all axes point to cbx. Dispatch.

### 2. Dispatch

```json
mcp__cbx__cbx_start({
  "task": "实现用户登录接口 POST /api/auth/login",
  "test_command": "npm test",
  "review": true,
  "review_executor": "opencode",
  "task_contract": {
    "goal": "用户能用邮箱+密码登录，签发 JWT，会话可被服务端吊销",
    "acceptance_criteria": [
      "npm test 通过",
      "登录接口 401/200 路径都被覆盖",
      "密码字段不进入任何日志"
    ],
    "non_goals": ["不做 SSO/三方登录", "不改 user 表结构"],
    "constraints": ["禁止硬编码 secret", "改动只在 src/auth/ 下"],
    "relevant_files": ["src/auth/", "tests/auth/"]
  }
})
```

Returns `{ job_id: "job-abc123", status: "queued" }`. **Tell the user immediately**: `已委派给 cbx，job_id=job-abc123，跑完后我会拉结果给你。`

### 3. Poll (incremental)

```text
offset = 0
loop:
  r = mcp__cbx__cbx_logs({ job_id: "job-abc123", since: offset })
  offset = r.next_offset
  for each e in r.events:
    if e.type in {process_started, process_finished, test, review_verdict}:
      surface to user (one short line each)
  s = mcp__cbx__cbx_status({ job_id: "job-abc123" })
  if s.status in {done, failed, needs_fix, review_failed, cancelled, awaiting_approval}:
    break
  sleep(min(2 ** attempt, 15))   # exponential backoff capped at 15s
```

### 4. Branch on terminal status

Say the job reached `needs_fix / review_failed` because the reviewer found two issues. The decision tree says: read `review.md`, build a fix message, call `cbx_continue`.

```json
mcp__cbx__cbx_artifact({ job_id: "job-abc123", name: "review.md" })
```

Suppose the report says: (a) JWT 过期时间硬编码 24h, (b) 错误信息泄露用户是否存在. Build a specific message:

```json
mcp__cbx__cbx_continue({
  "job_id": "job-abc123",
  "message": "按 review.md 修复：(1) JWT 过期时间从 env JWT_TTL 读取，默认 1h；(2) 登录失败统一返回 '凭证无效'，不区分用户存在与否。改完跑 npm test 验证。",
  "context_snapshot": "前一轮：实现已完成，review 失败 2 项。"
})
```

This re-queues. Resume polling from step 3.

### 5. On `done`

```json
mcp__cbx__cbx_result({ job_id: "job-abc123" })
mcp__cbx__cbx_artifact({ job_id: "job-abc123", name: "handback.md" })
mcp__cbx__cbx_artifact({ job_id: "job-abc123", name: "complete.patch" })
mcp__cbx__cbx_artifact({ job_id: "job-abc123", name: "test.log" })
mcp__cbx__cbx_artifact({ job_id: "job-abc123", name: "review.md" })
```

Cross-check: the patch matches the handback, tests are green, review verdict is PASS. **Then** summarize to the user — list the changed files, the test result, and the review verdict. Do not summarize from `result.json` alone.

### 6. Hand off to the user

```
搞定了，job-abc123 已 done：
- 改了 4 个文件（src/auth/login.ts, src/middleware/session.ts, ...）
- npm test 11/11 通过
- review 通过，2 个小建议已记入 review.md
- 完整产物在 .cbx/jobs/job-abc123/，需要的话可以 `cbx files job-abc123` 看
```

## Safety notes

- cbx stores everything under `<workspace>/.cbx/jobs/<job-id>/` — request.md, events.ndjson, test.log, diff.patch, review.md, result.json. Inspect any of it via the corresponding tool.
- Job creation records commit, branch, dirty state, and a dirty content fingerprint. With `isolated: true`, a dirty creation baseline pauses as `needs_fix / dirty_baseline` before worktree creation so uncommitted content cannot be silently omitted; commit or clean it, then confirm with `refresh_baseline: true`. Once clean, the worktree is created from the fixed commit. Non-isolated jobs pause on HEAD drift or when the dirty content fingerprint changes, but may run when the recorded dirty content is unchanged.
- The review agent runs in the same worktree; cbx detects if the reviewer mutated files and fails the job rather than delivering untested code.
- Test commands run in the worktree; cbx applies a basic destructive-command blocklist but does not guarantee safety of arbitrary commands.
