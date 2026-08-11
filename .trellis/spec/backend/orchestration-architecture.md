# Orchestration Architecture

## 1. Job Lifecycle

```
queued → running → done
              ├→ failed
              ├→ cancelled
              └→ awaiting_approval → (approve) → done / needs_fix
```

Jobs transition through a **state machine** driven by `executeJob()` in `src/execution.ts`.

### Job Status Matrix

| Status | Meaning |
|--------|---------|
| `queued` | Enqueued, waiting for a worker slot |
| `running` | Worker picked up, executing |
| `awaiting_approval` | Hit `approvalBeforeComplete`, paused for human sign-off |
| `needs_fix` | Approval rejected or evidence stale |
| `review_failed` | Review gate blocked the job |
| `failed` | Exhausted retries or fatal error |
| `done` | Completed successfully |
| `cancelled` | Cancelled by user |

### Job Phases (state.phase)

`before_run` → `queued` → `running` → `stages` → `before_complete` → `done`

Phase persists through retries and approvals, enabling mid-flight resumption.

---

## 2. TaskContract Model

Defined in `src/validation.ts`. The `TaskContract` is the **top-level task descriptor** submitted when a job is created.

```typescript
// src/validation.ts
interface TaskStage {
  name: string;
  executor: string;
  task: string;          // markdown instructions
  reviewExecutor?: string;
  skipReview?: boolean;  // skips review gate for this stage
  dependsOn?: string[]; // wait for named stages first
}

interface TaskContract {
  goal: string;                      // high-level goal
  acceptanceCriteria?: string[];
  constraints?: string[];
  relevantFiles?: string[];
  assumptions?: string[];
  nonGoals?: string[];
  stages?: TaskStage[];              // explicit stage chain (non-adaptive)
}
```

### Dependency Validation

`validateStageDependencies()` runs once at contract normalization time:
- **Dangling check**: every `dependsOn` name must match an existing stage name
- **Cycle check**: DFS detects circular dependencies

If the contract has no `stages`, the system runs in **adaptive mode** — the Manager decomposes the task dynamically.

---

## 3. Adaptive Manager

Enabled when `JobContext.adaptive.enabled = true` and `TaskContract.stages` is absent.

### Decision Loop

`requestAdaptiveAction()` in `stage-runner.ts` calls the Manager with a `ManagerContextPack`. The Manager responds with a `NextAction`:

```typescript
type NextAction =
  | { action: "execute"; stage: AdaptiveTaskStage }
  | { action: "ask"; questions: string[] }
  | { action: "blocked"; reason: string }
  | { action: "done" };
```

### Manager Context Pack

```typescript
interface ManagerContextPack extends CommonContextPack {
  role: "manager";
  current: {
    round: number;
    maxRounds: number;
    pendingStages: string[];         // stages completed so far
    recentFailure?: RecentFailure;   // last failed stage + error
  };
  contract: TaskContractProjection;
}
```

### Context Handshake

Before each Manager invocation, `performContextHandshake()` (baseline.ts) detects drift between the persisted baseline and current worktree state. If drift is detected and exceeds threshold, the job transitions to `needs_fix` instead of continuing.

### Rounds Budget

`adaptive.maxRounds` caps the number of Manager decision rounds. Each `execute` action that completes increments the round counter. When `round >= maxRounds`, the Manager is forced to `done`.

---

## 4. Stage Execution Model

When `TaskContract.stages` is present (non-adaptive) OR after the Manager emits `execute`, execution proceeds through `runStage()`.

### Stage Lifecycle

```
runStage(directory, stage, context)
  ├→ createExecutorContextPack()       → write context snapshot
  ├→ invokeExecutor()                   → spawn agent
  ├→ runTest() if testCommand set       → run tests
  ├→ review gate (if not skipReview)    → run review executor
  └→ write stage handback + report
```

### Stage Retry Policy

Two independent retry dimensions:

| Dimension | Config | Behavior |
|-----------|--------|---------|
| `executionRetries` | `JobContext` | Retry executor on failure |
| `fixRetries` | `JobContext` | Retry after `needs_fix` resolution |

Retries are tracked in `StageReport.attempts`. Max total attempts = `executionRetries + fixRetries + 1`.

### Dependency Guard

If `dependencyGuard: true` in `JobContext`, a stage only runs if all `dependsOn` stages reached `done` status. If any dependency ended `failed`/`needs_fix`/`review_failed`, the stage is marked `skipped`.

### Stage Report

```typescript
interface StageReport {
  name: string;
  status: "done" | "failed" | "skipped";
  attempts: number;
  executorOutput: string;
  testOutput?: string;
  reviewOutput?: string;
  reviewVerdict?: "PASS" | "FAIL";
  handback: string;          // markdown summary
  startedAt: string;
  finishedAt: string;
  error?: string;
}
```

### Stage Outcome

```typescript
interface StageOutcome {
  stageReport: StageReport;
  handbackContent: string;   // combined from all attempts
  completed: boolean;
  needsFix: boolean;
}
```

---

## 5. Stage Ordering (Non-Adaptive)

`groupStagesByDependency()` in `execution.ts` layers stages by dependency:

- Stages with no `dependsOn` → **Layer 0** (can run first)
- A stage → **Layer N** where N = max layer of any `dependsOn` + 1
- Within a layer, stages run **serially** (single worktree, single .cbx dir)

```typescript
// Example: stages [A, B, C] with B.dependsOn=[A], C.dependsOn=[B]
// Layers:
//   Layer 0: [A]
//   Layer 1: [B]
//   Layer 2: [C]
```

This ordering is enforced even though layers are theoretically parallelizable — the single-worktree constraint keeps intra-layer serial.

---

## 6. Approval Gates

Two approval points controlled by `JobContext`:

| Gate | Trigger | Check |
|------|---------|-------|
| `approvalBeforeRun` | Before any stage runs | Human approves at CLI: `cbx approve <jobId>` |
| `approvalBeforeComplete` | After all stages done, before marking `done` | Evidence hash verification + human sign-off |

### Approval Evidence Verification

On `approvalBeforeComplete`, `approveJob()` verifies:
1. SHA-256 hashes of `complete.patch`, `test.log`, `review.md` match `pendingCompletion.evidenceHashes`
2. Worktree snapshot SHA-256 matches `pendingCompletion.worktreeSha256`
3. `completionEvidenceValid()` structural check (test exit code 0, review verdict PASS, required artifacts present)

If any check fails → status becomes `needs_fix` with phase `completion_evidence_stale`.

### Auto-Commit

If `context.autoCommit: true`, `approveJob()` calls `commitWorktree()` after evidence verification passes.

---

## 7. Review Gate

Review gate runs **after a stage's executor** (unless `skipReview: true`).

### Standard Review (per-stage)

Uses `stage.reviewExecutor ?? context.reviewExecutor ?? context.executor`. Runs after `invokeExecutor()` succeeds (exit code 0).

### Stop-Gate Review

Controlled by `config.reviewGate.enabled`. Independent review on the **main workspace** (not the job's worktree) before the CLI exits. Uses temporary directory, fails open (blocks on error/timeout rather than erroring the parent session).

```typescript
// review-gate.ts
interface ReviewGateResult {
  pass: boolean;
  reason: string;
  review: string;
  verdict: "PASS" | "FAIL" | "SKIP" | "TIMEOUT" | "ERROR" | "UNKNOWN";
}
```

---

## 8. Worktree Isolation

Jobs can run in an **isolated worktree** (per-job git branch + working directory) or in the main workspace.

| Mode | Workdir | Isolation |
|------|---------|-----------|
| `isolated: false` | `workspace` (main) | Shared, no branch |
| `isolated: true` | `.cbx/worktrees/<jobId>/` | Fresh branch, cleaned on done |

### Baseline

On job creation (`jobs.ts`), `snapshotDiff()` captures a **baseline** of the main workspace. `evaluateBaselineDrift()` compares current state to baseline before each adaptive Manager round or before completion. Significant drift triggers `needs_fix` before work continues.

---

## 9. Data Persistence

### SQLite

`src/storage.ts` wraps SQLite for:
- **Job state**: `state.json` + `approval.json` written to job dir
- **Queue**: `queue.jsonl` at workspace root
- **Config**: `.cbx.json` at workspace root

### Artifacts

Every job directory (`.cbx/jobs/<jobId>/`) contains:

| Artifact | Role |
|----------|------|
| `request.md` | Raw job request |
| `context.json` | JobContext snapshot |
| `state.json` | Current JobState |
| `events.ndjson` | Append-only event stream |
| `agent.log` | Executor stdout/stderr |
| `handback.md` | Stage output summary |
| `review.md` | Review gate output |
| `test.log` | Test runner output |
| `complete.patch` | Final diff |
| `result.json` | Final output |
| `stage-<n>-<name>-handback.md` | Per-stage handback copy |

### Artifact Whitelist

`artifacts.ts` defines `ARTIFACTS` set. Dynamic stage handback files must match `/^stage-\d+-[A-Za-z0-9._-]+-handback\.md$/`. All other filenames are rejected by `readArtifact()`.

### Workspace Discovery (shared entrypoint)

Workspace discovery — scanning a root dir for direct subdirectories containing a `.cbx/` dir — is **centralized** in `src/artifacts.ts`:

- `discoverWorkspaces(root)` — 1-level scan for `.cbx/` subdirs; returns absolute paths
- `dedupWorkspaces(paths)` — `path.resolve` dedup, first-occurrence order
- `listJobsAcrossWorkspaces(root)` — discovery + per-workspace `listJobs`

All three are re-exported via `src/core.ts` and consumed by **CLI** (`cbx ws --workspaces-dir`, `ui` command) and **MCP** (`cbx_list_workspaces`). **Never re-implement discovery per entry point** — import the shared functions.

> **Warning**: Web UI (`createWebUiServer`) must **not** call `discoverWorkspaces` internally. It receives the already-resolved workspace list from the CLI layer and only maps over it (`/api/workspaces`). Discovery is a CLI-layer responsibility; moving it into `ui.ts` would break the explicit `--workspace` path (explicit workspaces are not necessarily discovery results) and the CLI→UI contract.

---

## 10. Key Design Decisions

### Decision: Adaptive vs Explicit Stages

**Context**: Should a job use the Manager's dynamic decomposition or a predefined stage chain?

**Choice**: If `TaskContract.stages` is absent + `adaptive.enabled`, use Manager. Otherwise use explicit stage chain.

**Why**: Adaptive mode is better for exploratory tasks where the full decomposition isn't known upfront. Explicit stages are better for well-specified workflows.

### Decision: Single Worktree Serial Execution

**Context**: Stages within a layer are theoretically parallelizable.

**Choice**: Still execute serially within a layer.

**Why**: A single job's worktree is a single directory. Parallel stages would require merge conflict resolution and additional locking complexity disproportionate to the benefit.

### Decision: Fail-Open Review Gate

**Context**: The stop-gate review runs in the main CLI session (not a job).

**Choice**: Review gate fails open — errors, timeouts, and non-zero exits all result in `pass: true`.

**Why**: Review gate is a convenience check, not a security boundary. Blocking the user's main session due to a flaky review would be disproportionate.

### Decision: Evidence Hash Verification on Approval

**Context**: Approval gate checks artifact integrity before marking done.

**Choice**: SHA-256 hashes of `complete.patch`, `test.log`, and `review.md` are recorded at completion time and verified at approval time.

**Why**: Prevents silent reversion of test results or review verdicts between job completion and human sign-off.

### Decision: Context Pack Token Budget

**Context**: Large task contracts + long task descriptions can exceed context windows.

**Choice**: Each role pack has a `tokenBudget`. `trimContract()` budgets from lowest priority up: `assumptions/rejectedOptions/decisions` → `constraints/relevantFiles` → `nonGoals`. `goal`, `acceptanceCriteria`, and `stages` are **never trimmed**.

**Why**: Core task semantics must survive budget pressure. Only auxiliary metadata gets truncated.

### Decision: Typed JobState Optional Fields

**Context**: `JobState` carried an open index signature `[key: string]: unknown`, forcing `as` casts at every read site (`state.reviewVerdict as ...`, `state.stages as ...`).

**Choice**: Declare the known optional fields (`error`, `retryReason`, `testExitCode`, `reviewVerdict`, `executorExitCode`, `adaptiveRound`, `adaptiveRounds`, `stages`, `stageRetries`, `humanGate`, `pendingCompletion`, `gitCommit`, baseline/cleanup flags, …) as typed optional properties, keeping `[key: string]: unknown` as a forward-compat fallback.

**Why**: Declared fields narrow on read (`Array.isArray(initial.stages)` narrows to `StageReport[]`), eliminating redundant casts while unknown future fields still compile. The index signature remains for forward compatibility with older persisted jobs.

**Extensibility**: When adding a new persisted field to `JobState`, declare it in `types.ts` rather than reading it through the index signature. Casts remain only for dynamically-typed payloads (`adaptiveRounds as Json[]`, `decision.stage as TaskStage`).
