import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob } from "../src/core.js";
import { runMcpHttpServer } from "../src/mcp-server.js";
import { createWebUiServer } from "../src/ui.js";
import {
  isLoopbackHostHeader,
  isSameLoopbackOrigin,
} from "../src/http-guard.js";

// ---- 纯函数：Host / Origin 判定 ----

test("isLoopbackHostHeader accepts loopback hosts with or without port", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:4173", "localhost", "localhost:8931", "[::1]:4173", "LOCALHOST:80"])
    assert.equal(isLoopbackHostHeader(host), true, host);
  for (const host of ["evil.example", "evil.example:4173", "127.0.0.1.evil.example", "", undefined, "10.0.0.1"])
    assert.equal(isLoopbackHostHeader(host), false, String(host));
});

test("isSameLoopbackOrigin allows no-origin clients and loopback origins only", () => {
  assert.equal(isSameLoopbackOrigin(undefined), true, "非浏览器客户端无 Origin");
  for (const origin of ["http://127.0.0.1:4173", "http://localhost:4173", "http://[::1]:8931"])
    assert.equal(isSameLoopbackOrigin(origin), true, origin);
  for (const origin of ["http://evil.example", "https://evil.example", "null", "not a url", ""])
    assert.equal(isSameLoopbackOrigin(origin), false, origin);
});

// ---- HTTP 集成：跨站 / rebinding / content-type 守卫 ----

interface RawResult {
  status: number;
  text: string;
}

function post(
  port: number,
  pathname: string,
  headers: Record<string, string>,
  body: string,
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: raw }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function get(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", headers },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: raw }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("MCP HTTP rejects cross-site Origin and non-loopback Host before auth", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const jsonHeaders = { "content-type": "application/json" };
    // 跨站 Origin（浏览器 CSRF 向量）：403，无论是否带 body
    const crossOrigin = await post(server.port, "/mcp", { ...jsonHeaders, origin: "http://evil.example" }, rpc);
    assert.equal(crossOrigin.status, 403);
    // DNS rebinding：Host 非回环 → 403（GET 亦拦）
    const rebound = await get(server.port, "/mcp", { host: "evil.example:8931" });
    assert.equal(rebound.status, 403);
    // 回环 Origin（本地浏览器 MCP 客户端）放行
    const localOrigin = await post(server.port, "/mcp", { ...jsonHeaders, origin: "http://127.0.0.1:5500" }, rpc);
    assert.equal(localOrigin.status, 200);
  } finally {
    await server.close();
  }
});

test("MCP HTTP requires application/json content-type on POST /mcp", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    // text/plain simple-request 变体（修复前可直达 dispatch）
    const plain = await post(server.port, "/mcp", { "content-type": "text/plain" }, rpc);
    assert.equal(plain.status, 415);
    const json = await post(server.port, "/mcp", { "content-type": "application/json" }, rpc);
    assert.equal(json.status, 200);
  } finally {
    await server.close();
  }
});

test("Web UI rejects cross-site Origin and enforces JSON content-type for body POSTs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-guard-"));
  const job = await createJob({
    workspace,
    task: "守卫测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "guard-job",
  });
  const server = createWebUiServer(workspace, "127.0.0.1", 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // 跨站 Origin 的写操作：403
    const cross = await post(
      port,
      `/api/jobs/${job.jobId}/cancel`,
      { origin: "http://evil.example" },
      "",
    );
    assert.equal(cross.status, 403);
    // DNS rebinding Host：403
    const rebound = await get(port, "/api/jobs", { host: "evil.example:4173" });
    assert.equal(rebound.status, 403);
    // 有 body 的 POST 必须 application/json；无 body POST 保持 curl 兼容
    const continuePath = `/api/jobs/${job.jobId}/continue`;
    const plain = await post(port, continuePath, { "content-type": "text/plain" }, JSON.stringify({ message: "x" }));
    assert.equal(plain.status, 415);
    const json = await post(port, continuePath, { "content-type": "application/json" }, JSON.stringify({ message: "修复问题" }));
    assert.equal(json.status, 200);
    const noBodyPause = await post(port, "/api/queue/pause", {}, "");
    assert.equal(noBodyPause.status, 200);
  } finally {
    server.close();
  }
});
