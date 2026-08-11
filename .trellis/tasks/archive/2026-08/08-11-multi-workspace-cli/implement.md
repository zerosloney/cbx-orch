# Implement: 多 workspace CLI 调度

## 执行顺序

按 1 → 2 → 3 顺序，每步验证后进入下一步。

---

## Step 1: 导出 summarizeWorkspace（`src/ui.ts`）

**改动**：
1. `interface WorkspaceSummary` → `export interface WorkspaceSummary`（加 `error?: string`）。
2. `async function summarizeWorkspace` → `export async function summarizeWorkspace`。
3. `src/core.ts` barrel 不加（ui.ts 专属）；CLI 直接从 `./ui.js` 导入。

**验证**：
```bash
npm run build
node --test dist/tests/ui.test.js    # /api/workspaces 形状测试仍过（导出不影响行为）
```

---

## Step 2: CLI workspace 解析 + `cbx ws` 子命令（`src/cli.ts`）

**改动**：
1. `resolveWorkspaces(parsed)` 辅助（见 design 2.2）。
2. `cbx ws` 分支：并行 `summarizeWorkspace`，per-ws catch，输出 JSON 或表格。
3. `renderWorkspacesTable`（`src/formatting.ts`）：列 Workspace/Jobs/Active/Queue/Paused/Branch。
4. usage 行加 `ws`。

**验证**：
```bash
npm run build
node --test dist/tests/interfaces.test.js   # CLI 端到端 ws
```

---

## Step 3: `list --all` / `health --all` + 测试 + README/CHANGELOG

**改动**：
1. `cbx list --all`：跨 ws listJobs 合并，`[ws] jobId` 前缀。
2. `cbx health --all`：跨 ws health 汇总。
3. `tests/` 新增/扩展：
   - `resolveWorkspaces` 单测（显式/扫描/默认/去重）
   - CLI e2e：`cbx ws` 双 workspace JSON 形状、`--json`、`list --all` 前缀、单 ws 兼容
4. README 加 `cbx ws`/`--all` 说明；CHANGELOG 记录。

**验证**：
```bash
npm run lint
npm test
npx prettier --check <改动文件>
git diff --check
```

## 回滚点

- Step 1 回滚：revert ui.ts（export 不影响内部使用）。
- Step 2/3 回滚：revert cli.ts + formatting.ts。

## Review Gate

- `summarizeWorkspace` 导出后 Web UI `/api/workspaces` 行为不变（测试验证）
- 跨 ws 查询只读，不触碰任何 workspace 状态
- 单 ws 时 `ws`/`list`/`health` 行为与旧版一致
- 每 ws 独立 catch（一个 ws 失败不拖垮整体汇总，error 字段标识）
