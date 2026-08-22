import { discoverAgents, type AgentProbe } from "../agent-registry.js";
import { classifyTask, type TaskCategory } from "../task-category.js";
import {
  collectExecutorStats,
  smoothedSuccessRate,
  type ExecutorStats,
} from "./stats.js";

// Agent 路由层：把「创建任务时声明委派一个 executor」升级为「执行前先路由」。
// executor 为保留字 ROUTE_AUTO（"auto"）时，按 agent spec 声明的 capabilities 能力标签
// 与任务文本做确定性词频匹配打分，从已探测可用（available=true）的 agent 中选最合适的；
// 声明式执行器（显式指定名字）永远优先，路由只兜底「未指定/指定 auto」的任务（渐进式，向后兼容）。
// 路由打分是纯函数（无 I/O、无 LLM），可单测；规则 5：确定性转换交代码而非调 model。
// 能力分只是第一排序键：同分时按历史战绩决胜（Laplace 平滑成功率 → 均值 token），
// 路由从「查表」升级为「看历史」；无历史的 agent 得中性先验 0.5，不会被惩罚性排除。

/** executor / reviewExecutor 的保留字：触发路由层解析。 */
export const ROUTE_AUTO = "auto";

/** 路由策略：best=战绩决胜（缺省）；cheapest/fastest=能力同层内按成本/时延选优。 */
export const ROUTING_STRATEGIES = ["best", "cheapest", "fastest"] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return (
    typeof value === "string" &&
    (ROUTING_STRATEGIES as readonly string[]).includes(value)
  );
}

export function parseRoutingStrategy(value: unknown): RoutingStrategy {
  if (!isRoutingStrategy(value))
    throw new Error(
      `未知路由策略。可选值：${ROUTING_STRATEGIES.join("、")}。`,
    );
  return value;
}

export interface RouteRank {
  name: string;
  label: string;
  score: number;
  /** 命中的能力标签（出现在任务文本中的），空表示该 agent 无命中 */
  hits: string[];
  /** 该 agent 的历史战绩投影（无历史为 undefined），供审计落盘与 `cbx agents` 展示 */
  stats?: {
    runs: number;
    successRate: number;
    avgTokens: number | null;
    avgDurationMs: number | null;
  };
}

export interface RouteDecision {
  /** 最终选中的 executor（注册名） */
  executor: string;
  label: string;
  /** 选中 agent 的原始分数（命中能力数） */
  score: number;
  ranked: RouteRank[];
  /** 路由说明：命中标签 / 战绩决胜 / 排除回退原因，供审计落盘 */
  notes: string[];
}

/** 能力标签与任务文本的匹配分数：大小写不敏感命中计 1（启发式，非精确分类）。
 *  ASCII 单 token 用词边界避免 "python" 命中 "pythonista"；多 token 短语或含非 ASCII
 *  （中文等）的能力串走整串包含匹配（\b 仅定义在 ASCII \w 之间，中文永远是"非词边界"，无法用 \b）。 */
export function scoreTaskAgainstCapabilities(
  task: string,
  capabilities: string[] | undefined,
): { score: number; hits: string[] } {
  if (!capabilities?.length) return { score: 0, hits: [] };
  const text = task.toLowerCase();
  const hits: string[] = [];
  for (const capability of capabilities) {
    const needle = capability.toLowerCase().trim();
    if (!needle) continue;
    const pureAscii = /^[\x20-\x7E]+$/.test(needle);
    const matched =
      needle.includes(" ") || !pureAscii
        ? text.includes(needle)
        : new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(text);
    if (matched) hits.push(capability);
  }
  return { score: hits.length, hits };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rank(
  task: string,
  probes: AgentProbe[],
  exclude: ReadonlySet<string>,
): RouteRank[] {
  const ranked: RouteRank[] = [];
  for (const probe of probes) {
    if (!probe.available || exclude.has(probe.name)) continue;
    const { score, hits } = scoreTaskAgainstCapabilities(task, probe.capabilities);
    ranked.push({ name: probe.name, label: probe.label, score, hits });
  }
  // 稳定性：score 降序，同分保持 discoverAgents 顺序（builtin 先行、文件按名排序）。
  return ranked.sort((a, b) => b.score - a.score);
}

/** 分类感知成功率：优先 (executor × 任务分类) 的平滑成功率，无分类样本回退全局，
 *  无历史回退中性先验。agent 可能「修 bug 很行、做新功能不行」——分类样本比全局
 *  更能反映本次任务的契合度；分类口径与全局同为 Laplace 平滑。 */
function categoryAwareRate(
  name: string,
  category: TaskCategory,
  stats: ReadonlyMap<string, ExecutorStats>,
): { rate: number; basis: "category" | "global" | "prior" } {
  const record = stats.get(name);
  const bucket = record?.categories?.[category];
  if (bucket)
    return { rate: (bucket.done + 1) / (bucket.runs + 2), basis: "category" };
  if (record) return { rate: smoothedSuccessRate(record), basis: "global" };
  return { rate: 0.5, basis: "prior" };
}

/** 战绩决胜比较：分类感知成功率降序 → 均值 token 升序 → 均值时长升序（null 视为未知排最后）。
 *  只在同能力分内比较，返回负数表示 a 优先。 */
function compareByStats(
  a: RouteRank,
  b: RouteRank,
  stats: ReadonlyMap<string, ExecutorStats>,
  category: TaskCategory,
): number {
  const rateA = categoryAwareRate(a.name, category, stats).rate;
  const rateB = categoryAwareRate(b.name, category, stats).rate;
  if (rateA !== rateB) return rateB - rateA;
  const tokensA = stats.get(a.name)?.avgTokens ?? Number.POSITIVE_INFINITY;
  const tokensB = stats.get(b.name)?.avgTokens ?? Number.POSITIVE_INFINITY;
  if (tokensA !== tokensB) return tokensA - tokensB;
  const durationA = stats.get(a.name)?.avgDurationMs ?? Number.POSITIVE_INFINITY;
  const durationB = stats.get(b.name)?.avgDurationMs ?? Number.POSITIVE_INFINITY;
  return durationA - durationB;
}

function describeStats(
  name: string,
  stats: ReadonlyMap<string, ExecutorStats>,
  category?: TaskCategory,
): string {
  const entry = stats.get(name);
  if (!entry) return `${name} 无历史`;
  const duration =
    entry.avgDurationMs != null
      ? `，均 ${(entry.avgDurationMs / 1000).toFixed(0)}s`
      : "";
  const scoped =
    category && entry.categories?.[category]
      ? `，${category} ${entry.categories[category].done}/${entry.categories[category].runs}`
      : "";
  return `${name} ${entry.done}/${entry.runs} 成（平滑 ${smoothedSuccessRate(entry).toFixed(2)}${scoped}，均 token ${entry.avgTokens ?? "?"}${duration}）`;
}

function decide(
  task: string,
  probes: AgentProbe[],
  exclude: ReadonlySet<string>,
  stats: ReadonlyMap<string, ExecutorStats>,
  strategy: RoutingStrategy,
): RouteDecision | undefined {
  const category = classifyTask(task);
  const ranked = rank(task, probes, exclude).map((entry) => {
    const record = stats.get(entry.name);
    return record
      ? {
          ...entry,
          stats: {
            runs: record.runs,
            successRate: record.successRate,
            avgTokens: record.avgTokens,
            avgDurationMs: record.avgDurationMs,
          },
        }
      : entry;
  });
  const top = ranked.find((entry) => entry.score > 0);
  const notes: string[] = [];
  if (!top) {
    const available = ranked.length;
    notes.push(
      `无可用 agent 命中任务能力标签${exclude.size ? `（已排除 ${[...exclude].join(",")}）` : ""}` +
        (available ? `，${available} 个可用 agent 能力均不匹配。` : "，无可用 agent。"),
    );
    return undefined;
  }
  // 策略窗口 = 最高能力分层（能力契合不可被成本/时延偏好交换；策略只在同层内选优）。
  const tier = ranked.filter((entry) => entry.score === top.score);
  const winner = pickByStrategy(tier, stats, strategy, notes, category);
  notes.push(`命中能力：${top.hits.join(",")}；按能力词频匹配得分最高。任务分类：${category}。`);
  // 决胜审计：战绩参与同层选择时说明依据（全员无历史走稳定性顺序，不产生噪音 note）。
  if (tier.length > 1 && tier.some((entry) => stats.has(entry.name))) {
    const losers = tier.filter((entry) => entry !== winner);
    notes.push(
      `能力同层决胜（${tier.length} 个并列，策略 ${strategy}，分类 ${category}）：${describeStats(winner.name, stats, category)} 优先于 ${losers.map((entry) => describeStats(entry.name, stats, category)).join("、")}。`,
    );
  }
  return { executor: winner.name, label: winner.label, score: winner.score, ranked, notes };
}

/** 「有证据的彻底坏」：跑过多次一次没成——它的便宜/快是假象（立刻失败当然便宜）。
 *  cheapest/fastest 把这类 agent 从候选中剔除；best 的平滑成功率天然压低它。 */
function demonstratedBroken(entry: ExecutorStats): boolean {
  return entry.runs >= 2 && entry.done === 0;
}

/** cheapest/fastest：同层内按目标指标升序；无该指标样本（未知成本/时长或已被剔除）的 agent 排后。
 *  全层都无样本时降级为 best 决胜（说明记入 notes）——不为优化指标牺牲可解释性。 */
function pickByStrategy(
  tier: RouteRank[],
  stats: ReadonlyMap<string, ExecutorStats>,
  strategy: RoutingStrategy,
  notes: string[],
  category: TaskCategory,
): RouteRank {
  const pickByBest = () =>
    tier.reduce((best, entry) =>
      compareByStats(entry, best, stats, category) < 0 ? entry : best,
    );
  if (strategy === "best") return pickByBest();
  const metricLabel =
    strategy === "cheapest" ? "均值 token" : "平均任务墙钟";
  const metric = (entry: RouteRank): number | null => {
    const record = stats.get(entry.name);
    if (!record || demonstratedBroken(record)) return null;
    const value =
      strategy === "cheapest" ? record.avgTokens : record.avgDurationMs;
    return typeof value === "number" ? value : null;
  };
  const eligible = tier.filter((entry) => metric(entry) !== null);
  if (eligible.length === 0) {
    notes.push(
      `策略 ${strategy}：同层 agent 均无${metricLabel}样本，降级为战绩决胜。`,
    );
    return pickByBest();
  }
  const pick = eligible.reduce((best, entry) =>
    metric(entry)! < metric(best)! ? entry : best,
  );
  const unknown = tier
    .filter((entry) => entry !== pick && metric(entry) === null)
    .map((entry) => entry.name);
  notes.push(
    `策略 ${strategy}：同层按${metricLabel}升序选 ${pick.name}（${metric(pick)}）${unknown.length ? `；无样本/被剔除：${unknown.join("、")}` : ""}。`,
  );
  return pick;
}

/**
 * 为任务路由主执行 agent：只在可用且能力命中时返回决策。
 * @returns 未命中任何可用 agent（或无可路由候选）时 undefined，调用方回退默认执行器。
 */
export async function routeStageExecutor(
  request: {
    task: string;
    workspace: string;
    exclude?: string[];
    strategy?: RoutingStrategy;
  },
): Promise<RouteDecision | undefined> {
  const { probes } = await discoverAgents(request.workspace);
  const stats = await collectExecutorStats(request.workspace);
  return decide(
    request.task,
    probes,
    new Set(request.exclude ?? []),
    stats,
    request.strategy ?? "best",
  );
}

/**
 * 为独立审查路由交叉验证 agent：排除主执行 agent（避免「自己审自己」）。
 * 若无可用且能力命中的另一 agent，返回 undefined —— 调用方回退主执行 agent 自审。
 */
export async function routeReviewExecutor(
  request: { task: string; workspace: string; primary: string },
): Promise<RouteDecision | undefined> {
  const { probes } = await discoverAgents(request.workspace);
  const stats = await collectExecutorStats(request.workspace);
  const exclude = new Set<string>([request.primary]);
  // 主执行 agent 不在能力候选里（ESM 插件 / 不可路由）时，不排除同名，允许选能力命中的其它 agent。
  const primaryIsCandidate = probes.some(
    (p) => p.available && p.name === request.primary,
  );
  return decide(
    request.task,
    probes,
    primaryIsCandidate ? exclude : new Set(),
    stats,
    "best",
  );
}
