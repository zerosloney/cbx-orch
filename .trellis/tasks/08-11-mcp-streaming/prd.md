# MCP 真流式事件传输(streamable HTTP)

## Goal

让 MCP 客户端能经 **现代 MCP streamable HTTP 传输(2025-06-18)** 拿到实时 job 事件流。当前 MCP 是 stdio JSON-RPC 请求/响应 + `cbx_logs` 游标轮询(非真流式);本任务新增 `cbx mcp --http` 模式,升级协议版本、暴露 HTTP listener,并通过 `resources/subscribe` + `notifications/resources/updated` 实现服务端推送,对齐 Web UI `/events` SSE 的实时能力。

## 决策(已定)

1. **机制**:升级到 streamable HTTP 传输(协议 2025-06-18)。
2. **部署形态**:`cbx mcp` 默认保持 stdio(现有集成不断);新增 `--http [--port <n>] [--host <loopback>] [--token <t>]` 模式启 HTTP listener。客户端把 MCP 配置从 stdio 命令改为 `http://127.0.0.1:<port>/mcp` 接入真流式。
3. **推送机制**:规范原生 `resources/subscribe` + `notifications/resources/updated`(主流客户端支持);事件资源 = per-job `cbx://job/<id>/events`。

## Background / Confirmed Facts

- 传输现状(`src/mcp-server.ts`):stdio readline 逐行 JSON-RPC;`protocolVersion: "2024-11-05"`;能力 `resources: { subscribe: false, listChanged: false }`(mcp-server.ts:614);notification 被丢弃(mcp-server.ts:601-603);服务器从不主动发消息。
- 无 streamable/sse/progress 代码;19 个工具 + resources(list/read)。
- 事件源:workspace 级 `.cbx/events.ndjson`,SQLite `nextEventSeq` 原子自增 seq(observability.ts:242)。Web UI `/events` SSE 已有复合游标 `<wsIndex>:<seq>` + 回放缓冲 + 1000 条截断——**可复用的事件订阅/推送模式**。
- 增量读:`readEventsIncremental(workspace, jobId, since)`(artifacts.ts:96)。
- 既有契约(`.trellis/spec/backend/mcp-server.md`):一个工具一种形状;错误传播;`cbx_logs` 恒返回 `{job_id, events, next_offset}`。
- 复用参考:`ui.ts` `createWebUiServer`(loopback 绑定 + token 鉴权 + SSE tailer + 事件回放)是现成的 HTTP 服务实现模式。

## 规范研究(MCP Streamable HTTP 2025-06-18,已核实)

- 单 HTTP endpoint(`POST /mcp`),客户端每条 JSON-RPC 一个 POST;响应可单 JSON 或 SSE 流(`text/event-stream`,承载请求相关通知 + 最终响应)。
- 客户端 `Accept: application/json, text/event-stream`;initialize 后所有请求带 `MCP-Protocol-Version: 2025-06-18`。
- 服务端推送走 SSE 流;资源变更用 `resources/subscribe` + `notifications/resources/updated`。
- 会话:2025-06-18 可选 `Mcp-Session-Id`;2026-07-28 修订移除协议级会话。本实现声明无状态(不要求 session),兼容两种客户端。

## Requirements

- R1. `cbx mcp` 保留 stdio 模式(现状不变);新增 `--http [--port] [--host] [--token]` 模式启 HTTP listener,仅绑定 loopback(对齐 `cbx ui` 的安全约束),支持 token 鉴权。
- R2. HTTP 模式用协议版本 `2025-06-18`,能力声明 `resources: { subscribe: true, listChanged: false }`;实现 `resources/subscribe` / `resources/unsubscribe`。
- R3. 事件资源 `cbx://job/<id>/events` 进入 `resources/list` 并支持 subscribe;job 事件变化时向已订阅客户端推 `notifications/resources/updated`。
- R4. 推送复用事件 tailer/回放模式(对齐 Web UI):事件源 `events.ndjson` 增量 + seq 游标;订阅后先回放 `since` 之后事件,再实时推送。SSE 流 + 回放缓冲防洞(对齐 `ui.ts` SseClient)。
- R5. 19 个既有工具与 `resources/list`/`resources/read` 契约不变,HTTP 与 stdio 复用同一 dispatch 逻辑(提取共享 request handler)。
- R6. 无状态会话(不要求 `Mcp-Session-Id`);HTTP 非法方法/路径/缺失 Accept → 明确错误。

## Acceptance Criteria

- [ ] AC1. `cbx mcp --http` 在 loopback 端口启 HTTP MCP endpoint;stdio 模式行为不变(向后兼容)。
- [ ] AC2. HTTP 模式 `initialize` 返回 `protocolVersion: "2025-06-18"` + `resources.subscribe: true`;19 个工具 + resources 契约与 stdio 一致。
- [ ] AC3. `resources/subscribe` 订阅 `cbx://job/<id>/events` 后,该 job 事件变化触发 `notifications/resources/updated`;客户端能经订阅流实时收到事件(含订阅时点之前的回放)。
- [ ] AC4. 非 loopback host 拒绝绑定;无 token 时 API 请求 401(对齐 `cbx ui` 鉴权模式)。
- [ ] AC5. 测试全绿(新增 HTTP 传输 + 订阅推送用例;现 463 例全过)。
- [ ] AC6. 文档更新(`.trellis/spec/backend/mcp-server.md`、README、CHANGELOG)。

## Out of Scope

- 不改 19 个既有工具契约、不删 stdio 模式、不改任务状态机/执行逻辑。
- 不改 Web UI / `/events` SSE(已有能力)。
- 不实现进度通知(progress)、sampling、prompts 等未用 MCP 能力。
- 不引入 MCP SDK 依赖(用 Node 原生 `http`/SSE 手写,零依赖,对齐项目风格)。
