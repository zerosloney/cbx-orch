import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { jobDir } from "../src/core.js";
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

test("HTTP: 非 GET 方法返回 405", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-method-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
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

test("HTTP: /api/jobs/:id 不存在时 loadState 抛错映射 500", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-http-enoent-"));
  await withServer(workspace, undefined, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/missing-job`);
    // loadState 对不存在的 job 抛普通 Error（非 ENOENT），HTTP 层映射 500。
    // ENOENT→404 映射专门用于 readArtifact 等文件读取路径（见下方 artifact 测试）。
    assert.equal(res.status, 500);
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
