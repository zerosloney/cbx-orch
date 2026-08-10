import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { jobDir } from "../src/core.js";
import { handleTuiKey, scheduleTuiPoll, startTui } from "../src/tui/index.js";
import { truncateDisplay } from "../src/tui/components/job-table.js";
import { buildTimeline, createWebUiServer, readAgentLogIncremental, readExecutorStatus } from "../src/ui.js";

test("TUI polling honors intervalMs and refresh fetches immediately", () => {
  let scheduledInterval: number | undefined;
  let scheduledCallback: (() => void) | undefined;
  let unrefCalled = false;
  let refreshes = 0;
  const fakeTimer = {
    unref() {
      unrefCalled = true;
      return this;
    },
  } as unknown as ReturnType<typeof setInterval>;

  const timer = scheduleTuiPoll(
    () => {
      refreshes += 1;
    },
    2750,
    (callback, intervalMs) => {
      scheduledCallback = callback;
      scheduledInterval = intervalMs;
      return fakeTimer;
    },
  );
  assert.equal(timer, fakeTimer);
  assert.equal(scheduledInterval, 2750);
  assert.equal(unrefCalled, true);
  scheduledCallback?.();
  assert.equal(refreshes, 1);

  const state = {
    jobs: [],
    selectedIndex: 0,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("refresh", state, () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 2);
  assert.equal(state.needsRedraw, true);
});

// 回归：空 jobs 下 "down" 不能让 selectedIndex 变为 -1（Math.min(-1,...) 的陷阱）。
//      fetchData 只重置 >= length，不处理负数，会留下脏索引导致后续高亮错位。
test("handleTuiKey down on empty jobs keeps selectedIndex >= 0", () => {
  const state = {
    jobs: [],
    selectedIndex: 0,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("down", state, () => {});
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.needsRedraw, true);
});

// 回归：truncateDisplay 必须正确处理 ANSI 转义——转义序列不计显示宽度但原样保留。
//      旧实现逐码元 stripAnsi(ch) 对单码元无效，会把 \x1b[31m 的 5 个码元各计 1 宽，
//      导致带色串提前触发截断 + 省略号位置错位。
test("truncateDisplay strips ANSI when measuring width but preserves escapes", () => {
  // 纯文本无需截断（宽度 <= width 原样返回）
  assert.equal(truncateDisplay("hello", 10), "hello");
  assert.equal(truncateDisplay("abcdefghij", 10), "abcdefghij"); // 正好填满
  // 纯文本需截断：width=9 截到 8 文本 + …（共 9 宽）
  assert.equal(truncateDisplay("abcdefghij", 9), "abcdefgh…");
  // 带 ANSI：\x1b[31m(5码元,0宽) + abcdefghij(10宽)。width=9 应截到 8 宽文本 + …，ANSI 前缀保留。
  const colored = "\x1b[31mabcdefghij\x1b[0m";
  const out = truncateDisplay(colored, 9);
  assert.equal(out, "\x1b[31mabcdefgh…");
  // 截断结果显示宽度应 = width（省略号占 1，文本占 width-1）
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(stripAnsi(out).length, 9);
});

test("TUI removes its SIGINT listener after keyboard exit", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-tui-lifecycle-"));
  const sigintListenerCount = process.listenerCount("SIGINT");
  const dataListenerCount = process.stdin.listenerCount("data");
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  console.log = () => {};
  const quitTimer = setInterval(() => {
    process.stdin.emit("keypress", "", { name: "q", ctrl: false });
  }, 25);
  try {
    await startTui(workspace, 2750);
  } finally {
    clearInterval(quitTimer);
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  assert.equal(process.listenerCount("SIGINT"), sigintListenerCount);
  assert.equal(process.stdin.listenerCount("data"), dataListenerCount);
});

test("buildTimeline returns empty stages for a job with no events", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-empty";
  await mkdir(jobDir(workspace, jobId), { recursive: true });
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 0);
  assert.equal(timeline.currentStage, null);
  assert.equal(timeline.startedAt, null);
  assert.equal(timeline.finishedAt, null);
  assert.equal(timeline.elapsedSec, 0);
});

test("buildTimeline parses queued → running → done state changes with phases", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-tl";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const events = [
    { event: "job.state_changed", jobId, status: "queued", phase: "queued", at: "2026-08-06T10:00:00.000Z" },
    { event: "job.state_changed", jobId, status: "running", phase: "executor", at: "2026-08-06T10:00:05.000Z" },
    { event: "job.state_changed", jobId, status: "done", phase: "done", at: "2026-08-06T10:00:30.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 3);
  assert.equal(timeline.stages[0].name, "queued");
  assert.equal(timeline.stages[0].durationMs, 5000);
  assert.equal(timeline.stages[1].name, "running");
  assert.equal(timeline.stages[1].durationMs, 25000);
  assert.equal(timeline.stages[2].name, "done");
  assert.equal(timeline.stages[2].endedAt, null);
  assert.equal(timeline.currentStage, "done");
  assert.equal(timeline.finishedAt, "2026-08-06T10:00:30.000Z");
});

test("buildTimeline falls back to stage_started/finished for legacy jobs (pre-0.10.2)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-tl-legacy";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  // 老格式:0.10.2 之前的 jobs 只写 stage_started/stage_finished,没有 job.state_changed
  const events = [
    { event: "executor_metadata", source: "builtin", name: "codebuddy", at: "2026-08-06T10:00:00.000Z" },
    { event: "process_started", command: ["codebuddy"], at: "2026-08-06T10:00:00.000Z" },
    { event: "stage_started", jobId, stage: "implementation", executor: "codebuddy", index: 0, total: 1, at: "2026-08-06T10:00:01.000Z" },
    { event: "stage_finished", jobId, stage: "implementation", executor: "codebuddy", index: 0, exitCode: 0, reviewVerdict: "PASS", at: "2026-08-06T10:00:30.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 1);
  assert.equal(timeline.stages[0].name, "implementation");
  assert.equal(timeline.stages[0].durationMs, 29000);
  assert.match(timeline.stages[0].phase ?? "", /codebuddy.*PASS/);
  assert.equal(timeline.finishedAt, "2026-08-06T10:00:30.000Z");
});

test("readExecutorStatus reads pid/heartbeat and reports no process when files are missing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-exec";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const status = await readExecutorStatus(workspace, jobId);
  assert.equal(status.pid, null);
  assert.equal(status.alive, null);
  assert.equal(status.heartbeatAt, null);
  assert.equal(status.command, null);
});

test("readExecutorStatus extracts the latest process_started command from events", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-exec2";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const events = [
    { event: "process_started", command: ["codebuddy", "-p", "first"], at: "2026-08-06T10:00:00.000Z" },
    { event: "process_finished", returncode: 0, at: "2026-08-06T10:00:10.000Z" },
    { event: "process_started", command: ["codebuddy", "-p", "second prompt"], at: "2026-08-06T10:00:15.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const status = await readExecutorStatus(workspace, jobId);
  // last process_started wins (we want the most recent command shown in UI)
  assert.equal(status.command, "codebuddy -p second prompt");
});

test("readAgentLogIncremental returns empty content for missing log and trims oversized output", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-log";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const empty = await readAgentLogIncremental(workspace, jobId);
  assert.equal(empty.content, "");
  assert.equal(empty.nextOffset, 0);
  assert.equal(empty.truncated, false);

  const huge = "x".repeat(1024 * 1024);
  await writeFile(path.join(dir, "agent.log"), huge, "utf8");
  const result = await readAgentLogIncremental(workspace, jobId, 0, 4096);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 4096);
  assert.equal(result.nextOffset, huge.length);
});

// 回归：未配置 token 时 /events 必须放行（前端 EventSource 无法带 Authorization header，
//      只发 ?token=空串）。曾因 /events 内冗余二次鉴权把无 token 请求误判为 401，导致 SSE 断流。
test("SSE /events allows unauthenticated access when no token is configured", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-noauth-sse-"));
  const server = createWebUiServer(workspace, "127.0.0.1", 0);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const sse = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    sse.body?.cancel();
  } finally {
    server.close();
  }
});
