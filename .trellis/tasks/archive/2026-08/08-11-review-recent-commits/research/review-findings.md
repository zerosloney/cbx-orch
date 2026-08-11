# 审查发现 — forget/purge 生命周期 + workspace discovery（ed9a918..HEAD）

审查范围:10 提交(7 代码 + 3 文档/归档)。方式:双轴(规范/需求),主会话内联执行(两个 review 子代理分别因 diff 过大退出与 429 inference-cap 失败,故回退内联,遵循 review-verification-protocol 逐条验证)。

## Standards

1. `[src/state.ts:126-127, 140-143]` 误导注释 / 冗余写:lifecycle/deleted 事件先写进 `jobDir/events.ndjson`(state.ts:32-33),随后 `rm(directory,{recursive:true})`(state.ts:140-143)把整个目录连 events.ndjson 一起删掉。state.ts:126 注释声称「即便目录都删了,审计链仍可查」——但 rm 删的正是承载该事件的 events.ndjson。作者在 state.ts:113 已自知 events.ndjson 会被 rm(tombstone 因此写 metadata),故此处注释与行为矛盾;events.ndjson 那条写是死写。实际审计靠 metadata tombstone + webhook outbox(publishEvent 是 workspace 级),无真实审计丢失。建议:删掉这条 logJobEvent 写,或修正注释。Minor。
2. `[src/state.ts:151, 153-155]` tombstone 只写不读(Speculative/死数据):`setMetadata(workspace,\`forgotten:${jobId}\`)` 写 tombstone,但全仓 grep 无任何读取(仅 state.ts:151 一处写)。提交 034a906 声称「Tombstone prevents same-id re-creation inheriting orphan state」——实际防重靠 SQLite 行缺失报错(jobs.ts:118-121),tombstone 不参与。tombstone 仅剩 audit 价值,「防静默继承」的声明未由它实现。Minor。
3. `[src/tui/index.ts:49-51 + render]` armed 状态未呈现给用户(不可见二次确认):提交 2ed37e1 声称「Status bar would show 'press d again'」,但 grep 显示 `armedAction/armedJobId/armedAtMs` 只在 handleTuiKey(确认门 + disarm)被读,渲染层从不读取。用户按 d 一次后 UI 重绘但不显示任何 armed 提示。安全机制本身正确(需两次按键),但缺乏 affordance——用户无反馈,可能误按其他键(会 disarm)。Minor。

## Spec

1. forget/purge 规格(提交声明):「tombstone 防同 id 静默继承孤儿态」的实现与实际不符——防重由 SQLite 行缺失错误承担,tombstone 未被消费。需求「看起来实现了但实现未达其声明的目的」。Minor(与 Standards 2 同源)。
2. TUI 提交声明「status bar 显示再按 d 确认」未实现(与 Standards 3 同源)。Minor。
3. workspace discovery 轴:R1-R5 + AC1-AC6 全部满足(上一任务逐条验证),无规范缺口。
4. 无范围蔓延:forget/purge 的 webhook/tombstone/pruneAfterTerminal 均属提交声明的行为;CLI 双命令强制 `--yes`/`CBX_YES`,reason 三入口审计标记一致(`cli:`/`tui:`/`web:` + MCP 默认),质量良好。

## 汇总

- Standards:3 条,全部 Minor(无 Critical/Major)。
- Spec:2 条(与 Standards 2、3 同源),1 条 workspace discovery 无缺口。
- 无阻塞项;均为 Minor 级注释/UX/死数据问题,可后续顺手清理,不需回滚。
