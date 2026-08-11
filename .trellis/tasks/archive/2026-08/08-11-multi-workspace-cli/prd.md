# PRD: 多 workspace CLI 调度

## Goal

CLI 侧支持跨 workspace 查询与汇总，对齐 Web UI 已有多 workspace 能力（`cbx ui --workspace A --workspace B` / `--workspaces-dir`）。新增 `cbx ws` 子命令聚合跨 workspace 的任务/队列/健康视图。

## Acceptance Criteria

### 1. workspace 解析

- [ ] 复用 `discoverWorkspaces`（`src/cli.ts` 已有）+ `--workspaces-dir <dir>`（1 层扫描含 `.cbx/` 子目录）。
- [ ] 支持显式 `--workspace` 多次（与 ui 命令一致）；未提供时默认 `.`。
- [ ] workspace 去重（`dedupWorkspaces` 已有）。

### 2. `cbx ws` 子命令

- [ ] `cbx ws [--workspace A --workspace B | --workspaces-dir DIR]` — 跨 workspace 汇总：
  - 每 workspace：任务总数、各状态计数（复用 `listJobs` 聚合）、队列深度、paused、git 分支（复用 `summarizeWorkspace` 逻辑或 `captureAsync`）
  - 输出 JSON：`{ workspaces: [{ path, name, jobsByStatus, queueDepth, paused, activeExecutors, gitBranch, error? }], default }`（与 Web UI `/api/workspaces` 形状一致）
- [ ] `cbx ws --json` 强制 JSON；交互终端输出表格（复用 `renderJobsTable` 风格或新 render）。

### 3. 子命令扩展（可选，按 `ws` 基础上叠加）

- [ ] `cbx list --all` 跨 workspace 列出任务（每行带 workspace 前缀）。
- [ ] `cbx health --all` 跨 workspace 健康汇总。

### 4. 与现有机制一致性

- [ ] 只读查询不触碰任何 workspace 状态；调度（run/start/batch）仍单 workspace（跨 workspace 调度属未来）。
- [ ] 单 workspace 时行为不变（向后兼容）。

## Out of Scope

- 跨 workspace 的 run/start/batch 调度（任务创建仍单 workspace）。
- 跨 workspace 的队列暂停/恢复聚合操作。
- 递归 workspace 扫描（保持 1 层，与 ui 一致）。

## References

- `src/cli.ts:discoverWorkspaces` / `dedupWorkspaces` — 现有扫描/去重
- `src/ui.ts:summarizeWorkspace` — Web UI 的 workspace 汇总投影（形状对齐目标）
- `src/artifacts.ts:listJobs`、`src/queue-api.ts:health` — 查询入口
