# Design — MCP 真流式事件传输(streamable HTTP)

## Architecture & Boundaries

新增 streamable HTTP 传输作为 stdio 之外的**第二种 transport**,复用同一套 JSON-RPC dispatch 逻辑。`src/mcp-server.ts` 拆成「dispatch 核心」+「两个 transport 壳」。

```
src/mcp-server.ts
  ├─ dispatch(request) → response          # 共享:tools/list · resources/* · callTool
  ├─ runMcpServer()                        # stdio transport(现状,不变)
  └─ runMcpHttpServer({port, host, token}) # 新:streamable HTTP transport
```

- **共享 dispatch**:把现在 `runMcpServer` 里 `input.on("line", ...)` 的请求处理体(initialize/ping/tools/list/resources/list/resources/read/tools/call)抽成 `handleJsonRpc(request, workspace?)` 纯函数,stdio 与 HTTP 共用;19 个工具与 resources 契约零改动。
- **HTTP transport**:`http.createServer`(Node 原生,零依赖,对齐 `ui.ts` 风格),loopback 绑定 + token 鉴权(对齐 `createWebUiServer` 的 `isAuthorized` 模式)。单 endpoint `POST /mcp`。
- **推送通道**:为支持服务端推送,HTTP transport 维护「事件订阅」状态——订阅了 `cbx://job/<id>/events` 的客户端集合;事件发布时经 tailer 推 `notifications/resources/updated`。

## 协议实现要点(2025-06-18)

### Handshake
- `POST /mcp` 收 JSON-RPC。`initialize` 响应:`protocolVersion: "2025-06-18"`,`capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } }`。
- 响应编码:单消息用 `application/json`;需服务端推送/多消息时用 `text/event-stream`(SSE 帧 `data: <json>\n\n`,事件可带 `event:`/`id:`)。
- 无状态会话:不要求 `Mcp-Session-Id`(兼容 2025-06-18 有状态客户端与 2026-07-28 无状态客户端);不强制校验 `MCP-Protocol-Version`(宽容,缺省按声明的 2025-06-18 处理)。

### 资源订阅推送
- `resources/subscribe { uri: "cbx://job/<id>/events" }` → 记录订阅(workspace, jobId, res 连接),返回 `{}`。
- `resources/unsubscribe` → 移除。
- job 事件源变化时,对该 job 的所有订阅连接推:
  `notifications/resources/updated { uri: "cbx://job/<id>/events" }`。
- **事件内容**:客户端收到 updated 通知后,`resources/read` 读 `cbx://job/<id>/events` 拿增量(响应含 seq 游标,对齐 `readEventsIncremental`)。避免在通知里塞大 payload,保持「通知 = 变更信号,read = 取数据」的规范分工。

### 订阅时点的回放
- 订阅建立时,先 `readEventsIncremental(ws, id, 0)` 拿当前事件(可选:带 `since` 参数支持从某 seq 续),作为回放;之后 tailer 实时推 updated。对齐 Web UI 的「回放 + 实时」模式。

### 事件 tailer 复用
- 复用 `ui.ts` 的 `startEventTailer` 模式(500ms 轮询 `events.ndjson` 增量,Windows 安全)。为 MCP 订阅各 job 启动/共享 tailer。若 UI 已有按 workspace 的 tailer,评估复用或独立轻量 tailer(不耦合 UI server 生命周期)。

## Security(对齐 `cbx ui`)

- `--host` 仅允许 loopback(`127.0.0.1`/`localhost`/`::1`),否则拒绝启动——防远程调用编排器。
- `--token` 存在时,非白名单路径(除 `/mcp` 握手相关)需 Bearer 校验;token 可经 `.cbx.json` `ui.token` 或 `--token` 传入(与 `cbx ui` 同源)。
- 事件订阅只对已鉴权连接生效。

## Compatibility & Migration

- stdio 模式完全不变:协议 2024-11-05、19 工具、resources 契约、`cbx_logs` 轮询——向后兼容现有集成。
- HTTP 模式是**新增入口**,不影响现有 stdio 客户端。
- 客户端接入:把 MCP 配置的 `command` 换成 `url: http://127.0.0.1:<port>/mcp` + 可选 token header。README 提供两种接入示例。
- 无持久化/schema 变更;纯新增 transport + 订阅能力。

## Trade-offs

- **HTTP listener 而非改造 stdio**:stdio 无法承载多客户端订阅/服务端主动推送语义(客户端 transport 是否转发非请求通知不可控)。HTTP + SSE 是 MCP 规范给出的推送通道。
- **零依赖手写 SSE/HTTP**:项目无 HTTP 框架,`ui.ts` 已用 Node 原生 `http` + 手写 SSE;保持零依赖、对齐风格,不引 `@modelcontextprotocol/sdk`(评估后:SDK 价值低于引入依赖成本,且手写面已覆盖所需子集)。
- **通知不含事件体**:避免在 `notifications/resources/updated` 塞 payload(可能很大),客户端用 `resources/read` 拉增量——符合规范、控 payload。

## Rollback

- 单提交可整体 revert;stdio 模式与 HTTP 模式互不影响,回退零风险。HTTP 模式是附加能力,不影响既有路径。
