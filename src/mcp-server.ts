#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { approveJob, cancelJob, createJob, jobDir, listArtifacts, listJobs, listQueue, loadConfig, loadState, mergeConfig, pauseQueue, readArtifact, resumeQueue, retryQueueJob, startBackground } from "./core.js";

const serverInfo = { name: "cbx-orch", version: "0.8.0" };
function send(id: unknown, result?: unknown, error?: unknown): void {
  const response: Record<string, unknown> = { jsonrpc: "2.0", id };
  if (error !== undefined) response.error = error; else response.result = result;
  process.stdout.write(JSON.stringify(response) + "\n");
}
function text(value: unknown): unknown { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
// intentional-simple: workspace 三级回退 args → env → cwd。env 单值，不处理多 workspace 切换。
function workspace(args: Record<string, unknown>): string { return String(args.workspace ?? process.env.CBX_WORKSPACE ?? "."); }

const tools = [
  { name: "cbx_start", description: "创建并后台执行一个任务", inputSchema: { type: "object", required: ["task"], properties: { task: { type: "string" }, context_snapshot: { type: "string", description: "父会话提炼的目标补充、计划、关键文件或命令输出及约束" }, workspace: { type: "string" }, test_command: { type: "string" }, review: { type: "boolean" }, isolated: { type: "boolean" }, timeout_ms: { type: "number" }, max_retries: { type: "number" }, keep_worktree: { type: "boolean" }, priority: { type: "number" }, auto_branch: { type: "boolean" }, auto_commit: { type: "boolean" }, commit_message: { type: "string" }, executor: { type: "string", description: "内置执行器 codebuddy/opencode/pi，或插件路径" } } } },
  { name: "cbx_status", description: "读取任务状态", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_review", description: "读取任务审查报告", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_continue", description: "根据审查意见继续任务", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" }, message: { type: "string" }, context_snapshot: { type: "string", description: "覆盖父会话提炼的目标补充、计划、关键文件或命令输出及约束" }, priority: { type: "number" } } } },
  { name: "cbx_cancel", description: "取消任务", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_approve", description: "批准等待中的任务并启动", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_list", description: "列出工作区中的任务", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_logs", description: "读取任务原始事件日志", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_result", description: "读取任务结构化结果", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" } } } },
  { name: "cbx_queue", description: "查看任务队列和并发槽位", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_queue_pause", description: "暂停启动新的队列 worker", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_queue_resume", description: "恢复队列并启动等待中的 worker", inputSchema: { type: "object", properties: { workspace: { type: "string" } } } },
  { name: "cbx_retry", description: "将失败任务重新加入队列", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, workspace: { type: "string" }, priority: { type: "number" } } } },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const root = workspace(args);
  const id = String(args.job_id ?? "");
  if (name === "cbx_start") {
    const config = await loadConfig(root);
    const defaults = mergeConfig(config, { testCommand: args.test_command ? String(args.test_command) : undefined, review: typeof args.review === "boolean" ? args.review : undefined, isolated: typeof args.isolated === "boolean" ? args.isolated : undefined, timeoutMs: args.timeout_ms === undefined ? undefined : Number(args.timeout_ms), maxRetries: args.max_retries === undefined ? undefined : Number(args.max_retries), keepWorktree: args.keep_worktree === undefined ? undefined : Boolean(args.keep_worktree), autoBranch: args.auto_branch === undefined ? undefined : Boolean(args.auto_branch), autoCommit: args.auto_commit === undefined ? undefined : Boolean(args.auto_commit), commitMessage: args.commit_message ? String(args.commit_message) : undefined, executor: args.executor ? String(args.executor) : undefined });
    const job = await createJob({ workspace: root, task: String(args.task), contextSnapshot: args.context_snapshot === undefined ? undefined : String(args.context_snapshot), testCommand: defaults.testCommand, review: defaults.review, isolated: defaults.isolated, permissionMode: defaults.permissionMode, maxTurns: defaults.maxTurns, timeoutMs: defaults.timeoutMs, maxRetries: defaults.maxRetries, keepWorktree: defaults.keepWorktree, reviewRules: config.reviewRules, approvalBeforeRun: defaults.approvalBeforeRun, autoBranch: defaults.autoBranch, autoCommit: defaults.autoCommit, commitMessage: defaults.commitMessage, executor: defaults.executor });
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
    await startBackground(root, id, String(args.message ?? "请根据 review.md 修复问题。"), Number(args.priority ?? 0), args.context_snapshot === undefined ? undefined : String(args.context_snapshot));
    return { job_id: id, status: "queued" };
  }
  if (name === "cbx_cancel") return cancelJob(root, id);
  if (name === "cbx_approve") { const state = await approveJob(root, id); await startBackground(root, id); return state; }
  if (name === "cbx_logs") return { job_id: id, logs: await readArtifact(root, id, "events.ndjson") };
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
