import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// 执行器战绩层：把已持久化的任务结果（context.executor + state 终态与 tokenUsage）
// 聚合成 per-executor 战绩表，供 `cbx agents` 展示与 auto 路由同分决胜消费。
// 只读扫描 jobDir，不引入新的持久化状态——战绩永远反映当前任务历史，
// 被 purge 的任务自然从战绩中消失。规则 5：确定性聚合，不调 model。

export interface ExecutorStats {
  executor: string;
  /** 计入战绩的终态任务数（cancelled 不计：用户中止不是执行器的问题） */
  runs: number;
  done: number;
  /** done / runs；条目存在即 runs >= 1 */
  successRate: number;
  /** 有 tokenUsage 样本的任务均值；无样本为 null（不产出错误数字） */
  avgTokens: number | null;
  /** 任务墙钟均值（终态 updatedAt - createdAt，含测试/审查/重试的整任务时长）；
   *  归因到主执行 executor 的时延代理，fastest 策略选优依据。无有效样本为 null。 */
  avgDurationMs: number | null;
  /** 分类战绩（context.taskCategory × 终态）：agent 可能「修 bug 很行、做新功能不行」，
   *  路由分类加权的数据源。旧任务无分类时不进该桶（只进全局）。 */
  categories?: Record<string, { runs: number; done: number }>;
  /** 最近一次计入战绩的任务 updatedAt */
  lastUsedAt: string | null;
}

/** Laplace 平滑成功率 (done+1)/(runs+2)：无历史得中性先验 0.5，
 *  1 跑 1 成得 0.67、4 跑 0 成得 0.2——小样本不被极端化，供路由决胜排序。 */
export function smoothedSuccessRate(
  stats: ExecutorStats | undefined,
): number {
  if (!stats || stats.runs === 0) return 0.5;
  return (stats.done + 1) / (stats.runs + 2);
}

/** 计入战绩的终态：done/failed/needs_fix/review_failed。
 *  cancelled 排除（用户中止）；queued/running/awaiting_approval 未有结论，排除。 */
const STATS_TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "needs_fix",
  "review_failed",
]);

interface StatsAccumulator {
  runs: number;
  done: number;
  tokensSum: number;
  tokensCount: number;
  durationSum: number;
  durationCount: number;
  categories: Map<string, { runs: number; done: number }>;
  lastUsedAt: string | null;
}

/** 任务墙钟：终态 updatedAt - createdAt。时钟回拨/缺字段/超长（> 30 天视为脏数据）返回 null。 */
function jobDurationMs(state: Record<string, unknown>): number | null {
  if (typeof state.createdAt !== "string" || typeof state.updatedAt !== "string")
    return null;
  const duration =
    Date.parse(state.updatedAt) - Date.parse(state.createdAt);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30 * 24 * 3600_000)
    return null;
  return duration;
}

/**
 * 扫描 workspace 的 .cbx/jobs/<jobId>/{state,context}.json 聚合 per-executor 战绩。
 * 缺文件或损坏的任务直接跳过（不影响其余任务）；目录不存在返回空表。
 * 任务量 = 一次全量 readdir + 每 job 两次小文件读，与 `cbx list` 同量级；
 * 路由每次任务创建调用一次，无需缓存。
 */
export async function collectExecutorStats(
  workspaceInput: string,
): Promise<Map<string, ExecutorStats>> {
  const workspace = path.resolve(workspaceInput);
  const root = path.join(workspace, ".cbx", "jobs");
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const acc = new Map<string, StatsAccumulator>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let state: Record<string, unknown>;
    let context: Record<string, unknown>;
    try {
      state = JSON.parse(
        await readFile(path.join(root, entry.name, "state.json"), "utf8"),
      );
      context = JSON.parse(
        await readFile(path.join(root, entry.name, "context.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (
      typeof state.status !== "string" ||
      !STATS_TERMINAL_STATUSES.has(state.status)
    )
      continue;
    // 归因键 = 主执行 executor。路由层在任务创建时已把解析结果写入 context.executor，
    // 理论上不会是 "auto"；防御性跳过以免把战绩记到保留字头上。
    const executor = context.executor;
    if (typeof executor !== "string" || !executor || executor === "auto")
      continue;
    const record =
      acc.get(executor) ??
      ({ runs: 0, done: 0, tokensSum: 0, tokensCount: 0, durationSum: 0, durationCount: 0, categories: new Map(), lastUsedAt: null } as StatsAccumulator);
    record.runs += 1;
    if (state.status === "done") record.done += 1;
    if (typeof context.taskCategory === "string" && context.taskCategory) {
      const bucket = record.categories.get(context.taskCategory) ?? {
        runs: 0,
        done: 0,
      };
      bucket.runs += 1;
      if (state.status === "done") bucket.done += 1;
      record.categories.set(context.taskCategory, bucket);
    }
    if (
      typeof state.tokenUsage === "number" &&
      Number.isFinite(state.tokenUsage) &&
      state.tokenUsage > 0
    ) {
      record.tokensSum += state.tokenUsage;
      record.tokensCount += 1;
    }
    const duration = jobDurationMs(state);
    if (duration !== null) {
      record.durationSum += duration;
      record.durationCount += 1;
    }
    if (typeof state.updatedAt === "string") {
      if (!record.lastUsedAt || state.updatedAt > record.lastUsedAt)
        record.lastUsedAt = state.updatedAt;
    }
    acc.set(executor, record);
  }
  const out = new Map<string, ExecutorStats>();
  for (const [executor, record] of acc) {
    out.set(executor, {
      executor,
      runs: record.runs,
      done: record.done,
      successRate: record.done / record.runs,
      avgTokens: record.tokensCount
        ? Math.round(record.tokensSum / record.tokensCount)
        : null,
      avgDurationMs: record.durationCount
        ? Math.round(record.durationSum / record.durationCount)
        : null,
      categories: record.categories.size
        ? Object.fromEntries(record.categories)
        : undefined,
      lastUsedAt: record.lastUsedAt,
    });
  }
  return out;
}
