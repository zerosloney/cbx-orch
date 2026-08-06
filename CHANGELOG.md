# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible behavior changes, security fixes, and migration requirements are recorded here before a release.

## Unreleased

- Fix: `createJob` 现在校验 SQLite 中是否已存在同 jobId 记录；legacy 导入后用户手清 `.cbx/jobs/<id>/` 目录但 SQLite 记录仍在时，同 jobId 不再静默覆盖旧任务状态。
- Fix: `retryQueueJob` 删除外层 20×50ms busy-wait，改为单个 `withQueueLock` 事务内原子完成"老 entry 标 cancelled + 插新 entry + 状态重置"；消除 dispatch 锁竞争时新老 entry 并存的漂移窗口。
- Fix: 队列终态状态映射（done/cancelled/awaiting_approval/else→failed）收敛到 storage 层 `savePersistedStateAndFinishQueue` 单一来源；`finishQueueEntry` 不再持有映射副本，避免新增终态时两处分叉。
- Fix: `dispatchQueue` 回收死 worker 增加双重校验——pid 不存活 OR 有 pid 但无 `worker.heartbeat` 且 `startedAt` 超 60s grace，视为僵尸（pid 复用 / spawn ENOENT 后 pid 被复用）并回收；queue worker 起步（`cli.ts run --queue-entry-id`）写入 `worker.heartbeat`。
- Fix: Windows 下超时/取消的进程终止增加兜底（taskkill 找不到 node 子进程时回退到 TerminateProcess），避免超时的执行器继续运行并改动工作区；`cancelJob` 与 `--timeout-ms` 共用同一修复。
- Fix: 取消排队中的任务现在会同步把对应队列条目标记为 `cancelled`，`executeJob` 不再为已取消任务清除标记后启动；`continue`/`retry` 作为显式重跑入口会在入队时清除取消标记。
- Fix: `stage-*-handback.md` 产物现在可通过 `readArtifact`（MCP `resources/read`、Web UI 文件面板）读取，与 `resources/list` 的展示一致。
- Feature: MCP `cbx_start` 支持 `allow_unsafe_permissions: true`，`permissionMode: dontAsk` 在 MCP/后台路径可用。
- Docs: README 补充 MCP 工具 `cbx_review_gate`，修正 `git.autoCommit` 与 telemetry 本地落盘的描述；同步 `package-lock.json` 版本到 0.9.0。
- Repo: 新增 `.gitattributes`（`* text=auto eol=lf`）与 `.prettierrc.json`（`endOfLine: lf`），全仓库行尾归一化为 LF，`format:check` 在 Windows 本地与 CI 一致通过；含一次性的 `git add --renormalize`。

## 0.9.0 - 2026-08-05

- Feature: stage chain — multiple executors接力 within a single job via `task_contract.stages`. Each stage runs sequentially in the same worktree, shares one diff/result, and its `handback.md` is auto-injected into the next stage's prompt. Per-stage `executor`, `review_executor`, and `skip_review` overrides. Mid-chain failure preserves earlier stage reports in `result.json`. Backward compatible: absent `stages` runs a single synthetic `implementation` stage.
- Feature: Web UI live board — `cbx ui` now streams real-time `job.state_changed` events over SSE by tailing `.cbx/events.ndjson` (previously the `/events` endpoint only sent heartbeats). Adds clickable job rows with an artifact viewer/下载 panel, stage-chain visualization (reads `result.json.stages`), a `reviewVerdict` column, and color-coded event stream. No new dependencies; single-file vanilla JS.
- Fix: SSE tailer dropped the first event when the events file did not exist at first poll — ENOENT now seeds `size=0` so the first appended event is delivered.

## 0.8.2 - 2026-08-05

- Refactor: extract `evaluateBaselineDrift`, `refreshBaseline`, and `performContextHandshake` helpers to reduce duplication in `executeJobLocked` and `startBackground`. Internal only; no public API or persisted schema changes.

## 0.8.1 - 2026-08-05

- Drop `pi` executor, rename `omp` to `Oh My Pi`; add `cline` builtin executor.
- Source repo no longer tracks `dist/`; npm publish now builds from source and verifies `dist/src/cli.js` is present before publishing.
- Harden delegated task context: record Git baseline (commit/branch/dirty/fingerprint), pause isolated jobs on dirty creation baseline, pause non-isolated jobs on dirty-content fingerprint drift, add structured `task_contract` with plan-only understanding handshake, add `review_executor` for independent review CLI.

## 0.8.0 - 2026-08-04

- Publish to npm: `npm install -g cbx-orch` provides the global `cbx` command. Plugin MCP server now calls `cbx mcp`, so dependencies resolve via the global install instead of the plugin cache (fixes `MCP error -32000: Connection closed` caused by missing `node_modules`/`better-sqlite3` in the plugin cache).
- Add `cbx mcp` subcommand as the MCP stdio entrypoint.
- Add `publish.yml` GitHub Action: pushing a `v*` tag publishes to npm automatically (requires `NPM_TOKEN` secret).
- Add SQLite-backed durable state, queue, and dead-letter storage.
- Add governed executor plugin manifests, allowlists, and provenance events.
- Add CI quality gates and package supply-chain artifacts.
