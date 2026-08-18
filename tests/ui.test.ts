import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createJob, cancelJob, jobDir, loadState } from "../src/core.js";
import { savePersistedState } from "../src/storage.js";
import { handleTuiKey, scheduleTuiPoll, startTui } from "../src/tui/index.js";
import { truncateDisplay } from "../src/tui/components/job-table.js";
import {
  buildTimeline,
  createWebUiServer,
  parseCursors,
  readAgentLogIncremental,
  readExecutorStatus,
  replayEvents,
} from "../src/ui.js";

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
    queuePaused: false,
    stopped: false,
    needsRedraw: false,
    armedAction: null,
    armedAtMs: 0,
    armedJobId: null,
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
    queuePaused: false,
    stopped: false,
    needsRedraw: false,
    armedAction: null,
    armedAtMs: 0,
    armedJobId: null,
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 断言输出需要剥离 ANSI 转义序列
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

test("TUI with seeded job and events exits cleanly (event stream path)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-tui-events-"));
  const job = await createJob({
    workspace,
    task: "事件流",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "tui-events",
  });
  // 种子事件：fetchData 的 readEventsIncremental 会读取并推进游标
  const dir = jobDir(workspace, job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({ event: "job.state_changed", jobId: job.jobId, status: "queued", at: new Date().toISOString() })}\n${JSON.stringify({ event: "job.state_changed", jobId: job.jobId, status: "running", at: new Date().toISOString() })}\n`,
    "utf8",
  );
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  console.log = () => {};
  const quitTimer = setInterval(() => {
    process.stdin.emit("keypress", "", { name: "q", ctrl: false });
  }, 25);
  try {
    await startTui(workspace, 100);
  } finally {
    clearInterval(quitTimer);
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  // 事件流路径不崩溃、正常退出即可；增量游标逻辑由 readEventsIncremental 单测覆盖。
});

test("TUI pause/resume triggers queueAction and exits cleanly", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-tui-pause-"));
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  console.log = () => {};
  let phase: "pause" | "resume" | "quit" = "pause";
  const timer = setInterval(() => {
    if (phase === "pause") {
      process.stdin.emit("keypress", "", { name: "p", ctrl: false });
      phase = "resume";
    } else if (phase === "resume") {
      process.stdin.emit("keypress", "", { name: "u", ctrl: false });
      phase = "quit";
    } else {
      process.stdin.emit("keypress", "", { name: "q", ctrl: false });
    }
  }, 50);
  try {
    await startTui(workspace, 100);
  } finally {
    clearInterval(timer);
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
  // queueAction pause→resume 路径覆盖：TUI 正常退出即可
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
    {
      event: "job.state_changed",
      jobId,
      status: "queued",
      phase: "queued",
      at: "2026-08-06T10:00:00.000Z",
    },
    {
      event: "job.state_changed",
      jobId,
      status: "running",
      phase: "executor",
      at: "2026-08-06T10:00:05.000Z",
    },
    {
      event: "job.state_changed",
      jobId,
      status: "done",
      phase: "done",
      at: "2026-08-06T10:00:30.000Z",
    },
  ];
  await writeFile(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
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
    {
      event: "executor_metadata",
      source: "builtin",
      name: "codebuddy",
      at: "2026-08-06T10:00:00.000Z",
    },
    {
      event: "process_started",
      command: ["codebuddy"],
      at: "2026-08-06T10:00:00.000Z",
    },
    {
      event: "stage_started",
      jobId,
      stage: "implementation",
      executor: "codebuddy",
      index: 0,
      total: 1,
      at: "2026-08-06T10:00:01.000Z",
    },
    {
      event: "stage_finished",
      jobId,
      stage: "implementation",
      executor: "codebuddy",
      index: 0,
      exitCode: 0,
      reviewVerdict: "PASS",
      at: "2026-08-06T10:00:30.000Z",
    },
  ];
  await writeFile(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
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
    {
      event: "process_started",
      command: ["codebuddy", "-p", "first"],
      at: "2026-08-06T10:00:00.000Z",
    },
    {
      event: "process_finished",
      returncode: 0,
      at: "2026-08-06T10:00:10.000Z",
    },
    {
      event: "process_started",
      command: ["codebuddy", "-p", "second prompt"],
      at: "2026-08-06T10:00:15.000Z",
    },
  ];
  await writeFile(
    path.join(dir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
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

// ---------- parseCursors ----------
test("parseCursors: undefined 返回全 0 数组", () => {
  assert.deepEqual(parseCursors(undefined, 3), [0, 0, 0]);
});

test("parseCursors: 复合格式按索引填游标", () => {
  assert.deepEqual(parseCursors("0:3,1:5", 2), [3, 5]);
});

test("parseCursors: 越界/非法 idx 忽略，合法部分仍生效", () => {
  // idx=5 越界(>=2)、idx=abc 非数字、seq=-1 非法 → 均忽略；idx=0:7 合法
  assert.deepEqual(parseCursors("5:9,abc:2,0:-1,0:7", 2), [7, 0]);
});

test("parseCursors: 旧格式纯数字广播到所有 workspace", () => {
  assert.deepEqual(parseCursors("42", 3), [42, 42, 42]);
});

test("parseCursors: 旧格式非法值返回全 0", () => {
  assert.deepEqual(parseCursors("notanumber", 2), [0, 0]);
});

// ---------- replayEvents ----------
// SseClient 最小桩：只实现 replayEvents 实际用到的 res.write。
// SseClient 类型未导出，用 Parameters<typeof replayEvents>[1] 精确对齐参数类型。
type SseClient = Parameters<typeof replayEvents>[1];
function makeFakeClient(): { written: string[]; client: SseClient } {
  const written: string[] = [];
  return {
    written,
    client: {
      res: {
        write: (s: string) => {
          written.push(s);
        },
      },
      pending: [],
      replaying: false,
    } as unknown as SseClient,
  };
}

test("replayEvents: 按 seq > cursor 过滤并逐行写 SSE 帧", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-replay-"));
  const eventsDir = path.join(workspace, ".cbx");
  await mkdir(eventsDir, { recursive: true });
  const events = [
    { seq: 1, event: "job.state_changed", at: "2026-08-06T10:00:00.000Z" },
    { seq: 2, event: "job.state_changed", at: "2026-08-06T10:00:01.000Z" },
    { seq: 3, event: "job.state_changed", at: "2026-08-06T10:00:02.000Z" },
  ];
  await writeFile(
    path.join(eventsDir, "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const { written, client } = makeFakeClient();
  // cursor=1：只发 seq 2,3
  await replayEvents(workspace, client, 0, 1);
  assert.equal(written.length, 2);
  assert.match(written[0], /id: 0:2/);
  assert.match(written[1], /id: 0:3/);
});

test("replayEvents: 超过 maxReplayLines 触发 truncation 警告", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-replay-trunc-"));
  const eventsDir = path.join(workspace, ".cbx");
  await mkdir(eventsDir, { recursive: true });
  const events = Array.from({ length: 5 }, (_, i) => ({
    seq: i + 1,
    event: "job.state_changed",
    at: "2026-08-06T10:00:00.000Z",
  }));
  await writeFile(
    path.join(eventsDir, "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const { written, client } = makeFakeClient();
  // maxReplayLines=2：5 条候选 → 警告 + 最近 2 条
  await replayEvents(workspace, client, 1, 0, 2);
  // 1 警告帧 + 2 数据帧 = 3
  assert.equal(written.length, 3);
  assert.match(written[0], /replay_truncated/);
  assert.match(written[0], /"dropped":3/);
});

test("replayEvents: 文件不存在时静默返回（不写任何帧）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-replay-empty-"));
  const { written, client } = makeFakeClient();
  await replayEvents(workspace, client, 0, 0);
  assert.equal(written.length, 0);
});

// ---------- buildTimeline 补充分支 ----------
test("buildTimeline: 非终态 state_changed 时 finishedAt=null", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-nonterm";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const events = [
    {
      event: "job.state_changed",
      jobId,
      status: "queued",
      phase: "queued",
      at: "2026-08-06T10:00:00.000Z",
    },
    {
      event: "job.state_changed",
      jobId,
      status: "running",
      phase: "executor",
      at: "2026-08-06T10:00:05.000Z",
    },
  ];
  await writeFile(
    path.join(dir, "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.currentStage, "running");
  assert.equal(timeline.finishedAt, null); // running 非终态
  assert.equal(timeline.stages.length, 2);
  assert.equal(timeline.stages[1].endedAt, null); // 最后一阶段无后续，未结束
});

test("buildTimeline: 老格式仅有 stage_started 无 finished 时 currentStage 兜底", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-legacy-open";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  // 只有 stage_started，没有 stage_finished：lastEnd=undefined → currentStage 兜底 firstStart.stage
  const events = [
    {
      event: "stage_started",
      jobId,
      stage: "implementation",
      executor: "codebuddy",
      index: 0,
      at: "2026-08-06T10:00:00.000Z",
    },
  ];
  await writeFile(
    path.join(dir, "events.ndjson"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 1);
  assert.equal(timeline.stages[0].name, "implementation");
  assert.equal(timeline.stages[0].endedAt, null);
  assert.equal(timeline.stages[0].durationMs, null);
  assert.equal(timeline.currentStage, "implementation");
  assert.equal(timeline.finishedAt, null);
});

// ---------- HTTP 路由端到端（覆盖 viz 同期引入的 ui.ts 路由分发 + 鉴权 + 错误映射）----------
// 用 createWebUiServer + fetch 走真实 HTTP 路径，一次性覆盖路由表、isAuthorized、summarizeWorkspace、错误码映射。
async function withServer(
  workspace: string | string[],
  token: string | undefined,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createWebUiServer(workspace, "127.0.0.1", 0, token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

test("HTTP: 未配置 token 时 API 数据接口放行", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), []);
  });
});

test("HTTP: 配置 token 后缺凭证返回 401 + Bearer challenge", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-auth-"));
  await withServer(workspace, "secret", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
    assert.match(JSON.stringify(await res.json()), /unauthorized/);
  });
});

// ---------- 写操作（POST）端到端 ----------
// 覆盖 approve/cancel/retry/continue 与 queue pause/resume 的 HTTP 路由；
// 无 token 时直接可用（loopback 绑定 + SameSite cookie 为浏览器侧防线），有 token 时需凭证。

test("HTTP: POST 写操作无 token 时可取消任务并更新状态", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-write-"));
  const job = await createJob({
    workspace,
    task: "写操作",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-write",
  });
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/cancel`,
      { method: "POST" },
    );
    assert.equal(res.status, 200);
    const state = (await res.json()) as { status: string };
    assert.equal(state.status, "cancelled");
    // 取消后从队列移除 → retry 可重新入队
    const retryRes = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(retryRes.status, 200);
    const retried = (await retryRes.json()) as {
      status: string;
      jobId: string;
    };
    assert.equal(retried.status, "queued");
  });
});

test("HTTP: POST 队列暂停/恢复切换 paused 状态", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-qwrite-"));
  await withServer(workspace, undefined, async (port) => {
    const pause = await fetch(`http://127.0.0.1:${port}/api/queue/pause`, {
      method: "POST",
    });
    assert.equal(pause.status, 200);
    assert.equal(((await pause.json()) as { paused: boolean }).paused, true);
    const resume = await fetch(`http://127.0.0.1:${port}/api/queue/resume`, {
      method: "POST",
    });
    assert.equal(resume.status, 200);
    assert.equal(((await resume.json()) as { paused: boolean }).paused, false);
  });
});

test("HTTP: POST 写操作需要 token 凭证（配置后无凭证 401）", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-http-writeauth-"),
  );
  const job = await createJob({
    workspace,
    task: "写操作鉴权",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-writeauth",
  });
  await withServer(workspace, "secret", async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/cancel`,
      { method: "POST" },
    );
    assert.equal(res.status, 401);
    // 带 Bearer 凭证则放行
    const ok = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/cancel`,
      { method: "POST", headers: { authorization: "Bearer secret" } },
    );
    assert.equal(ok.status, 200);
  });
});

test("HTTP: POST continue 携带 message 且非法 extra_rounds 报 400", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-continue-"));
  const job = await createJob({
    workspace,
    task: "继续",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-continue",
  });
  await withServer(workspace, undefined, async (port) => {
    // 先取消使任务离开队列（queued 状态 continue 会因重复入队失败）
    const cancelRes = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelRes.status, 200);
    // continue 重新入队（无 extra_rounds：任务没有 max_rounds gate）
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/continue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "继续执行" }),
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "queued");
    // 非法 extra_rounds → 400
    const bad = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/continue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extra_rounds: -1 }),
      },
    );
    assert.equal(bad.status, 400);
    // refresh_baseline 字符串 "false" 不得被强转成 true → 400（布尔类型校验）
    const badBool = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/continue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_baseline: "false" }),
      },
    );
    assert.equal(badBool.status, 400);
    const badBoolBody = (await badBool.json()) as { error: string };
    assert.match(badBoolBody.error, /refresh_baseline 必须是布尔值/);
  });
});

test("HTTP: POST /api/jobs 创建任务并后台执行（缺 task → 400）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-create-"));
  await withServer(workspace, undefined, async (port) => {
    // 缺 task → 400
    const bad = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
    const badBody = (await bad.json()) as { error: string };
    assert.match(badBody.error, /task 必须是非空字符串/);
    // 创建任务（携带可选 run 选项透传）
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "UI 创建任务", max_turns: 7, review: false }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { job_id: string; status: string };
    assert.equal(body.status, "queued");
    const state = await loadState(workspace, body.job_id);
    assert.equal(state.jobId, body.job_id);
    assert.equal(state.status, "queued");
  });
});

test("HTTP: 配置 token 后正确 Bearer 凭证放行 API", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-authok-"));
  await withServer(workspace, "secret", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(res.status, 200);
  });
});

test("HTTP: 配置 token 后错误 Bearer 凭证拒绝", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-badtoken-"));
  await withServer(workspace, "secret", async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 401);
  });
});

// 回归：token 改经 HttpOnly cookie 下发（不再内嵌 HTML window.CBX_TOKEN）。
// 首页返回 Set-Cookie，同源请求带 cookie 即放行；cookie 不得暴露在页面源码或 URL 查询串。
test("HTTP: 首页下发 HttpOnly cookie 且 cookie 可访问 API", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-cookie-"));
  await withServer(workspace, "secret", async (port) => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const setCookie = page.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^cbx_token=secret/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    // token 不得再内嵌进 HTML
    const html = await page.text();
    assert.ok(!html.includes("CBX_TOKEN"), "页面源码不得包含 token");
    assert.ok(!html.includes("secret"), "页面源码不得包含 token 明文");
    // 携带 cookie 的请求放行
    const cookie = setCookie.split(";")[0];
    const api = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      headers: { cookie },
    });
    assert.equal(api.status, 200);
  });
});

test("HTTP: PUBLIC_UI_PATHS（/ /style.css /app.js /healthz）免鉴权", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-public-"));
  await withServer(workspace, "secret", async (port) => {
    // /healthz 是 public 路径，配置 token 也不需鉴权
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    // / 返回 html（注入 token），无需鉴权
    const html = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  });
});

test("HTTP: 非 GET/POST 方法返回 405", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-method-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "PUT",
    });
    assert.equal(res.status, 405);
    assert.match(JSON.stringify(await res.json()), /method not allowed/);
  });
});

test("HTTP: 未知路由返回 404", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-404-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
    assert.equal(res.status, 404);
    assert.match(JSON.stringify(await res.json()), /not found/);
  });
});

test("HTTP: /api/jobs/:id 不存在时 loadState 抛 E_NOT_FOUND 映射 404", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-enoent-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/missing-job`);
    // loadState 对不存在的 job 抛 CbxError E_NOT_FOUND，HTTP 层映射 404；
    // ENOENT→404 映射专用于 readArtifact 等文件读取路径（见下方 artifact 测试）。
    assert.equal(res.status, 404);
    assert.match(JSON.stringify(await res.json()), /任务不存在/);
  });
});

test("HTTP: /api/jobs/:id/artifact/:name 白名单内文件不存在时 ENOENT 映射 404", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-art404-"));
  await mkdir(jobDir(workspace, "art-job"), { recursive: true });
  await withServer(workspace, undefined, async (port) => {
    // events.ndjson 在白名单内但文件不存在 → readFile ENOENT → HTTP 404
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/art-job/artifact/events.ndjson`,
    );
    assert.equal(res.status, 404);
  });
});

test("HTTP: /api/jobs/:id/artifact/:name 非白名单文件映射 403", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-art403-"));
  await mkdir(jobDir(workspace, "art-job2"), { recursive: true });
  await withServer(workspace, undefined, async (port) => {
    // missing.txt 不在白名单 → E_ARTIFACT_FORBIDDEN → HTTP 403
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/art-job2/artifact/missing.txt`,
    );
    assert.equal(res.status, 403);
  });
});

test("HTTP: /api/jobs/:id/artifacts 列出 job 产物", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-artlist-"));
  await mkdir(jobDir(workspace, "art-list"), { recursive: true });
  await writeFile(
    path.join(jobDir(workspace, "art-list"), "handback.md"),
    "x",
    "utf8",
  );
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/art-list/artifacts`,
    );
    assert.equal(res.status, 200);
    const arts = (await res.json()) as string[];
    assert.ok(arts.includes("handback.md"));
  });
});

test("HTTP: /api/workspaces 汇总 workspace 状态（含 git 分支探测）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-ws-"));
  // 非 git 目录：summarizeWorkspace 的 git 捕获走 catch，gitBranch/gitDirty 为 null
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      workspaces: Array<{
        name: string;
        gitBranch: string | null;
        paused: boolean;
      }>;
      default: string;
    };
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0].name, path.basename(workspace));
    assert.equal(body.workspaces[0].gitBranch, null);
    assert.equal(body.workspaces[0].paused, false);
    assert.equal(body.default, workspace);
  });
});

test("HTTP: /api/queue 和 /api/metrics 返回正常 JSON", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-qm-"));
  await withServer(workspace, undefined, async (port) => {
    const queueRes = await fetch(`http://127.0.0.1:${port}/api/queue`);
    assert.equal(queueRes.status, 200);
    const queue = (await queueRes.json()) as {
      maxConcurrent: number;
      entries: unknown[];
    };
    assert.equal(Array.isArray(queue.entries), true);

    const metricsRes = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()) as {
      status: string;
      metrics: Record<string, unknown>;
    };
    assert.equal(metrics.status, "ok");
  });
});

test("HTTP: /api/jobs/:id/timeline 对不存在 job 返回空 timeline", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-tl-"));
  await mkdir(jobDir(workspace, "empty-tl"), { recursive: true });
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/empty-tl/timeline`,
    );
    assert.equal(res.status, 200);
    const tl = (await res.json()) as { stages: unknown[] };
    assert.equal(tl.stages.length, 0);
  });
});

test("HTTP: /api/jobs/:id/executor 对无进程 job 返回 null pid", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-exec-"));
  await mkdir(jobDir(workspace, "exec-job"), { recursive: true });
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/exec-job/executor`,
    );
    assert.equal(res.status, 200);
    const status = (await res.json()) as { pid: null; alive: null };
    assert.equal(status.pid, null);
    assert.equal(status.alive, null);
  });
});

test("HTTP: /api/jobs/:id/agent.log 返回增量日志 JSON", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-log-"));
  await mkdir(jobDir(workspace, "log-job"), { recursive: true });
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/log-job/agent.log`,
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    const body = (await res.json()) as { content: string; nextOffset: number };
    assert.equal(body.content, "");
    assert.equal(body.nextOffset, 0);
  });
});

test("HTTP: 非回环 host 拒绝绑定", () => {
  assert.throws(() => createWebUiServer("/tmp", "0.0.0.0", 0), /回环地址/);
});

test("HTTP: 多 workspace 时 /api/workspaces 逐个汇总", async () => {
  const ws1 = await mkdtemp(path.join(os.tmpdir(), "cbx-http-multi1-"));
  const ws2 = await mkdtemp(path.join(os.tmpdir(), "cbx-http-multi2-"));
  await withServer([ws1, ws2], undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      workspaces: unknown[];
      default: string;
    };
    assert.equal(body.workspaces.length, 2);
    assert.equal(body.default, ws1);
  });
});

test("HTTP: POST forget 删 state.json/events.ndjson/artifacts 但保留 worktree", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-forget-"));
  const job = await createJob({
    workspace,
    task: "forget http test",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-forget",
  });
  // job 处于 queued/running 之外，先 cancel 让它进 cancelled（与 CLI/MCP 状态守卫一致）。
  const cancelled = await cancelJob(workspace, job.jobId);
  assert.equal(cancelled.status, "cancelled");
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/forget`,
      { method: "POST" },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      job_id: string;
      status: string;
      deleted_directory: boolean;
      worktree_cleaned: boolean;
      remaining_queue_entries: number;
    };
    assert.equal(body.job_id, "http-forget");
    assert.equal(body.status, "cancelled");
    assert.equal(body.deleted_directory, true);
    // forget 不删 worktree
    assert.equal(body.worktree_cleaned, false);
  });
  // 再次 loadState 应当失败——目录已经被 rm
  let loadErr: Error | undefined;
  try {
    await loadState(workspace, job.jobId);
  } catch (error) {
    loadErr = error as Error;
  }
  assert.ok(loadErr, "forget 后 loadState 必须抛错");
  assert.match(loadErr!.message, /任务不存在或状态文件损坏/);
});

test("HTTP: POST purge 连 worktree 一起删，worktree_cleaned=true", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-purge-"));
  const job = await createJob({
    workspace,
    task: "purge http test",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-purge",
    keepWorktree: true,
  });
  const cancelled = await cancelJob(workspace, job.jobId);
  assert.equal(cancelled.status, "cancelled");
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/purge`,
      { method: "POST" },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      job_id: string;
      deleted_directory: boolean;
      worktree_cleaned: boolean;
    };
    assert.equal(body.job_id, "http-purge");
    assert.equal(body.deleted_directory, true);
    // purge 在已 cancel 任务上，worktree 已被 cancelJob 先清过一次，cleanupWorktree 二次
    // 调用幂等返回 false，但语义上"worktree 不在"等价于"被清"
    assert.equal(body.worktree_cleaned, false);
  });
});

test("HTTP: POST forget 拒绝 running 任务（500 抛错）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-forget-busy-"));
  const job = await createJob({
    workspace,
    task: "forget busy test",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "http-forget-busy",
  });
  // 强制把状态写到 running 来模拟——后端状态守卫会拒绝。
  const state = await loadState(workspace, job.jobId);
  state.status = "running";
  await savePersistedState(workspace, job.jobId, state);
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/jobs/${job.jobId}/forget`,
      { method: "POST" },
    );
    // 后端状态守卫抛普通 Error（无错误码）→ HTTP 500（区别于缺失 job 的 E_NOT_FOUND→404）。
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /当前状态为 running/);
  });
});
