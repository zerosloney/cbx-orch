import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, runMcpHttpServer } from "../src/mcp-server.js";
import { createJob } from "../src/core.js";

const mcpPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "mcp-server.js",
);

function postJson(
  port: number,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(raw),
            });
          } catch {
            reject(new Error(`响应非 JSON：${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
    return undefined;
  });
}

function requestMethod(
  port: number,
  method: string,
  pathname: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method },
      (res) => resolve({ status: res.statusCode ?? 0 }),
    );
    req.on("error", reject);
    req.end();
  });
}

// =============================================================================
// callTool: adaptiveOverride 错误路径
// =============================================================================

test("MCP coverage: cbx_start adaptive 非对象/数组/null 抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-adaptive-"));
  for (const adaptive of ["string", 42, null, [1, 2]]) {
    await assert.rejects(
      callTool("cbx_start", { task: "x", adaptive, workspace }),
      /adaptive 必须是普通对象/,
    );
  }
});

test("MCP coverage: cbx_start adaptive 含未知字段抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-adaptive-unknown-"));
  await assert.rejects(
    callTool("cbx_start", {
      task: "x",
      adaptive: { enabled: true, unknown_field: 1 },
      workspace,
    }),
    /adaptive 不支持字段/,
  );
});

// =============================================================================
// callTool: optionalBoundedString 错误路径
// =============================================================================

test("MCP coverage: cbx_start context_snapshot 超限抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-ctx-"));
  await assert.rejects(
    callTool("cbx_start", {
      task: "x",
      context_snapshot: "x".repeat(65_537),
      workspace,
    }),
    /context_snapshot 超过/,
  );
});

// =============================================================================
// callTool: task_contract 非对象校验
// =============================================================================

test("MCP coverage: cbx_start task_contract 非对象/数组抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-contract-"));
  await assert.rejects(
    callTool("cbx_start", { task: "x", task_contract: "string", workspace }),
    /task_contract 必须是普通对象/,
  );
  await assert.rejects(
    callTool("cbx_start", { task: "x", task_contract: [1, 2], workspace }),
    /task_contract 必须是普通对象/,
  );
});

// =============================================================================
// callTool: 成功读取路径
// =============================================================================

test("MCP coverage: cbx_review 读取已有 review.md", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-rev-ok-"));
  const job = await createJob({
    workspace,
    task: "review 读取测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-rev-ok",
  });
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.md"), "VERDICT: PASS\n", "utf8");
  const result = (await callTool("cbx_review", {
    job_id: job.jobId,
    workspace,
  })) as { job_id: string; review: string };
  assert.equal(result.job_id, job.jobId);
  assert.equal(result.review, "VERDICT: PASS\n");
});

test("MCP coverage: cbx_artifact 读取 handback.md", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-art-ok-"));
  const job = await createJob({
    workspace,
    task: "artifact 读取测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-art-ok",
  });
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "handback.md"), "fake handback\n", "utf8");
  const result = (await callTool("cbx_artifact", {
    job_id: job.jobId,
    artifact: "handback.md",
    workspace,
  })) as { job_id: string; artifact: string; content: string };
  assert.equal(result.artifact, "handback.md");
  assert.equal(result.content, "fake handback\n");
});

test("MCP coverage: cbx_result 读取 result.json", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-res-ok-"));
  const job = await createJob({
    workspace,
    task: "result 读取测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-res-ok",
  });
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify({ verdict: "PASS", summary: "all good" }),
    "utf8",
  );
  const result = (await callTool("cbx_result", {
    job_id: job.jobId,
    workspace,
  })) as { verdict: string; summary: string };
  assert.equal(result.verdict, "PASS");
  assert.equal(result.summary, "all good");
});

// =============================================================================
// callTool: 队列操作
// =============================================================================

test("MCP coverage: cbx_queue 查看队列状态", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-queue-"));
  await createJob({
    workspace,
    task: "queue 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-queue-1",
  });
  const result = (await callTool("cbx_queue", { workspace })) as {
    maxConcurrent: number;
    paused: boolean;
  };
  assert.equal(typeof result.maxConcurrent, "number");
  assert.equal(typeof result.paused, "boolean");
});

test("MCP coverage: cbx_queue_pause/cbx_queue_resume 生命周期", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-pause-"));
  await createJob({
    workspace,
    task: "pause 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-pause-1",
  });
  const paused = (await callTool("cbx_queue_pause", { workspace })) as {
    paused: boolean;
  };
  assert.equal(paused.paused, true);
  const resumed = (await callTool("cbx_queue_resume", { workspace })) as {
    paused: boolean;
  };
  assert.equal(resumed.paused, false);
});

// =============================================================================
// callTool: 任务操作
// =============================================================================

test("MCP coverage: cbx_cancel 取消已存在的任务", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-cancel-ok-"));
  const job = await createJob({
    workspace,
    task: "cancel 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-cancel-ok",
  });
  const result = (await callTool("cbx_cancel", {
    job_id: job.jobId,
    workspace,
  })) as { status: string };
  assert.equal(result.status, "cancelled");
});

test("MCP coverage: cbx_forget 删除已取消任务（含 reason）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-forget-"));
  const job = await createJob({
    workspace,
    task: "forget 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-forget-1",
  });
  await callTool("cbx_cancel", { job_id: job.jobId, workspace });
  const result = (await callTool("cbx_forget", {
    job_id: job.jobId,
    reason: "test cleanup",
    workspace,
  })) as { job_id: string; status: string };
  assert.equal(result.job_id, job.jobId);
});

test("MCP coverage: cbx_purge 删除已取消任务（无 reason）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-purge-"));
  const job = await createJob({
    workspace,
    task: "purge 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-purge-1",
  });
  await callTool("cbx_cancel", { job_id: job.jobId, workspace });
  const result = (await callTool("cbx_purge", {
    job_id: job.jobId,
    workspace,
  })) as { job_id: string; status: string };
  assert.equal(result.job_id, job.jobId);
});

test("MCP coverage: cbx_retry 对不存在任务抛错", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-retry-"));
  await assert.rejects(
    callTool("cbx_retry", { job_id: "no-such-job", workspace }),
    (err: unknown) => err instanceof Error,
  );
});

// =============================================================================
// callTool: cbx_start 成功路径（含 adaptive override + context_snapshot）
// =============================================================================

test("MCP coverage: cbx_start 透传 adaptive + context_snapshot 成功", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-start-adaptive-"));
  // 先创建一个 job 以初始化 SQLite，再暂停队列，避免 startBackground 派生 worker
  await createJob({
    workspace,
    task: "init",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    jobId: "init-job",
  });
  await callTool("cbx_queue_pause", { workspace });
  const result = (await callTool("cbx_start", {
    task: "adaptive 透传测试",
    review: true,
    adaptive: { enabled: true, max_rounds: 3, manager_executor: "codebuddy" },
    context_snapshot: "some context",
    workspace,
  })) as { job_id: string; status: string };
  assert.equal(result.status, "queued");
  // 验证 adaptive 参数落盘到 context.json
  const ctx = JSON.parse(
    await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(workspace, ".cbx", "jobs", result.job_id, "context.json"),
        "utf8",
      ),
    ),
  ) as { adaptive: { enabled: boolean; maxRounds: number; managerExecutor: string } };
  assert.equal(ctx.adaptive.enabled, true);
  assert.equal(ctx.adaptive.maxRounds, 3);
  assert.equal(ctx.adaptive.managerExecutor, "codebuddy");
});

// =============================================================================
// HTTP dispatch: 分支补测
// =============================================================================

test("MCP coverage: HTTP initialize 带 protocolVersion 协商", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal(res.status, 200);
    const result = res.body.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, "2025-06-18");
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP initialize 带不支持的 protocolVersion 回退", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    assert.equal(res.status, 200);
    const result = res.body.result as Record<string, unknown>;
    // 不支持的版本回退到服务端默认（HTTP 为 2025-06-18）
    assert.equal(result.protocolVersion, "2025-06-18");
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP resources/read 读取非 events 资源", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-read-art-"));
  const job = await createJob({
    workspace,
    task: "read artifact 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-read-art",
  });
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "handback.md"), "artifact content\n", "utf8");
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const uri = `cbx://job/${job.jobId}/handback.md?workspace=${encodeURIComponent(workspace)}`;
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(res.status, 200);
    const contents = (res.body.result as { contents: Array<{ text: string; mimeType: string }> }).contents;
    assert.equal(contents[0].text, "artifact content\n");
    assert.equal(contents[0].mimeType, "text/plain");
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP resources/read JSON artifact mimeType", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-read-json-"));
  const job = await createJob({
    workspace,
    task: "read json 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "mcp-read-json",
  });
  const dir = path.join(workspace, ".cbx", "jobs", job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.json"), '{"verdict":"PASS"}', "utf8");
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const uri = `cbx://job/${job.jobId}/review.json?workspace=${encodeURIComponent(workspace)}`;
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri },
    });
    assert.equal(res.status, 200);
    const contents = (res.body.result as { contents: Array<{ mimeType: string }> }).contents;
    assert.equal(contents[0].mimeType, "application/json");
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP resources/subscribe 拒绝非 cbx:// URI", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 5,
      method: "resources/subscribe",
      params: { uri: "http://example.com/foo" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.error);
    assert.match(
      String((res.body.error as { message: string }).message),
      /不支持订阅的资源 URI/,
    );
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP resources/read 不支持的 URI 格式", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "http://example.com/foo" },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.error);
    assert.match(
      String((res.body.error as { message: string }).message),
      /不支持的资源 URI/,
    );
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP PUT /mcp 返回 405", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await requestMethod(server.port, "PUT", "/mcp");
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test("MCP coverage: HTTP DELETE /mcp 返回 405", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await requestMethod(server.port, "DELETE", "/mcp");
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

// =============================================================================
// stdio transport: 分支补测
// =============================================================================

test("MCP coverage: stdio 空行不产生响应", async () => {
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  proc.stdin.write("\n");
  proc.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 500);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(output.trim(), "");
});

test("MCP coverage: stdio 无效 JSON 返回错误响应", async () => {
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  proc.stdin.write("{bad json\n");
  proc.stdin.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, 2000);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const lines = output.trim().split(/\n/).filter(Boolean);
  assert.ok(lines.length >= 1, "应有至少一行响应");
  const response = JSON.parse(lines[0] ?? "{}") as {
    jsonrpc: string;
    id: null;
    error: { code: number; message: string };
  };
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.error.code, -32000);
});

test("MCP coverage: stdio resources/subscribe 在 stdio 模式抛错", async () => {
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const outChunks: Buffer[] = [];
  let settled = false;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      const text = Buffer.concat(outChunks).toString("utf8");
      const lines = text.trim().split(/\n/).filter(Boolean);
      if (lines.length >= 1 && !settled) {
        settled = true;
        try {
          resolve(JSON.parse(lines[0] ?? "{}"));
        } catch {
          reject(new Error(`响应非 JSON：${text}`));
        }
      }
    });
    proc.on("error", reject);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("超时"));
      }
    }, 5000);
  });
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/subscribe",
      params: { uri: "cbx://job/test/events" },
    }) + "\n",
  );
  proc.stdin.end();
  const response = await result;
  assert.ok(response.error, "应在 stdio 模式下返回 error");
  assert.match(
    String((response.error as { message: string }).message),
    /资源订阅需要 HTTP/,
  );
});

test("MCP coverage: stdio resources/unsubscribe 在 stdio 模式抛错", async () => {
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const outChunks: Buffer[] = [];
  let settled = false;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      const text = Buffer.concat(outChunks).toString("utf8");
      const lines = text.trim().split(/\n/).filter(Boolean);
      if (lines.length >= 1 && !settled) {
        settled = true;
        try {
          resolve(JSON.parse(lines[0] ?? "{}"));
        } catch {
          reject(new Error(`响应非 JSON：${text}`));
        }
      }
    });
    proc.on("error", reject);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("超时"));
      }
    }, 5000);
  });
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/unsubscribe",
      params: { uri: "cbx://job/test/events" },
    }) + "\n",
  );
  proc.stdin.end();
  const response = await result;
  assert.ok(response.error, "应在 stdio 模式下返回 error");
  assert.match(
    String((response.error as { message: string }).message),
    /资源订阅需要 HTTP/,
  );
});

test("MCP coverage: stdio tools/call dispatch 成功路径", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-stdio-call-"));
  await createJob({
    workspace,
    task: "stdio call 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "stdio-call-1",
  });
  const proc = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CBX_WORKSPACE: workspace },
  });
  const outChunks: Buffer[] = [];
  let settled = false;
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      outChunks.push(chunk);
      const text = Buffer.concat(outChunks).toString("utf8");
      const lines = text.trim().split(/\n/).filter(Boolean);
      if (lines.length >= 1 && !settled) {
        settled = true;
        try {
          resolve(JSON.parse(lines[0] ?? "{}"));
        } catch {
          /* wait for more data */
        }
      }
    });
    proc.on("error", reject);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("超时"));
      }
    }, 5000);
  });
  proc.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "cbx_list", arguments: {} },
    }) + "\n",
  );
  proc.stdin.end();
  const response = await result;
  assert.ok(response.result, "应返回 result");
  const rpcResult = response.result as { content: Array<{ text: string }> };
  const parsed = JSON.parse(rpcResult.content[0].text) as Array<{
    jobId: string;
  }>;
  assert.ok(parsed.some((j) => j.jobId === "stdio-call-1"));
});
