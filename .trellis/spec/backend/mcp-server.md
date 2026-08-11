# MCP Server Contract

`src/mcp-server.ts` exposes the orchestrator over MCP JSON-RPC. It is the control-plane counterpart to `src/cli.ts`; both call the same `src/core.js` functions.

## Scope

- Entry points: `cbx mcp`（stdio，默认）与 `cbx mcp --http`（streamable HTTP）。
- stdio 模式:JSON-RPC 2.0 over stdin/stdout,one JSON object per line;协议 `2024-11-05`,无订阅推送(向后兼容)。
- HTTP 模式:`cbx mcp --http [--port] [--host] [--token]`,单 endpoint `POST /mcp` + `GET /mcp`(SSE 长连接承载服务端推送);协议 `2025-06-18`。仅绑定 loopback;`--token` 或 `.cbx.json` `ui.token` 鉴权(Bearer)。
- Tools: `cbx_start` `cbx_status` `cbx_review` `cbx_continue` `cbx_artifact` `cbx_cancel` `cbx_approve` `cbx_list` `cbx_logs` `cbx_result` `cbx_queue` `cbx_queue_pause` `cbx_queue_resume` `cbx_retry` `cbx_review_gate` `cbx_clean` `cbx_list_workspaces`.
- Resources: `resources/list` + `resources/read` over `cbx://job/<id>/<artifact>?workspace=<encoded>` URIs;外加可订阅的**事件流资源** `cbx://job/<id>/events?workspace=<encoded>`。

## Streamable HTTP 订阅推送

- 能力:`initialize` 返回 `protocolVersion: "2025-06-18"` + `capabilities.resources.subscribe: true`。
- `resources/subscribe { uri: "cbx://job/<id>/events?workspace=..." }` → 登记订阅;此后该 job 的 `events.ndjson` 行数增长时,向所有打开的 SSE 连接(`GET /mcp`)推 `notifications/resources/updated { uri }`。
- **通知 = 变更信号**:客户端收到 updated 后,`resources/read` 读该 events 资源拿增量(`readEventsIncremental` 输出 `{ events, next_offset }`);通知体不含事件数据(控 payload)。
- 基线:订阅时读取当前事件数作为基线,此后增长才推送——订阅前已存在的事件不算增量。
- 无状态会话:不要求 `Mcp-Session-Id`;订阅按 uri 全局登记,变更广播到所有打开的 SSE 连接。intentional-simple:单用户 loopback 场景,客户端按 uri 过滤即可。
- 无事件文件的任务,`resources/read` 返回空增量 `{ events: [], next_offset: 0 }`(非错误)。

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
| `cbx_list_workspaces` | `root?` (default cwd) | `{ workspaces: Array<{ workspace: string; jobs: JobState[] }> }` — scans `root` for direct subdirectories containing `.cbx/`, lists jobs per workspace |

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

### Decision: streamable HTTP transport for server push (stdio kept as default)

**Context**: `cbx_logs` cursor polling gave MCP clients no real-time event stream; Web UI `/events` has true SSE push.

**Options**: (a) long-poll `cbx_logs`, (b) server-initiated JSON-RPC notifications over stdio, (c) upgrade to streamable HTTP transport (2025-06-18) with `resources/subscribe` push.

**Decision**: (c). stdio stays the default transport (protocol 2024-11-05, backward compatible); `cbx mcp --http` adds streamable HTTP (2025-06-18) with `resources/subscribe` + `notifications/resources/updated` — the spec-native push mechanism mainstream clients support. Zero-dependency (Node native `http` + hand-written SSE, matching `cbx ui`). Long-poll was rejected (held request, not push); stdio notifications rejected (client transport support for unsolicited messages is uncontrollable).

## Tests

- `tests/interfaces.test.ts` — tools/list shape, `cbx_status` structuredContent, error propagation, `task_contract`/`adaptive` validation, resources.
- `tests/mcp-migration.test.ts` — protocol lifecycle (initialize/ping/notification), `cbx_logs` unified shape across `since` modes, `cbx_review` missing-file error, tool list completeness.
