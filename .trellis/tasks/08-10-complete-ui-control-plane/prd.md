# PRD: 补齐 UI 控制面缺口

## Goal

对齐 CLI / MCP / TUI / Web UI 四个入口的控制面能力，修复能力矩阵剩余三项缺口：

1. **TUI 审批/重试/续跑键位** — TUI 已有 `p`(暂停)/`u`(恢复)/`x`(取消)，缺少高频操作 approve/retry/continue。
2. **TUI 详情面板深度** — 当前仅 5 行（jobId/status/phase/attempt/error），无 stage 链与阶段时间线。
3. **MCP cbx_clean 工具** — `cbx clean <jobId>` 仅 CLI 有；`--keep-worktree` 用户在 MCP 路径无法清理 worktree。

## Acceptance Criteria

### 1. TUI approve/retry/continue

- [ ] `a` 键对 `awaiting_approval` 选中任务触发 `approveJob`；批准后状态回 `queued` 时自动 `startBackground`（与 CLI/MCP 语义一致）。
- [ ] `y` 键对失败终态（`failed`/`needs_fix`/`review_failed`/`cancelled`）触发 `retryQueueJob`。
- [ ] `n` 键对 `needs_fix`/`review_failed` 触发 `startBackground`（continue 语义，默认消息"请根据 review.md 修复问题。"）。
- [ ] 未选中任务或无对应状态时按键忽略（与现有 `x` 行为一致）。
- [ ] `handleTuiKey` 经 `queueAction` 回调分发，保持可单测（无终端依赖）。
- [ ] 底部提示更新为含 `a 批准 · y 重试 · n 继续`。

### 2. TUI 详情面板深度

- [ ] 详情面板在选中任务时显示 stage 链（来自 `result.json.stages`，读 `/api` 同源逻辑或 `readArtifact`）：每阶段 name/executor/reviewVerdict，PASS/FAIL/skip 着色。
- [ ] 显示阶段时间线摘要（复用 `buildTimeline` 的事件推导逻辑或直接调用 `ui.ts` 导出的 `buildTimeline`）：当前阶段、已跑秒数。
- [ ] 小屏防溢出：详情行数动态计算表格高度（沿用现有 `draw()` 逻辑）。
- [ ] 数据来源为服务端投影（`readArtifact`/`buildTimeline`），不直接读 SQLite。

### 3. MCP cbx_clean

- [ ] 新增 `cbx_clean` 工具：入参 `job_id`/`workspace`，调用 `cleanupWorktree`，响应 `{ job_id, cleaned: boolean }`。
- [ ] 工具注册进 `tools` 数组（`tools/list` 可见）并更新 README 工具清单。
- [ ] 无 worktree 记录的任务返回 `{ cleaned: false }`（幂等清理，与 CLI `cbx clean` 一致），不抛错。

## Out of Scope

- Web UI 写操作（已完成）。
- 队列事件流在 TUI 中的展示（Web UI SSE 已承担）。
- 物理并行 stage 执行（单 worktree 约束，规划外）。

## References

- 能力矩阵分析（本会话早前输出）
- `.trellis/spec/frontend/hook-guidelines.md` — TUI 键位与 `handleTuiKey` seam 约定
- `.trellis/spec/backend/mcp-server.md` — MCP 工具契约与响应形状约定
- `.trellis/spec/frontend/state-management.md` — UI 写操作经服务端原则
