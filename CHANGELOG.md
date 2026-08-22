# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible behavior changes, security fixes, and migration requirements are recorded here before a release.

## 1.1.0 — 2026-08-22

治理与诊断版本：执行档位把安全约束收口为一处声明，`cbx doctor` 提供只读环境诊断，任务模板降低重复提交成本，`result.json` 显式区分已验证/未验证交付。

- Feature: **执行档位（Execution Profiles）**。新增 `profile` 四档预设（`fast`/`verified`/`governed`/`untrusted`），把隔离、独立审查、依赖守卫、完成前审批与信任模式的默认组合收口为一处声明：`fast` 默认不隔离、不审查、不强制测试命令；`verified` 要求 `isolated=true`、`review=true` 与非空测试命令；`governed` 再加 `dependencyGuard=true` 与 `approvalBeforeComplete=true`；`untrusted` 还要求 `trustMode=untrusted` 且必须配置提供容器级隔离的 `execution.runner`，否则任务创建被拒绝。可经 `.cbx.json` 顶层、CLI `--profile`、MCP `cbx_start.profile` 或 Web 请求体传入，优先级为入口显式值 > 任务模板 > 配置文件；显式字段可覆盖档位默认值但不得违反对应硬约束（非 `untrusted` 档位不允许 `trustMode=untrusted`）。未设置 profile 时沿用原有字段默认值，行为与 1.0.0 一致。
- Feature: **`cbx doctor` 只读环境诊断**。逐项检查 Node.js >= 22、workspace 目录、`.cbx.json` 配置加载与 profile 硬约束、Git 根目录、executor 可用性（复用执行期同一条 agent 发现路径）以及 `untrusted` 模式所需 runner 文件；默认输出人类可读逐项状态，`--json` 输出含 `checks` 数组的机器可读报告，任一检查 `fail` 时非零退出。不创建任务、不写工作区、不启动 Agent。
- Feature: **任务模板**。`.cbx.json` 的 `templates` 字段定义可复用任务预设（`task`/`test`/`review`/`executor`/`isolated`/`profile`），`cbx templates [--json]` 列出模板目录，`cbx run/start --template <name>` 展开提交。
- Feature: **验证状态显式化**。`result.json` 新增 `evidenceAvailable` 与 `verificationStatus`：仅当配置了非空测试命令、测试成功、review/结构化审计通过且证据文件齐备时才为 `true`/`"verified"`；未提供测试命令的任务仍可进入 `done`，但结果显式标记 `evidenceAvailable: false`、`verificationStatus: "unverified"`——占位 `test.log` 不再可能被误读为"已验证"。
- Chore: `npm run smoke:executors` 重构为 async 主流程并改用 `locateExecutable` 探测（行为不变：未安装跳过、失败非零退出、支持 `--executor <name>` 过滤）。

## 1.0.0 — 2026-08-19

首个稳定版本。核心能力已齐备并经多轮加固：五大入口（CLI/TUI/Web UI/MCP/插件）、多执行器适配与声明式注册、agent capabilities 路由、持久化队列与审批门、token 用量可观测、孤儿 worktree 巡检、多平台 CI（Ubuntu/Windows/macOS）与覆盖率门槛（94/85/90）。

- Feature: **孤儿 worktree 巡检与清理**。worker 崩溃或任务被 purge 后，`.<repo>.cbx-worktrees/` 下可能遗留无主 worktree 目录。`cbx health` / `/healthz` / `/api/metrics` 现巡检并报告（`worktreeOrphans`，`<jobId>-stage-<index>` 条目剥离后缀归属同一 jobId）；`cbx clean --orphans` 一键清理（优先 `git worktree remove --force` 同步 git 元数据，回退 rm -rf；best-effort 删除 `cbx/<jobId>` 分支并 `git worktree prune`）。孤儿判定为保守口径——仅当 `.cbx/jobs/<jobId>` 目录已不存在（job 数据已清理）；jobDir 仍在的终态遗留仍走既有 `cbx clean <jobId>`，不会被误删。
- Feature: **Token 用量可观测**。执行器流式输出中的 usage 汇总行（codebuddy/Claude Code 会话 `result`、`turn_end` 轮汇总、OpenAI 兼容末块）由 `CodeBuddyStreamFilter`/`QwenStreamFilter` 解析，进程结束时汇总入 `state.tokenUsage` 并经单条 `system_notice` 流事件（`meta.tokensNum`）落盘审计；`result.json` 暴露 `tokenUsage`，`/api/metrics` 与 `cbx health` 聚合 `tokensUsed`。只认终态汇总行——逐消息 usage（`message_start`/`message_delta`）与会话总量叠加会重复计数，一律跳过；解析不到保持缺省，不产出错误数字（多执行器成本对比的口径基础）。
- Feature: **Stage 依赖层物理并行**。`taskContract.stages[].dependsOn` + `isolated: true` 时，同层 stage 在每个独立 worktree 中并发执行（executor/test/review），层间串行合并——每层完成后按声明顺序把各 stage diff 合入主 worktree（`git merge`，内部提交带 cbx 身份兜底），下一层 worktree 包含全部前置层合并结果，最终 `complete.patch` 对任务基线计算，与串行依赖模式语义一致。合并冲突（同层 stage 改同一文件）以新 phase `needs_fix / stage_merge_conflict` 暂停并列出冲突文件；失败传播（terminal stage → 下游 skipped）与串行一致。stage 产出物写入 `stage-artifacts/<index>/` 私有目录，终态聚合为 jobDir 证据；`runStage` 新增 `writeDir` 参数（缺省 = 原行为）。线性模式与非隔离依赖模式保持单 worktree 串行不变。
- Feature: **Runner 插件接口（`cbx.runner/v1`）**。`execution.runner` 配置 ESM 插件路径后，executor/test/review 命令改由插件执行（容器隔离场景）；`untrusted` 信任模式由"一律拒绝"放行为"要求配置 runner"（isolated 仍是硬前提，路径穿越防护与 executor 插件一致）。新增 `src/runner-plugin.ts`（resolveRunnerPlugin/runViaRunner，墙钟超时兜底）；输出经截断写 agent.log/test.log，runner 模式不产生流式事件与 active.pid。保持核心零依赖（不内置容器运行时）。

- Feature: 任务列表规模控制。`cbx list --limit N`（1–10000，updated_at 倒序取最近 N 条）；Web UI `/api/jobs?limit=N`（非法值 400，缺省全量向后兼容），前端列表只拉最近 300 条并显示截断提示，卡片计数改用 workspace 摘要的 `jobsByStatus`（全量准确，不再受列表截断影响）。
- Feature: 任务保留策略 `governance.pruneJobs`（默认 `false`，须显式开启）。开启后超过 `retentionDays` 的已终态任务（`done`/`failed`/`needs_fix`/`review_failed`/`cancelled`）在终态路径与健康检查时自动等价 `cbx purge` 清理（state/events/产物 + worktree），复用 `forgetJob` 的审计（tombstone + `job.deleted` webhook）；运行/排队/审批中任务永不触碰。strict schema 接受新字段。
- Feature: 统一审查判定解析（`src/verdict.ts`）。审查器可写机器可读 `review.json`（`{"version":1,"verdict":"PASS"|"FAIL"}`），结构化判定优先于 `review.md` 首行 `VERDICT:` 旧契约；stage review 与 stop-gate 共用同一解析，消除两处口径漂移。无法解析时语义不变且有意为之：stage fail-closed（新增 `review_verdict_unparsable` 事件）、stop-gate fail-open。`review.json` 加入 CLI/UI/MCP 产物白名单。
- Feature: 执行器契约加固。内置执行器注册表新增 README 契约测试（envVar `CBX_<NAME>` 命名 / candidates 含注册名 / alias 回指）；新增 `npm run smoke:executors`：对每个已安装的真实编码 CLI 跑一次最小任务验证 adapter 参数契约，未安装跳过，失败非零退出（不属默认测试套件，需显式触发）。
- Feature: Web UI 前端轻量类型检查。`ui/tsconfig.json`（checkJs + 环境声明收窄 querySelector/按钮输入框属性）纳入 `npm run lint`，对 app.js 捕获未定义变量/拼写/签名错误；`ui-frontend.test.ts` 增补截断列表下卡片计数取摘要、trunc-hint 切换用例。
- Perf: 事件批量写。热路径 `executor_stream_event` 落盘从每次 `appendFileSync` 改为内存缓冲 + 行数(128)/字节(64KB)阈值合并写 + 进程 exit 钩子兜底；`executeJob` 终态前显式 flush 保证终态可见时事件流完整。耐久语义与改造前一致（OS page cache，不额外 fsync；SIGKILL/断电最多丢失缓冲尾部流诊断事件，审计事件不走此路径）。
- CI: 矩阵加入 `macos-latest`（覆盖 Unix 进程组击杀与路径分支的第三平台验证）；Node 支持矩阵对齐：`engines` 从 `>=20` 收紧为 `>=22`（Node 20 已 EOL 且不在 CI 验证范围），README 同步。
- Docs: 新增英文总览 `README.en.md`（随 npm 包发布），中文 README 顶部互链。

- Security: 修复 Windows 进程树击杀失效。`killTree` 此前有句柄时先 `child.kill` 短路返回——Node 在 Windows 的 kill 仅终止直接子进程且几乎总返回 true，`taskkill /T /F` 永不执行，每次超时/取消后 agent CLI 的孙进程（bash/git/node）成为孤儿继续改写 worktree。改为 `taskkill /T /F` 先行（必须趁根进程存活才能枚举整棵树），句柄与 pid 直杀作为受限会话兜底。
- Fix: `runProcess`/`captureAsync` 超时击杀后 close 可能永不到达（孤儿孙进程持有 stdio 管道句柄）。新增 `FORCE_SETTLE_MS`（3s）强制结算兜底，超时+宽限后 resolve 返回，杜绝 worker 因 promise 悬挂 → 心跳过期 → 队列反复回收（心跳重置绕过 `MAX_RECLAIMS` 熔断）的 30s 摆振；`captureAsync` 超时改走树杀并接入同一兜底。
- Security: 队列回收死 worker 时按 `active.pid` 终止其遗留的 detached executor（记 `queue_reclaim_killed_stray_executor` 事件），关闭"旧 worker 崩溃后孤儿 executor 与新 worker 并发改写同一 worktree"的双 agent 窗口。worker 进程仍存活（仅心跳过期）时不杀，由 run.lock 仲裁。
- Security: Web UI 与 MCP HTTP 增加共享请求守卫（`src/http-guard.ts`）：`Host` 头必须回环（防 DNS rebinding）、浏览器请求的 `Origin` 头必须同源回环（防任意网页以 no-preflight simple POST 调用写接口的 CSRF）、携带 body 的 POST 必须 `application/json`（MCP `POST /mcp` 一律强制）。无 body POST 保持兼容。
- Security: `governance.redactFields`/`redactPatterns` 覆盖任务级 `events.ndjson`：`process_started` 的完整 argv（含 prompt）与 `executor_stream_event` 的 `toolArgs` 此前绕过脱敏直写落盘，现经统一 `appendEvent` 收口（对象级字段 + 行级 key + 全文正则三层）。
- Security: `readArtifact`/`listArtifacts` 补 `assertJobId`（artifacts 层单点覆盖 CLI/UI/MCP 全部入口），阻断 `..` 等 jobId 穿越越权读 workspace 级 `.cbx` 文件。MCP stdio `send()` 捕获客户端断连的 EPIPE，消除事件回调 unhandled rejection。
- Security: 测试命令黑名单补已知绕过变体：flag 顺序无关的 `rd /q /s`/`rmdir /q /s`/`del /f /s`、`erase` 同义词、引号包裹的 flag/子命令（`rm '-rf' /`、`git 'clean' -fd`）、`find -exec`。仍为软防线，非隔离任务依赖环境隔离。
- Feature: adaptive + `dependsOn` 组合在任务创建时显式拒绝（此前 manager 决策的 stage 静默忽略依赖声明）；manager 决策 schema 同步移除 `dependsOn` 字段（幻觉出该字段按未知字段报错）。
- Refactor: 收敛复制契约。新增 `finalizeState`/`finalizeApprovalState`（状态写盘 + result.json 生成 + 可选保留期清理一次完成）替代 execution/approval 中 8 处三连副本；`approveJobAndStart` 内聚"before_run 批准后回 queued 必须重新入队"契约，替换 CLI/MCP/TUI/Web UI 四处各自维护的镜像副本。
- Refactor: `CbxError` 新增 `E_VALIDATION`（参数/策略校验）与 `E_STATE_CONFLICT`（状态冲突）错误码，`httpStatusForError` 集中错误码 → HTTP 状态映射（400/403/404/409），Web UI 弃用内联 if-else 链。`JobPhase` 联合类型文档化全部 phase 字面量（`JobState.phase` 保持 string 以兼容旧持久化数据）。移除未接线的 `prepareStageWorktree`/`cleanupStageWorktree` 死代码。
- CI: 矩阵加入 `windows-latest`（此前仅 Ubuntu——Windows 平台分支的进程/锁/路径代码从未被 CI 覆盖，本次 killTree 修复正是该盲区的产物）。README 的 Node 矩阵描述与 CI 实际（22/24）对齐。
- Fix: `npm run coverage` 与 `npm test` 对齐固定 `--test-concurrency=2`。此前覆盖率运行用默认并发（=CPU 数），大量 e2e 子进程并行拖爆紧凑的墙钟假设（秒级执行器超时、百毫秒杀进程余量），在多核机与 Windows CI 上随机时序失败（实测基线 17 例）。同步加固 3 例高负载脆弱测试：两例审批流测试的执行器超时上限 2s→10s（上限放宽不影响 happy path），插件超时杀进程测试的写入余量 500ms→5s（树杀经 taskkill 有数十毫秒真实延迟）。覆盖率地板随实测（76.5/61.7/78.1）从 68/46/70 上调至 73/58/75。

## 0.14.0 — 2026-08-13

- Security: MCP `resources/read` 补齐 `validateWorkspace`，与 `resources/list` 等入口一致；此前 URI query 的 `workspace` 直接作为 root，绕过了存在性与根目录校验（受 `assertJobId` + 工件白名单约束，属鉴权不一致面）。
- Feature: `dependencyGuard` 受监控清单从仅 JS 生态扩展到 Python/Rust/Go/Ruby/JVM 的依赖声明与锁文件；内置执行器为多语言通用 CLI，原清单让非 JS 项目裸奔。不存在的文件经 `existsSync` 守卫零开销。
- Refactor: 合并 `runProcess`/`runShell` 两份近乎逐字重复的实现为共享 `runChild` 核心 + 两个薄封装，导出签名与行为完全等价（`shell:false/true` 的 spawn 形式差异保留）。

## 0.13.2 — 2026-08-13

- Feature: 新增 `qwen` 内置执行器（Qwen Code CLI）。`permissionMode` 映射为 `plan` → `--approval-mode plan`、`auto`/`dontAsk` → `--yolo`；`maxTurns` → `--max-session-turns`。二进制路径可经 `CBX_QWEN` 覆盖。

## 0.13.0 — 2026-08-13

- Feature: 任务预算字段暴露到 state/result/UI。`configuredMaxTurns`（配置的最大轮次）与 `executorInvocations`（执行器实际调用次数）进入 job state 与 result，Web UI/TUI 可见，便于诊断预算耗尽与执行器行为。
- Security: 执行器插件路径校验加固。默认策略下也阻止路径穿越（含跨盘符绝对路径），并用 `realpath` 解析符号链接后比较，防止 workspace 内软链指向外部文件绕过校验加载任意代码；同时修复只读连接在库未就绪回落时污染只读缓存导致优化失效的问题。
- Fix: MCP streamable HTTP `readJsonBody` 对超限请求体先 drain 再返回 413，确保客户端收到 413 响应且 `server.close()` 能 resolve（此前超限请求导致连接悬挂）。
- Fix: stage-runner `skipReview` 路径使用真实子进程退出码并补 invariant 断言，移除失效死断言。

## 0.11.0 — 2026-08-09

## 0.12.1 — 2026-08-12

- Fix: storage `database()` 改 Promise 缓存，并发调用 await 同一 promise 保证同 workspace 单连接（reject 清缓存允许重试），根治并发建重复连接；`pruneDeliveryFailureArtifact` 改 `createReadStream` + `readline` 逐行流式，避免大 outbox 整文件读内存 OOM，cutoff 前删后留语义不变。
- Fix: MCP SSE `notifications/resources/updated` 帧加 `id`（闭包内 eventSeq 递增）+ `retry:3000`，支持 Last-Event-ID 恢复与重连间隔提示；`cbx_review` 先 `loadState` 确认 job 存在再读 review.md，区分 job 不存在（E_NOT_FOUND）vs review 未产出（ENOENT）。
- Fix: Web UI EventSource 加 `onerror` 可见性提示 + `beforeunload` 关闭连接（防 SPA 卸载泄漏；ES 为全局单例，switchWorkspace 不重建）；`<html lang="zh-CN">`、`<th scope="col">`、全局 `:focus-visible` 焦点样式提升可访问性。
- Fix: 修正 v0.12.0 release 版本同步遗漏（package-lock + 3 个 plugin manifest + `interfaces.test` 去 brittle 改 semver 格式校验），manifest 一致性测试恢复绿色。

## 0.12.0 — 2026-08-12

- Security: Web UI `esc()` 补引号转义堵属性上下文 XSS；SSE 事件 status 进 class 前转义。MCP `cbx_start`/`cbx_continue` 的 `context_snapshot` 加 65536 字符上限防 prompt 膨胀。MCP HTTP 加 CORS/OPTIONS 预检，支持浏览器 MCP 客户端。Web UI 静态响应补 `nosniff`/`no-store`。
- Security: MCP `workspace` 参数加 `validateWorkspace` 边界校验（非根 + 存在），拒绝任意路径操作。
- Fix: `logJobEvent` 补 fsync，job 审计事件流在系统级崩溃后可恢复（events.ndjson 无 SQLite 副本）。
- Fix: `listPersistedStates` 单条坏 state 容错跳过，不拖垮 listJobs/health。`startEventTailer` 文件截断时清空 buffer 防事件流错位。MCP SSE 连接全断时停 tailer 防 interval 泄漏。
- Fix: `withFileLock` 的 `reclaimLock` 在 rename 后重新校验 pid，缩小 TOCTOU 双持有窗口（活进程的锁放回，不误回收）。
- Improvement: CLI/TUI 表格 `displayWidth` 改按码点 + East Asian Wide 区块计列宽，中文任务名/phase 不再对齐错位。MCP `initialize` 的 protocolVersion 按规范协商（客户端版本命中支持集合则采纳）。
- Docs: governance 块（脱敏/retention/prune）补 15 例测试，原错位的 dispatch 测试归并 reliability。`mcp-server.md` 的 `extra_rounds` 文档对齐代码语义。覆盖率阈值 66/43/67 → 68/46/70（实测 70.4/48.8/72）。

- Feature: MCP streamable HTTP 传输。新增 `cbx mcp --http [--port] [--host] [--token]` 模式,协议升级 2025-06-18,单 endpoint `POST /mcp` + `GET /mcp`(SSE 承载服务端推送),仅绑定 loopback、token 鉴权(与 `cbx ui` 同源)。启用 `resources/subscribe` + `notifications/resources/updated`:订阅 `cbx://job/<id>/events` 后,任务事件变化实时推送(通知为变更信号,数据经 `resources/read` 读增量 `{events, next_offset}`;订阅时建基线,此前事件不算增量)。stdio 模式保持默认与协议 2024-11-05,完全向后兼容;19 个工具与 resources 契约不变。零依赖(Node 原生 http + 手写 SSE,对齐 `cbx ui`)。
- Test: 新增 `tests/mcp-http.test.ts`(6 例:initialize 2025-06-18+subscribe、tools/list 19 工具、events 资源 list/read、订阅→事件→updated 推送、非 loopback 拒绝、token 401/200)。总计 469 个测试全过。

- Fix: TUI forget/purge 二次确认提示。按下 `d`/`D` 进入 armed 后状态栏显示「再按 d/D 确认 <job>（3s）」黄色提示，超时或按其他键自动取消；此前 armed 状态对用户不可见。
- Refactor: workspace 发现收敛为单一共享入口。`discoverWorkspaces` / `dedupWorkspaces` / `listJobsAcrossWorkspaces` 从 CLI 本地副本移入 `src/artifacts.ts` 并经 `core.ts` re-export；CLI（`cbx ws --workspaces-dir`、`ui` 命令）改走共享实现，删除 `cli.ts` 本地重复。Web UI 不改（消费 CLI 已解析的 workspace 列表，发现是 CLI 层职责）。
- Feature: MCP 新增 `cbx_list_workspaces` 工具（扫描 `root` 下含 `.cbx/` 的 workspace 并列出各自任务，`root` 缺省 cwd），复用 `listJobsAcrossWorkspaces`，输出 `{ workspaces: Array<{ workspace, jobs }> }`。
- Test: `tests/mcp-migration.test.ts` 增补 `cbx_list_workspaces` 工具清单断言 + 双 workspace 功能用例。总计 462 个测试全过。

- Feature: 任务生命周期清理 `cbx forget` / `cbx purge`。此前 job 存储只增不减——`state.json`/`events.ndjson`/artifacts 与 SQLite 行在任务到终态后永久留存，仅有 `cbx clean`（仅 worktree）与 `prunePersistedData`（仅 delivery_failures）。新增 `forgetJobKeepWorktree` / `purgeJob` 原语：`cbx forget <jobId> [--reason <text>] [--yes]` 删 `state.json`/`events.ndjson`/全部 artifact 但保留 worktree，并写 tombstone 到 metadata 防止同 id 重建静默继承孤儿状态；`cbx purge` 连 worktree 一起删。`--reason` 落审计轨迹。
- Feature: MCP 新增 `cbx_forget` / `cbx_purge` 工具，复用同一 state 原语（无第二条删除路径）；刻意拆成两个工具而非单一 `cbx_forget{purge_worktree}`，便于模型在 schema 描述中明确选择、且审计记录 `cbx_purge` 而非猜测意图。状态守卫/事件顺序/tombstone/webhook 尽力投递与 CLI 一致。
- Feature: TUI 新增 `d`（forget，保留 worktree）/ `D`（purge，删 worktree）两步确认。forget/purge 不可逆（state/events/artifacts 删除后无恢复路径），故需二次按键：首按 arm 动作（记住 action/jobId/armedAt），状态栏提示「再按 d 确认」；超时或切换选中重置。
- Feature: Web UI 新增 `POST /api/jobs/:id/forget` 与 `POST /api/jobs/:id/purge` 路由 + 详情面板按钮（与 cancel/approve/retry/continue 同前缀、同鉴权），补齐任务真正结束后的清理入口。
- Refactor: 保留期清理收敛到 `pruneAfterTerminal`。`prunePersistedData` 迁入 `storage.ts` 后 6 处终态调用点各自重复「解析 governance.retentionDays + 调用 prune」；收敛为单一入口（approval.ts 3 处/lifecycle.ts 2 处/execution.ts 2 处 + queue-api.ts 健康检查），消除重复解析与高频状态写入时的配置重载/DB 扫描。
- Test: `tests/ui.test.ts`/`tests/tui.test.ts` 增补 forget/purge HTTP 路由、TUI 两步确认（arm/confirm/timeout/reset）与保留策略收敛用例。

- Feature: 多 workspace CLI 调度。新增 `cbx ws`（跨 workspace 汇总：任务状态计数/队列深度/paused/git 分支，输出与 Web UI `/api/workspaces` 同形状；交互终端显示表格）。`cbx list --all` 跨 workspace 合并任务并带 `[workspace]` 前缀；`cbx health --all` 输出每 workspace 指标。workspace 解析：显式 `--workspace`（可重复）> `--workspaces-dir`（1 层扫描含 `.cbx/` 子目录）> 默认 `.`，去重复用 `dedupWorkspaces`。复用并导出 `summarizeWorkspace`（单一权威汇总实现，CLI/Web UI 共享）；每 ws 独立 catch（单 ws 失败以 error 字段标识，不拖垮整体）。只读查询，不触碰任何 workspace 状态。
- Test: `tests/multi-workspace.test.ts`（ws 双 workspace 汇总/单 ws 兼容/--workspaces-dir 扫描/list --all 前缀/health --all）。总计 436 个测试全过。

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
- Feature: stage 依赖声明（dependsOn）与失败传播。`taskContract.stages[].dependsOn` 接受前置 stage name 数组；`normalizeTaskContract` 校验悬空依赖（引用不存在的 name）与循环依赖（DFS 三色标记）。执行时前置 stage 进入失败终态（FAIL / 非零退出）后，后继 stage 标记 skipped 而非执行，并记 `stage_skipped` 事件。handback 注入改为聚合所有 dependsOn stage 的交接文档（依赖模式）或沿用上一阶段 handback（线性模式）。`groupStagesByDependency` 导出为工具函数供未来并行执行使用；当前层内仍串行（单 worktree 安全）。Adaptive 模式不支持 dependsOn（manager 每轮自选 stage，依赖声明无语义）。
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
