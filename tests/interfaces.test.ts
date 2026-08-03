import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, loadState, readArtifact } from "../src/core.js";
import { createWebUiServer } from "../src/ui.js";
import { publishEvent } from "../src/observability.js";

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
    assert.match(await page.text(), /CBX Orchestrator/);
    const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(jobs.headers.get("access-control-allow-origin"), null);
    assert.equal((await jobs.json() as Array<{ jobId: string }>)[0].jobId, job.jobId);
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
  const serverFile = path.resolve("dist/src/mcp-server.js");
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
    assert.ok(((await call(2, "tools/list")).result as { tools: unknown[] }).tools.length > 5);
    const status = await call(3, "tools/call", { name: "cbx_status", arguments: { workspace, job_id: job.jobId } });
    assert.equal((((status.result as { structuredContent: { jobId: string } }).structuredContent).jobId), job.jobId);
    const resources = ((await call(4, "resources/list", { workspace })).result as { resources: Array<{ uri: string }> }).resources;
    const requestResource = resources.find(resource => resource.uri.includes("request.md"));
    assert.ok(requestResource);
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

test("corrupt state is surfaced and atomic writes leave no temporary state files", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-state-"));
  const job = await createJob({ workspace, task: "状态", review: false, isolated: false, permissionMode: "auto", maxTurns: 5, jobId: "state-job" });
  assert.equal((await readdir(job.directory)).some(name => name.includes("state.json.") && name.endsWith(".tmp")), false);
  await writeFile(path.join(job.directory, "state.json"), "{partial", "utf8");
  await assert.rejects(() => loadState(workspace, job.jobId), /JSON/);
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
