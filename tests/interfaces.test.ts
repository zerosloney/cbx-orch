import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, loadState, readArtifact } from "../src/core.js";
import { createWebUiServer } from "../src/ui.js";
import { finishSpan, publishEvent, startSpan } from "../src/observability.js";

async function closeServer(server: ReturnType<typeof createWebUiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
    assert.match(pageHtml, /<button type="button" class="job-select">/);
    assert.match(pageHtml, /<button type="button" class="art" data-name=/);
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
  try { await publishEvent(workspace, "test.redaction", { token: "top-secret", nested: { password: "hidden" } }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const events = await readFile(path.join(workspace, ".cbx", "events.ndjson"), "utf8");
  assert.doesNotMatch(events, /top-secret|hidden/);
  assert.doesNotMatch(received, /top-secret|hidden/);
  assert.match(events, /\[REDACTED\]/);
});
