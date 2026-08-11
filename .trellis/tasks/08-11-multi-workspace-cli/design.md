# Design: 多 workspace CLI 调度

## 1. Scope & Trigger

- 触发：CLI 调度命令（list/queue/health）单 workspace，Web UI 已有多 ws 能力。
- 边界：`src/ui.ts`（导出汇总函数）+ `src/cli.ts`（新增 `ws` 子命令）。只读查询，不触碰调度/状态。
- 单任务，无子项。

## 2. Contracts

### 2.1 复用 Web UI 汇总投影

`src/ui.ts:summarizeWorkspace`（私有）已是跨 workspace 汇总的权威实现（Web UI `/api/workspaces` 用）。**导出它 + `WorkspaceSummary` 类型**，CLI 直接复用，避免第二份实现分叉。

```typescript
// src/ui.ts 导出
export interface WorkspaceSummary {
  path: string;
  name: string;
  jobsByStatus: Record<string, number>;
  queueDepth: number;
  paused: boolean;
  activeExecutors: number;
  lastActivityAt: string;
  gitBranch: string | null;
  gitDirty: boolean | null;
  error?: string;   // summarize 失败时由调用方填充
}
export async function summarizeWorkspace(workspace: string): Promise<WorkspaceSummary>;
```

已用 `captureAsync`（异步 git，主进程不阻塞）——符合 hook-guidelines 的进程捕获约定。

### 2.2 CLI workspace 解析

```typescript
async function resolveWorkspaces(parsed: CliArgs): Promise<string[]> {
  const explicit = parsed.all("--workspace");               // 可重复
  const scanRoot = parsed.option("--workspaces-dir");
  const scanned = scanRoot ? await discoverWorkspaces(scanRoot) : [];
  const all = explicit.length ? explicit : scanned.length ? scanned : ["."];
  return dedupWorkspaces(all);
}
```

### 2.3 `cbx ws` 子命令

```
cbx ws [--workspace A --workspace B | --workspaces-dir DIR] [--json]
```

- 对每个 workspace 并行 `summarizeWorkspace`（`Promise.all` + per-ws catch → `error` 字段）。
- 输出 `{ workspaces: WorkspaceSummary[], default }`（与 `/api/workspaces` 形状一致）。
- `--json` 或非交互：JSON；交互终端：表格（新 `renderWorkspacesTable`，列：Workspace/Jobs/Active/Queue/Paused/Branch）。

### 2.4 `list --all` / `health --all`（可选扩展）

- `cbx list --all`：跨 workspace `listJobs` 并合并，每行 `[workspace] jobId ...`。
- `cbx health --all`：跨 workspace `health`，汇总每 ws 指标。
- 实现共享 `resolveWorkspaces`。

## 3. Data Flow

```
cbx ws --workspaces-dir ~/code
  ├→ resolveWorkspaces → [A, B]
  ├→ Promise.all([summarizeWorkspace(A), summarizeWorkspace(B)])  // 每 ws catch → error 字段
  └→ renderWorkspacesTable | JSON { workspaces, default }
```

## 4. Tradeoffs

| 决策 | 选择 | 理由 |
|------|------|------|
| 汇总实现 | 导出 `summarizeWorkspace` 复用 | 单一权威实现；Web UI 与 CLI 形状一致 |
| 命令形态 | 独立 `ws` 子命令 + `--all` 扩展 | `ws` 是聚合视图；`--all` 是现有命令的跨 ws 模式 |
| 调度能力 | 仅只读查询 | 跨 ws 调度（run/batch）语义复杂（workspace 归属、并发），范围外 |

## 5. Compatibility

- 纯新增：`ws` 新命令；`list --all`/`health --all` 为可选 flag，缺省行为不变。
- 导出 `summarizeWorkspace` 不影响 ui.ts 内部使用。
- 无 config/persist 变更。

## 6. Rollback

- 单文件 revert（cli.ts + ui.ts 导出）即可。

## 7. Test Strategy

- `resolveWorkspaces` 单测：显式多 ws / --workspaces-dir 扫描 / 默认 "." / 去重。
- `summarizeWorkspace` 导出后复用 Web UI 测试（`/api/workspaces` 形状断言已有）。
- CLI 端到端：`cbx ws` 双 workspace 输出（含每 ws 状态计数）；`--json` 形状；`list --all` 前缀；单 ws 向后兼容。
