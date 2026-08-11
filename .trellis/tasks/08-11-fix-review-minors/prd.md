# 修 forget/purge 审查 3 个 Minor

## Goal

清理审查任务 `08-11-review-recent-commits` 发现的 3 个 Minor 级问题(详见 `.trellis/tasks/archive/2026-08/08-11-review-recent-commits/research/review-findings.md`),均为注释准确性 / 死数据说明 / TUI UX 提示,无行为回归风险。

## Background / Confirmed Facts

- F1 `src/state.ts:126-127, 140-143`:注释声称「即便 SQLite 行 + 目录都删了,审计链仍可查」,但 `logJobEvent` 写的 `jobDir/events.ndjson`(state.ts:32-33)随后被 `rm(directory,{recursive:true})`(state.ts:140-143)连目录一起删。注释与行为矛盾。
- F2 `src/state.ts:151, 153-155`:`setMetadata(\`forgotten:${jobId}\`)` 写 tombstone,全仓无读取;提交 034a906 声称其「防同 id 重建静默继承孤儿态」,实际防重由 SQLite 行缺失报错(jobs.ts:118-121)承担,tombstone 未参与。
- F3 `src/tui/components/status-bar.ts` `renderStatusBar(queue, gitBranch)` 是纯组件(有测试);`state.armedAction/armedJobId/armedAtMs` 只在 `handleTuiKey`(tui/index.ts)被读,渲染层从不读取,armed 状态对用户不可见。提交 2ed37e1 声称「status bar 显示再按 d 确认」未实现。

## Requirements

- R1(F1):修正 `forgetJob` 中 `logJobEvent` 后的注释,准确说明该 events.ndjson 事件是**删除前审计记录,仅在目录 rm 失败时保留**;成功 forget 时 job 记录(含 events.ndjson)被有意擦除,持久审计靠 metadata tombstone + webhook outbox。**保留**该写(rm 失败路径上有价值),不改行为。
- R2(F2):修正 tombstone 注释,将其定位为**持久 forget 审计记录**(metadata 表,可经 getMetadata 查询),移除「防同 id 静默继承」的误导性声明(防重由 SQLite 行缺失错误承担)。**保留** tombstone 写,不改行为。
- R3(F3):`renderStatusBar` 增加可选 `armed?: { action: "forget" | "purge"; jobId: string } | null` 参数;armed 时追加黄色提示(如 ` ⚠ 再按 d 确认 forget <jobId>(3s)`;forget→`d`,purge→`D`)。`draw()`(tui/index.ts:286)传入 `state.armedAction/armedJobId`。
- R4:补测试——`tests/tui.test.ts` 增补 renderStatusBar armed 提示断言(armed 时含提示文案、未 armed 时不含);不破坏既有 renderStatusBar 用例(新参数可选,向后兼容)。

## Acceptance Criteria

- [ ] AC1. `src/state.ts` 两处误导注释已修正,准确描述 events.ndjson 事件与 tombstone 的真实作用;无行为变更(仅注释)。
- [ ] AC2. TUI 按 `d`/`D` 第一次进入 armed 时,状态栏显示「再按确认」提示;未 armed 时不显示。
- [ ] AC3. `tests/tui.test.ts` 增补 armed 提示断言,`npm test` 全绿(现 462 例 + 新增)。
- [ ] AC4. `git diff` 仅涉及 `src/state.ts`、`src/tui/components/status-bar.ts`、`src/tui/index.ts`、`tests/tui.test.ts`(及 CHANGELOG 若需)。
- [ ] AC5. 改动已提交。

## Out of Scope

- 不改 forget/purge 的逻辑行为、状态守卫、删除顺序。
- 不引入 tombstone 读取逻辑(createJob 防重已由 SQLite 行缺失承担,加读是范围蔓延)。
- 不新增 tombstone 相关新 API。

## Key Decisions

- F1/F2 均「保留写 + 修正注释」而非「删除」:events.ndjson 写在 rm 失败路径有审计价值;tombstone 是 metadata 持久审计记录。删除是行为/数据变更,修正注释是诚实且最小 diff。
- R3 用可选参数扩展 renderStatusBar(向后兼容),armed 提示内联到状态栏一行,不改组件签名破坏性。
