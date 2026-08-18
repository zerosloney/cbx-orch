import test from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import {
  colorizeStatus,
  displayWidth,
  fmtDuration,
  fmtElapsed,
  isInteractive,
  jobElapsedMs,
  renderExport,
  renderHealth,
  renderJobDetail,
  renderJobsTable,
  renderQueueTable,
  summarizePatch,
  summarizeTestLog,
} from "../src/formatting.js";
import type { JobState } from "../src/types.js";

// chalk v5 在非 TTY（CI/管道）默认 level=0 不输出 ANSI，使着色断言无法验证。
// 这里强制启用颜色（basic level），使着色逻辑可被断言；chalk 是单例，全局生效。
chalk.level = 1;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 断言输出需要剥离 ANSI 转义序列
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 计数红色 ANSI 转义正是断言目的
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

// ---------- fmtDuration / jobElapsedMs ----------
test("fmtDuration: 边界值（<60s / <1h / >=1h / 非法）", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(45_000), "45s");
  assert.equal(fmtDuration(60_000), "1m 0s");
  assert.equal(fmtDuration(125_000), "2m 5s");
  assert.equal(fmtDuration(3_600_000), "1h 0m");
  assert.equal(fmtDuration(3_725_000), "1h 2m");
  assert.equal(fmtDuration(NaN), "—");
  assert.equal(fmtDuration(-1), "—");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtDuration(undefined), "—");
});

test("fmtElapsed: 与 fmtDuration 在 valid input 下一致", () => {
  // 锚定 createdAt 到过去某点，fmtElapsed 用 Date.now() 实时算 → 不直接断言具体值，
  // 只验证非空且是合法格式；具体格式验证交给 fmtDuration。
  const out = fmtElapsed(new Date(Date.now() - 30_000).toISOString());
  assert.match(out, /^\d+s$/);
  assert.equal(fmtElapsed(""), "—");
  assert.equal(fmtElapsed(undefined), "—");
});

test("jobElapsedMs: 终态用 updatedAt 固定值，非终态用 now", () => {
  const start = new Date("2026-08-01T00:00:00Z");
  const end = new Date("2026-08-01T00:01:30Z"); // 90s
  assert.equal(
    jobElapsedMs({
      createdAt: start.toISOString(),
      updatedAt: end.toISOString(),
      status: "done",
    }),
    90_000,
  );
  // updatedAt 缺失时退化为 now（>0 即可，具体值会随调用时刻变化）
  const live = jobElapsedMs({ createdAt: start.toISOString() });
  assert.ok(live != null && live >= 90_000);
  // createdAt 缺失 → null
  assert.equal(
    jobElapsedMs({ createdAt: "", updatedAt: end.toISOString() }),
    null,
  );
});

// ---------- summarizeTestLog ----------
test("summarizeTestLog: 空输入", () => {
  const s = summarizeTestLog("");
  assert.equal(s.lineCount, 0);
  assert.equal(s.passed, null);
  assert.equal(s.failed, null);
  assert.equal(s.tail, "");
});

test("summarizeTestLog: mocha 风格 42 passing / 3 failing", () => {
  const log = [
    "  42 passing (2s)",
    "  3 failing",
    "",
    "  1) suite test name",
    "  2) another failure",
    "  3) third",
  ].join("\n");
  const s = summarizeTestLog(log);
  assert.equal(s.lineCount, log.split("\n").length);
  assert.equal(s.passed, 42);
  assert.equal(s.failed, 3);
  // 末尾保留原始行
  assert.ok(s.tail.includes("3) third"));
});

test("summarizeTestLog: jest 风格 Tests: X failed, Y passed", () => {
  const log = ["FAIL src/foo.test.ts", "Tests:       2 failed, 5 passed, 7 total"];
  const s = summarizeTestLog(log.join("\n"));
  assert.equal(s.passed, 5);
  assert.equal(s.failed, 2);
});

test("summarizeTestLog: 无结构化计数但含 FAILED 关键词 → failed=1", () => {
  const s = summarizeTestLog("error: FAILED to compile");
  assert.equal(s.passed, null);
  assert.equal(s.failed, 1);
});

test("summarizeTestLog: 仅有 OK 关键词 → passed=0（兜底标记）", () => {
  const s = summarizeTestLog("... OK (12ms)");
  assert.equal(s.passed, 0);
  assert.equal(s.failed, null);
});

// ---------- summarizePatch ----------
test("summarizePatch: 空 patch", () => {
  const s = summarizePatch("");
  assert.equal(s.filesChanged, 0);
  assert.equal(s.insertions, 0);
  assert.equal(s.deletions, 0);
});

test("summarizePatch: 单文件 +3 / -1", () => {
  const patch = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1234..5678 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,6 @@",
    " line1",
    "+inserted1",
    "+inserted2",
    "-removed1",
    "+inserted3",
    " line2",
    " line3",
  ].join("\n");
  const s = summarizePatch(patch);
  assert.equal(s.filesChanged, 1);
  assert.equal(s.insertions, 3);
  assert.equal(s.deletions, 1);
});

test("summarizePatch: 多文件 + 头/尾元数据行不计入 +/-", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "+a",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-b",
  ].join("\n");
  const s = summarizePatch(patch);
  assert.equal(s.filesChanged, 2);
  assert.equal(s.insertions, 1);
  assert.equal(s.deletions, 1);
});

// ---------- renderExport 完整链路 ----------
test("renderExport text: 含 test/review/patch 摘要与 Elapsed", () => {
  const state = makeJob({
    status: "done",
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    updatedAt: new Date().toISOString(),
    reviewVerdict: "PASS",
  });
  const result = {
    stages: [
      { name: "build", executor: "codebuddy", exitCode: 0, reviewVerdict: "PASS" },
    ],
    acceptanceEvidence: [{ criterion: "covers X", status: "evidence_available" }],
    handback: "# Done\n\nAll green.",
    testLog: "  5 passing (1s)\n  0 failing\n",
    review: "# Review\n\nLGTM.",
    completePatch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  };
  const out = renderExport(state, result, "text");
  const plain = stripAnsi(out);
  assert.match(plain, /Elapsed:\s+\d+m\s+\d+s/);
  assert.match(plain, /Stages:/);
  assert.match(plain, /Acceptance:/);
  assert.match(plain, /Handback:/);
  assert.match(plain, /Test:/);
  assert.match(plain, /5 passing/);
  assert.match(plain, /Review notes:/);
  assert.match(plain, /Patch:/);
  assert.match(plain, /1 files/);
  assert.match(plain, /\+1/);
  assert.match(plain, /-1/);
});

test("renderExport text: result=null 时仅任务状态 + 无 test/review/patch 段", () => {
  const out = renderExport(makeJob({ status: "running" }), null, "text");
  const plain = stripAnsi(out);
  assert.match(plain, /无 result.json/);
  assert.ok(!plain.includes("Test:"));
  assert.ok(!plain.includes("Review notes:"));
  assert.ok(!plain.includes("Patch:"));
});

test("renderExport text: 工件缺失时不渲染对应段", () => {
  const out = renderExport(
    makeJob({ status: "done" }),
    { stages: [{ name: "s", executor: "x", exitCode: 0 }] },
    "text",
  );
  const plain = stripAnsi(out);
  assert.ok(!plain.includes("Test:"));
  assert.ok(!plain.includes("Review notes:"));
  assert.ok(!plain.includes("Patch:"));
  assert.ok(!plain.includes("Handback:")); // 也没 handback
  // Stages 还在
  assert.match(plain, /Stages:/);
});

test("renderExport markdown: 含 Elapsed 字段 + Test/Review notes/Patch 段", () => {
  const state = makeJob({
    status: "done",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const result = {
    testLog: "  2 passing\n  1 failing\n",
    review: "# R\nOK",
    completePatch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new",
  };
  const out = renderExport(state, result, "markdown");
  assert.match(out, /^- 耗时：/m);
  assert.match(out, /^## Test$/m);
  assert.match(out, /通过：2/);
  assert.match(out, /失败：1/);
  assert.match(out, /^## Review notes$/m);
  assert.match(out, /^## Patch$/m);
  assert.match(out, /变更文件：1/);
  assert.match(out, /新增：\+1/);
  assert.match(out, /删除：-1/);
});

test("renderExport: 终态 Elapsed 在两次调用间稳定", () => {
  const start = new Date(Date.now() - 120_000).toISOString();
  const end = new Date(Date.now() - 30_000).toISOString(); // 90s 前固化的 updatedAt
  const state = makeJob({ status: "done", createdAt: start, updatedAt: end });
  const first = renderExport(state, null, "text");
  // 等 50ms 再调一次：终态应当保持原值，不应继续累加
  const wait = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  return wait(50).then(() => {
    const second = renderExport(state, null, "text");
    const a = first.match(/Elapsed:\s+(\S+)/)?.[1];
    const b = second.match(/Elapsed:\s+(\S+)/)?.[1];
    assert.equal(a, b, `终态 Elapsed 应稳定：${a} vs ${b}`);
  });
});

// ---------- displayWidth: CJK 宽字符列宽 ----------
test("displayWidth: ASCII 每字符 1 列", () => {
  assert.equal(displayWidth("hello"), 5);
});

test("displayWidth: CJK 表意文字每字符 2 列", () => {
  assert.equal(displayWidth("任务"), 4); // 2 字 × 2 列
  assert.equal(displayWidth("测试"), 4);
});

test("displayWidth: 中英混排累加实际列宽", () => {
  assert.equal(displayWidth("job任务"), 7); // job(3) + 任务(4)
});

test("displayWidth: 全角符号与假名按 2 列计", () => {
  assert.equal(displayWidth("ＡＢ"), 4); // 全角拉丁
  assert.equal(displayWidth("カタ"), 4); // 片假名
});

test("displayWidth: ANSI 转义序列不计宽度", () => {
  assert.equal(displayWidth("\x1b[31mred\x1b[0m"), 3);
});
