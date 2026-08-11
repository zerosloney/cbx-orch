# Design — 集中 workspace 发现为共享入口

## Architecture & Boundaries

共享函数保留在 `src/artifacts.ts`（孤儿代码已在此，且 `listJobs` 也在；`listJobsAcrossWorkspaces` 天然依赖 `listJobs`），经 `src/core.ts` re-export 供 CLI 与 MCP 消费。**不新建模块**——避免为一个 40 行扫描函数引入额外抽象层。

```
src/artifacts.ts     discoverWorkspaces(root) · dedupWorkspaces(paths) · listJobsAcrossWorkspaces(root)
        │  (core.ts re-export: export { …, discoverWorkspaces, dedupWorkspaces, listJobsAcrossWorkspaces } from "./artifacts.js")
        ▼
src/cli.ts           resolveWorkspaces / ui 命令  →  import from ./core.js
src/mcp-server.ts    cbx_list_workspaces 工具      →  import from ./core.js (或 artifacts.js)
```

## 共享函数契约

- `discoverWorkspaces(root: string): Promise<string[]>` — `path.resolve` 后扫描直接子目录，跳过 `.` 前缀与 `node_modules`，仅保留含 `.cbx/` 目录者；返回绝对路径数组。目录不可读/stat 失败 → 跳过（与 cli.ts 现行一致）。
- `dedupWorkspaces(paths: string[]): string[]` — 按 `path.resolve` 字符串去重，保留首次出现顺序（现为 cli.ts 本地，移入共享）。
- `listJobsAcrossWorkspaces(root: string): Promise<Array<{ workspace: string; jobs: JobState[] }>>` — `discoverWorkspaces(root)` 后并行 `listJobs`，返回带 workspace 投影。

## CLI 接线

`cli.ts` 现有两处本地使用：
1. `resolveWorkspaces(parsed)`（`cli.ts:95`）— 显式 `--workspace` > `--workspaces-dir` 扫描 > 默认 `.`。改为调用共享 `discoverWorkspaces` + `dedupWorkspaces`。优先级语义不变。
2. `ui` 命令（`cli.ts:415`）— `dedupWorkspaces([...explicit, ...(scanRoot ? await discoverWorkspaces(scanRoot) : [])])`。同样改调共享版本。

删除 `cli.ts:51` 本地 `discoverWorkspaces` 与本地 `dedupWorkspaces`。两函数加入 `cli.ts` 从 `./core.js` 的 import。

## Web UI（不改）

`createWebUiServer` 接收 CLI 已解析的 workspace 列表，`/api/workspaces` 对传入列表做汇总。发现是 CLI 层职责；若把发现移进 ui.ts 会破坏显式 `--workspace` 路径（显式 workspace 未必是发现结果）与 CLI→UI 契约。故只修正 docstring，不动 `ui.ts`。

## MCP `cbx_list_workspaces`（新增）

- 工具定义：`name: "cbx_list_workspaces"`，`description: "扫描 root 下含 .cbx/ 的 workspace 并列出各自任务"`。
- inputSchema：`{ type: "object", properties: { root: { type: "string" } } }`，`root` 可选。
- 解析：`const root = String(args.root ?? process.cwd())`（不复用单 workspace 的 `workspace()`，因为语义是「扫描目录」而非「目标 workspace」；缺省 cwd，与 CLI 未给 `--workspaces-dir` 时的 `.` 语义一致）。
- 处理：`return { workspaces: await listJobsAcrossWorkspaces(root) };`，挂到 `handleToolCall` 的 dispatch 链。
- 影响面（必须同步）：`src/mcp-server.ts` tools 数组 + dispatch；`tests/mcp-migration.test.ts` `tools/list` 断言新增 `cbx_list_workspaces` + 一个功能用例；`README.md` MCP 工具清单；`.trellis/spec/backend/mcp-server.md` 工具清单。

## Compatibility & Migration

- 无持久化/Schema 变更；纯代码重构 + 一个只读 MCP 工具。
- 行为不变：CLI 发现、去重、优先级语义与现网一致；共享函数逻辑逐字等价于 cli.ts 现行实现。
- MCP 新工具为追加，不影响既有工具；缺省 root=cwd 不会破坏现有 `CBX_WORKSPACE` 单 workspace 流程（那是 `cbx_list` 等的路径）。

## Trade-offs

- 保留在 artifacts.ts 而非独立模块：复用现有 re-export 通道，diff 最小；缺点是把「workspace 发现」混在「artifact 读写」模块——可接受，二者同属 workspace 层查询。
- `listJobsAcrossWorkspaces` 对每个 workspace 并行 `listJobs`，可能打开多个 SQLite；调用方是低频管理操作（MCP 列出、CLI ws 汇总），并发量受发现到的 workspace 数约束，无放大风险。

## Rollback

单提交可整体 revert；共享函数与 cli.ts 逻辑等价，回退无数据风险。
