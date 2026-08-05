# CBX Orchestrator (`cbx`)

基于 Node.js + TypeScript 的本地编排器，把任意 AI 编码 CLI（CodeBuddy / OpenCode / Pi 等）固成一条可持久化的流水线：

```text
创建任务 → 执行 → 保存原始日志 → 跑测试 → 生成 diff → 审查 → 必要时返工
```

任务状态、事件流、测试日志、diff、审查报告全部落盘，进程崩溃后仍可恢复与续跑。

## 快速开始

全局安装（发布到 npm 后）：

```powershell
npm install -g cbx-orch
```

开发模式（从源码构建）：

```powershell
npm install
npm run build
```

源码仓库不包含 `dist/`；以下 `node .../dist/src/cli.js` 示例均以已经执行上述安装和构建命令为前提。若通过 npm 全局安装，则可直接把 `node .../dist/src/cli.js` 替换为 `cbx`。

在目标代码仓库中运行（默认执行器为 `codebuddy`）：

```powershell
node C:\path\to\cbx-orch\dist\src\cli.js run `
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

`executor` 决定编排器实际调用哪个编码 CLI。内置 4 个适配器，也可指向自定义 ESM 插件。

| 执行器    | 注册名 / 别名     | 二进制      | 一次性调用                                                                    | 安装                                       | 覆盖 env        |
| --------- | ----------------- | ----------- | ----------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| CodeBuddy | `codebuddy` / `cbc` | `codebuddy` | `-p "<prompt>" --output-format stream-json --max-turns N --permission-mode M` | `npm i -g @tencent-ai/codebuddy-code`      | `CBX_CODEBUDDY` |
| OpenCode  | `opencode`        | `opencode`  | `run "<prompt>" --format json [--auto]`                                       | `npm i -g opencode-ai`                     | `CBX_OPENCODE`  |
| Oh My Pi  | `omp` / `oh-my-pi` | `omp`       | `-p "<prompt>" --mode json`                                                   | `npm i -g @oh-my-pi/pi-coding-agent`       | `CBX_OMP`       |
| Cline     | `cline`           | `cline`     | `--json "<prompt>" [--auto-approve true]`                                     | `npm i -g cline`                           | `CBX_CLINE`     |

说明：

- `oh-my-pi` 是 Oh My Pi 的扩展框架，本身不是独立二进制，因此作为 `omp` 的别名。
- `--auto`（OpenCode）/ `--auto-approve true`（Cline）仅在 `permissionMode` 为 `auto` 或 `dontAsk` 时追加；`default`/`acceptEdits`/`plan` 不追加，让 CLI 自行按默认权限行事。
- Oh My Pi 的 CLI 文档未公开权限/放行 flag，因此当前不追加任何权限参数，由 omp 非交互 `-p` 默认行为决定；待其暴露后补齐。
- Cline 在 headless 模式默认 `auto-approve=true`；`default`/`acceptEdits`/`plan` 模式下不显式追加，沿用 Cline 默认行为，避免 headless 卡死。
- 四个 CLI 中只有 CodeBuddy 保留 `--max-turns`；其余靠 `--timeout-ms` 兜底。
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
  "execution": { "trustMode": "trusted" },
  "notifications": {
    "webhook": "https://example.test/cbx-events",
    "timeoutMs": 3000,
    "maxRetries": 2,
    "retryBaseMs": 100
  },
  "telemetry": {
    "enabled": true,
    "endpoint": "http://localhost:4318/v1/traces",
    "serviceName": "cbx-orchestrator"
  },
  "governance": {
    "retentionDays": 30,
    "redactFields": ["token", "password", "authorization"]
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

# 单次调度：回收死 worker 并启动排队任务
node dist/src/cli.js dispatch --workspace .

# 常驻调度器：启动时回收死 worker，随后按间隔调度；SIGINT/SIGTERM 会停止调度器
node dist/src/cli.js serve --workspace . --interval-ms 30000

# 不含任务正文的健康与运行指标
node dist/src/cli.js health --workspace .
```

`continue` 默认将任务重新入队（后台执行）。加 `--foreground` 走前台同步语义（阻塞至完成）。

配置了 `approval.beforeRun` 后，任务会先进入 `awaiting_approval`，批准后才启动执行器。

`git.autoCommit` 要求 `isolated` 为 `true`，完成后会在 `cbx/<job-id>` 分支提交修改。

后台 worker 是 detached 进程。可使用常驻 `serve` 监护队列；它启动时会回收死 worker，仍可用 `dispatch` 供 cron/计划任务执行。

`notifications.webhook` 接收任务状态事件；事件同时会写入 `.cbx/events.ndjson`。webhook 和 OTLP 都支持 `timeoutMs`、`maxRetries`、`retryBaseMs`，非 2xx 会失败并有限指数退避；最终失败会落到 `.cbx/delivery-failures.ndjson`，不会无限阻塞状态写入。启用 `telemetry` 后，任务 span 会写入 `.cbx/telemetry.ndjson`，并按 OTLP/HTTP JSON 发送到配置的 endpoint。

任务状态、队列和通知死信的权威数据存储在 `.cbx/state.sqlite`（WAL 模式、版本化 migration）；首次访问会无损导入旧的 `.cbx/jobs/*/state.json`、`queue.json` 和 `delivery-failures.ndjson`。这些 JSON/NDJSON artifact 会继续保留以便人工查看，但不再作为调度一致性的依据；worker 终态与对应队列条目、以及 retry 的状态重置与重新入队，均在同一 SQLite transaction 提交。常驻 `serve` 使用工作区单实例租约，发现另一个存活实例会拒绝启动。`/healthz` 与 `/api/metrics`、以及 `cbx health` 返回队列深度、任务状态计数、失败/重试与死信计数，且不包含任务正文。

## Executor 插件

`executor` 可以指向一个 ESM 模块。插件应导出版本化 `manifest` 和 `run(request)`；manifest 使用 `cbx.executor/v1`，包含 `name`、`version` 和最小能力声明（例如 `execute`）。示例见 `plugins/example-executor.mjs`：

```json
{ "executor": "./plugins/example-executor.mjs" }
```

默认兼容历史的仅 `run` 插件。生产环境可启用严格治理：`plugins.enforce=true` 时必须为插件配置 `allowPaths` 或 `allowSha256`，并且每个已配置的 allowlist 都必须匹配；缺少 manifest、未批准路径或摘要都会被拒绝。任务事件只记录内置适配器来源/版本，或插件名称、版本、能力和 SHA-256，不记录环境变量值。

```json
{
  "plugins": {
    "enforce": true,
    "allowPaths": ["./plugins/example-executor.mjs"],
    "allowSha256": ["replace-with-64-hex-character-sha256"]
  }
}
```

## 质量与发布

`npm run check` 执行类型 lint、格式检查和测试；`npm run coverage` 运行 Node 测试覆盖率；`npm run audit` 检查高危依赖问题；`npm run sbom` 生成 CycloneDX SBOM。CI 在 Node 20、22 和 24 上执行这些确定性检查并上传测试、覆盖率和 SBOM 工件。

发布遵循 Semantic Versioning。源码仓库不跟踪 `dist/`；推送 `v*` tag 后，`.github/workflows/publish.yml` 会从源码构建它、运行测试，并用 `npm pack --dry-run` 校验待发布包确实包含 `dist/src/cli.js`，然后才发布到 npm（需在仓库 Secrets 配置 `NPM_TOKEN`）。`package.json.files` 仍明确限定 npm 包内容为 `dist/` 和文档，不包含源码与测试；`private` 已设为 `false`。

## MCP

最小 MCP stdio 适配器，不依赖 MCP SDK。安装 CLI 后直接调用子命令：

```powershell
cbx mcp
```

提供的工具：`cbx_start`、`cbx_status`、`cbx_review`、`cbx_continue`、`cbx_artifact`、`cbx_cancel`、`cbx_approve`、`cbx_list`、`cbx_logs`、`cbx_result`、`cbx_queue`、`cbx_queue_pause`、`cbx_queue_resume`、`cbx_retry`。

MCP 还提供 `resources/list` 和 `resources/read`，可直接读取任务的 `result.json`、`events.ndjson`、`complete.patch`、`review.md` 等产物。

非平凡任务可在 `cbx_start` 中传结构化 `task_contract`（目标、验收标准、非目标、约束、相关文件、决策与假设）。执行器会先生成 `understanding.json`；存在阻塞问题时任务以 `needs_fix / awaiting_clarification` 暂停。创建任务时还会记录 Git commit、branch、dirty 状态及 dirty 内容指纹。`isolated: true` 且创建基线包含未提交内容时，任务会在创建 worktree 前以 `needs_fix / dirty_baseline` 暂停，避免未提交内容被静默遗漏；请先提交或清理这些内容，确认当前基线符合预期后再以 `refresh_baseline: true` 继续。隔离 worktree 随后固定从确认过的 commit 创建。非隔离任务仅在 HEAD 或 dirty 内容指纹相对创建基线发生漂移时暂停，dirty 内容未变时可正常执行。`review_executor` 可指定独立审查 CLI，默认仍沿用 `executor`。

`result.json` 包含 changed files、handback、测试与验收摘要、基线信息及 artifact SHA-256。最终交付仍应通过 `cbx_artifact` 或 MCP resources 读取并核对 `handback.md`、`complete.patch`、`test.log` 和 `review.md`，不要只根据状态元数据总结。

## ZCode 插件

cbx 本身就是一个 ZCode 市场插件（仓库根含 `.zcode-plugin/plugin.json`、`commands/`、`skills/`）。安装后自动注册 cbx MCP server，并提供斜杠命令和技能，无需手写 MCP 配置。

### 安装

```powershell
# 1. 全局安装 cbx CLI（提供 cbx / cbx mcp 命令，依赖由 npm 自动解析）
npm install -g cbx-orch

# 2. 添加本仓库为市场源
zcode plugin marketplace add zerosloney/cbx-orch

# 3. 安装 cbx-orch 插件
zcode plugin install cbx-orch@cbx-orch-marketplace
```

安装后重启 ZCode 会话，插件 manifest 会调用全局安装的 `cbx mcp`，将 MCP server 自动以 `cbx` 名注册；工具暴露为 `mcp__cbx__cbx_*`。因此仅 clone 或安装插件目录并不足以启动 MCP，必须先确保全局 `cbx` 命令可用。

### 斜杠命令

| 命令                               | 作用                                                |
| ---------------------------------- | --------------------------------------------------- |
| `/cbx-run [task]`                  | 委派任务到 cbx，后台执行（含测试+审查），轮询至完成 |
| `/cbx-status [job_id]`             | 查任务状态/阶段/尝试                                |
| `/cbx-continue [job_id] [message]` | 按 review.md 或测试失败返工                         |
| `/cbx-list`                        | 列出当前工作区所有任务                              |
| `/cbx-queue [pause\|resume]`       | 查看或控制任务队列                                  |

### 技能

`cbx-orchestration` 技能文档（`skills/cbx-orchestration/SKILL.md`）指导 agent 何时用 cbx、如何选执行器、隔离策略。

### 用户配置

插件安装后，在 ZCode 设置中可配置（对应 `userConfig`）：

| 配置项     | 默认值      | 作用                                          |
| ---------- | ----------- | --------------------------------------------- |
| `executor` | `codebuddy` | 默认执行器：`codebuddy`/`opencode`/`omp`/`cline` |
| `review`   | `true`      | 测试通过后是否跑独立审查                      |
| `isolated` | `true`      | 是否在 git worktree 中隔离执行                |

### 工作区定位

插件通过 `CBX_WORKSPACE=${CLAUDE_PROJECT_DIR}` 把当前项目目录注入 cbx MCP server。调 `cbx_*` 工具时无需传 `workspace` 参数，默认即当前项目。

### 前置依赖

npm 发布包包含可直接运行的 `dist/` 编译产物；源码仓库不跟踪该目录。自行 clone 源码后，需先执行 `npm install && npm run build` 生成 `dist/`。还需至少安装一个执行器 CLI（codebuddy/opencode/omp/cline 之一）才能真正执行任务。

## 安全说明

- 默认权限模式 `auto`。可通过 `--permission-mode` 或配置覆盖；`dontAsk` 需显式 `--dangerously-skip-permissions`。
- 测试命令由用户提供，会在目标工作区执行。cbx 只做有限黑名单过滤（正则可被变体绕过），**不保证命令安全**。建议始终用 `--isolated` 让测试在 worktree 内跑；非隔离时 cbx 会输出告警。
- Web UI / TUI 仅绑定本机回环（127.0.0.1/::1），**不提供任何鉴权**。本机其他进程或浏览器仍可访问。远程共享必须放在带认证的反向代理之后。
- `--isolated` 会创建 Git worktree，避免直接污染主工作区；**它不是 OS 安全沙箱**，不会隔离网络、凭据、宿主机文件或进程。
- 默认 `execution.trustMode` 是 `trusted`。`untrusted` 任务需要 OS 容器沙箱；当前 cbx 没有内置容器 runner，因此会明确拒绝启动该模式。可通过 `--trust-mode trusted|untrusted` 覆盖配置。
- `.cbx.json` 是严格 schema：未知字段、错误类型和越界值会拒绝加载，避免策略拼写错误静默失效。`governance.redactFields` 会递归脱敏事件、webhook 和死信中的同名字段；`governance.retentionDays` 会在状态更新和健康检查时原子压缩 `.cbx/delivery-failures.ndjson`，并同步清理过期 SQLite 死信记录。
- `--timeout-ms` 限制执行器和测试命令的单次执行时间。
- `--max-retries` 控制失败后的自动重试次数，默认 1 次。
- 默认任务完成或失败后清理 isolated worktree；使用 `--keep-worktree` 保留。
- 同一个任务不能并发执行；`cancel` 会终止进程树并留下取消标记。
