import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, health, loadState, readArtifact } from "../src/core.js";
import { createWebUiServer } from "../src/ui.js";
import { finishSpan, flushDeliveries, publishEvent, startSpan } from "../src/observability.js";
import { MAX_CAPTURE_BYTES, runProcess, terminateTree } from "../src/process-runner.js";
import { APP_VERSION } from "../src/version.js";

async function closeServer(server: ReturnType<typeof createWebUiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fetchWithAuth(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

test("Web UI exposes read-only local routes without wildcard CORS", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const job = await createJob({ workspace, task: "UI", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "ui-job" });
  const server = createWebUiServer(workspace);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /CBX Orchestrator/);
    assert.match(pageHtml, /<link rel="stylesheet" href="\/style\.css">/);
    assert.match(pageHtml, /<script src="\/app\.js">/);
    // 静态资源可正常访问
    const css = await fetch(`http://127.0.0.1:${port}/style.css`);
    assert.equal(css.status, 200);
    const cssText = await css.text();
    assert.match(cssText, /\.tabs\{/);
    assert.match(cssText, /\.tab-panel/);
    assert.match(cssText, /timeline-row/);
    const js = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(js.status, 200);
    const jsText = await js.text();
    assert.match(jsText, /job-select/);
    const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(jobs.headers.get("access-control-allow-origin"), null);
    assert.equal((await jobs.json() as Array<{ jobId: string }>)[0].jobId, job.jobId);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { status: string }).status, "ok");
    const artifact = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.jobId}/artifact/request.md`);
    assert.match(await artifact.text(), /# 任务/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/jobs/${job.jobId}/artifact/context.json.bak`)).status, 403);
  } finally { await closeServer(server); }
  assert.throws(() => createWebUiServer(workspace, "0.0.0.0"), /回环地址/);
});

test("Web UI exposes job detail APIs (timeline / executor / agent.log)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-detail-"));
  const job = await createJob({ workspace, task: "detail", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "detail-job" });
  const jobDirPath = path.join(workspace, ".cbx", "jobs", job.jobId);
  await writeFile(path.join(jobDirPath, "events.ndjson"), [
    JSON.stringify({ event: "job.state_changed", jobId: job.jobId, status: "queued", phase: "queued", at: "2026-08-06T11:00:00.000Z" }),
    JSON.stringify({ event: "process_started", command: ["codebuddy", "-p", "do work"], at: "2026-08-06T11:00:05.000Z" }),
    JSON.stringify({ event: "job.state_changed", jobId: job.jobId, status: "running", phase: "executor", at: "2026-08-06T11:00:05.000Z" }),
  ].join("\n") + "\n", "utf8");
  await writeFile(path.join(jobDirPath, "agent.log"), "fake executor output\n", "utf8");
  const server = createWebUiServer(workspace);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const timeline = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.jobId}/timeline`)).json() as { stages: Array<{ name: string }>; currentStage: string | null; elapsedSec: number };
    assert.equal(timeline.stages.length, 2);
    assert.equal(timeline.stages[0].name, "queued");
    assert.equal(timeline.currentStage, "running");
    assert.ok(timeline.elapsedSec >= 0);
    const executor = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.jobId}/executor`)).json() as { pid: number | null; alive: boolean | null; command: string | null };
    assert.equal(executor.pid, null);
    assert.equal(executor.alive, null);
    assert.equal(executor.command, "codebuddy -p do work");
    const log = await (await fetch(`http://127.0.0.1:${port}/api/jobs/${job.jobId}/agent.log?since=0`)).json() as { content: string; truncated: boolean };
    assert.match(log.content, /fake executor output/);
    assert.equal(log.truncated, false);
  } finally { await closeServer(server); }
});

test("MCP initialize, tools, resources and errors preserve request ids", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-"));
  const job = await createJob({ workspace, task: "MCP", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "mcp-job" });
  const serverFile = path.resolve(process.env.CBX_TEST_MCP_SERVER ?? "dist/src/mcp-server.js");
  const child = spawn(process.execPath, [serverFile], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<unknown, (value: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      const response = JSON.parse(line) as Record<string, unknown>;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  const call = (id: number, method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 3_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    assert.equal(((await call(1, "initialize")).result as { serverInfo: { name: string } }).serverInfo.name, "cbx-orch");
    const tools = ((await call(2, "tools/list")).result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools;
    assert.ok(tools.length > 5);
    assert.ok(tools.some(tool => tool.name === "cbx_artifact"));
    assert.ok(tools.find(tool => tool.name === "cbx_start")?.inputSchema.properties?.task_contract);
    assert.ok(tools.find(tool => tool.name === "cbx_start")?.inputSchema.properties?.review_executor);
    assert.ok(tools.find(tool => tool.name === "cbx_start")?.inputSchema.properties?.adaptive);
    assert.ok(tools.find(tool => tool.name === "cbx_start")?.inputSchema.properties?.approval_before_complete);
    assert.ok(tools.find(tool => tool.name === "cbx_continue")?.inputSchema.properties?.extra_rounds);
    assert.ok(tools.find(tool => tool.name === "cbx_start")?.inputSchema.properties?.allow_unsafe_permissions);
    assert.ok(tools.some(tool => tool.name === "cbx_review_gate"));
    const status = await call(3, "tools/call", { name: "cbx_status", arguments: { workspace, job_id: job.jobId } });
    assert.equal((((status.result as { structuredContent: { jobId: string } }).structuredContent).jobId), job.jobId);
    const forbiddenArtifact = await call(31, "tools/call", { name: "cbx_artifact", arguments: { workspace, job_id: job.jobId, artifact: "request.md" } });
    assert.match(String((forbiddenArtifact.error as { message: string }).message), /不允许通过 cbx_artifact/);
    const invalidContract = await call(32, "tools/call", { name: "cbx_start", arguments: { workspace, task: "invalid", task_contract: [] } });
    assert.match(String((invalidContract.error as { message: string }).message), /task_contract 必须是普通对象/);
    const jobsBeforeInvalidStages = await readdir(path.join(workspace, ".cbx", "jobs"));
    const invalidStages = [
      [{ name: "missing-executor", task: "do work" }],
      [{ name: "missing-task", executor: "codebuddy" }],
      [{ name: 42, executor: "codebuddy", task: "do work" }],
      [{ name: "wrong-executor", executor: 42, task: "do work" }],
      [{ name: "wrong-task", executor: "codebuddy", task: 42 }],
      [{ name: "wrong-review-executor", executor: "codebuddy", task: "do work", review_executor: 42 }],
      [{ name: "wrong-skip-review", executor: "codebuddy", task: "do work", skip_review: "false" }],
    ];
    const expectedStageErrors = [/executor 必须是非空字符串/, /task 必须是非空字符串/, /name 必须是非空字符串/, /executor 必须是非空字符串/, /task 必须是非空字符串/, /reviewExecutor 必须是非空字符串/, /skipReview 必须是布尔值/];
    for (let index = 0; index < invalidStages.length; index += 1) {
      const response = await call(33 + index, "tools/call", { name: "cbx_start", arguments: { workspace, task: "invalid stage", task_contract: { stages: invalidStages[index] } } });
      assert.match(String((response.error as { message: string }).message), expectedStageErrors[index]);
    }
    assert.deepEqual(await readdir(path.join(workspace, ".cbx", "jobs")), jobsBeforeInvalidStages, "invalid stages must not create or enqueue jobs");
    const jobsBeforeInvalidAdaptive = await readdir(path.join(workspace, ".cbx", "jobs"));
    for (const [index, adaptive] of [[], { unknown: true }, { enabled: "yes" }, { max_rounds: 0 }].entries()) {
      const response = await call(50 + index, "tools/call", { name: "cbx_start", arguments: { workspace, task: "invalid adaptive", review: true, adaptive } });
      assert.match(String((response.error as { message: string }).message), /adaptive/);
    }
    assert.deepEqual(await readdir(path.join(workspace, ".cbx", "jobs")), jobsBeforeInvalidAdaptive, "invalid adaptive options must not create jobs");
    const invalidApproval = await call(55, "tools/call", { name: "cbx_start", arguments: { workspace, task: "invalid approval", approval_before_complete: "yes" } });
    assert.match(String((invalidApproval.error as { message: string }).message), /approval_before_complete 必须是布尔值/);
    const invalidExtraRounds = await call(56, "tools/call", { name: "cbx_continue", arguments: { workspace, job_id: job.jobId, extra_rounds: 0 } });
    assert.match(String((invalidExtraRounds.error as { message: string }).message), /extra_rounds 必须是 1 到 100/);
    const validAdaptive = await call(54, "tools/call", { name: "cbx_start", arguments: { workspace, task: "valid adaptive", review: true, adaptive: { enabled: true, max_rounds: 3, manager_executor: "codebuddy" } } });
    const adaptiveJobId = ((validAdaptive.result as { structuredContent: { job_id: string } }).structuredContent).job_id;
    const adaptiveContext = JSON.parse(await readFile(path.join(workspace, ".cbx", "jobs", adaptiveJobId, "context.json"), "utf8"));
    assert.deepEqual(adaptiveContext.adaptive, { enabled: true, maxRounds: 3, managerExecutor: "codebuddy" });
    const validStage = await call(40, "tools/call", { name: "cbx_start", arguments: { workspace, task: "valid stage", task_contract: { stages: [{ name: "implement", executor: "codebuddy", task: "do work", review_executor: "opencode", skip_review: false }] } } });
    const validJobId = ((validStage.result as { structuredContent: { job_id: string } }).structuredContent).job_id;
    const persistedContract = JSON.parse(await readFile(path.join(workspace, ".cbx", "jobs", validJobId, "context-contract.json"), "utf8")) as { stages: Array<Record<string, unknown>> };
    assert.deepEqual(persistedContract.stages[0], { name: "implement", executor: "codebuddy", task: "do work", reviewExecutor: "opencode", skipReview: false });
    const resources = ((await call(4, "resources/list", { workspace })).result as { resources: Array<{ uri: string }> }).resources;
    const requestResource = resources.find(resource => resource.uri.includes(`/mcp-job/request.md`));
    assert.ok(requestResource);
    const queuedJobResources = resources.filter(resource => resource.uri.includes(`/mcp-job/`));
    assert.ok(!queuedJobResources.some(resource => resource.uri.includes("result.json")), "queued job 不应暴露 result.json");
    assert.ok(!queuedJobResources.some(resource => resource.uri.includes("review.md")), "queued job 不应暴露 review.md");
    assert.ok(!queuedJobResources.some(resource => resource.uri.includes("handback.md")), "queued job 不应暴露 handback.md");
    const read = await call(5, "resources/read", { uri: requestResource!.uri });
    assert.match(((read.result as { contents: Array<{ text: string }> }).contents[0].text), /MCP/);
    const error = await call(73, "unknown/method");
    assert.equal(error.id, 73);
    assert.match(String((error.error as { message: string }).message), /未知方法/);
    // Per JSON-RPC 2.0: a notification (no id) must not receive a response.
    // Send initialized notification, then a real request and assert it still works.
    const collected: string[] = [];
    const collectListener = (chunk: Buffer) => { collected.push(chunk.toString("utf8")); };
    child.stdout.on("data", collectListener);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await new Promise(resolve => setTimeout(resolve, 150));
      const check = await call(74, "ping");
      assert.deepEqual((check.result as Record<string, unknown>), {});
      assert.equal(collected.some(line => line.includes("notifications/initialized") || line.includes('"id":null')), false, "notification 不应产生响应");
    } finally { child.stdout.off("data", collectListener); }
  } finally { child.kill(); }
});

test("job and artifact paths reject traversal and destructive test commands", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-security-"));
  await assert.rejects(() => loadState(workspace, "../../outside"), /无效的任务 ID/);
  const job = await createJob({ workspace, task: "安全", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "safe-job" });
  await assert.rejects(() => readArtifact(workspace, job.jobId, "../context.json"), /不允许读取/);
  await assert.rejects(() => createJob({ workspace, task: "危险", testCommand: "npm test && Remove-Item -Recurse .", review: false, isolated: false, permissionMode: "auto", maxTurns: 5 }), /不允许/);
});

test("SQLite state remains authoritative when legacy state artifact is corrupt", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-state-"));
  const job = await createJob({ workspace, task: "状态", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "state-job" });
  assert.equal((await readdir(job.directory)).some(name => name.includes("state.json.") && name.endsWith(".tmp")), false);
  await writeFile(path.join(job.directory, "state.json"), "{partial", "utf8");
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
});

test("timed out executor plugins are killed before they can mutate later", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-timeout-"));
  const plugin = path.join(workspace, "slow-plugin.mjs");
  await writeFile(plugin, `export default { async run(request) { await new Promise(r => setTimeout(r, 500)); await (await import("node:fs/promises")).writeFile(request.workdir + "/late-change.txt", "late"); return { code: 0 }; } };\n`, "utf8");
  const job = await createJob({ workspace, task: "插件超时", review: false, isolated: false, executor: plugin, permissionMode: "auto", maxTurns: 5, timeoutMs: 100, maxRetries: 0, jobId: "plugin-timeout" });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "failed");
  assert.equal(state.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 650));
  await assert.rejects(() => readFile(path.join(workspace, "late-change.txt")), /ENOENT/);
});

test("events remain ordered and webhook failures do not reject state notifications", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-events-"));
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ notifications: { webhook: "http://127.0.0.1:1/unavailable" } }), "utf8");
  await Promise.all(Array.from({ length: 12 }, (_, sequence) => publishEvent(workspace, "test.sequence", { sequence })));
  const lines = (await readFile(path.join(workspace, ".cbx", "events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { payload: { sequence: number } });
  assert.deepEqual(lines.map(line => line.payload.sequence), Array.from({ length: 12 }, (_, index) => index));
});

test("webhook delivery is queued without blocking the state event writer", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-async-delivery-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    setTimeout(() => response.end("ok"), 600);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ notifications: { webhook: `http://127.0.0.1:${port}`, timeoutMs: 2_000, maxRetries: 0 } }), "utf8");
  try {
    const startedAt = Date.now();
    await publishEvent(workspace, "test.async", {});
    assert.ok(Date.now() - startedAt < 400, "publishEvent should not await the remote response");
    assert.equal((await health(workspace)).metrics.pendingDeliveries, 1);
    await flushDeliveries(workspace, true);
    assert.equal(requests, 1);
    assert.equal((await health(workspace)).metrics.pendingDeliveries, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("webhook and OTLP retry non-2xx responses then persist delivery failures", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-delivery-"));
  const requests = { webhook: 0, otlp: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/webhook") requests.webhook += 1;
    if (request.url === "/otlp") requests.otlp += 1;
    response.statusCode = 503; response.end("unavailable");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({
    notifications: { webhook: `http://127.0.0.1:${port}/webhook`, timeoutMs: 100, maxRetries: 2, retryBaseMs: 1 },
    telemetry: { enabled: true, endpoint: `http://127.0.0.1:${port}/otlp`, timeoutMs: 100, maxRetries: 2, retryBaseMs: 1 },
  }), "utf8");
  try {
    await publishEvent(workspace, "test.delivery", {});
    await finishSpan(workspace, startSpan("test.delivery"), "ok");
    await flushDeliveries(workspace, true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  assert.equal(requests.webhook, 3);
  assert.equal(requests.otlp, 3);
  const failures = (await readFile(path.join(workspace, ".cbx", "delivery-failures.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { channel: string; attempts: number });
  assert.deepEqual(failures.map(failure => failure.channel), ["webhook", "otlp"]);
  assert.ok(failures.every(failure => failure.attempts === 3));
});

test("governance redacts configured fields from event artifacts and webhook payloads", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-redaction-"));
  let received = "";
  const server = createServer((request, response) => { request.setEncoding("utf8"); request.on("data", chunk => { received += chunk; }); request.on("end", () => response.end()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await writeFile(path.join(workspace, ".cbx.json"), JSON.stringify({ notifications: { webhook: `http://127.0.0.1:${port}` }, governance: { retentionDays: 7, redactFields: ["token", "password"] } }), "utf8");
  try {
    await publishEvent(workspace, "test.redaction", { token: "top-secret", nested: { password: "hidden" } });
    await flushDeliveries(workspace, true);
  }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const events = await readFile(path.join(workspace, ".cbx", "events.ndjson"), "utf8");
  assert.doesNotMatch(events, /top-secret|hidden/);
  assert.doesNotMatch(received, /top-secret|hidden/);
  assert.match(events, /\[REDACTED\]/);
});

test("runtime and plugin manifests share the package patch version", async () => {
  const root = path.resolve(".");
  const readVersion = async (file: string, marketplace = false): Promise<string> => {
    const value = JSON.parse(await readFile(path.join(root, file), "utf8")) as { version?: string; plugins?: Array<{ version?: string }> };
    return marketplace ? String(value.plugins?.[0]?.version) : String(value.version);
  };
  const packageVersion = await readVersion("package.json");
  assert.equal(APP_VERSION, packageVersion);
  assert.equal(await readVersion("marketplace.json", true), packageVersion);
  assert.equal(await readVersion(".claude-plugin/plugin.json"), packageVersion);
  assert.equal(await readVersion(".claude-plugin/marketplace.json", true), packageVersion);
  assert.equal(await readVersion(".zcode-plugin/plugin.json"), packageVersion);
});

test("process output is fully logged while memory capture keeps only a bounded tail", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-output-limit-"));
  const logFile = path.join(workspace, "process.log");
  const expectedBytes = MAX_CAPTURE_BYTES + 32_768;
  const result = await runProcess(process.execPath, ["-e", `process.stdout.write("x".repeat(${expectedBytes}))`], workspace, 10_000, logFile);
  assert.equal(result.code, 0);
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.output) <= MAX_CAPTURE_BYTES);
  assert.equal((await stat(logFile)).size, expectedBytes);
});

test("terminateTree escalates and confirms a resistant process has exited", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-terminate-tree-"));
  const pidFile = path.join(workspace, "active.pid");
  const running = runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], workspace, 20_000, undefined, pidFile);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { await stat(pidFile); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.equal(await terminateTree(pid, 100, 2_000), true);
  const result = await running;
  assert.notEqual(result.code, 0);
});

test("Web UI token auth protects API endpoints while healthz remains open", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-auth-"));
  const job = await createJob({ workspace, task: "auth-test", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "auth-job" });
  const token = "test-secret-token";
  const server = createWebUiServer(workspace, "127.0.0.1", 0, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // healthz 保持开放
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal((await healthz.json() as { status: string }).status, "ok");

    // 无 token 访问 API 返回 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.headers.get("www-authenticate"), "Bearer");
    assert.match(await noAuth.text(), /unauthorized/);

    // 错误 token 返回 401
    const wrongAuth = await fetch(`http://127.0.0.1:${port}/api/jobs`, { headers: { authorization: "Bearer wrong-token" } });
    assert.equal(wrongAuth.status, 401);

    // 正确 token 可以访问
    const withAuth = await fetchWithAuth(`http://127.0.0.1:${port}/api/jobs`, token);
    assert.equal(withAuth.status, 200);
    const jobs = await withAuth.json() as Array<{ jobId: string }>;
    assert.equal(jobs[0].jobId, job.jobId);

    // 首页无需鉴权（返回 HTML）
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CBX Orchestrator/);

    // SSE 支持 Authorization header
    const sseWithAuth = await fetch(`http://127.0.0.1:${port}/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(sseWithAuth.status, 200);
    assert.equal(sseWithAuth.headers.get("content-type"), "text/event-stream");
    sseWithAuth.body?.cancel();

    // SSE 无 token 返回 401
    const sseNoToken = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(sseNoToken.status, 401);
  } finally { await closeServer(server); }
});

test("Web UI without token allows unauthenticated access", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-noauth-"));
  await createJob({ workspace, task: "noauth", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "noauth-job" });
  const server = createWebUiServer(workspace, "127.0.0.1", 0);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(jobs.status, 200);
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(healthz.status, 200);
  } finally { await closeServer(server); }
});

test("end-to-end job execution with mock executor plugin", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-e2e-"));
  const plugin = path.join(workspace, "mock-executor.mjs");
  await writeFile(plugin, `
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
export default {
  manifest: { name: "mock-executor", version: "1.0.0", apiVersion: "cbx.executor/v1", capabilities: ["execute"] },
  async run(request) {
    // 模拟执行器：写入 handback.md 和一个代码文件
    await mkdir(request.workdir, { recursive: true });
    await writeFile(path.join(request.workdir, "output.txt"), "generated by mock executor");
    await writeFile(path.join(request.directory, "handback.md"), "# Handback\\n\\nTask completed successfully.");
    return { code: 0, output: "mock execution done" };
  }
};
`, "utf8");
  const job = await createJob({
    workspace,
    task: "e2e test task",
    review: false,
    isolated: false,
    executor: plugin,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "e2e-job",
  });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.phase, "done");
  // 验证执行器确实写入了文件
  const output = await readFile(path.join(workspace, "output.txt"), "utf8");
  assert.match(output, /generated by mock executor/);
  // 验证 handback 存在
  const handback = await readArtifact(workspace, job.jobId, "handback.md");
  assert.match(handback, /Task completed/);
  // 验证 result.json 包含正确的状态
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.equal(result.status, "done");
  assert.equal(result.jobId, job.jobId);
});

test("multi-stage job execution preserves stage reports", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-multistage-"));
  const plugin = path.join(workspace, "stage-executor.mjs");
  await writeFile(plugin, `
import { writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
export default {
  manifest: { name: "stage-executor", version: "1.0.0", apiVersion: "cbx.executor/v1", capabilities: ["execute"] },
  async run(request) {
    // 上下文握手阶段：生成 understanding.json 以通过 handshake
    if (request.prompt.includes("context handshake") || request.prompt.includes("understanding.json")) {
      await writeFile(path.join(request.directory, "understanding.json"), JSON.stringify({
        interpretedGoal: "multi-stage test",
        plannedFiles: [],
        acceptanceCriteria: [],
        assumptions: [],
        blockingQuestions: []
      }));
      return { code: 0, output: "handshake done" };
    }
    const marker = path.join(request.workdir, "stages.log");
    await appendFile(marker, request.prompt.slice(0, 100) + "\\n---\\n");
    await writeFile(path.join(request.directory, "handback.md"), "# Stage done\\nPrompt: " + request.prompt.slice(0, 50));
    return { code: 0, output: "stage done" };
  }
};
`, "utf8");
  const job = await createJob({
    workspace,
    task: "multi-stage task",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "multistage-job",
    taskContract: {
      goal: "multi-stage test",
      stages: [
        { name: "stage-one", executor: plugin, task: "first stage work" },
        { name: "stage-two", executor: plugin, task: "second stage work" },
      ],
    },
  });
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // 验证 stages 报告存在
  const result = JSON.parse(await readArtifact(workspace, job.jobId, "result.json"));
  assert.ok(Array.isArray(result.stages));
  assert.equal(result.stages.length, 2);
  assert.equal(result.stages[0].name, "stage-one");
  assert.equal(result.stages[1].name, "stage-two");
  // 验证每个 stage 都有 handback 副本
  const artifacts = await readdir(path.join(workspace, ".cbx", "jobs", job.jobId));
  assert.ok(artifacts.some(name => name.startsWith("stage-0-") && name.endsWith("-handback.md")));
  assert.ok(artifacts.some(name => name.startsWith("stage-1-") && name.endsWith("-handback.md")));
});

test("job cancellation stops execution and marks state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cancel-"));
  const plugin = path.join(workspace, "slow-executor.mjs");
  await writeFile(plugin, `
export default {
  manifest: { name: "slow-executor", version: "1.0.0", apiVersion: "cbx.executor/v1", capabilities: ["execute"] },
  async run(request) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    return { code: 0, output: "should not reach here" };
  }
};
`, "utf8");
  const job = await createJob({
    workspace,
    task: "cancel test",
    review: false,
    isolated: false,
    executor: plugin,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 10_000,
    jobId: "cancel-job",
  });
  // 启动后台执行
  const { startBackground, cancelJob, loadState } = await import("../src/core.js");
  await startBackground(workspace, job.jobId);
  // 等待任务开始运行
  await new Promise(resolve => setTimeout(resolve, 500));
  const runningState = await loadState(workspace, job.jobId);
  assert.ok(["running", "queued"].includes(runningState.status));
  // 取消任务
  const cancelled = await cancelJob(workspace, job.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.phase, "cancelled");
  assert.ok(cancelled.cancelledAt);
});

