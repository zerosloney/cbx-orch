import { existsSync } from "node:fs";
import { CbxError } from "./errors.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  saveJson,
  savePersistedState,
  loadPersistedState,
  now,
} from "./storage.js";
import { redactText } from "./redaction.js";
import { loadConfig, jobDir } from "./state.js";
import {
  validateWorkspace,
  validateTestCommand,
  validatePermissionMode,
  assertExecutionPolicy,
  normalizeJobId,
  normalizeTaskContract,
} from "./validation.js";
import {
  assertExecutionProfile,
  type ExecutionProfile,
} from "./profile.js";
import { normalizeAdaptiveOptions } from "./adaptive-manager.js";
import {
  snapshotGitBaseline,
  gitDirtyFingerprint,
  gitRoot,
} from "./git-ops.js";
import { DEFAULT_TOKEN_BUDGET, type ContextBudget } from "./context-pack.js";
import { APP_VERSION } from "./version.js";
import type { JobContext, JobState, TaskContract, Json } from "./types.js";
import { ROUTE_AUTO, routeStageExecutor } from "./executors/route.js";

/** 规范化 .cbx.json 的 context.tokenBudget；缺失角色用默认值填充。 */
function normalizeContextBudget(raw: unknown): ContextBudget {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_TOKEN_BUDGET };
  const obj = raw as Record<string, unknown>;
  const pick = (role: keyof ContextBudget): number => {
    const value = obj[role];
    return Number.isInteger(value) && Number(value) >= 100
      ? Number(value)
      : DEFAULT_TOKEN_BUDGET[role];
  };
  return {
    manager: pick("manager"),
    executor: pick("executor"),
    auditor: pick("auditor"),
  };
}

export async function createJob(options: {
  workspace: string;
  task: string;
  testCommand?: string;
  review: boolean;
  isolated: boolean;
  permissionMode: string;
  maxTurns: number;
  timeoutMs?: number;
  maxRetries?: number;
  keepWorktree?: boolean;
  allowUnsafePermissions?: boolean;
  reviewRules?: string;
  approvalBeforeRun?: boolean;
  approvalBeforeComplete?: boolean;
  autoBranch?: boolean;
  autoCommit?: boolean;
  commitMessage?: string;
  executor?: string;
  reviewExecutor?: string;
  trustMode?: "trusted" | "untrusted";
  profile?: ExecutionProfile;
  contextSnapshot?: string;
  taskContract?: TaskContract;
  adaptive?: Partial<import("./adaptive-manager.js").AdaptiveOptions>;
  dependencyGuard?: boolean;
  jobId?: string;
}): Promise<{ jobId: string; directory: string }> {
  const workspace = path.resolve(options.workspace);
  if (typeof options.task !== "string" || !options.task.trim())
    throw new CbxError("E_VALIDATION", "task 必须是非空字符串。");
  validateWorkspace(workspace);
  validateTestCommand(options.testCommand);
  validatePermissionMode(
    options.permissionMode,
    options.allowUnsafePermissions,
  );
  // untrusted 任务要求配置 execution.runner（容器隔离边界）；runner 路径穿越校验在
  // resolveRunnerPlugin 执行时进行，此处仅确认策略前提存在。
  const runnerConfigured = Boolean((await loadConfig(workspace)).execution?.runner);
  assertExecutionPolicy(
    options.trustMode ?? "trusted",
    options.isolated,
    runnerConfigured,
  );
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)
    throw new CbxError("E_VALIDATION", "maxTurns 必须是正整数。");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100)
  )
    throw new CbxError("E_VALIDATION", "timeoutMs 必须不小于 100ms。");
  if (
    options.maxRetries !== undefined &&
    (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
  )
    throw new CbxError("E_VALIDATION", "maxRetries 必须是非负整数。");
  const adaptive = normalizeAdaptiveOptions(options.adaptive);
  if (adaptive.enabled && !options.review)
    throw new Error(
      "adaptive.enabled=true 需要 review=true，以便 done 通过结构化证据门。",
    );
  // adaptive 循环由 manager 每轮自选 stage，dependsOn 会被静默忽略（无分层/失败传播）；
  // 显式拒绝而非接受错误语义的配置。
  if (
    adaptive.enabled &&
    options.taskContract?.stages?.some((stage) => stage.dependsOn?.length)
  )
    throw new Error(
      "adaptive.enabled=true 暂不支持 taskContract.stages[].dependsOn：adaptive 模式由 manager 每轮决定执行顺序，依赖声明不会生效。请移除 dependsOn 或关闭 adaptive。",
    );
  const taskContract =
    normalizeTaskContract(options.taskContract) ??
    (adaptive.enabled ? { goal: options.task.trim() } : undefined);
  // autoCommit 隐含 isolated：提交到 worktree 才安全，避免把主工作区无关改动一起提交。
  // 不抛错——autoCommit=true 时自动开启 isolated，保留告警让用户知道发生了隐含提升。
  if (options.autoCommit && !options.isolated) {
    console.error(
      "cbx 提示：autoCommit=true 已隐含开启 isolated=true（提交到 worktree，避免污染主工作区）。",
    );
    options.isolated = true;
  }
  assertExecutionProfile({
    profile: options.profile,
    isolated: options.isolated,
    review: options.review,
    testCommand: options.testCommand,
    dependencyGuard: options.dependencyGuard,
    approvalBeforeComplete: options.approvalBeforeComplete,
    trustMode: options.trustMode,
  });
  // 测试命令黑名单是软防线（正则可被变体绕过）。非隔离时强警告：cbx 不保证命令安全，应运行在受控环境。
  if (options.testCommand && !options.isolated) {
    console.error(
      `cbx 警告：测试命令将在主工作区执行（isolated=false），cbx 不保证其安全性：${options.testCommand}`,
    );
  }
  const jobId = normalizeJobId(options.jobId);
  const directory = jobDir(workspace, jobId);
  if (existsSync(directory))
    throw new CbxError("E_STATE_CONFLICT", `任务已存在：${jobId}`);
  // legacy 导入可能把 .cbx/jobs/<id>/ 目录清掉但 SQLite 记录仍在；仅查目录会让同 jobId 静默覆盖旧 state。
  const persisted = await loadPersistedState<unknown>(workspace, jobId);
  if (persisted)
    throw new CbxError(
      "E_STATE_CONFLICT",
      `任务已存在（SQLite 有记录但目录缺失）：${jobId}`,
    );
  await mkdir(directory, { recursive: true });
  const request = `# 任务\n\n## 目标\n\n${taskContract?.goal ?? options.task.trim()}\n\n## 验收标准\n\n${taskContract?.acceptanceCriteria?.map((item) => `- ${item}`).join("\n") || "- 以目标和验收命令为准。"}\n\n## 非目标\n\n${taskContract?.nonGoals?.map((item) => `- ${item}`).join("\n") || "- 未指定。"}\n\n## 约束\n\n${taskContract?.constraints?.map((item) => `- ${item}`).join("\n") || "- 只修改完成目标所需的文件。"}\n\n## 验收命令\n\n${options.testCommand ?? "未指定；请根据项目现有脚本选择最相关的检查。"}\n\n## 执行规则\n\n- 先检查项目结构和现有测试，再修改。\n- 完成后运行验收命令。\n- 将修改摘要、测试命令、测试结果和遗留问题写入 handback.md。\n`;
  await writeFile(path.join(directory, "request.md"), request, "utf8");
  const governance = (await loadConfig(workspace)).governance;
  const snapshot = redactText(
    options.contextSnapshot ?? "",
    governance?.redactFields,
    governance?.redactPatterns,
  );
  if (snapshot)
    await writeFile(
      path.join(directory, "context-snapshot.md"),
      snapshot,
      "utf8",
    );
  if (taskContract)
    await saveJson(path.join(directory, "context-contract.json"), taskContract);
  const baseline = snapshotGitBaseline(workspace);
  const dirtyFingerprint = gitDirtyFingerprint(workspace);
  const runtimeConfig = await loadConfig(workspace);
  const contextBudget = normalizeContextBudget(
    runtimeConfig.context?.tokenBudget,
  );
  // 路由层（executor="auto"）：执行前先按 agent capabilities 与任务文本匹配选执行器。
  // 显式声明的 executor 不经过路由（本段仅在保留字 auto 时触发），决策落盘 context.routing 供审计。
  let executor = options.executor;
  let routing: Json = {} as Json;
  if (options.executor === ROUTE_AUTO) {
    const decision = await routeStageExecutor({ task: options.task, workspace });
    if (decision) {
      executor = decision.executor;
      routing = {
        mode: "auto",
        route_to: decision.executor,
        score: decision.score,
        ranked: decision.ranked,
        notes: decision.notes,
      };
    } else {
      executor = "codebuddy";
      routing = {
        mode: "auto",
        route_to: "codebuddy",
        score: 0,
        ranked: [],
        notes: ["无可用 agent 命中能力，回退默认 codebuddy。"],
      };
    }
  }
  // executor 走 auto 且启用审查、未显式声明审查者时，默认用 auto 做交叉验证（避开主执行 agent）。
  const reviewExecutor =
    options.reviewExecutor ??
    (options.review && options.executor === ROUTE_AUTO ? ROUTE_AUTO : undefined);
  const context: JobContext = {
    appVersion: APP_VERSION,
    jobId,
    workspace,
    createdAt: now(),
    testCommand: options.testCommand,
    taskText: options.task,
    profile: options.profile,
    reviewRequested: options.review,
    isolated: options.isolated,
    permissionMode: options.permissionMode,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    maxRetries: options.maxRetries ?? 1,
    executionRetries: Math.max(1, (options.maxRetries ?? 1) + 1),
    fixRetries: Math.max(1, options.maxRetries ?? 1),
    keepWorktree: options.keepWorktree ?? false,
    reviewRules: options.reviewRules,
    approvalBeforeRun: options.approvalBeforeRun ?? false,
    approvalBeforeComplete: options.approvalBeforeComplete ?? false,
    autoBranch: options.autoBranch ?? false,
    autoCommit: options.autoCommit ?? false,
    commitMessage: options.commitMessage ?? "chore(cbx): apply task",
    executor: executor ?? "codebuddy",
    reviewExecutor,
    routing: Object.keys(routing).length ? routing : undefined,
    adaptive: adaptive.enabled
      ? {
          ...adaptive,
          managerExecutor:
            adaptive.managerExecutor ?? executor ?? "codebuddy",
        }
      : undefined,
    taskContract,
    trustMode: options.trustMode ?? "trusted",
    gitRoot: baseline?.root ?? gitRoot(workspace),
    baseCommit: baseline?.commit,
    baseBranch: baseline?.branch,
    baseDirty: baseline?.dirty,
    baseStatus: baseline?.status,
    dirtyFingerprint,
    dependencyGuard: options.dependencyGuard ?? false,
    contextBudget,
  };
  await saveJson(path.join(directory, "context.json"), context);
  const state: JobState = {
    jobId,
    status: "queued",
    phase: "queued",
    workspace,
    jobDir: directory,
    createdAt: now(),
    updatedAt: now(),
    attempt: 0,
    // P0-2: 创建时记录 maxTurns，UI/result 可直接读取实际预算而无需推断。
    configuredMaxTurns: context.maxTurns,
  };
  await savePersistedState(workspace, jobId, state);
  await saveJson(path.join(directory, "state.json"), state);
  return { jobId, directory };
}
