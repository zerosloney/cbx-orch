# Design: 低复杂度增量功能

## 1. Scope & Trigger

- 触发：能力矩阵四入口对齐后，三个低成本增量（TUI 事件流 / 任务模板 / 结果导出）。
- 边界：TUI 层（`src/tui/`）、CLI 层（`src/cli.ts`）、config 层（`src/storage.ts` + `src/state.ts`）。不触碰 execution/stage-runner/queue。
- 单任务三子项，各可独立验证，按 implement.md 顺序执行。

## 2. Contracts

### 2.1 TUI 事件流面板

**数据源**：`readEventsIncremental(workspace, jobId, since)` → `{ events: string[], next_offset }`（`src/artifacts.ts:33`，已导出）。

**TuiState 扩展**：

```typescript
interface TuiState {
  // ...existing
  eventStream: { lines: string[]; offset: number };
}
```

**fetchData 扩展**：选中任务时调用 `readEventsIncremental(workspace, jobId, state.eventStream.offset)`；新事件追加到 `lines`（上限 5，超限 shift）；`offset` 更新为 `next_offset`。

**渲染**：`draw()` 在详情面板后追加最多 5 行事件（时间 + 类型着色，`job.state_changed` 显示 `<prev> → <next>`）。

**关键点**：`readEventsIncremental` 的 `next_offset` 在并发写入时可能"停在半行"——游标推进到最后一个完整行，下次补齐（已在 artifacts.ts 注释说明）。

### 2.2 任务模板

**config schema 扩展**（`src/storage.ts:loadRuntimeConfig`）：

```typescript
interface TaskTemplate {
  task: string;                 // required
  test?: string;
  review?: boolean;
  executor?: string;
  isolated?: boolean;
}
// .cbx.json known 白名单加 "templates"
// 校验：templates 为对象；每个 value 为对象，task 必填非空字符串；
//       未知模板键拒绝；可选字段类型校验（test/executor 字符串，review/isolated 布尔）
```

**RuntimeConfig 扩展**（`storage.ts`）：`templates?: Record<string, TaskTemplate>`。

**CLI 展开**（`src/cli.ts` run 分支）：

```typescript
// 解析顺序：--template <name> → 查 config.templates[name] → 不存在报错列出可用名
// 合并：命令行显式参数优先，模板值兜底（mergeConfig 已支持 partial overrides）
```

实现：`--template` 时先读模板，用模板值填充 `mergeConfig` 的 defaults 层，命令行参数仍覆盖。

### 2.3 任务结果导出

**CLI 新子命令**：`cbx export <jobId> [--format text|markdown] [--workspace .]`

```
src/cli.ts:  if (command === "export") { ... }
```

**实现**：
- 读 `result.json`（`readArtifact`）→ 失败时输出基本 `loadState` 摘要 + 提示
- text 格式：状态/阶段/耗时/stage 链/验收证据/错误（复用 `renderJobDetail` + 新增摘要）
- markdown 格式：`# 任务 <id>` + 各段（状态、stage 表、验收、handback 摘要、test/review 摘要）
- 依赖：`result.json` 字段（status/phase/stages/acceptanceEvidence/error/handback）

## 3. Data Flow

```
TUI 事件流: readEventsIncremental(ws, jobId, offset) → {events[], next_offset}
            → state.eventStream.lines（上限5）→ draw() 渲染
模板:       cli run --template T → config.templates[T] → mergeConfig(defaults=模板值)
            → createJob → 常规执行
导出:       cbx export ID → readArtifact(result.json) + 工件 → text/markdown 渲染
```

## 4. Tradeoffs

| 决策 | 选项 | 选择 |
|------|------|------|
| 事件流位置 | 独立面板 vs 详情内联 | 详情下方内联（小屏友好，复用现有布局计算） |
| 模板覆盖 | 命令行覆盖模板 vs 模板覆盖命令行 | 命令行优先（用户显式意图 > 配置默认） |
| 导出格式 | text/markdown vs HTML | text/markdown（终端工具定位，无浏览器依赖） |

## 5. Compatibility

- `templates` 新增字段向后兼容（未配置时无行为变化）；strict schema 白名单扩展不会拒绝旧配置。
- `cbx export` 新子命令不影响现有命令。
- TUI 事件流纯增量渲染，不影响现有轮询/键位。

## 6. Rollback

- 每子项单文件 revert 即可回滚。
- config schema 变更若需回滚，旧版本 cbx 读取含 `templates` 的 `.cbx.json` 会因未知字段拒绝——需文档提示或宽松处理。**决策**：加 `templates` 到白名单后，旧版本会拒绝新配置；接受（配置回滚 = 移除 templates 字段）。

## 7. Test Strategy

- TUI 事件流：`tests/tui.test.ts` 断言 fetchData 后 `eventStream.lines` 增量 + 上限裁剪；渲染含状态转场。
- 模板：`tests/hardening.test.ts`（config schema）断言 `templates` 接受合法/拒绝非法（缺 task、未知类型）；`tests/interfaces.test.ts` 或新 CLI 测试断言 `--template` 展开 + 不存在报错 + 命令行覆盖。
- 导出：CLI 端到端断言 text/markdown 输出包含状态/stage/验收；job 不存在报错。
