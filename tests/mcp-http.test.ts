import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob } from "../src/core.js";
import { logJobEvent } from "../src/state.js";
import { runMcpHttpServer } from "../src/mcp-server.js";

// Node 24 运行时支持 Promise.withResolvers；tsconfig lib 为 ES2022 未声明，
// 在此按官方签名补环境声明，不改全局 tsconfig。
declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

// =============================================================================
// MCP streamable HTTP transport (cbx mcp --http)
// =============================================================================

function postJson(
  port: number,
  pathname: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    body: Record<string, unknown>;
  }>();
  const req = request(
    {
      host: "127.0.0.1",
      port,
      path: pathname,
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
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          reject(new Error(`响应非 JSON：${raw}`));
        }
      });
    },
  );
  req.on("error", reject);
  req.end(JSON.stringify(body));
  return promise;
}

interface SseChannel {
  close(): void;
  /** 等待 SSE 流中出现包含 marker 的数据帧（含超时）。 */
  waitFor(marker: string, timeoutMs: number): Promise<string>;
}

function openSse(port: number, token?: string): Promise<SseChannel> {
  const { promise, resolve, reject } = Promise.withResolvers<SseChannel>();
  const req = request(
    {
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "GET",
      headers: {
        accept: "text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE 连接失败：${res.statusCode}`));
        return;
      }
      const chunks: string[] = [];
      const waiters: Array<{
        marker: string;
        resolve: (text: string) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      }> = [];
      const text = (): string => chunks.join("");
      res.on("data", (c: Buffer) => {
        chunks.push(c.toString("utf8"));
        const t = text();
        for (const w of waiters) {
          if (t.includes(w.marker)) {
            clearTimeout(w.timer);
            w.resolve(t);
          }
        }
      });
      resolve({
        close: () => req.destroy(),
        waitFor: (marker: string, timeoutMs: number) => {
          const { promise: p, resolve: r, reject: rj } =
            Promise.withResolvers<string>();
          if (text().includes(marker)) {
            r(text());
            return p;
          }
          const w = {
            marker,
            resolve: r,
            reject: rj,
            timer: setTimeout(() => rj(new Error(`SSE 超时未收到 ${marker}`)), timeoutMs),
          };
          waiters.push(w);
          return p;
        },
      });
    },
  );
  req.on("error", reject);
  req.end();
  return promise;
}

test("MCP HTTP: initialize 返回 2025-06-18 + subscribe:true", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    assert.equal(res.status, 200);
    const result = res.body.result as Record<string, unknown>;
    assert.equal(result.protocolVersion, "2025-06-18");
    const resources = (result.capabilities as Record<string, unknown>)
      .resources as Record<string, unknown>;
    assert.equal(resources.subscribe, true);
  } finally {
    await server.close();
  }
});

test("MCP HTTP: tools/list 返回全部 19 个工具", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const res = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (res.body.result as { tools: Array<{ name: string }> }).tools;
    assert.ok(tools.some((t) => t.name === "cbx_list_workspaces"));
    assert.ok(tools.some((t) => t.name === "cbx_logs"));
    assert.equal(tools.length, 19);
  } finally {
    await server.close();
  }
});

test("MCP HTTP: resources/list 含 events 资源，resources/read 可读事件增量", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-http-"));
  await createJob({
    workspace,
    task: "HTTP 事件资源测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-evt-1",
  });
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    const listRes = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
      params: { workspace },
    });
    const resources = (listRes.body.result as { resources: Array<{ uri: string }> }).resources;
    const eventsUri = `cbx://job/http-evt-1/events?workspace=${encodeURIComponent(workspace)}`;
    assert.ok(resources.some((r) => r.uri === eventsUri), "缺少 events 资源");

    const readRes = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: eventsUri },
    });
    const contents = (readRes.body.result as { contents: Array<{ text: string }> }).contents;
    const parsed = JSON.parse(contents[0].text) as {
      events: unknown[];
      next_offset: number;
    };
    assert.ok(Array.isArray(parsed.events));
    assert.equal(typeof parsed.next_offset, "number");
  } finally {
    await server.close();
  }
});

test("MCP HTTP: 订阅 events 资源后事件变化推送 notifications/resources/updated", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-mcp-sub-"));
  await createJob({
    workspace,
    task: "HTTP 订阅推送测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-sub-1",
  });
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  const eventsUri = `cbx://job/http-sub-1/events?workspace=${encodeURIComponent(workspace)}`;
  try {
    const sse = await openSse(server.port);
    const subRes = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 5,
      method: "resources/subscribe",
      params: { uri: eventsUri },
    });
    assert.equal(subRes.status, 200);
    assert.deepEqual(subRes.body.result, {});
    // 触发 job 事件；tailer 是真实的 500ms 轮询，SSE 推送走真实传输，
    // 故本集成测试需要真实延迟（不能用 fake timers 驱动平台轮询）。
    logJobEvent(workspace, "http-sub-1", "test/pushed", { n: 1 });
    const stream = await sse.waitFor("notifications/resources/updated", 4000);
    assert.ok(stream.includes(eventsUri), `updated 通知缺 uri：${stream}`);
    sse.close();
  } finally {
    await server.close();
  }
});

test("MCP HTTP: 非 loopback host 拒绝启动", async () => {
  await assert.rejects(
    runMcpHttpServer({ port: 0, host: "0.0.0.0" }),
    /仅允许绑定到本机回环地址/,
  );
});

test("MCP HTTP: 配置 token 后未鉴权 401，鉴权后 200", async () => {
  const server = await runMcpHttpServer({
    port: 0,
    host: "127.0.0.1",
    token: "sekret",
  });
  try {
    const unauth = await postJson(server.port, "/mcp", {
      jsonrpc: "2.0",
      id: 6,
      method: "ping",
    });
    assert.equal(unauth.status, 401);
    // 错误 token 同样 401（覆盖常量时间比较的负路径）。
    const wrong = await postJson(
      server.port,
      "/mcp",
      { jsonrpc: "2.0", id: 8, method: "ping" },
      "not-the-secret",
    );
    assert.equal(wrong.status, 401);
    const authed = await postJson(
      server.port,
      "/mcp",
      { jsonrpc: "2.0", id: 7, method: "ping" },
      "sekret",
    );
    assert.equal(authed.status, 200);
    assert.deepEqual(authed.body.result, {});
  } finally {
    await server.close();
  }
});

// 原始 POST：返回 status + text，不强制 JSON 解析；容忍 server 提前响应（413）后关闭连接
// 导致的写入重置——已拿到响应即视为成功。
function requestRaw(
  port: number,
  body: string,
  token?: string,
): Promise<{ status: number; text: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    status: number;
    text: string;
  }>();
  const req = request(
    {
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, text: raw }),
      );
    },
  );
  req.on("error", () => resolve({ status: 0, text: "" }));
  req.end(body);
  return promise;
}

test("MCP HTTP: 无 id 的 notification 不返回 JSON-RPC 响应（JSON-RPC 2.0 守卫）", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    // 标准 MCP 客户端握手发 notifications/initialized（无 id）。修复前 dispatch 落到
    // "未知方法" 分支并回 error body，违反 JSON-RPC 2.0 且可能让客户端判定握手失败。
    const res = await requestRaw(
      server.port,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    assert.ok(
      res.status === 202,
      `notification 应回 202 无 body，got status=${res.status}`,
    );
    assert.equal(res.text, "", "notification 不应返回任何 body");
  } finally {
    await server.close();
  }
});

test("MCP HTTP: 超过 1MB 的请求体返回 413", async () => {
  const server = await runMcpHttpServer({ port: 0, host: "127.0.0.1" });
  try {
    // 2MB body：远超 1MB 上限，服务端累计字节超限后中断读取并回 413。
    const big = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "ping",
      padding: "x".repeat(2 * 1024 * 1024),
    });
    const res = await requestRaw(server.port, big);
    assert.equal(res.status, 413, `超限 body 应 413，got ${res.status}`);
  } finally {
    await server.close();
  }
});
