import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWebUiServer, parseCursors } from "../src/ui.js";
import { publishEvent } from "../src/observability.js";
import type { AddressInfo } from "node:net";

// ui.ts 未覆盖区段的补充：parseCursors 复合游标解析 + readJsonBody 边界
// （超 1MB / 非法 JSON / 非对象 JSON / 空 body），经真实 HTTP POST 端到端驱动。

async function withServer(
  workspace: string,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createWebUiServer(workspace, "127.0.0.1", 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

function post(port: number, pathName: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("parseCursors: 无 id / 旧格式 / 复合格式 / 非法片段", () => {
  assert.deepEqual(parseCursors(undefined, 2), [0, 0]);
  assert.deepEqual(parseCursors("", 3), [0, 0, 0]);
  // 旧格式纯数字：应用到所有 workspace
  assert.deepEqual(parseCursors("5", 2), [5, 5]);
  assert.deepEqual(parseCursors("-3", 2), [0, 0]);
  // 复合格式 <wsIndex>:<seq>，逗号分隔多 workspace
  assert.deepEqual(parseCursors("0:3,1:7", 2), [3, 7]);
  assert.deepEqual(parseCursors("1:9", 2), [0, 9]);
  // 非法片段（越界 idx / 非数字 / 负 seq）被忽略，不影响其他片段
  assert.deepEqual(parseCursors("5:1,0:2", 2), [2, 0]);
  assert.deepEqual(parseCursors("abc:def,0:4", 2), [4, 0]);
  assert.deepEqual(parseCursors("0:-1,1:8", 2), [0, 8]);
  // 旧格式非法值回退 0
  assert.deepEqual(parseCursors("xyz", 2), [0, 0]);
});

test("readJsonBody: 空 body 与合法对象走通（POST approve 无 body）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-cov-"));
  await withServer(workspace, async (port) => {
    const res = await post(port, "/api/jobs", "");
    // 空 body → {} → task 校验失败（不是 body 解析错误）
    const payload = (await res.json()) as { error?: string };
    assert.equal(res.status, 400);
    assert.ok(payload.error?.includes("task"));
  });
});

test("readJsonBody: 非法 JSON 返回解析错误", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-cov-"));
  await withServer(workspace, async (port) => {
    const res = await post(port, "/api/jobs", "{not-json");
    const payload = (await res.json()) as { error?: string };
    assert.ok(payload.error?.includes("合法 JSON"));
  });
});

test("readJsonBody: 数组 body 返回非对象错误", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-cov-"));
  await withServer(workspace, async (port) => {
    const res = await post(port, "/api/jobs", "[1,2,3]");
    const payload = (await res.json()) as { error?: string };
    assert.ok(payload.error?.includes("JSON 对象"));
  });
});

test("readJsonBody: 超过 1 MB 上限返回 EBIG 错误", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-cov-"));
  await withServer(workspace, async (port) => {
    const big = JSON.stringify({ task: "x".repeat(2 * 1024 * 1024) });
    const res = await post(port, "/api/jobs", big);
    const payload = (await res.json()) as { error?: string };
    assert.ok(payload.error?.includes("1 MB"));
  });
});

test("SSE /events: 实时 broadcast 与 heartbeat 推送", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-sse-cov-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await withServer(workspace, async (port) => {
    const controller = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: controller.signal,
    });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const collecting = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
      } catch {
        /* abort 结束 */
      }
    })();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // 连接建立事件
    await sleep(500);
    assert.ok(received.includes("connected"));
    // 发布真实事件 → tailer（500ms 轮询）→ broadcast → 客户端
    await publishEvent(workspace, "cov.broadcast", { hello: 1 });
    await sleep(1_200);
    assert.ok(received.includes("cov.broadcast"));
    // 等待 heartbeat（1500ms 间隔）覆盖 interval 分支
    await sleep(1_700);
    assert.ok(received.includes("heartbeat"));
    controller.abort();
    await collecting;
  });
});

test("resolveWorkspace: ?workspace= 白名单命中与未命中回退", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-ws-cov-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await withServer(workspace, async (port) => {
    const valid = await fetch(
      `http://127.0.0.1:${port}/api/jobs?workspace=${encodeURIComponent(workspace)}`,
    );
    assert.equal(valid.status, 200);
    const invalid = await fetch(
      `http://127.0.0.1:${port}/api/jobs?workspace=${encodeURIComponent("C:\\definitely-not-mounted")}`,
    );
    // 未命中白名单回退 default workspace，仍正常响应
    assert.equal(invalid.status, 200);
  });
});
