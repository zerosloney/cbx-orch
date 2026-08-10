# Implement: 补齐 UI 控制面缺口

## 执行顺序

按 1 → 2 → 3 顺序，每步完成各自验证点后进入下一步。每一步都可独立回滚（单文件 revert）。

---

## Step 1: TUI approve/retry/continue 键位

**改动文件**：
- `src/tui/keyboard.ts` — `KeyAction` 加 `approve`/`retry`/`continue`；handler 映射 `a`/`y`/`n`
- `src/tui/index.ts` — `handleTuiKey` 加三个 case（状态过滤 + queueAction 分发）；`startTui` 的 `queueAction` 回调扩展支持 approve/retry/continue；底部提示更新

**queueAction 回调扩展**：

```typescript
const queueAction = (
  action: "pause" | "resume" | "cancel" | "approve" | "retry" | "continue",
  jobId?: string,
): void => {
  const operation =
    action === "pause" ? pauseQueue(workspace)
    : action === "resume" ? resumeQueue(workspace)
    : action === "cancel" ? (jobId ? cancelJob(workspace, jobId) : Promise.resolve())
    : action === "approve" ? (jobId ? approveAndStart(workspace, jobId) : Promise.resolve())
    : action === "retry" ? (jobId ? retryQueueJob(workspace, jobId) : Promise.resolve())
    : (jobId ? startBackground(workspace, jobId, "请根据 review.md 修复问题。") : Promise.resolve());
  void operation.catch(...).then(() => fetchData(workspace, state));
};
```

其中 `approveAndStart` 复刻 MCP 语义：`approveJob` 后若 `status === "queued"` 则 `startBackground`。

**状态过滤**（handleTuiKey case 内）：
- `approve`：仅 `status === "awaiting_approval"`
- `retry`：仅 `failed`/`needs_fix`/`review_failed`/`cancelled`
- `continue`：仅 `needs_fix`/`review_failed`
- 无选中或状态不匹配 → return（不触发）

**验证**：
```bash
npm run build
node --test dist/tests/tui.test.js
```
- `tests/tui.test.ts` 新增：approve 仅 awaiting_approval 触发 + jobId 正确；retry/continue 状态过滤；无选中忽略；未匹配状态忽略。

---

## Step 2: TUI 详情面板深度

**改动文件**：
- `src/tui/components/detail-pane.ts` — `renderDetailPane` 签名扩展（timeline + stages 参数），stage 链单行渲染 + timeline 摘要
- `src/tui/index.ts` — `fetchData` 对选中任务并行拉 `buildTimeline` + `readArtifact(result.json)`，存 `TuiState`；`draw` 传参

**TuiState 扩展**：

```typescript
interface TuiState {
  // ...existing
  detail?: { timeline: JobTimeline | null; stages: StageReport[] | null };
}
```

**渲染**：
- stage 链：`name / executor / verdict`，verdict PASS→绿 / FAIL→红 / 其余灰（复用 `theme` 或内联 chalk）
- timeline：`当前阶段: X · 已跑 Ns`
- 行数并入 `draw()` 的 `tableHeight` 动态计算

**验证**：
```bash
npm run build
node --test dist/tests/ui.test.js
```
- 新增 renderDetailPane 带 timeline/stages 参数的渲染断言（含 verdict 着色、空数据兜底）。

---

## Step 3: MCP cbx_clean

**改动文件**：
- `src/mcp-server.ts` — tools 数组加 `cbx_clean`；`callTool` 加分发；import `cleanupWorktree`
- `README.md` — MCP 工具清单加 `cbx_clean`

**验证**：
```bash
npm run build
node --test dist/tests/mcp-migration.test.js
```
- 新增：cbx_clean 对无 worktree 记录 job 返回 `{ job_id, cleaned: false }`；`tools/list` 包含 cbx_clean。

---

## 全量验证（Step 3 后）

```bash
npm run lint
npm test           # 全量（预计 ~3.5 min）
npx prettier --check <改动文件>   # 排除 ui/ 下浏览器资产
git diff --check
```

## 回滚点

| 步骤 | 回滚动作 |
|------|----------|
| Step 1 | revert `src/tui/keyboard.ts` + `src/tui/index.ts`（键位不冲突，无迁移） |
| Step 2 | revert `detail-pane.ts` + `tui/index.ts`（详情渲染纯增量） |
| Step 3 | revert `mcp-server.ts` + README（工具移除即回滚） |

## Review Gate

- `handleTuiKey` 状态过滤正确性（每键对应状态集合）
- TUI 详情数据来自服务端投影（不直读 SQLite）
- MCP 响应形状统一（`{job_id, cleaned}`）
- 三个测试文件全过
