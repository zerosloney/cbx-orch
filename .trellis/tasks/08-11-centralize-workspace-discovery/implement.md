# Implement — 集中 workspace 发现为共享入口

## 顺序实施清单

1. **`src/artifacts.ts`** — 在 `listJobsAcrossWorkspaces` 后新增共享 `dedupWorkspaces`（从 cli.ts 移入，保持 `path.resolve` 去重、保序）。修正 `discoverWorkspaces` docstring（去掉「Web UI 内部调用」错误表述，改为 CLI `cbx ws --workspaces-dir`、CLI `ui` 命令、MCP `cbx_list_workspaces` 共享此入口）。
2. **`src/core.ts`** — artifacts re-export 行（`core.ts:22`）追加 `discoverWorkspaces`、`dedupWorkspaces`、`listJobsAcrossWorkspaces`。
3. **`src/cli.ts`** — 从 `./core.js` import 三个共享函数；删除本地 `discoverWorkspaces`（`cli.ts:51`）与本地 `dedupWorkspaces`；确认 `resolveWorkspaces` 与 `ui` 命令改走共享版本。
4. **`src/mcp-server.ts`** — tools 数组新增 `cbx_list_workspaces`（inputSchema `{ root: string }`，可选）；dispatch 链新增 `if (name === "cbx_list_workspaces") return { workspaces: await listJobsAcrossWorkspaces(String(args.root ?? process.cwd())) };`；import 共享函数。
5. **`tests/mcp-migration.test.ts`** — `tools/list` expected 数组新增 `cbx_list_workspaces`；新增一例：临时目录建两个含 `.cbx/` 的 workspace 子目录（各 `createJob` 一个），调用 `cbx_list_workspaces` 断言返回两个 workspace 且各自 jobs 正确。
6. **文档** — `README.md` MCP 工具清单追加 `cbx_list_workspaces`；`.trellis/spec/backend/mcp-server.md` 工具清单追加同名工具。

## 验证命令

- `npm test`（或项目现有测试入口；`tests/mcp-migration.test.ts` 的 `tools/list` 断言必须含新工具且全绿）。
- `npm run build`（若有 build 步骤）确认 TS 编译通过、无未用 import。
- 手动冒烟：`node dist/cli.js ws --workspaces-dir <tmp>` 行为与改动前一致。

## 风险 / 回滚点

- 唯一风险：`cli.ts` 删除本地函数后漏改某调用点 → 编译报错兜底（函数不再导出即失效）。逐步改 + build 验证。
- 回滚：单提交整体 revert，逻辑等价无数据风险。

## task.py start 前复查

- [ ] cli.ts 无残留本地 `discoverWorkspaces` / `dedupWorkspaces`
- [ ] artifacts.ts 两函数有真实调用者（grep 非零）
- [ ] MCP tools/list + dispatch + 测试 + 文档四处一致
- [ ] docstring 与实现一致
