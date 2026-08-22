import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import { isMissing } from "./file-utils.js";
import {
  validateExecutionProfile,
  type ExecutionProfile,
} from "./profile.js";
import { isRoutingStrategy, type RoutingStrategy } from "./executors/route.js";

export interface TaskTemplate {
  task: string;
  test?: string;
  review?: boolean;
  executor?: string;
  isolated?: boolean;
  profile?: ExecutionProfile;
  routingStrategy?: RoutingStrategy;
}

export interface RuntimeConfig {
  profile?: ExecutionProfile;
  testCommand?: string;
  review?: boolean;
  isolated?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  maxTurns?: number;
  keepWorktree?: boolean;
  permissionMode?: string;
  reviewRules?: string;
  approval?: { beforeRun?: boolean; beforeComplete?: boolean };
  maxConcurrent?: number;
  git?: { autoBranch?: boolean; autoCommit?: boolean; commitMessage?: string };
  ci?: { failOnReview?: boolean };
  executor?: string;
  reviewExecutor?: string;
  /** auto 路由策略：best（战绩决胜，缺省）/ cheapest（同层按均值 token）/ fastest（同层按任务墙钟） */
  routingStrategy?: RoutingStrategy;
  /** 模型选择（任务级可覆盖）；仅在 agent spec 声明 modelArg 时追加到 CLI 参数 */
  model?: string;
  templates?: Record<string, TaskTemplate>;
  execution?: {
    trustMode?: "trusted" | "untrusted";
    /** ESM runner 插件路径（`cbx.runner/v1`）：接管 executor/test/review 命令的进程执行。
     *  配置后 untrusted 信任模式放行——由插件提供容器级隔离，cbx 自身保持零依赖。 */
    runner?: string;
  };
  plugins?: {
    enforce?: boolean;
    allowPaths?: string[];
    allowSha256?: string[];
  };
  notifications?: {
    webhook?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    filters?: {
      events?: string[];
      jobIds?: string[];
      statuses?: string[];
    };
  };
  telemetry?: {
    enabled?: boolean;
    endpoint?: string;
    serviceName?: string;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
  };
  governance?: {
    retentionDays?: number;
    /** 启用后，超过 retentionDays 的已终态任务（state/产物/worktree）会被自动清理。
     *  默认 false——保留策略涉及删除数据，必须显式开启。 */
    pruneJobs?: boolean;
    redactFields?: string[];
    redactPatterns?: string[];
  };
  reviewGate?: { enabled?: boolean };
  adaptive?: {
    enabled?: boolean;
    maxRounds?: number;
    managerExecutor?: string;
  };
  dependencyGuard?: boolean;
  ui?: { token?: string };
  context?: {
    tokenBudget?: { manager?: number; executor?: number; auditor?: number };
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} 必须是对象。`);
  return value as Record<string, unknown>;
}
function known(
  value: Record<string, unknown>,
  name: string,
  keys: string[],
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${name} 不支持字段：${key}`);
}
function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error(`${name} 必须是布尔值。`);
}
function optionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim()))
    throw new Error(`${name} 必须是非空字符串。`);
}
function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum)
  )
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
}

/** Strict runtime validation prevents unknown policy fields from silently weakening controls. */
export async function loadRuntimeConfig(
  workspaceInput: string,
): Promise<RuntimeConfig> {
  const workspace = path.resolve(workspaceInput);
  const file = path.join(workspace, ".cbx.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  const config = object(parsed, ".cbx.json");
  known(config, ".cbx.json", [
    "profile",
    "testCommand",
    "review",
    "isolated",
    "timeoutMs",
    "maxRetries",
    "maxTurns",
    "keepWorktree",
    "permissionMode",
    "reviewRules",
    "approval",
    "maxConcurrent",
    "git",
    "ci",
    "executor",
    "reviewExecutor",
    "routingStrategy",
    "model",
    "execution",
    "plugins",
    "notifications",
    "telemetry",
    "governance",
    "reviewGate",
    "adaptive",
    "dependencyGuard",
    "ui",
    "context",
    "templates",
  ]);
  if (config.profile !== undefined) validateExecutionProfile(config.profile);
  optionalString(config.testCommand, "testCommand");
  optionalBoolean(config.review, "review");
  optionalBoolean(config.isolated, "isolated");
  optionalInteger(config.timeoutMs, "timeoutMs", 100);
  optionalInteger(config.maxRetries, "maxRetries", 0);
  optionalInteger(config.maxTurns, "maxTurns", 1);
  optionalBoolean(config.keepWorktree, "keepWorktree");
  optionalString(config.permissionMode, "permissionMode");
  optionalString(config.reviewRules, "reviewRules");
  optionalInteger(config.maxConcurrent, "maxConcurrent", 1);
  optionalString(config.executor, "executor");
  optionalString(config.reviewExecutor, "reviewExecutor");
  if (
    config.routingStrategy !== undefined &&
    !isRoutingStrategy(config.routingStrategy)
  )
    throw new Error("routingStrategy 必须是 best、cheapest 或 fastest。");
  optionalString(config.model, "model");
  optionalBoolean(config.dependencyGuard, "dependencyGuard");
  if (config.approval !== undefined) {
    const value = object(config.approval, "approval");
    known(value, "approval", ["beforeRun", "beforeComplete"]);
    optionalBoolean(value.beforeRun, "approval.beforeRun");
    optionalBoolean(value.beforeComplete, "approval.beforeComplete");
  }
  if (config.git !== undefined) {
    const value = object(config.git, "git");
    known(value, "git", ["autoBranch", "autoCommit", "commitMessage"]);
    optionalBoolean(value.autoBranch, "git.autoBranch");
    optionalBoolean(value.autoCommit, "git.autoCommit");
    optionalString(value.commitMessage, "git.commitMessage");
  }
  if (config.ci !== undefined) {
    const value = object(config.ci, "ci");
    known(value, "ci", ["failOnReview"]);
    optionalBoolean(value.failOnReview, "ci.failOnReview");
  }
  if (config.execution !== undefined) {
    const value = object(config.execution, "execution");
    known(value, "execution", ["trustMode", "runner"]);
    if (
      value.trustMode !== undefined &&
      value.trustMode !== "trusted" &&
      value.trustMode !== "untrusted"
    )
      throw new Error("execution.trustMode 必须是 trusted 或 untrusted。");
    if (value.runner !== undefined && typeof value.runner !== "string")
      throw new Error("execution.runner 必须是字符串（ESM 插件路径）。");
  }
  if (config.plugins !== undefined) {
    const value = object(config.plugins, "plugins");
    known(value, "plugins", ["enforce", "allowPaths", "allowSha256"]);
    optionalBoolean(value.enforce, "plugins.enforce");
    // 收紧默认策略：显式声明 plugins 即表示使用 executor 插件，默认强制校验。
    if (value.enforce === undefined) value.enforce = true;
    for (const key of ["allowPaths", "allowSha256"] as const)
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some((item) => typeof item !== "string" || !item.trim()))
      )
        throw new Error(`plugins.${key} 必须是非空字符串数组。`);
    const hashes = value.allowSha256 as string[] | undefined;
    if (
      hashes !== undefined &&
      hashes.some((hash) => !/^[a-fA-F0-9]{64}$/.test(hash))
    )
      throw new Error("plugins.allowSha256 必须是 SHA-256 十六进制摘要。");
  }
  for (const [name, fields] of [
    [
      "notifications",
      ["webhook", "timeoutMs", "maxRetries", "retryBaseMs", "filters"],
    ],
    [
      "telemetry",
      [
        "enabled",
        "endpoint",
        "serviceName",
        "timeoutMs",
        "maxRetries",
        "retryBaseMs",
      ],
    ],
  ] as const) {
    const raw = config[name];
    if (raw === undefined) continue;
    const value = object(raw, name);
    known(value, name, fields as unknown as string[]);
    optionalString(value.webhook, "notifications.webhook");
    optionalString(value.endpoint, "telemetry.endpoint");
    optionalBoolean(value.enabled, `${name}.enabled`);
    optionalString(value.serviceName, `${name}.serviceName`);
    if (
      name === "telemetry" &&
      value.enabled === true &&
      value.endpoint === undefined
    )
      throw new Error("telemetry.enabled=true 时必须提供 telemetry.endpoint。");
    optionalInteger(value.timeoutMs, `${name}.timeoutMs`, 50, 120_000);
    optionalInteger(value.maxRetries, `${name}.maxRetries`, 0, 10);
    if (
      value.retryBaseMs !== undefined &&
      (typeof value.retryBaseMs !== "number" || value.retryBaseMs < 0)
    )
      throw new Error(`${name}.retryBaseMs 必须是非负数。`);
    // notifications.filters：webhook 事件订阅过滤（仅 notifications 有）。
    if (name === "notifications" && value.filters !== undefined) {
      const filters = object(value.filters, "notifications.filters");
      known(filters, "notifications.filters", ["events", "jobIds", "statuses"]);
      for (const key of ["events", "jobIds", "statuses"] as const) {
        if (
          filters[key] !== undefined &&
          (!Array.isArray(filters[key]) ||
            filters[key].length < 1 ||
            filters[key].some(
              (item) => typeof item !== "string" || !item.trim(),
            ))
        )
          throw new Error(
            `notifications.filters.${key} 必须是非空字符串数组。`,
          );
      }
    }
  }
  if (config.governance !== undefined) {
    const value = object(config.governance, "governance");
    known(value, "governance", [
      "retentionDays",
      "pruneJobs",
      "redactFields",
      "redactPatterns",
    ]);
    optionalInteger(value.retentionDays, "governance.retentionDays", 1, 3650);
    optionalBoolean(value.pruneJobs, "governance.pruneJobs");
    if (
      value.redactFields !== undefined &&
      (!Array.isArray(value.redactFields) ||
        value.redactFields.length > 100 ||
        value.redactFields.some(
          (field) => typeof field !== "string" || !field.trim(),
        ))
    )
      throw new Error("governance.redactFields 必须是最多 100 个非空字符串。");
    // intentional-simple: redactPatterns 只做语法校验（new RegExp 不抛即过），无 catastrophic backtracking 检测；
    // 配置来自工作区所有者（同信任域），ReDoS 风险低。升级路径：引入 safe-regex 类启发式检测。
    if (value.redactPatterns !== undefined) {
      if (
        !Array.isArray(value.redactPatterns) ||
        value.redactPatterns.length > 100
      )
        throw new Error(
          "governance.redactPatterns 必须是最多 100 个正则字符串。",
        );
      for (const pattern of value.redactPatterns) {
        if (typeof pattern !== "string" || !pattern.trim())
          throw new Error("governance.redactPatterns 必须是非空正则字符串。");
        try {
          new RegExp(pattern);
        } catch {
          throw new Error(`governance.redactPatterns 包含无效正则：${pattern}`);
        }
      }
    }
  }
  if (config.reviewGate !== undefined) {
    const value = object(config.reviewGate, "reviewGate");
    known(value, "reviewGate", ["enabled"]);
    optionalBoolean(value.enabled, "reviewGate.enabled");
  }
  if (config.adaptive !== undefined) normalizeAdaptiveOptions(config.adaptive);
  if (config.ui !== undefined) {
    const value = object(config.ui, "ui");
    known(value, "ui", ["token"]);
    optionalString(value.token, "ui.token");
  }
  if (config.context !== undefined) {
    const value = object(config.context, "context");
    known(value, "context", ["tokenBudget"]);
    if (value.tokenBudget !== undefined) {
      const budget = object(value.tokenBudget, "context.tokenBudget");
      known(budget, "context.tokenBudget", ["manager", "executor", "auditor"]);
      for (const role of ["manager", "executor", "auditor"] as const)
        optionalInteger(budget[role], `context.tokenBudget.${role}`, 100);
    }
  }
  if (config.templates !== undefined) {
    // 任务模板：task 必填非空字符串；可选字段类型校验；未知模板键拒绝（防拼写错误静默失效）。
    const templates = object(config.templates, "templates");
    for (const [name, value] of Object.entries(templates)) {
      const tpl = object(value, `templates.${name}`);
      known(tpl, `templates.${name}`, [
        "task",
        "test",
        "review",
        "executor",
        "isolated",
        "profile",
        "routingStrategy",
      ]);
      if (typeof tpl.task !== "string" || !tpl.task.trim())
        throw new Error(`templates.${name}.task 必须是必填的非空字符串。`);
      optionalString(tpl.test, `templates.${name}.test`);
      optionalBoolean(tpl.review, `templates.${name}.review`);
      optionalString(tpl.executor, `templates.${name}.executor`);
      optionalBoolean(tpl.isolated, `templates.${name}.isolated`);
      if (tpl.profile !== undefined)
        validateExecutionProfile(tpl.profile);
      if (
        tpl.routingStrategy !== undefined &&
        !isRoutingStrategy(tpl.routingStrategy)
      )
        throw new Error(
          `templates.${name}.routingStrategy 必须是 best、cheapest 或 fastest。`,
        );
    }
  }
  return config as RuntimeConfig;
}
