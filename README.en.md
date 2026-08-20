# CBX Orchestrator (`cbx`)

Durable task orchestration for AI coding CLIs — turn CodeBuddy / OpenCode / Oh My Pi / Cline / Qwen Code (or any ESM plugin) into a persistent, verifiable pipeline:

```text
create task → execute → save raw logs → run tests → generate diff → review → rework if needed
```

Job state, event streams, test logs, diffs, and review reports all persist to disk. Jobs survive process crashes and can be resumed, retried, and reworked. The full Chinese documentation lives in [README.md](./README.md); this file is a concise English overview.

## Quick start

```powershell
npm install -g cbx-orch        # published package
# run from the target repo:
cbx run --workspace . --task "实现用户登录功能" --test "npm test" --timeout-ms 1800000 --max-retries 1 --review
cbx doctor --workspace .
cbx doctor --workspace . --json
cbx status JOB_ID
cbx review JOB_ID
cbx continue JOB_ID --message "fix the issues in review.md"
```

Job data is stored under `.cbx/jobs/<job-id>/` in the target repo: task spec, state, raw event stream, test log, diff, and review report.

> Source install: `npm install && npm run build` (the repo does not track `dist/`). Requires **Node.js ≥ 22**.

## What it does differently

Handing a task to an agent CLI directly is a one-shot session: a crash loses the work, batches need hand-holding, and the agent grades its own homework. cbx turns delegation into a durable, verifiable, concurrent pipeline:

- **Durable by design.** SQLite WAL + versioned migration, monotonic event `seq` with replay, durable delivery outbox, worker heartbeats with reclaim circuit breaker, service leases with fencing tokens. A crash mid-execution leaves a resumable job, not a mystery.
- **Executor-agnostic.** One orchestrator over five coding CLIs with a plugin system (`executor: "./plugin.mjs"`). Not tied to any single vendor.
- **Verification gates.** Tests + an independent review pass + a structured completion-evidence gate + optional approval gates (`beforeRun` / `beforeComplete`). `done` means the evidence exists, not just that an agent claimed success.
- **Isolation.** Each job runs in its own git worktree by default; dirty baselines are detected and require explicit confirmation.
- **Agent-native control plane.** An MCP server (stdio + streamable HTTP with resource subscriptions) and plugins for ZCode and Claude Code let a host agent delegate long work to a detached worker and poll incrementally.
- **Governance.** Strict config schema, event redaction, plugin allowlisting (path/SHA-256), dependency-change guards, retention policies, and an OS-independent trust boundary note: worktree isolation is not an OS sandbox.

## Executors

| Executor  | Name / alias        | Binary      | Env override    |
| --------- | ------------------- | ----------- | --------------- |
| CodeBuddy | `codebuddy` / `cbc` | `codebuddy` | `CBX_CODEBUDDY` |
| OpenCode  | `opencode`          | `opencode`  | `CBX_OPENCODE`  |
| Oh My Pi  | `omp` / `oh-my-pi`  | `omp`       | `CBX_OMP`       |
| Cline     | `cline`             | `cline`     | `CBX_CLINE`     |
| Qwen Code | `qwen`              | `qwen`      | `CBX_QWEN`      |

`cbx run`/`start`/`batch`/`doctor`/`templates`/`ws`/`mcp`/`status`/`list`/`queue`/`dispatch`/`serve`/`health`/`metrics`/`logs`/`files`/`result`/`export`/`review`/`continue`/`approve`/`retry`/`cancel`/`clean`/`forget`/`purge`/`watch`/`ui`/`tui`/`review-gate`/`stop-review-gate` are available (see `cbx --help`).

### Agent registration and discovery

Custom executors use the AgentSpec JSON contract. Place project-level specs in `.cbx/agents/` (versionable with the repository) or user-level specs in `~/.cbx/agents/`; workspace specs override user-level specs, and built-in names cannot be overridden. Inspect the discovered agents and their binary availability with:

```powershell
cbx agents --workspace .
cbx agents --workspace . --json
```

The human-readable output is a table; `--json` is intended for scripts and integrations.

## Configuration

`.cbx.json` at the repo root (CLI flags override config):

```json
{
  "executor": "codebuddy",
  "profile": "verified",
  "testCommand": "npm test",
  "review": true,
  "isolated": true,
  "timeoutMs": 1800000,
  "maxRetries": 1,
  "maxTurns": 50,
  "maxConcurrent": 2,
  "approval": { "beforeRun": false, "beforeComplete": false },
  "git": {
    "autoBranch": true,
    "autoCommit": true,
    "commitMessage": "chore: apply task"
  },
  "dependencyGuard": false,
  "templates": {
    "bugfix": {
      "task": "修复 review.md 中的问题",
      "test": "npm test",
      "review": true,
      "profile": "verified"
    }
  },
  "adaptive": { "enabled": false, "maxRounds": 8 },
  "governance": {
    "retentionDays": 30,
    "pruneJobs": false,
    "redactFields": ["token", "password"]
  },
  "execution": {
    "trustMode": "trusted",
    "runner": "./my-container-runner.mjs"
  },
  "ui": { "token": "your-secret-token" }
}
```

### Task templates

Task templates come from the `templates` object in the target repository's `.cbx.json`. List the templates for a workspace with:

```powershell
cbx templates --workspace .
cbx templates --workspace . --json
```

The default output shows each template name, `profile`, and a `task` summary. `--json` returns `{ "templates": [...] }` for scripts. A template can set `task`, `test`, `review`, `executor`, `isolated`, and an optional `profile` (`fast`, `verified`, `governed`, or `untrusted`):

```json
{
  "templates": {
    "bugfix": {
      "task": "修复 review.md 中的问题",
      "test": "npm test",
      "review": true,
      "profile": "verified"
    }
  }
}
```

Use `--template <name>` with `cbx run` or `cbx start` to expand a template. Profile precedence is: explicit CLI `--profile` > template `profile` > top-level config-file `profile`.

```powershell
cbx start --workspace . --template bugfix
cbx start --workspace . --template bugfix --profile fast
```

### Execution Profiles

`profile` can be set at the top level of `.cbx.json`, or passed through the CLI as `--profile fast|verified|governed|untrusted`, MCP as `cbx_start.profile`, or the Web request body as `profile`. An explicitly supplied entry-point value overrides the config-file value:

| Profile     | Defaults and creation-time constraints                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fast`      | Defaults to no Git worktree isolation (`isolated=false`) and no independent review (`review=false`); no test command is required; trust mode is `trusted`. |
| `verified`  | Enables isolation and independent review by default; a non-empty test command is required.                                                                 |
| `governed`  | Adds `dependencyGuard=true` and approval before completion (`approval.beforeComplete=true`) to the `verified` constraints.                                 |
| `untrusted` | Adds `trustMode=untrusted` to the `governed` constraints and also requires `execution.runner` to provide container-level isolation.                        |

Explicit fields override profile defaults, but the resulting configuration must still satisfy the profile's hard constraints; for example, `verified` with `review=false` or `isolated=false` is rejected during task creation. Profiles other than `untrusted` cannot use `trustMode=untrusted`. When no profile is set, the existing field defaults remain in effect.

Unknown fields, wrong types, and out-of-range values are rejected so policy typos fail loudly.

### Doctor diagnostics

`cbx doctor` is a read-only environment check. It does not create jobs, write to the workspace, or start an Agent. It checks Node.js >= 22, the workspace directory, `.cbx.json` configuration and profile constraints, Git, executor availability, and the runner file required by `untrusted` mode:

```powershell
cbx doctor --workspace .
cbx doctor --workspace . --json
```

The default output is human-readable; `--json` returns a machine-readable report with `checks`. A `fail` check returns a non-zero exit code, while `warn` and `pass` return 0.

### Task contracts

For non-trivial work pass a structured contract (`goal`, `acceptance_criteria`, `non_goals`, `constraints`, `relevant_files`, `decisions`, `rejected_options`, `assumptions`) via MCP `cbx_start` or `--task-file`. This enables a plan-only `understanding.json` handshake; blocking ambiguity stops as `needs_fix / awaiting_clarification` instead of being guessed. Multi-stage pipelines use `taskContract.stages[]` with `dependsOn` (dangling and circular deps are rejected at creation); with `isolated: true`, dependency layers run **in parallel** — each stage in its own worktree, layer diffs merged in declaration order, merge conflicts pausing as `needs_fix / stage_merge_conflict`. Adaptive mode replaces the fixed chain with a manager executor that picks each round's stage.

### Container runner plugin

`execution.runner` points to an ESM plugin (`cbx.runner/v1`) that takes over process execution for executor/test/review commands — the intended use is container-level isolation for `untrusted` jobs (cbx ships no container runtime itself). The plugin exports `manifest` + `run(request)` (`{ workspace, directory, workdir, command, shell, role, timeoutMs, env, logFile }` → `{ code, timedOut, output }`) and must kill its container within `timeoutMs`. Path traversal is guarded like executor plugins. `untrusted` requires `isolated: true` plus a configured runner; without a runner it is rejected.

### Review verdicts

The reviewer writes `review.md` (first line `VERDICT: PASS|FAIL`) and, ideally, a machine-readable `review.json` (`{"version":1,"verdict":"PASS"|"FAIL"}`) — the structured file takes precedence. Unparsable output is handled differently by design: the stop-gate fails open (never blocks your session), while the in-stage review fails closed (unreviewed code never passes silently) and records a `review_verdict_unparsable` event.

## Web UI / TUI / MCP

```powershell
cbx ui --workspace . --port 4173            # dashboard: jobs, queue, SSE live events, task actions
cbx tui --workspace .                       # terminal UI
cbx mcp                                     # stdio MCP (2024-11-05, backward compatible)
cbx mcp --http --port 8931 --token <t>      # streamable HTTP MCP (2025-06-18, resource subscriptions)
```

The Web UI binds loopback only; `--ui-token` enables auth via HttpOnly cookie / Bearer header. The MCP server exposes 19+ tools (`cbx_start`, `cbx_status`, `cbx_continue`, `cbx_artifact`, `cbx_review`, …) plus `resources/read` for job artifacts. ZCode and Claude Code marketplace plugins register the MCP server automatically and provide `/cbx-run` etc. slash commands.

In `result.json`, `evidenceAvailable` is `true` and `verificationStatus` is `"verified"` only when a non-empty `testCommand` is configured, the test succeeds, and the existing review/evidence conditions pass. A task without a test command may still reach `done`, but its result is `evidenceAvailable: false` and `verificationStatus: "unverified"`; the placeholder `test.log` does not count as verification.

## Security notes

- Default permission mode is `auto`; `dontAsk` requires explicit `--dangerously-skip-permissions`.
- Test commands are user-provided and run in the target workspace. cbx applies a best-effort destructive-command blocklist — **not** a guarantee of safety. Prefer `--isolated`.
- `--isolated` uses git worktrees; it is **not** an OS sandbox (no network/credential/host isolation). `trustMode: untrusted` is rejected unless a container runner is supplied externally.
- Host/Origin guards (DNS rebinding + CSRF), redaction of secrets in events/webhooks, plugin allowlisting, and dependency-hash guards are built in.

## Development

```powershell
npm run check        # lint (incl. ui checkJs) + format check + full test suite
npm run coverage     # test coverage with enforced thresholds
npm run audit        # high-severity dependency audit
npm run sbom         # CycloneDX SBOM
npm run smoke:executors   # run each INSTALLED executor CLI against a trivial prompt (verifies adapter contracts)
```

CI runs lint/format/test/coverage/SBOM on **Ubuntu, Windows, macOS × Node 22, 24**. Windows is a first-class target (process-tree kill via taskkill, file locks, worktree paths). Publish (`v*` tag) builds from source, verifies package contents, and publishes with provenance.

## License

MIT — see [LICENSE](./LICENSE). Report suspected vulnerabilities privately per [SECURITY.md](./SECURITY.md).
