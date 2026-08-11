# Backend Development Guidelines

## Scope

The backend is a **durable task orchestration engine** for coding-agent CLIs. It owns:

- Job lifecycle state machine (queued → running → stages → done/failed/cancelled)
- Adaptive multi-round Manager that decomposes tasks into stages
- Stage executor pipeline with dependency ordering, retry, and evidence gates
- Queue-based background scheduler with worker heartbeat and circuit-breaking
- Plugin executor system (builtin adapters + dynamic plugin loading)
- Human approval gates, review gates, and structured evidence verification
- Worktree isolation with git baseline drift detection
- Persistence: SQLite (state/queue) + JSON artifacts + ndjson event log

## Source Map

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry, 20+ subcommands dispatch |
| `src/core.ts` | Barrel facade → delegates to split modules |
| `src/types.ts` | Core types: `JobStatus`, `JobContext`, `JobState`, `TaskStage`, `TaskContract` |
| `src/execution.ts` | Orchestration engine: `executeJob()`, `prepareContinuation()`, stage ordering |
| `src/stage-runner.ts` | Stage executor: `runStage()`, `requestAdaptiveAction()`, retry logic |
| `src/runner.ts` | Executor invocation: `invokeExecutor()`, `runTest()` |
| `src/executors/builtin.ts` | Builtin adapters: codebuddy, opencode, omp, cline |
| `src/executor.ts` | Plugin contract: `ExecutorRequest`/`ExecutorResult`, SHA-256 verify |
| `src/context-pack.ts` | Role projections (manager/executor/auditor) with token budgets |
| `src/queue.ts` | Queue scheduler: dispatch, heartbeat reclaim, circuit-breaking |
| `src/queue-api.ts` | Queue facade |
| `src/approval.ts` | Human approval handler |
| `src/review-gate.ts` | Independent stop-gate review |
| `src/evidence.ts` | SHA-256 evidence, `PendingCompletion`, structured audit |
| `src/progress.ts` | `StructuredAudit`, `CriterionJudgement`, verification |
| `src/human-gate.ts` | Pause/resume mechanism, failure tracking |
| `src/state.ts` | SQLite persistence, `loadState`/`writeState`, event log |
| `src/jobs.ts` | Job creation, directory structure, git baseline snapshot |
| `src/validation.ts` | `normalizeTaskContract()`, `validateStageDependencies()` |
| `src/adaptive-manager.ts` | `NextAction` decisions, `managerPrompt()` |
| `src/artifacts.ts` | Artifact whitelist, `readArtifact()`, `listArtifacts()` |
| `src/storage.ts` | SQLite ops, JSON load/save, redaction |
| `src/errors.ts` | `CbxError` error codes |

## Guides

| Guide | Use it for |
|-------|-----------|
| [Orchestration Architecture](./orchestration-architecture.md) | Job lifecycle, stage model, adaptive Manager, data flow |
| [Executor Model](./executor-model.md) | Builtin adapters, plugin system, executor invocation |
| [Context Pack](./context-pack.md) | Role projections, token budgets, artifact references |
| [Queue & Scheduler](./queue-scheduler.md) | Worker dispatch, heartbeat, reclaim, circuit-breaking |
| [Evidence & Approval](./evidence-approval.md) | Evidence hashes, approval gates, structured audit |
| [MCP Server](./mcp-server.md) | JSON-RPC tool contracts, response shape convention, validation |

## Pre-Development Checklist

Before changing orchestration behavior:

1. Trace the execution path through `executeJob()` → `executeJobLocked()` → `runStage()` → `invokeExecutor()`.
2. Check `validation.ts` for `normalizeTaskContract()` — dependency/cycle validation happens once at intake, not per-stage.
3. Review `context-pack.ts` token budget logic before adding fields to any role projection.
4. Any new artifact must be added to the whitelist in `artifacts.ts` (`ARTIFACTS` set).
5. Queue changes: understand `WORKER_HEARTBEAT_GRACE_MS`, `MAX_RECLAIMS`, and `SERVICE_LEASE_TTL_MS`.
6. Approval/evidence changes: check `evidenceHashes()` artifacts list and `completionEvidenceValid()` gates.
7. A new `.cbx.json` field must be added to the strict-schema whitelist in `storage.ts:loadRuntimeConfig` (`known(...)` + per-field validators). Unknown keys are rejected — a misspelled config field silently fails validation, which is the intended guardrail. `templates` is the example: each entry requires a non-empty `task`, optional `test`/`review`/`executor`/`isolated`, and unknown template keys are rejected.

## Quality Check

```text
npm run lint
npm run format:check
npm test
git diff --check
```

## Observability Contract: Webhook Filters

`src/observability.ts:publishEvent` enqueues webhook deliveries; `notifications.filters` (`.cbx.json`) narrows which events are enqueued. Filtering happens **before** `enqueueDelivery` — a non-matching event never enters the durable outbox or dead-letter path, but always lands in the local `events.ndjson`.

```json
{ "notifications": { "webhook": "https://x", "filters": { "events": ["job.state_changed"], "jobIds": ["job-1"], "statuses": ["done"] } } }
```

- AND semantics: all configured dimensions must match; unconfigured dimensions do not restrict.
- Payload fields are read as strings; a missing `jobId`/`status` makes that dimension non-matching when its filter is configured (never a false positive delivery).
- The predicate is the exported pure function `matchesWebhookFilters(event, filters)` — keep it side-effect free and unit-tested. Do not move filtering into the outbox drain (dead-letter/retry would then carry events that should never have been enqueued).

## Batch Run Contract

`cbx batch` (`src/batch.ts`) creates independent jobs in waves. It is a CLI-layer convenience over `createJob` + `startBackground` — it never touches the queue's `maxConcurrent` or the scheduler.

- `chunkBatch(tasks, maxBatch)` splits into waves; `maxBatch <= 0` or `>= total` means one full wave. Waves wait for the previous wave's terminal states before enqueueing the next (batch-local concurrency control).
- Job IDs are `batch-<ts>-<seq>`; batch jobs are structurally identical to single jobs (same queue, same config, independently `retry`/`continue`-able).
- `--wait` polls every job to a terminal state (`BATCH_TERMINAL_STATUSES`); timeout returns unfinished IDs and a non-zero exit. The terminal set must stay in sync with `JobStatus` additions.
- Keep batch orchestration pure/testable: chunking and summarization are exported pure functions; only `runBatch` touches the queue.
