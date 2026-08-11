# 集中 workspace 发现为共享入口

## Goal

消除 workspace 发现的重复实现，收敛到单一共享入口，让 CLI、Web UI 启动路径与 MCP 复用同一份扫描逻辑。当前 `src/artifacts.ts` 有一份未提交、未被引用的 `discoverWorkspaces` / `listJobsAcrossWorkspaces`（孤儿代码），与 `src/cli.ts:51` 的本地 `discoverWorkspaces` 逐字重复；CLI 仍用本地副本。本任务把它转正：共享、接线、删重复，并补齐 MCP 侧缺失的 `cbx_list_workspaces` 工具。

## Background / Confirmed Facts

- `src/artifacts.ts:31` `discoverWorkspaces(root)` 扫描根目录下含 `.cbx/` 的直接子目录（1 层，不递归），返回绝对路径列表——与 `src/cli.ts:51` 的本地同名函数逻辑逐字一致。
- `src/artifacts.ts:63` `listJobsAcrossWorkspaces(root)` 返回 `Array<{ workspace: string; jobs: JobState[] }>`。
- 两函数目前**零调用者**；CLI 仍用 `cli.ts` 本地副本（`resolveWorkspaces` 与 `ui` 命令两处）。
- `src/core.ts:22` 已 re-export `listJobs` / `readArtifact` 等来自 `./artifacts.js`；`cli.ts` 从 `./core.js` 导入。新增共享函数需加入 core.ts re-export 才能被 cli.ts 消费。
- Web UI `createWebUiServer(workspace: string | string[])`（`ui.ts`）接收 CLI 已解析好的 workspace 列表；`/api/workspaces` 只对传入列表做 `summarizeWorkspace`，**内部不做发现**。发现发生在 CLI 层（`cli.ts ui` 命令）。因此 UI 无需调用 `discoverWorkspaces`——docstring 中「Web UI `/api/workspaces` 走此入口」的说法不准确。
- MCP 目前只有单 workspace 工具（`workspace()` = args → env → cwd 三级回退），无 `cbx_list_workspaces`。
- 受影响文件：`src/artifacts.ts`、`src/cli.ts`、`src/core.ts`、`src/mcp-server.ts`、`tests/mcp-migration.test.ts`、文档（`README.md`、`.trellis/spec/backend/mcp-server.md`）。

## Requirements

- R1. 单一共享入口：`discoverWorkspaces` / `dedupWorkspaces` / `listJobsAcrossWorkspaces` 只存在一份，位于 `src/artifacts.ts` 并由 `core.ts` re-export。
- R2. CLI 全部发现路径（`resolveWorkspaces`、`ui` 命令）改调共享入口；删除 `cli.ts` 本地 `discoverWorkspaces` / `dedupWorkspaces`。
- R3. 新增 MCP 工具 `cbx_list_workspaces`，复用 `listJobsAcrossWorkspaces`。
- R4. 修正 `discoverWorkspaces` docstring：去掉「Web UI 内部走此入口」的错误表述，改为「CLI `cbx ws --workspaces-dir`、CLI `ui` 命令、MCP `cbx_list_workspaces`」。
- R5. 同步更新 MCP 工具清单相关文档与测试。

## Out of Scope

- 不改 Web UI `/api/workspaces` 内部实现（它操作 CLI 传入的已解析列表，行为正确）。
- 不改单 workspace MCP 工具（`cbx_list` 等）的解析逻辑。
- 不新增 CLI 子命令（`cbx ws` 已存在）。
- 不重构 `resolveWorkspaces` 的显式 `--workspace` > 扫描 > 默认 `.` 优先级语义。

## Acceptance Criteria

- [ ] AC1. `src/cli.ts` 不再含本地 `discoverWorkspaces` / `dedupWorkspaces` 定义；两处调用（`resolveWorkspaces`、`ui` 命令）改用 `core.js` 导出的共享版本，行为不变。
- [ ] AC2. `src/artifacts.ts` 的 `discoverWorkspaces` / `listJobsAcrossWorkspaces` 有真实调用者（至少 CLI 一处 + MCP 一处），不再是孤儿。
- [ ] AC3. MCP `tools/list` 返回 `cbx_list_workspaces`；调用它按 `root` 扫描返回 `{ workspaces: [{ workspace, jobs }] }`（root 缺省回退 cwd）。
- [ ] AC4. `discoverWorkspaces` docstring 与实现一致（不再声称 Web UI 内部调用）。
- [ ] AC5. 测试全绿：`npm test`（含 `tests/mcp-migration.test.ts` 的 tools/list 断言新增 `cbx_list_workspaces`）；无未提交的孤儿代码。
- [ ] AC6. 改动已提交，README 与 `mcp-server.md` 的 MCP 工具清单含 `cbx_list_workspaces`。
