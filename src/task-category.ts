// 任务分类：路由分类加权的第一步——把任务文本确定性地归入一个意图类别。
// 纯启发式关键词匹配（规则 5：确定性转换交代码而非调 model），无 I/O 可单测。
// 分类结果持久化到 context.taskCategory，战绩层按 (executor × 分类) 聚合成功率，
// 路由同层决胜时优先用分类样本（agent 可能「修 bug 很行、做新功能不行」）。

export const TASK_CATEGORIES = [
  "bugfix",
  "performance",
  "refactor",
  "testing",
  "docs",
  "feature",
  "chore",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** 无规则命中的缺省类别：意图不明的常规杂务。 */
export const DEFAULT_TASK_CATEGORY: TaskCategory = "chore";

export function isTaskCategory(value: unknown): value is TaskCategory {
  return (
    typeof value === "string" &&
    (TASK_CATEGORIES as readonly string[]).includes(value)
  );
}

/** 规则顺序即优先级：先命中先归类（"修复"优先于"实现"——缺陷修复的表述
 *  常包含实现动词，反向则几乎不会发生；性能/重构在 feature 之前同理）。 */
const RULES: ReadonlyArray<readonly [TaskCategory, RegExp]> = [
  [
    "bugfix",
    /修复|修一下|改正|bug|缺陷|报错|异常|崩溃|挂了|坏了|错误|失败原因|回归|热修|hotfix|fix(?:ed|es|ing)?\b/i,
  ],
  [
    "performance",
    /性能|提速|太慢|很慢|卡顿|耗时|内存泄漏|memory leak|perf(?:ormance)?\b|latency|吞吐/i,
  ],
  [
    "refactor",
    /重构|重写|抽离|拆分|合并.*模块|清理.*实现|解耦|refactor(?:ing)?\b/i,
  ],
  [
    "testing",
    /补测试|添加测试|编写测试|单测|集成测试|测试覆盖|覆盖率|pytest|vitest|jest|playwright/i,
  ],
  ["docs", /文档|注释|README|CHANGELOG|使用说明|操作手册|docs?\b/i],
  [
    "feature",
    /实现|新增|添加|支持|接入|集成|开发|构建.*功能|feature\b|新增功能/i,
  ],
];

export function classifyTask(task: string): TaskCategory {
  for (const [category, pattern] of RULES)
    if (pattern.test(task)) return category;
  return DEFAULT_TASK_CATEGORY;
}
