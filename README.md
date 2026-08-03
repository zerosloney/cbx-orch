# CBX Orchestrator (`cbx`)

基于 Node.js + TypeScript 的本地编排器，把任意 AI 编码 CLI（CodeBuddy / OpenCode / Pi 等）固成一条可持久化的流水线：

```text
创建任务 → 执行 → 保存原始日志 → 跑测试 → 生成 diff → 审查 → 必要时返工
```

任务状态、事件流、测试日志、diff、审查报告全部落盘，进程崩溃后仍可恢复与续跑。

## 快速开始

先构建：

```powershell
npm install
npm run build
```

在目标代码仓库中运行（默认执行器为 `codebuddy`）：

```powershell
node C:\path\to\codebuddy-orchestrator\dist\src\cli.js run `
  --workspace . `
  --task "实现用户登录功能" `
  --test "npm test" `
  --timeout-ms 1800000 `
  --max-retries 1 `
  --review
```

指定执行器（例如 OpenCode）：

```powershell
node dist\src\cli.js run --workspace . --executor opencode --task "修复登录 bug" --test "npm test" --review
```

查询任务：

```powershell
node dist\src\cli.js status JOB_ID
node dist\src\cli.js review JOB_ID
node dist\src\cli.js continue JOB_ID --message "修复 review.md 中的问题"
node dist\src\cli.js clean JOB_ID
```

默认任务数据保存在目标仓库的 `.cbx/jobs/<job-id>/`，包括需求、状态、原始事件流、测试日志、diff 和审查报告。

## 执行器

`executor` 决定编排器实际调用哪个编码 CLI。内置 3 个适配器，也可指向自定义 ESM 插件。

| 执行器 | 注册名 / 别名 | 二进制 | 一次性调用 | 安装 | 覆盖 env |
|---|---|---|---|---|---|
| CodeBuddy | `codebuddy` / `cbc` | `codebuddy` | `-p "<prompt>" --output-format stream-json --max-turns N --permission-mode M` | `npm i -g @tencent-ai/codebuddy-code` | `CBX_CODEBUDDY` |
| OpenCode | `opencode` | `opencode` | `run "<prompt>" --format json [--auto]` | `npm i -g opencode-ai` | `CBX_OPENCODE` |
| Pi | `pi` / `oh-my-pi` | `pi` | `-p "<prompt>" --mode json [-a]` | `npm i -g @earendil-works/pi-coding-agent` | `CBX_PI` |

说明：
- `oh-my-pi` 是 Pi 的扩展框架，本身不是独立二进制，因此作为 `pi` 的别名。
- `--auto`（OpenCode）/ `-a`（Pi）仅在 `permissionMode` 为 `auto` 或 `dontAsk` 时追加；`default`/`acceptEdits`/`plan` 不追加，让 CLI 自行按默认权限行事。
- 三个 CLI 都没有 `--max-turns`：OpenCode/Pi 靠 `--timeout-ms` 兜底；CodeBuddy 保留该 flag。
- 通过对应的 env 变量可覆盖二进制路径，常用于测试或指向自定义脚本。
- 自定义插件：`executor` 指向一个 ESM 模块路径，模块导出 `run(request)`，返回 `{ code, output, timedOut }`。示例见 `plugins/example-executor.mjs`。

## 项目配置

在目标仓库根目录放置 `.cbx.json`，命令行参数会覆盖配置文件：

```json
{
  "executor": "codebuddy",
  "testCommand": "npm test",
  "review": true,
  "isolated": true,
  "timeoutMs": 1800000,
  "maxRetries": 1,
  "maxTurns": 50,
  "maxConcurrent": 2,
  "reviewRules": "重点检查鉴权、数据校验和回归测试。",
  "approval": { "beforeRun": true },
  "git": {
    "autoBranch": true,
    "autoCommit": true,
    "commitMessage": "chore: apply task"
  },
  "notifications": {
    "webhook": "https://example.test/cbx-events"
  },
  "telemetry": {
    "enabled": true,
    "endpoint": "http://localhost:4318/v1/traces",
    "serviceName": "cbx-orchestrator"
  }
}
```

任务管理：

```powershell
node dist/src/cli.js list --workspace .
node dist/src/cli.js logs JOB_ID --workspace .
node dist/src/cli.js files JOB_ID --workspace .
node dist/src/cli.js result JOB_ID --workspace .
node dist/src/cli.js approve JOB_ID --workspace .
node dist/src/cli.js queue --workspace .
node dist/src/cli.js queue pause --workspace .
node dist/src/cli.js queue resume --workspace .
node dist/src/cli.js retry JOB_ID --priority 10 --workspace .
node dist/src/cli.js watch JOB_ID --ci --workspace .

# 本地 Web UI / TUI
node dist/src/cli.js ui --workspace . --port 4173
node dist/src/cli.js tui --workspace .

# CI 模式：任务失败时返回非 0 退出码
node dist/src/cli.js run --ci --workspace . --task "实现某功能" --test "npm test"
```

配置了 `approval.beforeRun` 后，任务会先进入 `awaiting_approval`，批准后才启动执行器。

`git.autoCommit` 要求 `isolated` 为 `true`，完成后会在 `cbx/<job-id>` 分支提交修改。

`notifications.webhook` 接收任务状态事件；事件同时会写入 `.cbx/events.ndjson`。启用 `telemetry` 后，任务 span 会写入 `.cbx/telemetry.ndjson`，并按 OTLP/HTTP JSON 发送到配置的 endpoint。

## Executor 插件

`executor` 可以指向一个 ESM 模块。模块导出 `run(request)`，返回 `{ code, output, timedOut }`。示例见 `plugins/example-executor.mjs`：

```json
{ "executor": "./plugins/example-executor.mjs" }
```

## MCP

最小 MCP stdio 适配器，不依赖 MCP SDK：

```powershell
node C:\path\to\codebuddy-orchestrator\dist\src\mcp-server.js
```

提供的工具：`cbx_start`、`cbx_status`、`cbx_review`、`cbx_continue`、`cbx_cancel`、`cbx_approve`、`cbx_list`、`cbx_logs`、`cbx_result`、`cbx_queue`、`cbx_queue_pause`、`cbx_queue_resume`、`cbx_retry`。

MCP 还提供 `resources/list` 和 `resources/read`，可直接读取任务的 `result.json`、`events.ndjson`、`complete.patch`、`review.md` 等产物。

## 安全说明

- 默认权限模式 `auto`。可通过 `--permission-mode` 或配置覆盖；`dontAsk` 需显式 `--dangerously-skip-permissions`。
- 测试命令由用户提供，会在目标工作区执行；不要把不可信输入直接作为测试命令。
- `--isolated` 会创建 Git worktree，避免直接污染主工作区。
- `--timeout-ms` 限制执行器和测试命令的单次执行时间。
- `--max-retries` 控制失败后的自动重试次数，默认 1 次。
- 默认任务完成或失败后清理 isolated worktree；使用 `--keep-worktree` 保留。
- 同一个任务不能并发执行；`cancel` 会终止进程树并留下取消标记。
