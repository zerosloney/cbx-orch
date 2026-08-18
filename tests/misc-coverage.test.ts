import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, killTree } from "../src/process-runner.js";
import type { StreamLogEvent } from "../src/types.js";
import {
  CodeBuddyStreamFilter,
  QwenStreamFilter,
  LineStreamAccumulator,
  createLogEventFilter,
} from "../src/log-filter.js";

// process-runner.ts 与 log-filter.ts 未覆盖区段补充：
// 超时强杀路径、spawn error 路径、killTree 回退链、
// CodeBuddy/Qwen 过滤器的 error 事件与非 JSON 回退分支。

const testCtx = { jobId: "cov-job", executor: "test-exec", stageName: "stage_0" };

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-proc-cov-"));
}

test("runProcess: 超时后强制回收并返回 timedOut", async () => {
  const cwd = await tempDir();
  const result = await runProcess(
    process.execPath,
    ["-e", "setTimeout(console.log, 60000)"],
    cwd,
    300,
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("runProcess: 不存在的命令 reject（error 事件路径）", async () => {
  const cwd = await tempDir();
  await assert.rejects(
    runProcess("cbx-definitely-missing-binary-xyz", [], cwd, 5_000),
    /ENOENT/,
  );
});

test("runProcess: logFile 落盘 stdout 内容", async () => {
  const cwd = await tempDir();
  const logFile = path.join(cwd, "out.log");
  const result = await runProcess(
    process.execPath,
    ["-e", "console.log('hello coverage')"],
    cwd,
    10_000,
    logFile,
  );
  assert.equal(result.code, 0);
  assert.ok(result.output.includes("hello coverage"));
});

test("killTree: 对真实子进程返回 true", async () => {
  const cwd = await tempDir();
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(console.log, 60000)"], {
    cwd,
    stdio: "ignore",
  });
  await new Promise((resolve) => {
    if (child.pid) resolve(undefined);
    else child.on("spawn", () => resolve(undefined));
  });
  assert.ok(child.pid);
  assert.equal(killTree(child.pid, "SIGKILL", child), true);
});

test("CodeBuddyStreamFilter: error 事件与非 JSON 行回退", () => {
  const filter = new CodeBuddyStreamFilter();
  const errorEvents = filter.processLine(
    JSON.stringify({ type: "error", message: "boom" }),
    testCtx,
  );
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].kind, "error");
  assert.equal(errorEvents[0].content, "boom");
  // 缺 message/error 字段时回退默认文案
  const fallbackEvents = filter.processLine(
    JSON.stringify({ type: "error" }),
    testCtx,
  );
  assert.equal(fallbackEvents[0].content, "CodeBuddy Error");
  // 非 JSON 行原样作为 text 事件
  const textEvents = filter.processLine("plain output line", testCtx);
  assert.equal(textEvents[0].kind, "text");
  assert.equal(textEvents[0].content, "plain output line");
  // { 开头但非法 JSON → catch 回退 text
  const brokenEvents = filter.processLine("{broken json", testCtx);
  assert.equal(brokenEvents[0].kind, "text");
  assert.equal(brokenEvents[0].content, "{broken json");
});

test("QwenStreamFilter: reasoning/text/tool_calls/error 分支", () => {
  const filter = new QwenStreamFilter();
  const reasoning = filter.processLine(
    JSON.stringify({
      choices: [{ delta: { reasoning_content: "thinking..." } }],
    }),
    testCtx,
  );
  assert.equal(reasoning[0].kind, "thought");
  assert.equal(reasoning[0].content, "thinking...");

  const text = filter.processLine(
    JSON.stringify({ choices: [{ delta: { content: "answer" } }] }),
    testCtx,
  );
  assert.equal(text[0].kind, "text");

  const tool = filter.processLine(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { name: "edit", arguments: '{"path":"a.ts"}' } },
            ],
          },
        },
      ],
    }),
    testCtx,
  );
  assert.equal(tool[0].kind, "tool_use");
  assert.deepEqual(tool[0].meta?.toolArgs, { path: "a.ts" });

  // tool arguments 非法 JSON → raw 回退
  const rawTool = filter.processLine(
    JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ function: { name: "t", arguments: "{bad" } }] } },
      ],
    }),
    testCtx,
  );
  assert.deepEqual(rawTool[0].meta?.toolArgs, { raw: "{bad" });

  // tool arguments 为对象（非字符串）→ 直接采用
  const objTool = filter.processLine(
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { name: "t2", arguments: { nested: true } } },
            ],
          },
        },
      ],
    }),
    testCtx,
  );
  assert.deepEqual(objTool[0].meta?.toolArgs, { nested: true });

  // error 对象
  const errorEvents = filter.processLine(
    JSON.stringify({ error: { message: "quota exceeded" } }),
    testCtx,
  );
  assert.equal(errorEvents[0].kind, "error");
  assert.equal(errorEvents[0].content, "quota exceeded");

  // 非 JSON 行回退 text
  const fallback = filter.processLine("not json at all", testCtx);
  assert.equal(fallback[0].kind, "text");

  // { 开头但非法 JSON → catch 回退 text
  const broken = filter.processLine("{also broken", testCtx);
  assert.equal(broken[0].kind, "text");
  assert.equal(broken[0].content, "{also broken");
});

test("LineStreamAccumulator: flush 时透传带 flush 的过滤器事件", () => {
  const flushedEvent: StreamLogEvent = {
    jobId: "cov-job",
    stageName: "stage_0",
    executor: "test-exec",
    timestamp: new Date().toISOString(),
    kind: "text",
    content: "flushed",
  };
  const customFilter = {
    name: "custom",
    processLine: (): StreamLogEvent[] => [],
    flush: (): StreamLogEvent[] => [flushedEvent],
  };
  const accumulator = new LineStreamAccumulator(customFilter);
  const events = accumulator.flush(testCtx);
  assert.equal(events.length, 1);
  assert.equal(events[0].content, "flushed");
});

test("createLogEventFilter: 未知执行器回退 generic", () => {
  assert.equal(createLogEventFilter("unknown-exec").name, "generic");
});
