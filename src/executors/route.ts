import { discoverAgents, type AgentProbe } from "../agent-registry.js";

// Agent 路由层：把「创建任务时声明委派一个 executor」升级为「执行前先路由」。
// executor 为保留字 ROUTE_AUTO（"auto"）时，按 agent spec 声明的 capabilities 能力标签
// 与任务文本做确定性词频匹配打分，从已探测可用（available=true）的 agent 中选最合适的；
// 声明式执行器（显式指定名字）永远优先，路由只兜底「未指定/指定 auto」的任务（渐进式，向后兼容）。
// 路由打分是纯函数（无 I/O、无 LLM），可单测；规则 5：确定性转换交代码而非调 model。

/** executor / reviewExecutor 的保留字：触发路由层解析。 */
export const ROUTE_AUTO = "auto";

export interface RouteRank {
  name: string;
  label: string;
  score: number;
  /** 命中的能力标签（出现在任务文本中的），空表示该 agent 无命中 */
  hits: string[];
}

export interface RouteDecision {
  /** 最终选中的 executor（注册名） */
  executor: string;
  label: string;
  /** 选中 agent 的原始分数（命中能力数） */
  score: number;
  ranked: RouteRank[];
  /** 路由说明：命中标签 / 排除回退原因，供审计落盘 */
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

function decide(
  task: string,
  probes: AgentProbe[],
  exclude: ReadonlySet<string>,
): RouteDecision | undefined {
  const ranked = rank(task, probes, exclude);
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
  notes.push(`命中能力：${top.hits.join(",")}；按能力词频匹配得分最高。`);
  return { executor: top.name, label: top.label, score: top.score, ranked, notes };
}

/**
 * 为任务路由主执行 agent：只在可用且能力命中时返回决策。
 * @returns 未命中任何可用 agent（或无可路由候选）时 undefined，调用方回退默认执行器。
 */
export async function routeStageExecutor(
  request: { task: string; workspace: string; exclude?: string[] },
): Promise<RouteDecision | undefined> {
  const { probes } = await discoverAgents(request.workspace);
  return decide(request.task, probes, new Set(request.exclude ?? []));
}

/**
 * 为独立审查路由交叉验证 agent：排除主执行 agent（避免「自己审自己」）。
 * 若无可用且能力命中的另一 agent，返回 undefined —— 调用方回退主执行 agent 自审。
 */
export async function routeReviewExecutor(
  request: { task: string; workspace: string; primary: string },
): Promise<RouteDecision | undefined> {
  const { probes } = await discoverAgents(request.workspace);
  const exclude = new Set<string>([request.primary]);
  // 主执行 agent 不在能力候选里（ESM 插件 / 不可路由）时，不排除同名，允许选能力命中的其它 agent。
  const primaryIsCandidate = probes.some(
    (p) => p.available && p.name === request.primary,
  );
  return decide(request.task, probes, primaryIsCandidate ? exclude : new Set());
}