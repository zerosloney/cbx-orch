# Design: 任务批处理 batch run

## 1. Scope & Trigger

- 触发：能力矩阵中价值功能——批量创建多个独立任务。
- 边界：CLI 层（`src/cli.ts`）+ 新增批处理辅助（`src/batch.ts` 或 cli 内联）。复用 `createJob`/`startBackground`/队列，不触碰 execution/stage-runner/queue 核心。
- 单任务，无子项。

## 2. Contracts

### 2.1 CLI 命令

```
cbx batch --task "A" --task "B" [--task-file f.md] [--max-batch N] [--wait [--wait-timeout-ms T]] [--workspace .] [run 选项透传]
```

- `--task` 可重复；`--task-file` 可重复；两者混用。至少 1 个任务。
- run 选项（`--executor`/`--review`/`--isolated`/`--max-turns` 等）经 `mergeConfig` 透传到每个 job。
- 输出：每任务创建后打印 `jobId`，结束打印 JSON 汇总。

### 2.2 并发控制

**决策：batch 并发由全局 `maxConcurrent` 控制，`--max-batch` 为批内自控分片。**

| 方案 | 分析 | 决策 |
|------|------|------|
| A. 改 queue maxConcurrent | 会改变全局并发，影响其他任务 | ❌ |
| B. `--max-batch` 分片入队 | 批任务分 N 个波次 enqueue，每波 max-batch 个；下一波等上一波全部终态 | ✅ 简单、可预测、不碰全局 |
| C. 批内 priority 分片 | 依赖队列优先级语义，间接且不可见 | ❌ |

- `--max-batch N`：批任务分 N 个波次（chunk）入队。波次间等待上一波全部达终态（done/failed/cancelled）再入队下一波。默认 0 = 一次性全部入队（无分片）。
- 波次等待用轮询 `loadState`（复用现有轮询模式），非阻塞事件驱动。

### 2.3 jobId 命名

`createJob` 接受 `jobId` 选项（`normalizeJobId`）。批任务命名：`batch-<ts>-<seq>`（seq 为批内序号），便于识别与汇总。用户未指定 jobId 时使用；若 `--job-id` 显式给出则仅允许单任务场景（batch 下拒绝）。

### 2.4 汇总输出

```typescript
interface BatchSummary {
  total: number;
  created: number;
  jobs: Array<{ jobId: string; task: string; status: string }>;
  // --wait 时追加：
  finished?: number;
  succeeded?: number;
  failed?: number;
  unfinished?: string[];   // wait 超时未终态
}
```

### 2.5 `--wait` 轮询

- 等待所有 job 终态（`TERMINAL = done/failed/review_failed/cancelled/needs_fix`）。
- `--wait-timeout-ms`（默认 30 分钟）超时后返回 `unfinished` 列表 + 非零退出码。
- 轮询间隔 1s（复用 `scheduleTuiPoll` 的定时模式或简单 setInterval）。

## 3. Data Flow

```
cbx batch --task A --task B --max-batch 1
  ├→ parse: tasks[] = [A, B], maxBatch = 1
  ├→ chunk [[A], [B]]
  ├→ wave 1: createJob(A) + startBackground(A) → jobId
  │    └→ wait A 终态
  ├→ wave 2: createJob(B) + startBackground(B) → jobId
  │    └→ wait B 终态
  └→ 汇总输出
```

无 `--max-batch` 时：所有任务一次入队（与多个 `cbx start` 等价），不等待。

## 4. Tradeoffs

| 决策 | 选择 | 理由 |
|------|------|------|
| 并发方案 | 波次分片（B） | 不污染全局 maxConcurrent；可预测；实现简单 |
| 等待语义 | `--wait` 可选 | 默认"创建+入队"（与 start 一致）；wait 是显式增强 |
| 实现位置 | `src/batch.ts` 独立模块 | cli.ts 已大（520+ 行）；批处理逻辑独立可测 |
| 任务来源 | `--task`/`--task-file` 重复 | 与现有 run 解析一致，无新语法 |

## 5. Compatibility

- 纯新增命令，不影响现有 `run`/`start`/队列。
- 批任务 job 与普通 job 完全同构（同队列/同配置），可独立 retry/continue。
- 无 config schema 变更，无持久化变更。

## 6. Rollback

- 单文件 revert（`src/batch.ts` + cli.ts 分支）即可。

## 7. Test Strategy

- `src/batch.ts` 纯函数单测：chunk 分片（maxBatch=0/1/2/N>total）、汇总聚合。
- CLI 端到端（`tests/core.executor.test.ts` 或新 `batch.test.ts`）：
  - `cbx batch --task A --task B` 创建 2 job + 汇总
  - `--max-batch 1` 波次执行（fake agent 快速终态，验证 wave 顺序）
  - 无任务报错
  - `--wait` 汇总含终态计数
  - 任务参数透传（--review/--executor 生效）
