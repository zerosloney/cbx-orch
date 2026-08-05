#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { approveJob, cancelJob, createJob, jobDir, listArtifacts, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, readEventsIncremental, resumeQueue, retryQueueJob, startBackground, type TaskContract } from "./core.js";
import { runReviewGate } from "./review-gate.js";

const serverInfo = { name: "cbx-orch", version: "0.9.0" };
const EVIDENCE_ARTIFACTS = new Set(["handback.md", "complete.patch", "test.log", "review.md", "understanding.json"]);
function send(id: unknown, result?: unknown, error?: unknown): void {
  const response: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error !== undefined) response.error = error; else response.result = result;
  process.stdout.write(JSON.stringify(response) + "\n");
}
function text(value: unknown): unknown { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
// intentional-simple: workspace 三级回退 args → env → cwd。env 单值，不处理多 workspace 切换。
function workspace(args: Record<string, unknown>): string { return String(args.workspace ?? process.env.CBX_WORKSPACE ?? "."); }

const tools = [
  { name: "cbx_start", description: "创建并后台执行一个任务", inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" }, context_snapshot: { type: "string", description: "父会话提炼的目标补充、计划、关键文件或命令输出及约束" }, task_contract: { type: "object", description: "可选结构化契约；提供后先执行上下文握手", properties: { goal: { type: "string" }, non_goals: { type: "array", items: { type: "string" } }, acceptance_criteria: { type: "array", items: { type: "string" } }, constraints: { type: "array", items: { type: "string" } }, relevant_files: { type: "array", items: { type: "string" } }, decisions: { type: "array", items: { type: "string" } }, rejected_options: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } }, stages: { type: "array", description: "接力链；每个 stage 用不同 executor，前序 stage 的 handback 自动注入下一个 stage", items: { type: "object", properties: { name: { type: "string" }, executor: { type: "string" }, task: { type: "string" }, review_executor: { type: "string" }, skip_review: { type: "boolean" } }, required: ["name", "executor", "task"] } } } }, workspace: { type: "string" }, test_command: { type: "string" }, review: { type: "boolean" }, isolated: { type: "boolean" }, timeout_ms: { type: "number" }, max_retries: { type: "number" }, keep_worktree: { type: "boolean" }, priority: { type: "number" }, auto_branch: { type: "boolean" }, auto_commit: { type: "boolean" }, commit_message: { type: "string" }, executor: { type: "string", description: "内置执行器 codebuddy/opencode/omp/cline，或插件路径" }, review_executor: { type: "string", description: "可选独立审查执行器；默认沿用 executor" } } } },
  { name: "cbx_status", description: "读取任务状态", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_review", description: "读取任务审查报告", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_continue", description: "根据审查意见继续任务", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" }, message: { type: "string" }, context_snapshot: { type: "string", description: "覆盖父会话提炼的目标补充、计划、关键文件或命令输出及约束" }, refresh_baseline: { type: "boolean", description: "确认当前 HEAD 为新的任务基线" }, priority: { type: "number" } } } },
  { name: "cbx_artifact", description: "读取任务证据文件", inputSchema: { type: "object", required: ["job_id", "artifact"], properties: { job_id: { type: "string" }, artifact: { type: "string", enum: ["handback.md", "complete.patch", "test.log", "review.md", "understanding.json"] }, workspace: { type: "string" } } } },
  { name: "cbx_cancel", description: "取消任务", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_approve", description: "批准等待中的任务并启动", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_list", description: "列出工作区中的任务", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_logs", description: "读取任务原始事件日志（传 since 走增量游标，省略则全量）", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" }, since: { type: "number", description: "行号游标，只返回此值之后的事件；省略=全量返回 {logs: string}" } } } },
  { name: "cbx_result", description: "读取任务结构化结果", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_queue", description: "查看任务队列和并发槽位", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_queue_pause", description: "暂停启动新的队列 worker", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_queue_resume", description: "恢复队列并启动等待中的 worker", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_retry", description: "将失败任务重新加入队列", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" }, priority: { type: "number" } } } },
  { name: "cbx_review_gate", description: "对当前工作区未提交改动跑独立 review（Stop hook gate 的手动入口）", inputSchema: { type: "object", properties: { workspace: { type: "string" }, executor: { type: "string" }, timeout_ms: { type: "number" } } } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const root = workspace(args);
  const id = String(args.job_id ?? "");
  if (name === "cbx_start") {
    const config = await loadConfig(root);
    const defaults = mergeConfig(config, { testCommand: args.test_command ? String(args.test_command) : undefined, review: typeof args.review === "boolean" ? args.review : undefined, isolated: typeof args.isolated === "boolean" ? args.isolated : undefined, timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms), maxRetries: args.max_retries === undefined ? undefined : Number(args.max_retries), keepWorktree: args.keep_worktree === undefined ? undefined : Boolean(args.keep_worktree), autoBranch: args.auto_branch === undefined ? undefined : Boolean(args.auto_branch), autoCommit: args.auto_commit === undefined ? undefined : Boolean(args.auto_commit), commitMessage: args.commit_message ? String(args.commit_message) : undefined, executor: args.executor ? String(args.executor) : undefined, reviewExecutor: args.review_executor ? String(args.review_executor) : undefined });
    if (args.task_contract !== undefined && (!args.task_contract || typeof args.task_contract !== "object" || Array.isArray(args.task_contract) || Object.getPrototypeOf(args.task_contract) !== Object.prototype)) throw new Error("task_contract 必须是普通对象。");
    const rawContract = args.task_contract as Record<string, unknown> | undefined;
    const strings = (key: string): string[] | undefined => rawContract?.[key] as string[] | undefined;
    const taskContract: TaskContract | undefined = rawContract ? { goal: rawContract.goal as string | undefined, nonGoals: strings("non_goals"), acceptanceCriteria: strings("acceptance_criteria"), constraints: strings("constraints"), relevantFiles: strings("relevant_files"), decisions: strings("decisions"), rejectedOptions: strings("rejected_options"), assumptions: strings("assumptions"), stages: Array.isArray(rawContract.stages) ? (rawContract.stages as Array<Record<string, unknown>>).map(stage => ({ name: String(stage.name), executor: String(stage.executor), task: String(stage.task), reviewExecutor: stage.review_executor ? String(stage.review_executor) : undefined, skipReview: stage.skip_review === undefined ? undefined : Boolean(stage.skip_review) })) : undefined } : undefined;
    const job = await createJob({ workspace: root, task: String(args.task), contextSnapshot: args.context_snapshot === undefined ? undefined : String(args.context_snapshot), taskContract, testCommand: defaults.testCommand, review: defaults.review, isolated: defaults.isolated, permissionMode: defaults.permissionMode, maxTurns: defaults.maxTurns, timeoutMs: defaults.timeoutMs, maxRetries: defaults.maxRetries, keepWorktree: defaults.keepWorktree, reviewRules: config.reviewRules, approvalBeforeRun: defaults.approvalBeforeRun, autoBranch: defaults.autoBranch, autoCommit: defaults.autoCommit, commitMessage: defaults.commitMessage, executor: defaults.executor, reviewExecutor: defaults.reviewExecutor });
    await startBackground(root, job.jobId, "", Number(args.priority ?? 0));
    return { job_id: job.jobId, status: "queued" };
  }
  if (name === "cbx_list") return listJobs(root);
  if (name === "cbx_queue") return listQueue(root);
  if (name === "cbx_queue_pause") return pauseQueue(root);
  if (name === "cbx_queue_resume") return resumeQueue(root);
  if (name === "cbx_retry") return retryQueueJob(root, id, Number(args.priority ?? 0));
  if (name === "cbx_status") return loadState(root, id);
  if (name === "cbx_review") {
    try { return { job_id: id, review: await readFile(`${jobDir(root, id)}/review.md`, "utf8") }; }
    catch { return { job_id: id, review: "尚无 review.md" }; }
  }
  if (name === "cbx_continue") {
    await startBackground(root, id, String(args.message ?? "请根据 review.md 修复问题。"), Number(args.priority ?? 0), args.context_snapshot === undefined ? undefined : String(args.context_snapshot), Boolean(args.refresh_baseline));
    return { job_id: id, status: "queued" };
  }
  if (name === "cbx_cancel") return cancelJob(root, id);
  if (name === "cbx_approve") { const state = await approveJob(root, id); await startBackground(root, id); return state; }
  if (name === "cbx_logs") {
    if (args.since === undefined) return { job_id: id, logs: await readArtifact(root, id, "events.ndjson") };
    const { events, next_offset } = await readEventsIncremental(root, id, Number(args.since));
    return { job_id: id, events, next_offset };
  }
  if (name === "cbx_artifact") {
    const artifact = String(args.artifact);
    if (!EVIDENCE_ARTIFACTS.has(artifact)) throw new Error(`不允许通过 cbx_artifact 读取：${artifact}`);
    return { job_id: id, artifact, content: await readArtifact(root, id, artifact) };
  }
  if (name === "cbx_review_gate") {
    const result = await runReviewGate(root, { executor: args.executor ? String(args.executor) : undefined, timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms) });
    return { pass: result.pass, reason: result.reason, verdict: result.verdict };
  }
  if (name === "cbx_result") return JSON.parse(await readArtifact(root, id, "result.json"));
  throw new Error(`未知工具：${name}`);
}

export function runMcpServer(): void {
  const input = createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let requestId: unknown = null;
    try {
      const request = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      requestId = request.id ?? null;
      // Per JSON-RPC 2.0, a request without an id is a notification and must not receive a response.
      const isNotification = request.id === undefined || request.id === null;
      if (isNotification && request.method && request.method !== "ping") return;
      if (request.method === "initialize") send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: { subscribe: false, listChanged: false } }, serverInfo });
      else if (request.method === "ping") send(request.id, {});
      else if (request.method === "tools/list") send(request.id, { tools });
      else if (request.method === "resources/list") {
        const root = workspace((request.params ?? {}) as Record<string, unknown>);
        const jobs = await listJobs(root);
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
        for (const job of jobs) for (const name of await listArtifacts(root, job.jobId)) resources.push({ uri: `cbx://job/${job.jobId}/${name}?workspace=${encodeURIComponent(root)}`, name: `${job.jobId}/${name}`, mimeType: name.endsWith(".json") ? "application/json" : "text/plain" });
        send(request.id, { resources });
      }
      else if (request.method === "resources/read") {
        const uri = String(request.params?.uri ?? "");
        const match = /^cbx:\/\/job\/([^/]+)\/([^?]+)(?:\?workspace=(.*))?$/.exec(uri);
        if (!match) throw new Error(`不支持的资源 URI：${uri}`);
        const root = match[3] ? decodeURIComponent(match[3]) : process.cwd();
        const content = await readArtifact(root, match[1], match[2]);
        send(request.id, { contents: [{ uri, mimeType: match[2].endsWith(".json") ? "application/json" : "text/plain", text: content }] });
      }
      else if (request.method === "tools/call") send(request.id, text(await callTool(String(request.params?.name), (request.params?.arguments ?? {}) as Record<string, unknown>)));
      else throw new Error(`未知方法：${request.method ?? "<missing>"}`);
    } catch (error) { send(requestId, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
  });
}

// Backward compat: `node dist/src/mcp-server.js` still starts the server directly.
// `cbx mcp` 子命令通过 import 后显式调用 runMcpServer()。
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runMcpServer();
