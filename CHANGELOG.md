# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible behavior changes, security fixes, and migration requirements are recorded here before a release.

## 0.11.0 — 2026-08-09

## Unreleased

- Feature: 任务批处理 `cbx batch`。`--task`/`--task-file` 可重复（可混用）批量创建独立任务；run 选项（executor/review/isolated 等）透传。`--max-batch N` 波次分片入队（波间等上一波终态，不改变全局 maxConcurrent），默认 0 一次全量。`--wait` 等待全部终态输出成功/失败计数，超时（`--wait-timeout-ms`）返回未完成列表并以非零退出；批任务 job 与普通任务同构（可独立 retry/continue）。jobId 前缀 `batch-<ts>-<seq>`。
- Test: `tests/batch.test.ts`（chunkBatch 分片边界 3 例 + summarizeBatch 聚合 3 例 + CLI 端到端 4 例：多任务创建/无任务报错/--max-batch 1 波次 --wait 汇总/runBatch 直接调用）。总计 424 个测试全过。

- Feature: webhook 事件订阅细分。`.cbx.json` `notifications.filters`（可选 `events`/`jobIds`/`statuses` 字符串数组）按 AND 语义过滤 webhook 投递：`events` 匹配事件 type、`jobIds` 匹配 payload.jobId、`statuses` 匹配 payload.status，未配置维度不限制；payload 字段缺失视为不匹配。不匹配事件不入 outbox（本地 events.ndjson 仍全量）；无 filters 时行为不变。strict schema：未知 filters 键/空数组/错类型拒绝。
- Test: `matchesWebhookFilters` 单测 6 例（无 filters 全量/各维度匹配与缺失/AND 语义）+ `publishEvent` 过滤集成（不匹配无 pending delivery、本地 events 全量）+ config schema 4 例。总计 421 个测试全过。

- Feature: TUI 事件流面板。选中任务在详情下方显示最近 5 条事件（时间 + 类型着色，`job.state_changed` 显示状态），经 `readEventsIncremental` 增量游标拉取，不重读全量；并入详情行数计算保持小屏防溢出。
- Feature: 任务模板。`.cbx.json` 新增 `templates`（strict schema：`task` 必填非空，可选 `test`/`review`/`executor`/`isolated`，未知键拒绝）。CLI `cbx run/start --template <name>` 展开模板，优先级：命令行显式参数 > 模板值 > 配置默认值；模板不存在报错并列出可用名。
- Feature: 任务结果导出。`cbx export <jobId> [--format text|markdown]` 输出任务摘要（状态/阶段/stage 链/验收证据/handback 截断）；无 result.json 时降级输出基本状态。
- Test: `tests/tui.test.ts`/`tests/ui.test.ts` 增补 TUI 事件流（种子事件端到端）；`tests/core.executor.test.ts` 增补 templates schema（接受/缺 task/未知键/错类型）+ CLI `--template` 展开；`tests/hardening.test.ts` 增补 export text/markdown/降级。总计 414 个测试全过。

- Feature: TUI 控制面补齐。新增 `a` 批准（awaiting_approval 任务，批准后 queued 自动 startBackground）、`y` 重试（失败终态）、`n` 继续（needs_fix/review_failed）；每个键按选中任务状态过滤，不匹配或无选中则忽略。详情面板扩展：选中任务显示 stage 链（name/executor/verdict，PASS/FAIL/skip 着色，来自 result.json.stages）与阶段时间线摘要（当前阶段/已跑秒数，复用 `buildTimeline`），数据为服务端投影。
- Feature: MCP 新增 `cbx_clean` 工具（清理任务遗留 Git worktree，对应 CLI `cbx clean`）。响应 `{ job_id, cleaned: boolean }`，无 worktree 记录幂等返回 `cleaned:false` 不抛错。
- Test: `tests/tui.test.ts` 增补 approve/retry/continue 键位状态过滤断言（4 例）+ renderDetailPane 带 timeline/stages 渲染断言（4 例）；`tests/mcp-migration.test.ts` 增补 cbx_clean 幂等行为与工具清单断言。总计 409 个测试全过。

- Feature: Web UI 写操作。新增 POST 端点 `POST /api/jobs/:id/approve|cancel|retry|continue` 与 `POST /api/queue/pause|resume`（与 CLI/MCP 语义一致，continue 支持 `message`/`priority`/`refresh_baseline`/`extra_rounds` 参数，非法 `extra_rounds` 报 400）。任务详情面板按状态显示操作按钮（awaiting_approval→批准；运行/排队→取消；失败终态→重试/继续），队列卡片旁新增暂停/恢复按钮。写操作经 HttpOnly cookie 或 Bearer 鉴权，SameSite=Strict 阻止跨站携带。
- Feature: Web UI token 鉴权加固。token 从 HTML 内嵌 `window.CBX_TOKEN` + SSE `?token=` 查询串改为 `cbx_token` HttpOnly cookie（SameSite=Strict，同源请求自动携带，JS/XSS 不可读、不出现在 URL）；curl/API 客户端仍支持 Bearer header，SSE 兼容旧客户端保留 query token。
- Feature: TUI 队列操作。`p` 暂停队列 / `u` 恢复队列 / `x` 取消选中任务（空选中忽略），状态栏与操作提示同步。
- Refactor: 新增 `captureAsync`（异步进程捕获）。Web UI `summarizeWorkspace` 与 TUI 轮询的 git 调用改异步，不再阻塞 SSE 心跳与键盘响应；worker 进程内 git-ops 保持同步（单用途进程，阻塞无副作用）。
- Test: 新增 `tests/ui-frontend.test.ts`（6 例：app.js 的 esc/fmtElapsed/totalJobs/rowAttr/rowHtml/updateCards，node:vm 沙箱注入 DOM 桩）；`tests/ui.test.ts` 增补 POST 写操作端到端（cancel/retry/pause/resume/continue/鉴权）；`tests/hardening.test.ts` 增补 `captureAsync` 覆盖（成功/非零退出/stderr/命令缺失）。
- Refactor: MCP 响应形状统一。`cbx_logs` 恒返回 `{job_id, events, next_offset}`（不再因 `since` 分叉为 `{logs}` 与 `{events}`）；`cbx_review` 缺文件改走 JSON-RPC error（与 `cbx_artifact`/`cbx_result` 一致，不吞异常）。
- Fix: approval 隔离任务 worktree 守卫显式化。`snapshotDiff` 经 `workdir !== undefined && existsSync(workdir)` 窄化消除 `!` 断言；`commitWorktree` 前增加显式不变量守卫。

- Refactor: JobState 补齐显式可选字段类型（error/retryReason/testExitCode/reviewVerdict/adaptiveRound/stages 等 30+ 字段），消除 5 处 `as` 强制转换；`evidence.ts` 循环导入修复（`core.js` → `types.js`）；移除 `cli.ts` 4 处死代码 `?? 0`（`intOption` 已带默认值）。
- Refactor: 保留期清理（`prunePersistedData`）从每次 `writeState` / `saveStateAndQueue` 调用移出，收敛到任务终态路径——`executeJob`（含早退基线漂移/取消分支）、`approveJob` 与 `cancelJob` 各执行一次，消除高频状态写入时的配置重载与 DB 扫描开销。
- Test: 新增 `tests/mcp-migration.test.ts`（10 例：MCP JSON-RPC initialize/ping/tools-list/cbx_status/cbx_list/cbx_cancel/unknown-method/notification 无响应 + SQLite 未来版本拒绝降级/当前版本正常接受），总计 385 个测试全过。

- Feature: SSE 事件 Last-Event-ID 回放。`publishEvent` 为每个事件分配 workspace 内单调递增的 `seq`（持久化于 SQLite `metadata` 表，进程重启后续编）。Web UI `/events` 端点支持标准 `Last-Event-ID` 头与 `?last_event_id=` query 参数：新客户端连接时自动回放 `seq > lastEventId` 的历史事件（上限默认 1000 条，超限发 `replay_truncated` 警告并只补最近 N 条）。EventSource 断线重连自动携带 lastEventId，无需前端改动。无 lastEventId 时行为不变（只推新事件）。旧格式事件（无 seq 字段）被跳过。
- Feature: 上下文包 token 计量与 per-role 预算裁剪。`context-pack.ts` 新增 `estimateTokens`（启发式：ASCII ≈ chars/4，CJK ≈ chars/1.5，零依赖）与 `ContextBudget`（默认 manager 6000 / executor 8000 / auditor 8000 tokens）。超预算时按优先级裁剪 taskContract 低优先字段（assumptions/rejectedOptions/decisions → constraints/relevantFiles → nonGoals；goal + acceptanceCriteria + stages 永不裁剪），再裁 recentFailure.retryReason，再收缩 userInstructions。触发裁剪时 pack 标记 `truncated: true` 并记录 `estimatedTokens`。`.cbx.json` 可经 `context.tokenBudget.{manager,executor,auditor}` 覆盖默认值（最小 100）。既有 24K char 硬上限仍生效。
- Feature: stage 依赖声明（dependsOn）与失败传播。`taskContract.stages[].dependsOn` 接受前置 stage name 数组；`normalizeTaskContract` 校验悬空依赖（引用不存在的 name）与循环依赖（DFS 三色标记）。执行时前置 stage 进入失败终态（FAIL / 非零退出）后，后继 stage 标记 skipped 而非执行，并记 `stage_skipped` 事件。handback 注入改为聚合所有 dependsOn stage 的交接文档（依赖模式）或沿用上一阶段 handback（线性模式）。`groupStagesByDependency` 导出为工具函数供未来并行执行使用；当前层内仍串行（单 worktree 安全）。Adaptive 模式 Manager 返回的 stage 同样支持 dependsOn。
- Feature: Adaptive Manager done 决策缓存。Manager 返回 done 但结构化证据门未通过时，若已有执行过的 stage，下一轮跳过 Manager 调用直接重试证据门（省一次 executor spawn）；连续跳过上限 2 次后强制重新调用 Manager 防卡死。任意非 done 决策（execute/ask/blocked）重置缓存计数。无已执行 stage 时 done 直接返回 needs_fix（无修复材料，不空转）。
- Test: 新增 `tests/events-replay.test.ts`（8 例：seq 单调递增/跨重启持久化、Last-Event-ID 回放/id 字段/maxReplayLines 截断/跳过无 seq 旧事件/缺失文件兜底）、`tests/context-budget.test.ts`（13 例：estimateTokens ASCII/CJK/混合、预算内不裁剪、超预算裁剪低优先字段/userInstructions 收缩/retryReason 清空、parseContextPack 接受新字段/拒绝非法类型/24K 硬上限）、`tests/stage-dependencies.test.ts`（16 例：groupStagesByDependency 单层/线性/菱形/多根、validateStageDependencies 悬空/循环/自依赖、normalizeTaskContract dependsOn 透传/去重/空数组/非字符串/未知字段）。总计 180 个测试全过。
- Feature: Adaptive 模式。`adaptive.enabled=true` 后由独立 manager executor 每轮产出 `candidate.json`（`execute`/`ask`/`blocked`/`done` 决策），编排器据此跑 stage 链并执行结构化完成门；超出 `maxRounds` 触发 `needs_fix / adaptive_max_rounds` Human Gate，可用 `--extra-rounds`（或 MCP `extra_rounds`，1–100）续跑。CLI：`--adaptive` / `--no-adaptive` / `--adaptive-max-rounds N` / `--manager-executor <cli>`；`.cbx.json`：`adaptive`（`enabled`/`maxRounds`/`managerExecutor`，maxRounds 默认 8，上限 100）；MCP `cbx_start` 同名 `adaptive` 对象（snake_case：`max_rounds`/`manager_executor`）。`adaptive.enabled=true` 要求 `review=true`。
- Feature: 完成前审批门 `approval.beforeComplete`。证据门通过后任务停在 `awaiting_approval / before_complete`（`pendingCompletion` 含工件 SHA-256 快照），批准才落 `done`。CLI：`--approval-before-complete` / `--no-approval-before-complete`；MCP `cbx_start`：`approval_before_complete`。批准入口同 `cbx approve`。
- Feature: 智能重试双计数器。`maxRetries` 拆为执行器崩溃预算 `executionRetries = maxRetries+1` 与测试/审查失败修复预算 `fixRetries = maxRetries`，两计数器独立计数，避免 `needs_fix` 场景每轮都白耗一次执行器重试。根因收敛在 `runStage` 共享循环，调用方与 `--max-retries` 语义不变。
- Feature: 依赖守卫。`dependencyGuard=true` 时在 stage 执行前后对 `package.json`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`bun.lockb` 取 SHA-256 baseline 比对，未授权改动触发 `needs_fix / dependency_guard`。CLI：`--dependency-guard` / `--no-dependency-guard`；`.cbx.json`：`dependencyGuard`（默认 false）；旧 job 续跑时从 `.cbx.json` 同步该字段进持久化 context。
- Feature: Human Gate 统一持久化。所有人工等待统一为 `humanGate` 状态（version 1，reason ∈ `before_run`/`needs_input`/`semantic_conflict`/`repeated_failure`/`max_rounds`/`completion`，status ∈ `waiting`/`resolved`），写入 `state.json` 与 `result.json`。连续 3 次同根因失败自动升 `needs_fix / repeated_failure`。
- Feature: 新增 phase（影响 `cbx_status` 返回与 agent 决策树）：`verification_gate`（完成门未过）、`repeated_failure`（3 次同根因）、`context_handshake`（understanding.json 失败）、`before_complete` / `completion_evidence_stale`（完成审批门）、`adaptive_state` / `adaptive_manager[_next|_decision|_safety]` / `adaptive_ask` / `adaptive_blocked` / `adaptive_max_rounds`、`dependency_guard`。
- Fix: `cbx approve` 仅在状态为 `queued` 时才 `startBackground`，避免重复拉起已运行/已终态任务（CLI 与 MCP 路径一致）。
- Docs: README 补 `adaptive` / `dependencyGuard` / `approval.beforeComplete` 配置与 CLI flag、修正 `--max-retries` 双计数器语义、补 dependency guard 安全说明；SKILL.md 新增 Adaptive 章节、扩展 Job status decision tree 覆盖全部新 phase、补 `extra_rounds` / `approval_before_complete` / `adaptive` 参数；commands/cbx-run.md 补 `awaiting_approval` 终态与新参数；commands/cbx-continue.md 补 `extra_rounds`。
- Feature: Web UI 多 workspace 模式。`cbx ui --workspace A --workspace B` 或 `cbx ui --workspaces-dir <dir>` 扫描根目录下所有含 `.cbx/` 的子目录,一个 UI 跨多个项目。Dashboard 顶部 6 个卡片(总任务 / 运行中-并发 / 失败 / 队列 / 最后活动 / 健康),多 workspace 时显示 workspace 列表与状态点。
- Feature: Web UI 任务详情面板升级为 6 个 tab(概览 / 阶段时间线 / 执行器 / Diff / Test / Review),执行器 tab 显示 PID 脉冲灯、心跳、已跑时间和 `process_started` 命令,并附 agent.log 尾部。
- Feature: Web UI 任务行新增 Elapsed 列,非终态任务从 `createdAt` 实时计算(每秒刷新),终态显示 `totalSeconds`。
- Feature: Web UI 新增 3 个 HTTP 接口 —— `GET /api/workspaces`(所有 workspace 状态摘要)、`GET /api/jobs/:id/timeline`(从 events.ndjson 推导阶段时间线)、`GET /api/jobs/:id/executor`(PID/heartbeat/命令)、`GET /api/jobs/:id/agent.log?since=0`(增量读取,默认 256KB 截断)。
- Test: 新增 `tests/ui.test.ts`(5 个 case 覆盖 buildTimeline / readExecutorStatus / readAgentLogIncremental);`tests/interfaces.test.ts` 增补 1 个 detail API 端到端测试,90 个测试全过。
- Refactor: 将 1,157 行的 `core.ts` 拆分为 13 个职责单一的模块（`types`/`state`/`jobs`/`artifacts`/`result`/`runner`/`baseline`/`stage-runner`/`execution`/`approval`/`lifecycle`/`queue-api`/`worktree`），无循环依赖；`core.ts` 保留为 re-export barrel，公共 API 完全向后兼容。
- Feature: Web UI token 鉴权。`--ui-token <token>` 或 `.cbx.json` `ui.token` 启用 Bearer token 认证；API 端点需 `Authorization: Bearer` 请求头，SSE 支持 `?token=` 查询参数；`/healthz` 与 `/` 首页保持开放。未配置 token 时行为不变。
- Test: 新增 5 个集成测试（Web UI token 鉴权、无 token 开放访问、mock executor 端到端执行、多阶段任务 stage reports、任务取消），总计 122 个测试。
- Fix: 队列写入统一锁。调度器整 blob 写回与 worker 终态双写（`writeState` / `writeApprovalState` 携带 `queueEntryId` 的路径）现共用 storage 层新增的 `queueLockFile` / `withQueueLock`（唯一锁来源，queue.ts 本地实现删除），消除终态条目被旧调度快照整 blob 覆盖而倒退（如 `awaiting_approval` 退回 `queued`）且无自愈的 lost-update；终态双写锁重试提升至 120 次以覆盖长 dispatch 持锁窗口。
- Fix: 死 worker 回收新增熔断。队列条目记录 `reclaimCount`，同一 job 被回收重派超过 3 次后置为 `failed`（提示检查任务状态后用 `retry` 手动重跑）并落 `queue_reclaim_circuit_breaker` 事件，避免状态永久损坏的任务在"派发—失活—回收"间无限循环。
- Fix: `importLegacyData` 改为先异步收集再单事务原子提交（jobs INSERT OR IGNORE + failures + `legacy_import_v1` 标记）；损坏的 `state.json` / `delivery-failures.ndjson` 记录跳过并留痕而非致命抛出，导入不再把整个 workspace 锁在迁移中间态，重复导入保持幂等。
- Fix: `validateTestCommand` 注入防线收紧：拦截换行/回车、反引号、`$(` 命令替换，以及 `rm` 带 `-r`/`-f` 系列短选项或 `--recursive`/`--force` 长选项、`rd /s`、`rmdir /s`、`Remove-Item`、`del /s`、`deltree`、`format`、PowerShell `-enc`/`-encodedcommand` 编码执行等破坏性变体。
- Fix: executor 指向插件文件但 `plugins.enforce` 未启用时，启动前输出显著告警并向 job 目录 `events.ndjson` 追加 `plugin_policy_warning` 审计事件（含插件路径与 SHA-256）；此前插件可在无路径/SHA 白名单校验的情况下被静默加载。配置 `enforce=true` 且白名单通过时不告警。
- Test: 新增 `tests/reliability.test.ts`（6 个用例：testCommand 注入矩阵、回收未超阈值续派、熔断超阈值置 failed、终态写与 dispatch 扫描并发不互踩、legacy 导入跳过损坏记录且幂等、插件策略告警触发/抑制），总计 128 个测试。
- Refactor: 统一 CLI 参数解析。新增 `src/cli-args.ts` 一次解析分离位置参数与选项，消除 `args[0]` 位置依赖——`cbx status --workspace X <jobId>` 这类选项在前的调用不再把选项误当 jobId；需要 jobId 的子命令统一经 `requireJobId` 取首个位置参数，缺失时报明确用法提示；新增支持 `--option=value` 与 `--` 分隔符，`queue pause/resume` 子命令也改从位置参数判定。既有调用形式全部向后兼容；唯一收紧：带值选项（如 `--workspace`）缺值时报明确错误而非静默走默认值。
- Refactor: 引入统一错误类型 `CbxError` 与错误码（`E_INVALID_JOB_ID` / `E_ARTIFACT_FORBIDDEN` / `E_INVALID_CONTEXT` / `E_LOCK_BUSY` / `E_QUEUE_BUSY`，见 `src/errors.ts`），控制流改为按错误码判定：队列锁忙降级（queue.ts）与 Web UI HTTP 状态映射（403/400）不再匹配错误消息子串；面向用户的文案与既有测试断言保持不变，`core.ts` barrel 导出 `CbxError` / `isCbxError`。
- Fix: `context.json` 加载增加 schema 校验（`loadJobContext` / `validateJobContext`）：核心必填字段（appVersion/jobId/workspace/createdAt/permissionMode/executor、reviewRequested/isolated、maxTurns/timeoutMs/maxRetries）缺失或类型错误即抛 `E_INVALID_CONTEXT`，不再让半损坏上下文进入执行循环；新增字段（trustMode/executionRetries/fixRetries/approval* 等）存在时做类型检查但不强制，保持旧 job 跨版本续跑不硬阻断（消费方均有 `??` 兜底）；未知字段容忍以兼容后续版本。approval/baseline/execution/result/updateJobContext 五个读写点统一走校验入口。
- Fix: 随机数与凭据比较加固。queueId 与 jobId 兜底生成从 `Math.random()` 统一为 `crypto.randomBytes`；Web UI Bearer/query token 校验改为 SHA-256 + `timingSafeEqual` 常量时间比较，消除 `===` 逐字节短路的时序侧信道。
- Test: 新增 `tests/hardening.test.ts`（10 个用例：CLI 解析单元与端到端位置参数、错误码稳定性、队列锁忙 `E_QUEUE_BUSY`、context schema 接受/拒绝、redactText 三种键行形态与正则兜底、staleLock 存活/死 pid/损坏记录分支、git-ops 超 200KB 未跟踪文件截断、crypto 随机数与常量时间比较），总计 138 个测试。
- Repo: `npm run coverage` 增加最低覆盖率门槛。`scripts/check-coverage.mjs` 运行全量测试后解析覆盖率报告 `all files` 行并校验 lines ≥ 70% / branch ≥ 51% / functions ≥ 74%，低于门槛即失败；采用脚本解析而非高版本 Node 专属 flag，CI 矩阵最低的 Node 20 同样可用。README 质量章节同步说明。

## 0.10.2 - 2026-08-06

- Fix: 以 `package.json` 作为运行时和 MCP 版本的唯一来源，并同步 Claude Code、ZCode 与 marketplace manifest，避免补丁版本发布漂移。
- Fix: 取消任务会等待进程树退出，必要时升级为强制终止，只有确认退出后才清理 worktree 并写入 `cancelled`。
- Fix: 子进程输出完整流式落盘、内存仅保留有界尾部，避免长任务输出耗尽编排器内存。
- Fix: webhook 与 OTLP 改为 SQLite durable outbox 异步投递；状态写入不再等待网络重试。
- Fix: `serve` 租约支持续期和 fencing token，worker heartbeat 周期更新并按时间判定失活。

## 0.10.1 - 2026-08-06

- Fix: approval gate 的 job 状态与队列终态在同一 SQLite transaction 中提交，避免后台批准任务被重复拉起。
- Fix: executor 插件在执行顶层代码前校验 allowlist 和预期 SHA-256，关闭插件内容替换窗口。

## 0.10.0 - 2026-08-06

- Feature: 新增 `cbx stop-review-gate` 子命令作为 Stop hook 入口，复用 `stopReviewGateHook`（检查 `reviewGate.enabled` / 读 stdin 的 cwd / 输出 decision / 永不非 0 退出的 fail-open 契约）。`hooks/hooks.json` 从 `node "${CLAUDE_PLUGIN_ROOT}/dist/src/hooks/stop-review-gate.js"` 改为 `cbx stop-review-gate`，不再依赖被 gitignore 排除的 dist 目录 —— 从 GitHub 源码安装插件时 Stop hook 不再失效。配套删除孤儿 `src/hooks/stop-review-gate.ts`。
- Fix: `stopReviewGateHook` 的 `shouldRunGate` 原在 try 块外，`.cbx.json` 含非法字段时 `loadConfig` 抛异常会逃逸为 `exitCode=1`，破坏 fail-open 放行契约；现纳入 try 块，配置异常也走放行。
- Fix: `createJob` 现在校验 SQLite 中是否已存在同 jobId 记录；legacy 导入后用户手清 `.cbx/jobs/<id>/` 目录但 SQLite 记录仍在时，同 jobId 不再静默覆盖旧任务状态。
- Fix: `retryQueueJob` 删除外层 20×50ms busy-wait，改为单个 `withQueueLock` 事务内原子完成"老 entry 标 cancelled + 插新 entry + 状态重置"；消除 dispatch 锁竞争时新老 entry 并存的漂移窗口。
- Fix: 队列终态状态映射（done/cancelled/awaiting_approval/else→failed）收敛到 storage 层 `savePersistedStateAndFinishQueue` 单一来源；`finishQueueEntry` 不再持有映射副本，避免新增终态时两处分叉。
- Fix: `dispatchQueue` 回收死 worker 增加双重校验——pid 不存活 OR 有 pid 但无 `worker.heartbeat` 且 `startedAt` 超 60s grace，视为僵尸（pid 复用 / spawn ENOENT 后 pid 被复用）并回收；queue worker 起步（`cli.ts run --queue-entry-id`）写入 `worker.heartbeat`。
- Fix: Windows 下超时/取消的进程终止增加兜底（taskkill 找不到 node 子进程时回退到 TerminateProcess），避免超时的执行器继续运行并改动工作区；`cancelJob` 与 `--timeout-ms` 共用同一修复。
- Fix: 取消排队中的任务现在会同步把对应队列条目标记为 `cancelled`，`executeJob` 不再为已取消任务清除标记后启动；`continue`/`retry` 作为显式重跑入口会在入队时清除取消标记。
- Fix: `stage-*-handback.md` 产物现在可通过 `readArtifact`（MCP `resources/read`、Web UI 文件面板）读取，与 `resources/list` 的展示一致。
- Feature: MCP `cbx_start` 支持 `allow_unsafe_permissions: true`，`permissionMode: dontAsk` 在 MCP/后台路径可用。
- Docs: README 补充 MCP 工具 `cbx_review_gate`，修正 `git.autoCommit` 与 telemetry 本地落盘的描述；同步 `package-lock.json` 版本到 0.9.0。
- Repo: 新增 `.gitattributes`（`* text=auto eol=lf`）与 `.prettierrc.json`（`endOfLine: lf`），全仓库行尾归一化为 LF，`format:check` 在 Windows 本地与 CI 一致通过；含一次性的 `git add --renormalize`。

## 0.9.0 - 2026-08-05

- Feature: stage chain — multiple executors接力 within a single job via `task_contract.stages`. Each stage runs sequentially in the same worktree, shares one diff/result, and its `handback.md` is auto-injected into the next stage's prompt. Per-stage `executor`, `review_executor`, and `skip_review` overrides. Mid-chain failure preserves earlier stage reports in `result.json`. Backward compatible: absent `stages` runs a single synthetic `implementation` stage.
- Feature: Web UI live board — `cbx ui` now streams real-time `job.state_changed` events over SSE by tailing `.cbx/events.ndjson` (previously the `/events` endpoint only sent heartbeats). Adds clickable job rows with an artifact viewer/下载 panel, stage-chain visualization (reads `result.json.stages`), a `reviewVerdict` column, and color-coded event stream. No new dependencies; single-file vanilla JS.
- Fix: SSE tailer dropped the first event when the events file did not exist at first poll — ENOENT now seeds `size=0` so the first appended event is delivered.

## 0.8.2 - 2026-08-05

- Refactor: extract `evaluateBaselineDrift`, `refreshBaseline`, and `performContextHandshake` helpers to reduce duplication in `executeJobLocked` and `startBackground`. Internal only; no public API or persisted schema changes.

## 0.8.1 - 2026-08-05

- Drop `pi` executor, rename `omp` to `Oh My Pi`; add `cline` builtin executor.
- Source repo no longer tracks `dist/`; npm publish now builds from source and verifies `dist/src/cli.js` is present before publishing.
- Harden delegated task context: record Git baseline (commit/branch/dirty/fingerprint), pause isolated jobs on dirty creation baseline, pause non-isolated jobs on dirty-content fingerprint drift, add structured `task_contract` with plan-only understanding handshake, add `review_executor` for independent review CLI.

## 0.8.0 - 2026-08-04

- Publish to npm: `npm install -g cbx-orch` provides the global `cbx` command. Plugin MCP server now calls `cbx mcp`, so dependencies resolve via the global install instead of the plugin cache (fixes `MCP error -32000: Connection closed` caused by missing `node_modules`/`better-sqlite3` in the plugin cache).
- Add `cbx mcp` subcommand as the MCP stdio entrypoint.
- Add `publish.yml` GitHub Action: pushing a `v*` tag publishes to npm automatically (requires `NPM_TOKEN` secret).
- Add SQLite-backed durable state, queue, and dead-letter storage.
- Add governed executor plugin manifests, allowlists, and provenance events.
- Add CI quality gates and package supply-chain artifacts.
