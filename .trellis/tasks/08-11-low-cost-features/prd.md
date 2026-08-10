# PRD: 低复杂度增量功能（TUI 事件流 + 任务模板 + 结果导出）

## Goal

三个低复杂度、可独立验证的增量功能，均不触碰编排核心架构（execution/stage-runner/queue）：

1. **TUI 事件流面板** — 补齐四入口中唯一缺的实时事件能力。
2. **任务模板/预设** — `.cbx.json` 支持任务模板，避免每次手写长 `--task` 描述。
3. **任务结果导出** — `cbx export <id>` 生成人类可读报告。

## Acceptance Criteria

### 1. TUI 事件流面板

- [ ] 详情面板或状态栏下方显示选中任务最近事件（复用 `readEventsIncremental` 增量读取 `events.ndjson`）。
- [ ] 每轮轮询增量拉取，仅显示新增事件；不重新读取全量（游标 `next_offset` 持久于 `TuiState`）。
- [ ] 最多显示 N 条（默认 5），超出滚动丢弃最旧；事件行含时间 + 类型（`job.state_changed` 显示状态转场）。
- [ ] 无事件/获取失败时静默（不影响主渲染）。
- [ ] 数据来自服务端投影（`readArtifact`/`readEventsIncremental`），不直接读文件。

### 2. 任务模板/预设

- [ ] `.cbx.json` 新增 `templates` 字段（strict schema 校验，未知键拒绝）：
  ```json
  { "templates": { "bugfix": { "task": "修复 review.md 中的问题", "test": "npm test", "review": true } } }
  ```
- [ ] CLI `cbx run --template <name>` 展开模板：`task` 必填，`test`/`review`/`executor`/`isolated` 等为可选覆盖；命令行显式参数优先于模板值。
- [ ] 模板不存在报明确错误（列出可用模板名）。
- [ ] `.cbx.json` schema 校验更新（`storage.ts` 的 `known` 白名单 + `templates` 结构校验）。

### 3. 任务结果导出

- [ ] `cbx export <jobId> [--format text|markdown]`（默认 text）。
- [ ] 输出读取 `result.json` + 关键工件（handback.md / test.log 摘要 / review.md 摘要 / complete.patch 统计）。
- [ ] text 格式为终端友好摘要（状态/阶段/耗时/stage 链/验收证据/错误）；markdown 格式含工件链接或内联摘要。
- [ ] job 不存在报错；无 result.json 时输出基本状态 + 提示。

## Out of Scope

- Web UI / MCP 侧的事件流（已有 SSE / cbx_logs）。
- 模板变量的插值/继承（保持简单键值展开）。
- 导出为 PDF/HTML 附件（仅终端 text/markdown 文本）。

## References

- `.trellis/spec/frontend/state-management.md` — UI 数据来自服务端投影
- `.trellis/spec/backend/mcp-server.md` — 响应形状与错误传播约定
- `src/storage.ts` `loadRuntimeConfig` — strict schema 校验模式（新增字段需加白名单）
- `src/artifacts.ts` `readEventsIncremental` — 增量事件游标
