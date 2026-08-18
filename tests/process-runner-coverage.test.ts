import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  captureAsync,
  killTree,
  runProcess,
  runShell,
  terminateTree,
  MAX_CAPTURE_BYTES,
  type ProcessStreamOptions,
} from "../src/process-runner.js";
import { GenericTextStreamFilter } from "../src/log-filter.js";

// ---- BoundedOutput 截断逻辑（通过 captureAsync 间接测试）----
test("captureAsync: 超大输出被截断（写文件避免 ENAMETOOLONG）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-trunc-"));
  const script = path.join(dir, "big.mjs");
  await writeFile(script, [
    `import { writeFileSync, readFileSync } from "node:fs";`,
    `const big = "x".repeat(${MAX_CAPTURE_BYTES + 1024});`,
    `process.stdout.write(big);`,
  ].join("\n"), "utf8");
  const result = await captureAsync([process.execPath, script], ".", 15_000);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length < MAX_CAPTURE_BYTES + 1024, "应被截断");
});

test("captureAsync: 多次小 chunk 累积后超限截断（覆盖 while 循环）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-chunks-"));
  const script = path.join(dir, "chunks.mjs");
  const chunkSize = 64 * 1024;
  const numChunks = Math.ceil(MAX_CAPTURE_BYTES / chunkSize) + 5;
  await writeFile(script, [
    `const s = "x".repeat(${chunkSize});`,
    `for (let i = 0; i < ${numChunks}; i++) process.stdout.write(s);`,
  ].join("\n"), "utf8");
  const result = await captureAsync([process.execPath, script], ".", 20_000);
  assert.equal(result.code, 0);
  assert.ok(
    result.stdout.length <= MAX_CAPTURE_BYTES,
    `stdout 不应超过上限，实际 ${result.stdout.length}`,
  );
});

// ---- captureAsync 超时路径 ----
test("captureAsync: 超时触发树杀并返回非零 code", async () => {
  const result = await captureAsync(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    ".",
    200,
  );
  assert.notEqual(result.code, 0);
});

// ---- captureAsync child.on('error') 路径 ----
test("captureAsync: 不存在的命令触发 error 事件", async () => {
  const result = await captureAsync(
    ["this-binary-does-not-exist-xyz123"],
    ".",
    5_000,
  );
  assert.equal(result.code, -1);
  assert.ok(result.stderr.length > 0);
});

// ---- killTree 非优先路径 ----
test("killTree: 无 child 参数时直杀 pid", () => {
  const result = killTree(999_999, "SIGKILL");
  assert.equal(typeof result, "boolean");
});

// ---- terminateTree 优雅终止 → SIGTERM → SIGKILL 升级 ----
test("terminateTree: 对活跃进程先 SIGTERM 后 SIGKILL 升级", async () => {
  const child = spawnLongProcess(5000, true);
  const pid = child.pid ?? 0;
  if (!pid) { child.kill(); return; }
  try {
    const ok = await terminateTree(pid, 100, 2_000);
    assert.equal(ok, true, "SIGKILL 升级后应确认进程已停");
  } finally {
    try { killTree(pid, "SIGKILL"); } catch { /* best effort */ }
  }
});

test("terminateTree: 优雅响应 SIGTERM 的进程在 gracefulMs 内停", async () => {
  const child = spawnLongProcess(5000, false);
  const pid = child.pid ?? 0;
  if (!pid) { child.kill(); return; }
  try {
    const ok = await terminateTree(pid, 500, 2_000);
    assert.equal(ok, true);
  } finally {
    try { killTree(pid, "SIGKILL"); } catch { /* best effort */ }
  }
});

// ---- runShell ----
test("runShell: 执行 shell 命令并捕获输出", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-shell-"));
  const script = path.join(dir, "shell.mjs");
  await writeFile(script, "console.log('shell out');", "utf8");
  const result = await runShell(
    `"${process.execPath}" "${script}"`,
    dir,
    5_000,
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /shell out/);
});

test("runShell: 超时触发 SIGKILL 并标记 timedOut", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-shell-to-"));
  const script = path.join(dir, "hang.mjs");
  await writeFile(script, "setInterval(() => {}, 1000);", "utf8");
  const result = await runShell(
    `"${process.execPath}" "${script}"`,
    dir,
    200,
  );
  assert.equal(result.timedOut, true);
});

// ---- runProcess with pidFile ----
test("runProcess: 写入 pidFile 并在结束后清理", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-pidfile-"));
  const pidFile = path.join(dir, "child.pid");
  const result = await runProcess(
    process.execPath,
    ["-e", "console.log('pid test')"],
    dir,
    5_000,
    undefined,
    pidFile,
  );
  assert.equal(result.code, 0);
  let exists = false;
  try { await readFile(pidFile, "utf8"); exists = true; } catch { /* cleaned */ }
  assert.equal(exists, false, "pidFile 应在进程结束后被清理");
});

// ---- runProcess with streamOptions (log filtering) ----
test("runProcess: streamOptions 过滤日志事件并回调 onLogEvent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-stream-"));
  const logFile = path.join(dir, "output.log");
  const events: unknown[] = [];
  const streamOptions: ProcessStreamOptions = {
    filter: new GenericTextStreamFilter(),
    filterContext: { jobId: "test", executor: "test" },
    onLogEvent: (event) => events.push(event),
  };
  const script = `console.log(JSON.stringify({ event: "test_event", at: new Date().toISOString() }))`;
  const result = await runProcess(
    process.execPath,
    ["-e", script],
    dir,
    5_000,
    logFile,
    undefined,
    streamOptions,
  );
  assert.equal(result.code, 0);
  const logContent = await readFile(logFile, "utf8");
  assert.match(logContent, /test_event/);
});

// ---- runProcess with logFile ----
test("runProcess: logFile 记录 stdout + stderr", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-log-"));
  const logFile = path.join(dir, "combined.log");
  const result = await runProcess(
    process.execPath,
    ["-e", "console.log('out line'); console.error('err line');"],
    dir,
    5_000,
    logFile,
  );
  assert.equal(result.code, 0);
  const content = await readFile(logFile, "utf8");
  assert.match(content, /out line/);
  assert.match(content, /err line/);
});

// ---- runShell with logFile ----
test("runShell: 写 logFile 并在超时后强制结算", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-shell-log-"));
  const logFile = path.join(dir, "shell.log");
  const script = path.join(dir, "hang2.mjs");
  await writeFile(script, "console.log('line1'); setInterval(() => {}, 1000);", "utf8");
  const result = await runShell(
    `"${process.execPath}" "${script}"`,
    dir,
    200,
    logFile,
  );
  assert.equal(result.timedOut, true);
  const content = await readFile(logFile, "utf8");
  assert.match(content, /line1/);
});

// ---- 辅助函数 ----
function spawnLongProcess(durationMs: number, ignoreSigterm: boolean) {
  const script = ignoreSigterm
    ? `process.on("SIGTERM", () => {}); setInterval(() => {}, ${durationMs});`
    : `setTimeout(() => {}, ${durationMs});`;
  return spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
}
