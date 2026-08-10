import test from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import {
  colorizeStatus,
  fmtElapsed,
  isInteractive,
  renderHealth,
  renderJobDetail,
  renderJobsTable,
  renderQueueTable,
} from "../src/formatting.js";
import type { JobState } from "../src/types.js";

// chalk v5 在非 TTY（CI/管道）默认 level=0 不输出 ANSI，使着色断言无法验证。
// 这里强制启用颜色（basic level），使着色逻辑可被断言；chalk 是单例，全局生效。
chalk.level = 1;

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeJob(overrides: Partial<JobState> = {}): JobState {
  return {
    jobId: "job-1",
    status: "running",
    phase: "test",
    workspace: "/tmp",
    jobDir: "/tmp/.cbx/jobs/job-1",
    createdAt: new Date(Date.now() - 5_000).toISOString(),
    updatedAt: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  };
}

test("colorizeStatus maps known statuses", () => {
  assert.ok(colorizeStatus("done").includes("done"));
  assert.ok(colorizeStatus("failed").includes("failed"));
  assert.ok(colorizeStatus("running").includes("running"));
});

test("renderJobsTable empty", () => {
  const out = renderJobsTable([]);
  assert.match(out, /暂无任务/);
});

test("renderJobsTable renders job row", () => {
  const jobs = [
    {
      jobId: "job-abc",
      status: "running",
      phase: "test",
      workspace: "/tmp",
      jobDir: "/tmp/.cbx/jobs/job-abc",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 2,
      reviewVerdict: "PASS",
    },
  ];
  const out = renderJobsTable(
    jobs as unknown as Parameters<typeof renderJobsTable>[0],
  );
  assert.match(out, /job-abc/);
  assert.match(out, /running/);
  assert.match(out, /test/);
  assert.match(out, /PASS/);
});

test("renderQueueTable shows paused", () => {
  const q = {
    maxConcurrent: 2,
    paused: true,
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  const out = renderQueueTable(
    q as unknown as Parameters<typeof renderQueueTable>[0],
  );
  assert.match(out, /PAUSED/);
  assert.match(out, /队列为空/);
});

test("renderJobDetail shows fields", () => {
  const state = {
    jobId: "job-xyz",
    status: "failed",
    phase: "execute",
    workspace: "/tmp",
    jobDir: "/tmp/.cbx/jobs/job-xyz",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T01:00:00Z",
    attempt: 1,
    error: "timeout",
  };
  const out = renderJobDetail(
    state as unknown as Parameters<typeof renderJobDetail>[0],
  );
  assert.match(out, /job-xyz/);
  assert.match(out, /failed/);
  assert.match(out, /timeout/);
});

test("renderHealth shows metrics", () => {
  const out = renderHealth({
    status: "ok",
    metrics: {
      queueDepth: 3,
      failedJobs: 1,
      retryingJobs: 0,
      pendingDeliveries: 2,
      deliveryFailures: 0,
      jobsByStatus: { done: 5, running: 1, failed: 1 },
    },
  });
  assert.match(out, /ok/);
  assert.match(out, /3/);
  assert.match(out, /done/);
});

// ---------- fmtElapsed 边界分支 ----------
test("fmtElapsed: null/undefined 返回 —", () => {
  assert.equal(fmtElapsed(null), "—");
  assert.equal(fmtElapsed(undefined), "—");
});

test("fmtElapsed: 负数 ms 返回 —", () => {
  // 未来时间：Date.now() - 未来 = 负数
  const future = new Date(Date.now() + 10_000).toISOString();
  assert.equal(fmtElapsed(future), "—");
});

test("fmtElapsed: <60s 显示秒", () => {
  const iso = new Date(Date.now() - 30_000).toISOString();
  assert.match(fmtElapsed(iso), /^\d+s$/);
});

test("fmtElapsed: 分钟段显示 Nm Ms", () => {
  const iso = new Date(Date.now() - 125_000).toISOString(); // 2m5s
  assert.match(fmtElapsed(iso), /^\d+m \d+s$/);
});

test("fmtElapsed: 小时段显示 Nh Mm", () => {
  const iso = new Date(Date.now() - 3_720_000).toISOString(); // 1h2m
  assert.match(fmtElapsed(iso), /^\d+h \d+m$/);
});

// ---------- isInteractive ----------
test("isInteractive: CBX_JSON 环境变量强制非交互", () => {
  const orig = process.env.CBX_JSON;
  try {
    process.env.CBX_JSON = "1";
    assert.equal(isInteractive(), false);
  } finally {
    if (orig === undefined) delete process.env.CBX_JSON;
    else process.env.CBX_JSON = orig;
  }
});

test("isInteractive: 非 TTY 返回 false", () => {
  const orig = process.env.CBX_JSON;
  const origTty = process.stdout.isTTY;
  try {
    delete process.env.CBX_JSON;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    assert.equal(isInteractive(), false);
  } finally {
    if (orig === undefined) delete process.env.CBX_JSON;
    else process.env.CBX_JSON = orig;
    Object.defineProperty(process.stdout, "isTTY", {
      value: origTty,
      configurable: true,
    });
  }
});

// ---------- colorizeStatus 全状态覆盖 ----------
test("colorizeStatus: 全部已知状态着色且文本保留", () => {
  const known = [
    "done",
    "failed",
    "review_failed",
    "needs_fix",
    "running",
    "awaiting_approval",
    "queued",
    "cancelled",
  ];
  for (const status of known) {
    const out = colorizeStatus(status);
    assert.equal(stripAnsi(out), status);
  }
  // FAIL/PASS review 着色由 colorizeReview 处理，经 renderJobDetail/renderJobsTable 间接覆盖
});

// ---------- renderJobsTable terminal + totalSeconds 分支 ----------
test("renderJobsTable: terminal job 带 totalSeconds<60 显示秒", () => {
  const out = renderJobsTable([makeJob({ status: "done", totalSeconds: 30 })]);
  assert.match(out, /30s/);
});

test("renderJobsTable: terminal job 带 totalSeconds>=60 显示分秒", () => {
  const out = renderJobsTable([
    makeJob({ status: "failed", totalSeconds: 90 }),
  ]);
  assert.match(out, /1m 30s/);
});

test("renderJobsTable: 多行渲染表头与分隔", () => {
  const out = renderJobsTable([
    makeJob({ jobId: "a" }),
    makeJob({ jobId: "b" }),
  ]);
  const lines = out.split("\n");
  assert.match(lines[0], /Job.*Status/);
  assert.match(lines[1], /─/);
  assert.equal(lines.length, 4); // 表头 + 分隔 + 2 数据行
});

// ---------- renderQueueTable 带 entries ----------
test("renderQueueTable: 带 entries 渲染行，含 priority 和 error 截断", () => {
  const longError = "x".repeat(50);
  const out = renderQueueTable({
    maxConcurrent: 2,
    paused: false,
    entries: [
      {
        jobId: "q1",
        status: "queued",
        priority: 5,
        createdAt: new Date().toISOString(),
        error: "",
      },
      {
        jobId: "q2",
        status: "running",
        createdAt: new Date().toISOString(),
        error: longError,
      },
    ],
    updatedAt: new Date().toISOString(),
  } as Parameters<typeof renderQueueTable>[0]);
  assert.match(out, /q1/);
  assert.match(out, /q2/);
  assert.match(out, /5/); // priority
  // error 截断到 40 字符
  assert.ok(out.includes("x".repeat(40)));
  assert.ok(!out.includes("x".repeat(50)));
});

// ---------- renderJobDetail 兜底字段 ----------
test("renderJobDetail: 缺 phase/attempt/createdAt 兜底", () => {
  const out = renderJobDetail(
    makeJob({
      phase: undefined as unknown as string,
      attempt: undefined,
      createdAt: "",
      updatedAt: "",
    }),
  );
  const plain = stripAnsi(out);
  assert.match(plain, /Phase:\s*—/);
  assert.match(plain, /Attempt:\s*0/);
  // createdAt="" 时直接显示空串（!iso → "—" 只对 null/undefined，空串 falsy 但非 nullish）
  assert.match(plain, /Created:\s*$/m);
});

test("renderJobDetail: review FAIL 着红", () => {
  const out = renderJobDetail(makeJob({ reviewVerdict: "FAIL" }));
  assert.ok(out.includes("\x1b[31m"), "FAIL 应含红色");
  assert.match(stripAnsi(out), /FAIL/);
});

// ---------- renderHealth 非 ok + 着红 + 无 jobsByStatus ----------
test("renderHealth: 非 ok 状态着红", () => {
  const out = renderHealth({
    status: "degraded",
    metrics: {
      queueDepth: 0,
      failedJobs: 0,
      retryingJobs: 0,
      pendingDeliveries: 0,
      deliveryFailures: 0,
    },
  });
  assert.ok(out.includes("\x1b[31m"), "degraded 应着红");
});

test("renderHealth: failedJobs>0 和 deliveryFailures>0 着红", () => {
  const out = renderHealth({
    status: "ok",
    metrics: {
      queueDepth: 1,
      failedJobs: 2,
      retryingJobs: 0,
      pendingDeliveries: 0,
      deliveryFailures: 3,
    },
  });
  // 红色 ANSI 至少出现 2 次（failedJobs + deliveryFailures）
  const redCount = (out.match(/\x1b\[31m/g) ?? []).length;
  assert.ok(redCount >= 2, `期望 >=2 处红色，实际 ${redCount}`);
});

test("renderHealth: 无 jobsByStatus 时不渲染该区块", () => {
  const out = renderHealth({
    status: "ok",
    metrics: {
      queueDepth: 0,
      failedJobs: 0,
      retryingJobs: 0,
      pendingDeliveries: 0,
      deliveryFailures: 0,
    },
  });
  assert.ok(!out.includes("Jobs by status"));
});
