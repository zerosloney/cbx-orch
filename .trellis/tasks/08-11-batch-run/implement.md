# Implement: 任务批处理 batch run

## 执行顺序

按 1 → 2 → 3 顺序，每步验证后进入下一步。

---

## Step 1: batch 核心模块（`src/batch.ts`）

**新增文件** `src/batch.ts`，导出纯函数 + 编排函数：

```typescript
export interface BatchTask { task: string; }

/** 按 maxBatch 分片；maxBatch<=0 或 >= total 时单片全量。 */
export function chunkBatch(
  tasks: BatchTask[],
  maxBatch: number,
): BatchTask[][];

/** 汇总：按终态分类计数。TERMINAL = done/failed/review_failed/cancelled/needs_fix */
export function summarizeBatch(
  results: Array<{ jobId: string; task: string; status: string }>,
): { total: number; finished: number; succeeded: number; failed: number; unfinished: string[] };
```

**编排函数** `runBatch`：

```typescript
export async function runBatch(params: {
  workspace: string;
  tasks: string[];                 // 任务描述列表
  maxBatch: number;
  wait: boolean;
  waitTimeoutMs: number;
  jobOptions: Parameters<typeof createJob>[0] & { jobId?: string };  // 透传
}): Promise<BatchSummary>;
```

- 每任务 `createJob({ ...jobOptions, task, jobId: batch-<ts>-<seq> })` + `startBackground`。
- `maxBatch` 分片：波次间等上一波全部终态（轮询 `loadState`）。
- `wait`：全部任务入队后轮询到终态或超时。

**验证**：
```bash
npm run build
node --test dist/tests/batch.test.js   # chunk 分片 + summarize 纯函数单测
```

---

## Step 2: CLI `cbx batch` 命令（`src/cli.ts`）

**改动**：
1. `--task`/`--task-file` 已支持重复（`parseCliArgs.all()`），`--max-batch`/`--wait`/`--wait-timeout-ms` 加 `VALUE_OPTIONS`（`--wait` 是布尔开关不用加）。
2. 命令分发加 `batch` 分支：
   - 收集 tasks（`parsed.all("--task")` + `--task-file` 读取）
   - 至少 1 个，否则报错
   - `--job-id` 在 batch 下拒绝（多任务无法共用）
   - 调 `runBatch`，打印逐 job 创建 + 最终 `print(summary)`
3. usage 行加 `batch`。

**验证**：
```bash
npm run build
node --test dist/tests/batch.test.js   # CLI 端到端
```

---

## Step 3: 测试补全 + README + CHANGELOG

**测试**（`tests/batch.test.ts`）：
- chunk 分片边界（maxBatch 0/1/2/>total）
- summarize 聚合（成功/失败/未完成）
- CLI 端到端：2 任务创建 + 汇总；`--max-batch 1` 波次（fake agent 快速终态验证顺序）；无任务报错；`--wait` 汇总；`--executor` 透传

**文档**：README 加 `cbx batch` 说明；CHANGELOG 记录。

**验证**：
```bash
npm run lint
npm test
npx prettier --check <改动文件>
git diff --check
```

## 回滚点

- Step 1 回滚：删 `src/batch.ts`。
- Step 2 回滚：revert `src/cli.ts`（batch 分支）+ `cli-args.ts`（若有新增选项）。
- 无持久化/配置变更，回滚零副作用。

## Review Gate

- chunk 分片正确（maxBatch 语义：0=全量一次性，N=每波 N 个）
- wave 等待只等批内任务（不误等无关 job）
- `--wait` 汇总终态计数准确；超时返回 unfinished + 非零退出
- 批任务与普通任务同构（可独立 retry/continue）
