import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWebUiServer } from "../src/ui.js";
import { buildOpenApiDocument } from "../src/openapi.js";
import type { AddressInfo } from "node:net";

// 校验 openapi.ts 文档与 ui.ts 实际路由表的一致性：端点增删时两边必须同步。

interface Operation {
  summary?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<string, unknown>;
  security?: unknown[];
}

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

function documentPaths(): Map<string, Set<string>> {
  const doc = buildOpenApiDocument("127.0.0.1", 4173) as {
    paths: Record<string, Record<string, Operation>>;
  };
  const paths = new Map<string, Set<string>>();
  for (const [path, operations] of Object.entries(doc.paths))
    paths.set(path, new Set(Object.keys(operations)));
  return paths;
}

/** 从文档路径模板（/api/jobs/{jobId}/approve）推导应能命中的真实路由。 */
function realize(template: string): string {
  const fills: Record<string, string> = { jobId: "j1", name: "diff.patch" };
  return template.replace(/\{(\w+)\}/g, (_, key: string) => fills[key] ?? key);
}

interface ApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  components: { securitySchemes: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
}

test("buildOpenApiDocument 输出 3.1 结构且含鉴权与 server 定义", () => {
  const doc = buildOpenApiDocument("127.0.0.1", 4173) as unknown as ApiDocument;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "CBX Orchestrator API");
  assert.match(doc.info.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(doc.servers, [{ url: "http://127.0.0.1:4173" }]);
  assert.ok(doc.components.securitySchemes.bearerAuth);
  assert.ok(doc.components.securitySchemes.cookieAuth);
  assert.ok(Object.keys(doc.paths).length >= 20);
});

test("文档声明的每个路径方法都能被真实 server 响应（非 404）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-openapi-"));
  const paths = documentPaths();
  await withServer(workspace, async (port) => {
    for (const [template, methods] of paths) {
      if (template === "/events" || template === "/") continue; // SSE/HTML 不在此校验
      const url = `http://127.0.0.1:${port}${realize(template)}`;
      for (const method of methods) {
        const init: RequestInit =
          method === "post"
            ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
            : { method: "GET" };
        const res = await fetch(url, init);
        // 占位 jobId 对应的资源不存在 → 404 + 具体错误消息是合法响应；
        // 路由未注册才会返回 "not found"（ui.ts 兜底分支），这才是文档与实现脱节。
        let body = "";
        try {
          body = String((await res.json() as { error?: string }).error ?? "");
        } catch {
          /* 非 JSON 响应按空处理 */
        }
        assert.ok(
          !(res.status === 404 && body === "not found"),
          `${method.toUpperCase()} ${template} 在文档中声明但 server 返回 404 not found`,
        );
      }
    }
  });
});

test("文档未声明的回退路由仍返回 404（防僵尸端点未入档）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-openapi-404-"));
  await withServer(workspace, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
    assert.equal(res.status, 404);
  });
});

test("/openapi.json 端点可访问且与 buildOpenApiDocument 输出一致", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-openapi-ep-"));
  await withServer(workspace, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    const served = (await res.json()) as { openapi: string; paths: unknown };
    assert.equal(served.openapi, "3.1.0");
    const expected = buildOpenApiDocument("127.0.0.1", port) as { paths: unknown };
    // 端点实参 port 动态，比对路径集合即可
    assert.deepEqual(
      Object.keys(served.paths as object).sort(),
      Object.keys(expected.paths as object).sort(),
    );
  });
});

test("配置 token 时 /openapi.json 仍开放（生成器无凭证可读）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-openapi-token-"));
  const server = createWebUiServer(workspace, "127.0.0.1", 0, "secret");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/openapi.json`);
    assert.equal(res.status, 200);
    const denied = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(denied.status, 401);
  } finally {
    server.close();
  }
});

test("路径参数均声明 required 且位于 path 位置", () => {
  const doc = buildOpenApiDocument("127.0.0.1", 4173) as {
    paths: Record<string, Record<string, Operation>>;
  };
  for (const [template, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      for (const param of operation.parameters ?? []) {
        if (template.includes(`{${param.name}}`)) {
          assert.equal(
            param.in,
            "path",
            `${method} ${template}: 参数 ${param.name} 应在 path`,
          );
          assert.equal(
            param.required,
            true,
            `${method} ${template}: path 参数 ${param.name} 必须 required`,
          );
        }
      }
      // 每个 operation 至少声明一个响应
      assert.ok(
        operation.responses && Object.keys(operation.responses).length > 0,
        `${method} ${template} 缺少 responses`,
      );
    }
  }
});
