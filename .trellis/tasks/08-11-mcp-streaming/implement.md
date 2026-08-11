# Implement — MCP 真流式事件传输(streamable HTTP)

## 顺序实施清单

1. **重构 dispatch 共享**:`src/mcp-server.ts` 把 `runMcpServer` 的请求处理体抽成 `async function handleJsonRpc(request): Promise<unknown>`(含 initialize/ping/tools/list/resources/list/resources/read/tools/call + 错误映射)。stdio 的 `runMcpServer` 改为逐行调 `handleJsonRpc` 后 `send`。验证:现有 `tests/mcp-migration.test.ts` 全绿(stdio 行为不变)。
2. **HTTP transport**:新增 `runMcpHttpServer({ port, host, token })`:
   - `http.createServer`;仅允许 loopback host(拒绝启动非回环)。
   - `POST /mcp`:读 body → JSON.parse → `handleJsonRpc` → 单消息 `application/json` 响应。
   - `GET /mcp`(可选,SSE 长连接):返回 `text/event-stream`,作为服务端推送的承载连接。
   - token 鉴权(对齐 `ui.ts` `isAuthorized`):无 token 的 API 请求 401。
   - 响应头:无 session 要求;非法方法/路径 → 405/404。
3. **资源订阅**:`resources/subscribe` / `resources/unsubscribe` handler + 订阅表(uri → 连接集);`initialize` 能力声明 `resources: { subscribe: true, listChanged: false }`;`protocolVersion: "2025-06-18"`。
4. **事件资源 + 推送**:`resources/list` 增加 `cbx://job/<id>/events`;`resources/read` 支持该 uri(返回 `readEventsIncremental` 增量,含 seq 游标)。事件 tailer(复用 `ui.ts` `startEventTailer` 模式)检测 job 事件变化 → 对订阅连接推 `notifications/resources/updated { uri }`。订阅建立时先回放(读当前事件)。
5. **CLI 接线**:`cbx mcp` 解析 `--http [--port <n>] [--host <h>] [--token <t>]`;有 `--http` 时走 `runMcpHttpServer`,否则 stdio。端口默认(如 8931);token 优先级 `--token` > `.cbx.json` `ui.token`(与 `cbx ui` 同源)。
6. **测试**:新增 `tests/mcp-http.test.ts`(HTTP transport):
   - initialize 返回 2025-06-18 + subscribe:true
   - tools/list 19 工具齐全
   - resources/subscribe → 事件变化推 updated → resources/read 拿增量
   - 非 loopback host 拒绝绑定;无 token 401
   - stdio 回归:现有 mcp-migration.test.ts 全绿
7. **文档**:`.trellis/spec/backend/mcp-server.md`(协议版本/HTTP 模式/subscribe 契约)、README(两种接入示例)、CHANGELOG。

## 验证命令

- `npm test`(全量;含新 mcp-http.test.ts 与既有 463 例)
- `npm run build`(tsc,确认无未用 import/类型错)
- 手动冒烟:`cbx mcp --http --port 8931` + curl POST `/mcp` initialize 看协议版本;起一个 job 看订阅推送。

## 风险 / 回滚点

- 风险 1:SSE 长连接/推送细节与客户端行为差异 → 用真实 MCP 客户端(或 curl SSE)冒烟验证;通知仅作变更信号,数据经 read 拉取,降级语义清晰。
- 风险 2:重构 dispatch 抽共享函数改动 stdio 路径 → 现有 mcp-migration.test.ts 是回归护栏,先绿再进 HTTP。
- 风险 3:订阅连接泄漏(客户端断连) → 连接 `close` 时清理订阅表。
- 回滚:单提交 revert;stdio 与 HTTP 独立,零耦合。

## task.py start 前复查

- [ ] dispatch 抽共享后 stdio 测试全绿
- [ ] HTTP initialize 协议版本 + subscribe:true
- [ ] 订阅→推送→read 增量端到端测试通过
- [ ] 非 loopback 拒绝 + token 401
- [ ] 文档三处(规范/README/CHANGELOG)更新
