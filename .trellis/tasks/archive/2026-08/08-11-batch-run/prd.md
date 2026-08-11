# PRD: 任务批处理 batch run

## Goal

一条命令批量创建并执行多个任务，受并发上限控制，结束后输出汇总报告。复用现有 `createJob` + 队列机制，不触碰编排核心。

## Acceptance Criteria

### 1. CLI `cbx batch` 命令

- [ ] `cbx batch --task "A" --task "B" [--task "C"...] [--workspace .] [其他 run 选项]`
- [ ] 也支持 `--task-file <path>` 重复（每个文件一个任务）与 `--task`/`--task-file` 混用。
- [ ] 至少 1 个任务；无任务时报错（用法提示）。
- [ ] 每任务独立 job（`createJob` + `enqueueJob`，后台入队），jobId 生成后打印。

### 2. 并发控制

- [ ] `--max-batch <N>`（默认 0 = 不设 batch 专属上限，受全局 `maxConcurrent` 约束）。
- [ ] batch 专属上限实现方式：批任务用 `batch:<jobId>` 前缀命名 jobId 便于识别；并发上限经队列的 `maxConcurrent` 或批次自管理（见 design 决策）。
- [ ] 不等待执行完成（batch 是"创建+入队"语义，与 `start` 一致），除非 `--wait`。

### 3. 汇总输出

- [ ] 命令结束输出 JSON 汇总：`{ jobs: [{ jobId, status: "queued", task }], total, created }`。
- [ ] `--wait` 时等待所有 job 终态，汇总含每 job 最终状态 + 成功/失败计数；超时（`--wait-timeout-ms`）报未完成列表。

### 4. 与现有机制一致性

- [ ] 批任务与单任务共享同一队列、并发槽位、重试/审批配置（CLI 参数透传到每个 createJob）。
- [ ] 失败的任务仍可 `cbx retry`/`continue` 单独操作。

## Out of Scope

- 跨 workspace 批处理（仅单 workspace，多 workspace 是另一候选功能）。
- 批级依赖编排（任务间 DAG）——batch 是无依赖的独立任务集合。
- 批量取消/暂停的聚合命令（可逐 job 操作，或后续增强）。

## References

- `src/jobs.ts:createJob` — 单任务创建
- `src/queue.ts:configuredConcurrency` — 并发上限语义
- `.trellis/spec/backend/index.md` — queue/scheduler 契约
- `src/cli.ts` run 分支 — 任务参数解析与 mergeConfig 模式
