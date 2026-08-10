# Design: 补齐 UI 控制面缺口

## 1. Scope & Trigger

- 触发：能力矩阵审计发现三个跨入口缺口（TUI 审批/重试/续跑、TUI 详情深度、MCP worktree 清理）。
- 边界：只动 TUI 层（`src/tui/`）与 MCP 层（`src/mcp-server.ts`），不触及编排核心（execution/stage-runner/queue）。
- 单一任务而非父子拆分：三子项相互独立但每个都小，拆子任务的开销大于收益；在 `implement.md` 内按序执行并各自独立验证。

## 2. Contracts

### 2.1 TUI 键位（`src/tui/keyboard.ts` + `src/tui/index.ts`）

`KeyAction` 联合类型扩展：

```typescript
export type KeyAction =
  | "up" | "down" | "refresh"
  | "pause" | "resume" | "cancel"
  | "approve" | "retry" | "continue"   // 新增
  | "quit" | "unknown";
```

键位映射（`startKeyboardListener` 的 handler）：

| 键 | Action | 语义 |
|----|--------|------|
| `a` | approve | 批准 `awaiting_approval` 选中任务 |
| `y` | retry | 重试失败终态任务 |
| `n` | continue | 续跑 `needs_fix`/`review_failed` 任务 |

`handleTuiKey` 签名不变（第 4 参 `queueAction` 回调已存在），新增 case 走同一分发。状态过滤逻辑：

```typescript
case "approve": {
  const job = state.jobs[state.selectedIndex];
  if (!job || job.status !== "awaiting_approval") return;
  state.needsRedraw = true;
  void queueAction?.("approve", job.jobId);
  break;
}
```

### 2.2 TUI 详情深度（`src/tui/index.ts` + `src/tui/components/detail-pane.ts`）

`detail-pane.ts` 的 `renderDetailPane(state)` 签名扩展为接收额外投影：

```typescript
export function renderDetailPane(
  state: JobState | undefined,
  timeline?: JobTimeline | null,     // 来自 ui.ts buildTimeline
  stages?: StageReport[] | null,     // 来自 result.json.stages
): string
```

数据获取：`fetchData` 在选中任务时并行拉取（复用 Web UI 同源逻辑）：
- `buildTimeline(workspace, jobId)` — `src/ui.ts` 已导出
- `readArtifact(workspace, jobId, "result.json")` → parse `.stages`

渲染约束（沿用现有 `draw()` 防溢出模式）：
- stage 链单行内联（`name / executor / verdict`，PASS/FAIL/skip 三色）
- timeline 显示当前阶段 + 已跑秒数
- 详情总行数仍参与 `tableHeight` 动态计算

### 2.3 MCP cbx_clean（`src/mcp-server.ts`）

工具注册：

```typescript
{ name: "cbx_clean", description: "清理任务 worktree", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } }
```

`callTool` 分发：

```typescript
if (name === "cbx_clean") return { job_id: id, cleaned: await cleanupWorktree(root, id) };
```

响应形状 `{ job_id, cleaned: boolean }`；不存在的 job 抛错（`cleanupWorktree` 内部校验路径，错误传播遵循 MCP 约定）。`cleanupWorktree` 已在 `src/core.js` 导出（CLI `cbx clean` 同源）。

## 3. Data Flow

```
TUI: 键盘事件 → handleTuiKey → queueAction 回调 → approveJob/retryQueueJob/startBackground → fetchData 刷新
     选中变化 → fetchData → buildTimeline + readArtifact(result.json) → renderDetailPane → draw()

MCP: cbx_clean → cleanupWorktree(workspace, jobId) → { job_id, cleaned }
```

## 4. Tradeoffs

| 选项 | 取舍 | 决策 |
|------|------|------|
| TUI 详情读 SQLite vs 服务端投影 | 直接读库省一次解析，但违反"UI 只消费投影"原则 | 服务端投影（buildTimeline/readArtifact），与 spec 一致 |
| `a/y/n` vs 组合键 | 单键冲突风险低（当前键位稀疏） | 单键，符合现有 p/u/x 模式 |
| MCP clean 返回 shape | `{job_id, cleaned}` vs 裸 boolean | 带 job_id 与其它 job 工具一致 |

## 5. Compatibility

- TUI：向后兼容——新增键不占用现有键；`handleTuiKey` 签名不变（仅扩展 union）。
- MCP：新增工具不影响现有工具；`tools/list` 自动包含。
- 无持久化 schema 变更，无数据迁移。

## 6. Rollback

- 每子项独立可回滚：键位/详情/工具各自 revert 单个文件即可。
- `implement.md` 每步验证点通过后才进入下一步。

## 7. Test Strategy

- `tests/tui.test.ts`：`handleTuiKey` 新增 approve/retry/continue 的分发断言（状态过滤 + queueAction jobId + 无选中忽略）。
- `tests/ui.test.ts` 或新测试：`renderDetailPane` 接收 timeline/stages 的渲染断言。
- `tests/mcp-migration.test.ts`：`cbx_clean` 成功路径 + 不存在 job 的 error 断言。
