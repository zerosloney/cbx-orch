// 任务批处理：批量创建并（可选）等待多个独立任务。
// 复用 createJob + startBackground，不触碰编排核心；批任务与普通任务同构。

import { createJob, startBackground } from "./core.js";
import { loadState } from "./state.js";

/** 任务终态集合：--wait 时等待这些状态。 */
export const BATCH_TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "review_failed",
  "cancelled",
  "needs_fix",
]);

export interface BatchTask {
  task: string;
}

/** 按 maxBatch 分片；maxBatch<=0 或 >= total 时单片全量（一次入队）。 */
export function chunkBatch(
  tasks: BatchTask[],
  maxBatch: number,
): BatchTask[][] {
  if (tasks.length === 0) return [];
  if (maxBatch <= 0 || maxBatch >= tasks.length) return [tasks];
  const chunks: BatchTask[][] = [];
  for (let i = 0; i < tasks.length; i += maxBatch)
    chunks.push(tasks.slice(i, i + maxBatch));
  return chunks;
}

export interface BatchJobResult {
  jobId: string;
  task: string;
  status: string;
}

/** 汇总：按终态分类计数。 */
export function summarizeBatch(results: BatchJobResult[]): {
  total: number;
  finished: number;
  succeeded: number;
  failed: number;
  unfinished: string[];
} {
  const succeeded = results.filter((r) => r.status === "done").length;
  const finished = results.filter((r) =>
    BATCH_TERMINAL_STATUSES.has(r.status),
  ).length;
  const failed = results.filter(
    (r) => BATCH_TERMINAL_STATUSES.has(r.status) && r.status !== "done",
  ).length;
  const unfinished = results
    .filter((r) => !BATCH_TERMINAL_STATUSES.has(r.status))
    .map((r) => r.jobId);
  return { total: results.length, finished, succeeded, failed, unfinished };
}

// intentional-simple: tsconfig target 为 ES2022，Promise.withResolvers（ES2024）不可用；sleep 用 executor 形式。
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待单个 job 达终态（轮询 loadState）。 */
async function waitForTerminal(
  workspace: string,
  jobId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await loadState(workspace, jobId);
    if (BATCH_TERMINAL_STATUSES.has(state.status)) return state.status;
    if (Date.now() >= deadline) return state.status;
    await sleep(500);
  }
}

export interface RunBatchParams {
  workspace: string;
  tasks: string[];
  maxBatch: number;
  wait: boolean;
  waitTimeoutMs: number;
  /** 透传给 createJob 的公共选项（不含 task/jobId）。 */
  jobOptions: Omit<
    Parameters<typeof createJob>[0],
    "workspace" | "task" | "jobId"
  >;
}

export interface BatchSummary {
  total: number;
  created: number;
  jobs: Array<{ jobId: string; task: string; status: string }>;
  finished?: number;
  succeeded?: number;
  failed?: number;
  unfinished?: string[];
}

/** 批量创建任务；maxBatch 分片时波间等待上一波终态。返回汇总。 */
export async function runBatch(params: RunBatchParams): Promise<BatchSummary> {
  const tasks: BatchTask[] = params.tasks.map((task) => ({ task }));
  const waves = chunkBatch(tasks, params.maxBatch);
  const jobs: BatchJobResult[] = [];
  const ts = Date.now().toString(36);
  let seq = 0;

  for (const wave of waves) {
    const waveJobs: BatchJobResult[] = [];
    for (const t of wave) {
      seq += 1;
      const jobId = `batch-${ts}-${seq}`;
      const created = await createJob({
        workspace: params.workspace,
        task: t.task,
        jobId,
        ...params.jobOptions,
      });
      await startBackground(params.workspace, created.jobId);
      waveJobs.push({ jobId: created.jobId, task: t.task, status: "queued" });
    }
    jobs.push(...waveJobs);
    // 波间等待：上一波全部达终态再入下一波（batch 专属并发控制，不碰全局 maxConcurrent）。
    if (waves.length > 1)
      await Promise.all(
        waveJobs.map((j) =>
          waitForTerminal(params.workspace, j.jobId, params.waitTimeoutMs),
        ),
      );
  }

  const summary: BatchSummary = {
    total: jobs.length,
    created: jobs.length,
    jobs,
  };
  if (params.wait) {
    // 全部入队后等待终态（若 maxBatch 分片已等待过，此处补足剩余）。
    const waited = await Promise.all(
      jobs.map((j) =>
        waitForTerminal(params.workspace, j.jobId, params.waitTimeoutMs),
      ),
    );
    const results = jobs.map((j, i) => ({
      ...j,
      status: waited[i],
    }));
    const agg = summarizeBatch(results);
    summary.jobs = results;
    summary.finished = agg.finished;
    summary.succeeded = agg.succeeded;
    summary.failed = agg.failed;
    summary.unfinished = agg.unfinished;
  }
  return summary;
}
