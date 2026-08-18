import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hostPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "plugin-host.js",
);

const validPlugin = `export const manifest = { apiVersion: "cbx.executor/v1", name: "test-plugin", version: "1.0.0", capabilities: ["execute"] };
export async function run(request) {
  return { code: 0, output: "ok:" + request.prompt };
}`;

const throwingPlugin = `export const manifest = { apiVersion: "cbx.executor/v1", name: "throw-plugin", version: "1.0.0", capabilities: ["execute"] };
export async function run() {
  throw new Error("plugin boom");
}`;

function runHost(
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [hostPath, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("plugin-host: 参数不足时退出码 1", () => {
  const r = runHost([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin host 缺少参数/);
});

test("plugin-host: 只传 3 个参数也报错", () => {
  const r = runHost(["a", "b", "c"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin host 缺少参数/);
});

test("plugin-host: 只传 1 个参数报错", () => {
  const r = runHost(["a"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin host 缺少参数/);
});

test("plugin-host: 只传 2 个参数报错", () => {
  const r = runHost(["a", "b"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin host 缺少参数/);
});

test("plugin-host: 成功加载插件并写入结果", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-ok-"));
  const plugin = path.join(dir, "test-plugin.mjs");
  await writeFile(plugin, validPlugin, "utf8");
  const requestFile = path.join(dir, "request.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(
    requestFile,
    JSON.stringify({
      directory: dir,
      workdir: dir,
      prompt: "hello world",
      timeoutMs: 5000,
      maxTurns: 3,
      permissionMode: "auto",
      executor: plugin,
    }),
    "utf8",
  );
  const r = runHost([plugin, dir, requestFile, resultFile]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(result.code, 0);
  assert.equal(result.output, "ok:hello world");
});

test("plugin-host: 无效 JSON 请求文件退出码 1", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-bad-"));
  const plugin = path.join(dir, "noop.mjs");
  await writeFile(plugin, validPlugin, "utf8");
  const requestFile = path.join(dir, "bad.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(requestFile, "{bad json", "utf8");
  const r = runHost([plugin, dir, requestFile, resultFile]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0, "应有 stderr 输出");
});

test("plugin-host: 插件 run 抛错时退出码 1 并输出堆栈", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-throw-"));
  const plugin = path.join(dir, "throw-plugin.mjs");
  await writeFile(plugin, throwingPlugin, "utf8");
  const requestFile = path.join(dir, "request.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(
    requestFile,
    JSON.stringify({
      directory: dir,
      workdir: dir,
      prompt: "test",
      timeoutMs: 5000,
      maxTurns: 3,
      permissionMode: "auto",
      executor: plugin,
    }),
    "utf8",
  );
  const r = runHost([plugin, dir, requestFile, resultFile]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin boom/);
});

test("plugin-host: 不存在的插件路径退出码 1", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-missing-"));
  const requestFile = path.join(dir, "request.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(
    requestFile,
    JSON.stringify({
      directory: dir,
      workdir: dir,
      prompt: "test",
      timeoutMs: 5000,
      maxTurns: 3,
      permissionMode: "auto",
      executor: "/nonexistent/plugin.mjs",
    }),
    "utf8",
  );
  const r = runHost(["/nonexistent/plugin.mjs", dir, requestFile, resultFile]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.length > 0, "应有 stderr 输出");
});

test("plugin-host: 抛出非 Error 值时用 String() 格式化", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-nonerr-"));
  const plugin = path.join(dir, "throw-string.mjs");
  await writeFile(
    plugin,
    `export const manifest = { apiVersion: "cbx.executor/v1", name: "throw-string", version: "1.0.0", capabilities: ["execute"] };
export async function run() { throw "plain string error"; }`,
    "utf8",
  );
  const requestFile = path.join(dir, "request.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(
    requestFile,
    JSON.stringify({
      directory: dir,
      workdir: dir,
      prompt: "test",
      timeoutMs: 5000,
      maxTurns: 3,
      permissionMode: "auto",
      executor: plugin,
    }),
    "utf8",
  );
  const r = runHost([plugin, dir, requestFile, resultFile]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plain string error/);
});

test("plugin-host: 请求含 plugin.policy 透传到 loadExecutorPlugin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-plugin-host-policy-"));
  const plugin = path.join(dir, "policy-plugin.mjs");
  await writeFile(plugin, validPlugin, "utf8");
  const requestFile = path.join(dir, "request.json");
  const resultFile = path.join(dir, "result.json");
  await writeFile(
    requestFile,
    JSON.stringify({
      directory: dir,
      workdir: dir,
      prompt: "policy test",
      timeoutMs: 5000,
      maxTurns: 3,
      permissionMode: "auto",
      executor: plugin,
      plugin: {
        policy: { enforce: true, allowPaths: [plugin], allowSha256: [] },
      },
    }),
    "utf8",
  );
  const r = runHost([plugin, dir, requestFile, resultFile]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(result.code, 0);
});
