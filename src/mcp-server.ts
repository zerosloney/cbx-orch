#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import {
  approveJob,
  cancelJob,
  cleanupWorktree,
  createJob,
  forgetJobKeepWorktree,
  listArtifacts,
  listJobs,
  listJobsAcrossWorkspaces,
  listQueue,
  loadConfig,
  loadState,
  mergeConfig,
  pauseQueue,
  purgeJob,
  readArtifact,
  readEventsIncremental,
  resumeQueue,
  retryQueueJob,
  startBackground,
  type TaskContract,
  validateWorkspace,
} from "./core.js";
import { runReviewGate } from "./review-gate.js";
import { constantTimeEqual } from "./storage.js";
import { APP_VERSION } from "./version.js";

const serverInfo = { name: "cbx-orch", version: APP_VERSION };
const EVIDENCE_ARTIFACTS = new Set([
  "handback.md",
  "complete.patch",
  "test.log",
  "review.md",
  "understanding.json",
]);
function send(id: unknown, result?: unknown, error?: unknown): void {
  const response: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error !== undefined) response.error = error;
  else response.result = result;
  process.stdout.write(JSON.stringify(response) + "\n");
}
function text(value: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
// intentional-simple: workspace 三级回退 args → env → cwd。env 单值，不处理多 workspace 切换。
function workspace(args: Record<string, unknown>): string {
  const resolved = path.resolve(String(args.workspace ?? process.env.CBX_WORKSPACE ?? "."));
  validateWorkspace(resolved);
  return resolved;
}

function adaptiveOverride(
  value: unknown,
):
  | { enabled?: boolean; maxRounds?: number; managerExecutor?: string }
  | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("adaptive 必须是普通对象。");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    (key) => !["enabled", "max_rounds", "manager_executor"].includes(key),
  );
  if (unknown.length)
    throw new Error(`adaptive 不支持字段：${unknown.join(", ")}`);
  return {
    enabled: raw.enabled as boolean | undefined,
    maxRounds: raw.max_rounds as number | undefined,
    managerExecutor: raw.manager_executor as string | undefined,
  };
}

function optionalBoundedString(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (s.length > max) throw new Error(`${field} 超过 ${max} 字符上限。`);
  return s;
}

function optionalBoolean(args: Record<string, unknown>, field: string): void {
  if (args[field] !== undefined && typeof args[field] !== "boolean")
    throw new Error(`${field} 必须是布尔值。`);
}

const tools = [
  {
    name: "cbx_start",
    description: "创建并后台执行一个任务",
    inputSchema: {
      type: "object",
      required: ["task"],
      properties: {
        task: { type: "string" },
        context_snapshot: {
          type: "string",
          description: "父会话提炼的目标补充、计划、关键文件或命令输出及约束",
        },
        task_contract: {
          type: "object",
          description: "可选结构化契约；提供后先执行上下文握手",
          properties: {
            goal: { type: "string" },
            non_goals: { type: "array", items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
            relevant_files: { type: "array", items: { type: "string" } },
            decisions: { type: "array", items: { type: "string" } },
            rejected_options: { type: "array", items: { type: "string" } },
            assumptions: { type: "array", items: { type: "string" } },
            stages: {
              type: "array",
              description:
                "接力链；每个 stage 用不同 executor，前序 stage 的 handback 自动注入下一个 stage",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  executor: { type: "string" },
                  task: { type: "string" },
                  review_executor: { type: "string" },
                  skip_review: { type: "boolean" },
                  depends_on: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "前置 stage name 数组（对应 CLI task_contract.stages.dependsOn）；前置失败时本 stage 标记 skipped",
                  },
                },
                required: ["name", "executor", "task"],
              },
            },
          },
        },
        workspace: { type: "string" },
        test_command: { type: "string" },
        review: { type: "boolean" },
        isolated: { type: "boolean" },
        timeout_ms: { type: "number" },
        max_retries: { type: "number" },
        max_turns: { type: "integer", minimum: 1 },
        permission_mode: {
          type: "string",
          enum: ["default", "acceptEdits", "auto", "dontAsk"],
        },
        approval_before_run: { type: "boolean" },
        dependency_guard: { type: "boolean" },
        keep_worktree: { type: "boolean" },
        approval_before_complete: { type: "boolean" },
        priority: { type: "number" },
        auto_branch: { type: "boolean" },
        auto_commit: { type: "boolean" },
        commit_message: { type: "string" },
        executor: {
          type: "string",
          description: "内置执行器 codebuddy/opencode/omp/cline，或插件路径",
        },
        review_executor: {
          type: "string",
          description: "可选独立审查执行器；默认沿用 executor",
        },
        adaptive: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            max_rounds: { type: "integer", minimum: 1, maximum: 100 },
            manager_executor: { type: "string" },
          },
        },
        allow_unsafe_permissions: {
          type: "boolean",
          description:
            "permissionMode 为 dontAsk 时必须显式传 true（对应 CLI 的 --dangerously-skip-permissions）",
        },
      },
    },
  },
  {
    name: "cbx_status",
    description: "读取任务状态",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_review",
    description: "读取任务审查报告",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_continue",
    description: "根据审查意见继续任务",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      additionalProperties: false,
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
        message: { type: "string" },
        context_snapshot: {
          type: "string",
          description:
            "覆盖父会话提炼的目标补充、计划、关键文件或命令输出及约束",
        },
        refresh_baseline: {
          type: "boolean",
          description: "确认当前 HEAD 为新的任务基线",
        },
        extra_rounds: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "仅在 max_rounds Human Gate 等待时追加轮次",
        },
        priority: { type: "number" },
      },
    },
  },
  {
    name: "cbx_artifact",
    description: "读取任务证据文件",
    inputSchema: {
      type: "object",
      required: ["job_id", "artifact"],
      properties: {
        job_id: { type: "string" },
        artifact: {
          type: "string",
          enum: [
            "handback.md",
            "complete.patch",
            "test.log",
            "review.md",
            "understanding.json",
          ],
        },
        workspace: { type: "string" },
      },
    },
  },
  {
    name: "cbx_cancel",
    description: "取消任务",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_approve",
    description: "批准等待中的任务并启动",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_list",
    description: "列出工作区中的任务",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_logs",
    description: "读取任务原始事件日志（增量游标；since=0 全量，省略等同 0）",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
        since: {
          type: "number",
          description:
            "行号游标，只返回此值之后的事件；省略或 0 = 全量。响应恒为 {job_id, events: string[], next_offset: number}",
        },
      },
    },
  },
  {
    name: "cbx_result",
    description: "读取任务结构化结果",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: { job_id: { type: "string" }, workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_queue",
    description: "查看任务队列和并发槽位",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_queue_pause",
    description: "暂停启动新的队列 worker",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_queue_resume",
    description: "恢复队列并启动等待中的 worker",
    inputSchema: {
      type: "object",
      properties: { workspace: { type: "string" } },
    },
  },
  {
    name: "cbx_retry",
    description: "将失败任务重新加入队列",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
        priority: { type: "number" },
      },
    },
  },
  {
    name: "cbx_review_gate",
    description:
      "对当前工作区未提交改动跑独立 review（Stop hook gate 的手动入口）",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" },
        executor: { type: "string" },
        timeout_ms: { type: "number" },
      },
    },
  },
  {
    name: "cbx_clean",
    description:
      "清理任务遗留的 Git worktree（--keep-worktree 任务的清理入口）",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
      },
    },
  },
  {
    name: "cbx_forget",
    description:
      "删除任务的 state.json / events.ndjson / 全部工件（保留 worktree）。不可逆——running/queued/awaiting_approval 状态会被拒绝，调用方需先 cancel 或 approve。",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "cbx_purge",
    description:
      "cbx_forget 的破坏力加强版：连 worktree 一起删。不可逆——running/queued/awaiting_approval 状态会被拒绝，调用方需先 cancel 或 approve。",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
        workspace: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "cbx_list_workspaces",
    description: "扫描 root 下含 .cbx/ 的 workspace 并列出各自任务",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string" } },
    },
  },
];

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const root = workspace(args);
  const id = String(args.job_id ?? "");
  if (name === "cbx_start") {
    // schema 声明 required，但 JSON-RPC 不强制 schema：缺 task 时 String(undefined) 会创建 "undefined" 垃圾任务。
    if (typeof args.task !== "string" || !args.task.trim())
      throw new Error("task 必须是非空字符串。");
    optionalBoolean(args, "approval_before_complete");
    optionalBoolean(args, "approval_before_run");
    optionalBoolean(args, "dependency_guard");
    optionalBoolean(args, "keep_worktree");
    optionalBoolean(args, "auto_branch");
    optionalBoolean(args, "auto_commit");
    if (
      args.max_turns !== undefined &&
      (!Number.isInteger(args.max_turns) || Number(args.max_turns) < 1)
    )
      throw new Error("max_turns 必须是正整数。");
    if (
      args.permission_mode !== undefined &&
      !["default", "acceptEdits", "auto", "dontAsk"].includes(
        String(args.permission_mode),
      )
    )
      throw new Error(
        "permission_mode 必须是 default/acceptEdits/auto/dontAsk 之一。",
      );
    const config = await loadConfig(root);
    const defaults = mergeConfig(config, {
      testCommand: args.test_command ? String(args.test_command) : undefined,
      review: typeof args.review === "boolean" ? args.review : undefined,
      isolated: typeof args.isolated === "boolean" ? args.isolated : undefined,
      timeoutMs:
        args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
      maxRetries:
        args.max_retries === undefined ? undefined : Number(args.max_retries),
      maxTurns:
        args.max_turns === undefined ? undefined : Number(args.max_turns),
      permissionMode: args.permission_mode
        ? String(args.permission_mode)
        : undefined,
      approvalBeforeRun:
        typeof args.approval_before_run === "boolean"
          ? args.approval_before_run
          : undefined,
      dependencyGuard:
        typeof args.dependency_guard === "boolean"
          ? args.dependency_guard
          : undefined,
      keepWorktree:
        typeof args.keep_worktree === "boolean"
          ? args.keep_worktree
          : undefined,
      approvalBeforeComplete:
        typeof args.approval_before_complete === "boolean"
          ? args.approval_before_complete
          : undefined,
      autoBranch:
        typeof args.auto_branch === "boolean"
          ? args.auto_branch
          : undefined,
      autoCommit:
        typeof args.auto_commit === "boolean"
          ? args.auto_commit
          : undefined,
      commitMessage: args.commit_message
        ? String(args.commit_message)
        : undefined,
      executor: args.executor ? String(args.executor) : undefined,
      reviewExecutor: args.review_executor
        ? String(args.review_executor)
        : undefined,
      adaptive: adaptiveOverride(args.adaptive),
    });
    if (
      args.task_contract !== undefined &&
      (!args.task_contract ||
        typeof args.task_contract !== "object" ||
        Array.isArray(args.task_contract) ||
        Object.getPrototypeOf(args.task_contract) !== Object.prototype)
    )
      throw new Error("task_contract 必须是普通对象。");
    const rawContract = args.task_contract as
      Record<string, unknown> | undefined;
    const strings = (key: string): string[] | undefined =>
      rawContract?.[key] as string[] | undefined;
    const taskContract: TaskContract | undefined = rawContract
      ? ({
          goal: rawContract.goal as string | undefined,
          nonGoals: strings("non_goals"),
          acceptanceCriteria: strings("acceptance_criteria"),
          constraints: strings("constraints"),
          relevantFiles: strings("relevant_files"),
          decisions: strings("decisions"),
          rejectedOptions: strings("rejected_options"),
          assumptions: strings("assumptions"),
          stages: Array.isArray(rawContract.stages)
            ? rawContract.stages.map((stage) => {
                if (!stage || typeof stage !== "object" || Array.isArray(stage))
                  return stage;
                const value = stage as Record<string, unknown>;
                return {
                  name: value.name,
                  executor: value.executor,
                  task: value.task,
                  reviewExecutor: value.review_executor,
                  skipReview: value.skip_review,
                  dependsOn: Array.isArray(value.depends_on)
                    ? value.depends_on
                    : undefined,
                };
              })
            : rawContract.stages,
        } as TaskContract)
      : undefined;
    const job = await createJob({
      workspace: root,
      task: args.task,
      contextSnapshot: optionalBoundedString(args.context_snapshot, 65_536, "context_snapshot"),
      taskContract,
      testCommand: defaults.testCommand,
      review: defaults.review,
      isolated: defaults.isolated,
      permissionMode: defaults.permissionMode,
      maxTurns: defaults.maxTurns,
      timeoutMs: defaults.timeoutMs,
      maxRetries: defaults.maxRetries,
      keepWorktree: defaults.keepWorktree,
      reviewRules: config.reviewRules,
      approvalBeforeRun: defaults.approvalBeforeRun,
      approvalBeforeComplete: defaults.approvalBeforeComplete,
      autoBranch: defaults.autoBranch,
      autoCommit: defaults.autoCommit,
      commitMessage: defaults.commitMessage,
      executor: defaults.executor,
      reviewExecutor: defaults.reviewExecutor,
      adaptive: defaults.adaptive,
      dependencyGuard: defaults.dependencyGuard,
      allowUnsafePermissions: args.allow_unsafe_permissions === true,
    });
    await startBackground(root, job.jobId, "", Number(args.priority ?? 0));
    return { job_id: job.jobId, status: "queued" };
  }
  if (name === "cbx_list") return listJobs(root);
  if (name === "cbx_queue") return listQueue(root);
  if (name === "cbx_queue_pause") return pauseQueue(root);
  if (name === "cbx_queue_resume") return resumeQueue(root);
  if (name === "cbx_retry")
    return retryQueueJob(root, id, Number(args.priority ?? 0));
  if (name === "cbx_status") return loadState(root, id);
  if (name === "cbx_review") {
    // 先确认 job 存在（job 不存在会抛 CbxError(E_NOT_FOUND)，dispatch catch 转 JSON-RPC error，
    // 消息已是"任务不存在或状态文件损坏"——明确）；再读 review.md，若不存在则抛明确错误
    // "任务 <id> 尚无 review.md（审查阶段未产出）"，区分 job 不存在与审查未产出两种情况。
    await loadState(root, id);
    let review: string;
    try {
      review = await readArtifact(root, id, "review.md");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        throw new Error(`任务 ${id} 尚无 review.md（审查阶段未产出）。`);
      throw error;
    }
    return { job_id: id, review };
  }
  if (name === "cbx_continue") {
    // 未传 extra_rounds 默认 0 = 不追加轮次；仅 max_rounds gate 下 extraRounds>0 才扩展轮次。
    if (
      args.extra_rounds !== undefined &&
      (!Number.isInteger(args.extra_rounds) ||
        Number(args.extra_rounds) < 1 ||
        Number(args.extra_rounds) > 100)
    )
      throw new Error("extra_rounds 必须是 1 到 100 的整数。");
    if (
      args.refresh_baseline !== undefined &&
      typeof args.refresh_baseline !== "boolean"
    )
      throw new Error("refresh_baseline 必须是布尔值。");
    await startBackground(
      root,
      id,
      String(args.message ?? "请根据 review.md 修复问题。"),
      Number(args.priority ?? 0),
      optionalBoundedString(args.context_snapshot, 65_536, "context_snapshot"),
      args.refresh_baseline === true,
      Number(args.extra_rounds ?? 0),
    );
    return { job_id: id, status: "queued" };
  }
  if (name === "cbx_cancel") return cancelJob(root, id);
  if (name === "cbx_approve") {
    const state = await approveJob(root, id);
    if (state.status === "queued") await startBackground(root, id);
    return state;
  }
  if (name === "cbx_logs") {
    // 统一形状：恒为 { job_id, events, next_offset }，不再因 since 有无而分叉成 { logs } 与 { events } 两种结构。
    const since = args.since === undefined ? 0 : Number(args.since);
    if (!Number.isInteger(since) || since < 0)
      throw new Error("since 必须是非负整数。");
    const { events, next_offset } = await readEventsIncremental(
      root,
      id,
      since,
    );
    return { job_id: id, events, next_offset };
  }
  if (name === "cbx_artifact") {
    const artifact = String(args.artifact);
    if (!EVIDENCE_ARTIFACTS.has(artifact))
      throw new Error(`不允许通过 cbx_artifact 读取：${artifact}`);
    return {
      job_id: id,
      artifact,
      content: await readArtifact(root, id, artifact),
    };
  }
  if (name === "cbx_review_gate") {
    const result = await runReviewGate(root, {
      executor: args.executor ? String(args.executor) : undefined,
      timeoutMs:
        args.timeout_ms === undefined ? undefined : Number(args.timeout_ms),
    });
    return {
      pass: result.pass,
      reason: result.reason,
      verdict: result.verdict,
    };
  }
  if (name === "cbx_clean") {
    // 幂等清理：无 worktree 记录返回 cleaned:false，与 CLI `cbx clean` 一致，不抛错。
    return { job_id: id, cleaned: await cleanupWorktree(root, id) };
  }
  if (name === "cbx_forget" || name === "cbx_purge") {
    // MCP 路径下没有 CLI 那种 --yes 交互门：reason 字段缺失时给一个默认的 source 标记
    // 让审计链能区分是 MCP 触发而非 CLI 触发。状态守卫由后端原语保证。
    const reason =
      typeof args.reason === "string" && args.reason.trim()
        ? `mcp:${name} ${args.reason}`
        : `mcp:${name}`;
    const result = await (name === "cbx_forget"
      ? forgetJobKeepWorktree(root, id, reason)
      : purgeJob(root, id, reason));
    return {
      job_id: result.jobId,
      status: result.status,
      deleted_directory: result.deletedDirectory,
      worktree_cleaned: result.worktreeCleaned,
      remaining_queue_entries: result.remainingQueueEntries,
      tombstoned_at: result.tombstonedAt,
    };
  }
  if (name === "cbx_result")
    return JSON.parse(await readArtifact(root, id, "result.json"));
  if (name === "cbx_list_workspaces")
    return { workspaces: await listJobsAcrossWorkspaces(String(args.root ?? process.cwd())) };
  throw new Error(`未知工具：${name}`);
}

/**
 * 共享 JSON-RPC dispatch：stdio 与 HTTP(--http) 两个 transport 复用同一套请求处理。
 * initialize 的协议版本与 subscribe 能力按 transport 区分（stdio 保持 2024-11-05 兼容，
 * HTTP 升级 2025-06-18 并启用资源订阅推送）。
 */
interface DispatchContext {
  protocolVersion: string;
  subscribeCapable: boolean;
  onSubscribe?: (uri: string) => void | Promise<void>;
  onUnsubscribe?: (uri: string) => void | Promise<void>;
}
interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

/** 服务端支持的 MCP 协议版本集合。initialize 协商时若客户端请求版本在此集合内则采纳。 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18"]);

async function dispatch(
  request: { method?: string; params?: Record<string, unknown> },
  ctx: DispatchContext,
): Promise<RpcResult> {
  try {
    const method = request.method;
    if (method === "initialize") {
      // 协议版本协商（MCP 2025-06-18）：客户端在 params.protocolVersion 声明其支持版本，
      // 服务端若也支持则采纳，否则返回本端最新版本（声明式，客户端决定是否继续）。
      // 当前 cbx 单版本实现——协商结果恒为 2025-06-18，但保留协商入口供未来多版本扩展。
      const requested = String((request.params ?? {}).protocolVersion ?? "");
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : ctx.protocolVersion;
      return {
        result: {
          protocolVersion: negotiated,
          capabilities: {
            tools: {},
            resources: { subscribe: ctx.subscribeCapable, listChanged: false },
          },
          serverInfo,
        },
      };
    }
    if (method === "ping") return { result: {} };
    if (method === "tools/list") return { result: { tools } };
    if (method === "resources/list") {
      const root = workspace(
        (request.params ?? {}) as Record<string, unknown>,
      );
      const jobs = await listJobs(root);
      const resources: Array<{
        uri: string;
        name: string;
        mimeType: string;
      }> = [];
      for (const job of jobs) {
        for (const name of await listArtifacts(root, job.jobId))
          resources.push({
            uri: `cbx://job/${job.jobId}/${name}?workspace=${encodeURIComponent(root)}`,
            name: `${job.jobId}/${name}`,
            mimeType: name.endsWith(".json")
              ? "application/json"
              : "text/plain",
          });
        // 事件流资源：可订阅（resources/subscribe），变更时推 notifications/resources/updated。
        resources.push({
          uri: `cbx://job/${job.jobId}/events?workspace=${encodeURIComponent(root)}`,
          name: `${job.jobId}/events`,
          mimeType: "application/json",
        });
      }
      return { result: { resources } };
    }
    if (method === "resources/read") {
      const uri = String(request.params?.uri ?? "");
      const match =
        /^cbx:\/\/job\/([^/]+)\/([^?]+)(?:\?workspace=(.*))?$/.exec(uri);
      if (!match) throw new Error(`不支持的资源 URI：${uri}`);
      const root = match[3] ? decodeURIComponent(match[3]) : process.cwd();
      if (match[2] === "events") {
        // 事件流资源：返回 readEventsIncremental 增量（含 next_offset 游标）。
        // 尚无 events.ndjson 的任务返回空增量，不当作错误。
        let incremental;
        try {
          incremental = await readEventsIncremental(root, match[1], 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
            incremental = { events: [], next_offset: 0 };
          else throw error;
        }
        return {
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(incremental, null, 2),
              },
            ],
          },
        };
      }
      const content = await readArtifact(root, match[1], match[2]);
      return {
        result: {
          contents: [
            {
              uri,
              mimeType: match[2].endsWith(".json")
                ? "application/json"
                : "text/plain",
              text: content,
            },
          ],
        },
      };
    }
    if (method === "resources/subscribe") {
      if (!ctx.subscribeCapable || !ctx.onSubscribe)
        throw new Error("资源订阅需要 HTTP(--http) 模式。");
      const uri = String(request.params?.uri ?? "");
      if (!uri.startsWith("cbx://job/"))
        throw new Error(`不支持订阅的资源 URI：${uri}`);
      await ctx.onSubscribe(uri);
      return { result: {} };
    }
    if (method === "resources/unsubscribe") {
      if (!ctx.subscribeCapable || !ctx.onUnsubscribe)
        throw new Error("资源订阅需要 HTTP(--http) 模式。");
      await ctx.onUnsubscribe(String(request.params?.uri ?? ""));
      return { result: {} };
    }
    if (method === "tools/call")
      return {
        result: text(
          await callTool(
            String(request.params?.name),
            (request.params?.arguments ?? {}) as Record<string, unknown>,
          ),
        ),
      };
    throw new Error(`未知方法：${method ?? "<missing>"}`);
  } catch (error) {
    return {
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** stdio transport（默认）：协议 2024-11-05，无订阅推送，行为与历史版本一致。 */
export function runMcpServer(): void {
  const input = createInterface({ input: process.stdin });
  const ctx: DispatchContext = {
    protocolVersion: "2024-11-05",
    subscribeCapable: false,
  };
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let requestId: unknown = null;
    try {
      const request = JSON.parse(line) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      requestId = request.id ?? null;
      // Per JSON-RPC 2.0, a request without an id is a notification and must not receive a response.
      const isNotification = request.id === undefined || request.id === null;
      if (isNotification && request.method && request.method !== "ping")
        return;
      const { result, error } = await dispatch(request, ctx);
      send(request.id, result, error);
    } catch (error) {
      send(requestId, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

interface SseConnection {
  res: ServerResponse;
}

/**
 * streamable HTTP transport（`cbx mcp --http`）：协议 2025-06-18，单 endpoint `POST /mcp`，
 * 启用 `resources/subscribe` + `notifications/resources/updated` 服务端推送。
 * 无状态会话：订阅按 uri 全局登记，变更通知广播到所有打开的 SSE 连接（`GET /mcp`）。
 * intentional-simple: 单用户 loopback 场景，广播 + 客户端按 uri 过滤足够；
 * 若需多租户隔离再引入 Mcp-Session-Id 会话表。
 */
export interface McpHttpServer {
  port: number;
  close(): Promise<void>;
}

export async function runMcpHttpServer(opts: {
  port: number;
  host: string;
  token?: string;
}): Promise<McpHttpServer> {
  const { port, host, token } = opts;
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host))
    throw new Error("MCP HTTP 仅允许绑定到本机回环地址；远程访问需在受认证的反向代理后实现。");
  const uris = new Set<string>();
  const connections = new Set<SseConnection>();
  const tailers = new Map<string, () => void>();
  let eventSeq = 0;

  const pushUpdated = (uri: string): void => {
    const seq = ++eventSeq;
    const frame = `id: ${seq}\nretry: 3000\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri },
    })}\n\n`;
    for (const conn of connections) {
      try {
        conn.res.write(frame);
      } catch {
        /* 连接已断开 */
      }
    }
  };

  // uri → {workspace, jobId}：onSubscribe/onUnsubscribe 共用，避免两处 regex 漂移。
  const parseEventsUri = (
    uri: string,
  ): { workspace: string; jobId: string } | null => {
    const m = /^cbx:\/\/job\/([^/]+)\/events(?:\?workspace=(.*))?$/.exec(uri);
    if (!m) return null;
    return {
      workspace: m[2] ? decodeURIComponent(m[2]) : process.cwd(),
      jobId: m[1],
    };
  };

  // 订阅某个 job 的事件资源时，轮询该 job 的 events.ndjson 行数增量，变化则推送 updated。
  // 基线在订阅时读取（await），此后行数增长才推送——保证订阅前已存在的事件不算增量。
  const ensureTailer = async (workspace: string, jobId: string): Promise<void> => {
    const key = `${workspace}\u0000${jobId}`;
    if (tailers.has(key)) return;
    // 同步占位：async 基线读取期间若并发 subscribe 同一 job，第二个命中 has(key) 直接 return，
    // 避免创建第二个 interval 后 tailers.set 覆盖、首个 interval 引用丢失而泄漏。
    tailers.set(key, () => {});
    let lastLen = 0;
    try {
      lastLen = (await readEventsIncremental(workspace, jobId, 0)).events.length;
    } catch {
      /* 尚无 events.ndjson，基线为 0 */
    }
    const timer = setInterval(async () => {
      try {
        const { events } = await readEventsIncremental(workspace, jobId, 0);
        if (events.length > lastLen) {
          const uri = `cbx://job/${jobId}/events?workspace=${encodeURIComponent(workspace)}`;
          if (uris.has(uri)) pushUpdated(uri);
        }
        lastLen = events.length;
      } catch {
        /* events.ndjson 缺失等，跳过本轮 */
      }
    }, 500);
    timer.unref();
    tailers.set(key, () => clearInterval(timer));
  };

  // unsubscribe 时停掉对应 tailer：否则订阅过的 job 的 500ms 轮询 interval 永久泄漏，
  // 仅 server.close() 才清理（长生命周期 MCP server + 多 job 订阅累积磁盘读）。
  const stopTailer = (uri: string): void => {
    const parsed = parseEventsUri(uri);
    if (!parsed) return;
    const key = `${parsed.workspace}\u0000${parsed.jobId}`;
    tailers.get(key)?.();
    tailers.delete(key);
  };

  const server = createServer(async (req, res) => {
    // CORS：MCP HTTP 强制 loopback，允许浏览器 MCP 客户端跨域访问。
    // Bearer token 在 Authorization header（非 cookie 凭证），Access-Control-Allow-Origin: * 可用。
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    const url = new URL(req.url ?? "/", `http://${host}`);
    // OPTIONS 预检在 token 校验前返回：浏览器带 Authorization 的跨域请求会先发无凭证预检。
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-max-age": "86400" });
      res.end();
      return;
    }
    if (token) {
      // 与 cbx ui 同源：token 校验用 SHA-256 + timingSafeEqual 常量时间比较，
      // 避免 `===` 逐字节短路的时序侧信道（CHANGELOG 0.10.2 加固项对新增 HTTP 路径同样适用）。
      const auth = req.headers.authorization;
      const presented = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!presented || !constantTimeEqual(presented, token)) {
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      // MCP JSON-RPC 请求远小于 1MB；超限按异常/恶意客户端拒，避免无界累积撑爆进程内存
      // （与 captureAsync 的 BoundedOutput 同一动机——D10 加固的对偶面）。
      const maxBodyBytes = 1 * 1024 * 1024;
      // intentional-simple: 字符串拼接 raw += chunk 在大量小 chunk 时 O(n²)；1MB 上限下可接受。
      // 升级路径：chunks: Buffer[] + Buffer.concat（与 ui.ts readJsonBody 一致）。
      let raw = "";
      let tooLarge = false;
      try {
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw, "utf8") > maxBodyBytes) {
            tooLarge = true;
            break;
          }
        }
      } catch {
        /* body 读取失败 */
      }
      if (tooLarge) {
        res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "请求体超过上限。" }));
        return;
      }
      let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        request = JSON.parse(raw) as typeof request;
      } catch {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify({ error: "请求体必须是合法 JSON。" }));
        return;
      }
      const ctx: DispatchContext = {
        protocolVersion: "2025-06-18",
        subscribeCapable: true,
        onSubscribe: async (uri) => {
          uris.add(uri);
          const parsed = parseEventsUri(uri);
          if (parsed) await ensureTailer(parsed.workspace, parsed.jobId);
        },
        onUnsubscribe: (uri) => {
          uris.delete(uri);
          stopTailer(uri);
        },
      };
      const { result, error } = await dispatch(request, ctx);
      // JSON-RPC 2.0：无 id 的 notification 不返回响应（与 stdio transport 的 isNotification
      // 守卫一致）。标准 MCP 客户端握手会发 notifications/initialized，若此处仍回 error body
      // 会被严格客户端判定握手失败。
      const isNotification = request.id === undefined || request.id === null;
      if (isNotification) {
        res.writeHead(202, { "cache-control": "no-store" });
        res.end();
        return;
      }
      const payload =
        error !== undefined
          ? { jsonrpc: "2.0", id: request.id ?? null, error }
          : { jsonrpc: "2.0", id: request.id ?? null, result };
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.method === "GET" && url.pathname === "/mcp") {
      // SSE 长连接：服务端推送 notifications/resources/updated 的承载通道。
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const conn: SseConnection = { res };
      connections.add(conn);
      req.on("close", () => {
        connections.delete(conn);
        // 无状态广播架构下订阅与连接不绑定；所有 SSE 连接断开后已启动的 tailer 无人消费，
        // 停掉它们避免 500ms 轮询 interval 永久泄漏（此前仅 server.close 才清理）。
        // 客户端重连后会重新 initialize + resources/subscribe，ensureTailer 按需重建。
        if (connections.size === 0) {
          for (const stop of tailers.values()) stop();
          tailers.clear();
          uris.clear();
        }
      });
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const actualPort =
    addr !== null && typeof addr === "object" ? addr.port : port;
  process.stdout.write(
    `cbx MCP (streamable HTTP) 监听 ${host}:${actualPort}/mcp，协议 2025-06-18\n`,
  );
  // 打开的 listener 本身保持进程常驻，无需调用方阻塞等待 close。
  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        // 关闭前销毁所有打开的 SSE 连接与 tailer，否则 server.close() 会因活动连接挂起。
        for (const conn of connections) {
          try {
            conn.res.destroy();
          } catch {
            /* 已断开 */
          }
        }
        connections.clear();
        for (const stop of tailers.values()) stop();
        tailers.clear();
        server.close(() => resolve());
      }),
  };
}

// Backward compat: `node dist/src/mcp-server.js` still starts the server directly.
// `cbx mcp` 子命令通过 import 后显式调用 runMcpServer()。
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  runMcpServer();
