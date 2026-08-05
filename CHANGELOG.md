# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible behavior changes, security fixes, and migration requirements are recorded here before a release.

## Unreleased

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
