# MCP Server Contract

`src/mcp-server.ts` exposes the orchestrator over MCP JSON-RPC (stdio). It is the control-plane counterpart to `src/cli.ts`; both call the same `src/core.js` functions.

## Scope

- Entry point: `cbx mcp` subcommand; also runnable directly as `node dist/src/mcp-server.js`.
- Protocol: JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
- Tools: `cbx_start` `cbx_status` `cbx_review` `cbx_continue` `cbx_artifact` `cbx_cancel` `cbx_approve` `cbx_list` `cbx_logs` `cbx_result` `cbx_queue` `cbx_queue_pause` `cbx_queue_resume` `cbx_retry` `cbx_review_gate` `cbx_clean`.
- Resources: `resources/list` + `resources/read` over `cbx://job/<id>/<artifact>?workspace=<encoded>` URIs.

## Response Shape Convention (must stay uniform)

Every `tools/call` result is wrapped by `text()`:

```jsonc
{
  "content": [{ "type": "text", "text": "<JSON.stringify(value)>" }],
  "structuredContent": <value>
}
```

Clients read `structuredContent`. Rules:

- **One tool, one shape.** A tool must not return different payload structures depending on arguments. `cbx_logs` is the canonical example: with or without `since`, it always returns `{ job_id, events: string[], next_offset: number }`. Do not reintroduce a `{ logs: string }` variant for the no-`since` case.
- **Errors propagate.** A tool that reads an artifact must let the missing-file/forbidden error surface as a JSON-RPC error (`{ code: -32000, message }`), matching `cbx_artifact` / `cbx_result`. Do not swallow failures into placeholder success payloads (historical `cbx_review` returned `{ review: "尚无 review.md" }` — removed).
- Job-scoped reads return `{ job_id, ... }`; whole-workspace reads (`cbx_list`, `cbx_queue`) return the raw projection.

## Key Tool Contracts

| Tool | Request | Response (`structuredContent`) |
|------|---------|-------------------------------|
| `cbx_start` | `task` (required), `task_contract`, `test_command`, `review`, `isolated`, `timeout_ms`, `max_retries`, `approval_before_complete`, `executor`, `review_executor`, `adaptive` (snake_case: `max_rounds`/`manager_executor`), `allow_unsafe_permissions` | `{ job_id, status: "queued" }` |
| `cbx_logs` | `job_id`, `since?` (0 = full) | `{ job_id, events, next_offset }` |
| `cbx_continue` | `job_id`, `message?`, `context_snapshot?`, `refresh_baseline?`, `extra_rounds?` (1..100), `priority?` | `{ job_id, status: "queued" }` |
| `cbx_approve` | `job_id` | JobState; if `status === "queued"` the server calls `startBackground` (approval-then-launch) |
| `cbx_review_gate` | `workspace?`, `executor?`, `timeout_ms?` | `{ pass, reason, verdict }` |
| `cbx_clean` | `job_id`, `workspace?` | `{ job_id, cleaned: boolean }` — idempotent; no worktree record → `cleaned: false` (matches CLI `cbx clean`), does not throw |

## Validation

- `extra_rounds` must be integer 1..100 → JSON-RPC error otherwise.
- `task_contract` must be a plain object; unknown `adaptive` keys rejected.
- `cbx_artifact` whitelist (`EVIDENCE_ARTIFACTS`): `handback.md`, `complete.patch`, `test.log`, `review.md`, `understanding.json`. Anything else → error.
- `since` for `cbx_logs` must be a non-negative integer.

## Design Decisions

### Decision: unified `cbx_logs` shape

**Context**: `cbx_logs` originally returned `{ job_id, logs: string }` without `since` but `{ job_id, events, next_offset }` with it — two shapes for one tool forced clients to branch.

**Options**: (a) keep dual shape, (b) always return events array + cursor.

**Decision**: (b). `readEventsIncremental(root, id, since)` is the single source; no-`since` maps to `since = 0`. Clients get one contract and can page with `next_offset`.

### Decision: errors propagate from read tools

**Context**: `cbx_review` caught missing `review.md` and returned a placeholder; `cbx_artifact`/`cbx_result` propagated errors.

**Decision**: propagate. Uniform failure semantics beat a friendlier-looking but shape-breaking fallback; the MCP client already handles JSON-RPC errors.

## Tests

- `tests/interfaces.test.ts` — tools/list shape, `cbx_status` structuredContent, error propagation, `task_contract`/`adaptive` validation, resources.
- `tests/mcp-migration.test.ts` — protocol lifecycle (initialize/ping/notification), `cbx_logs` unified shape across `since` modes, `cbx_review` missing-file error, tool list completeness.
