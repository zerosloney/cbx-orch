import assert from "node:assert/strict";
import test from "node:test";
import chalk from "chalk";
import type { JobState } from "../src/types.js";
import type { QueueFile } from "../src/queue.js";
import { colorizeStatus } from "../src/tui/theme.js";
import { renderStatusBar } from "../src/tui/components/status-bar.js";
import { renderDetailPane } from "../src/tui/components/detail-pane.js";
import {
  buildRows,
  renderJobTable,
  truncateDisplay,
} from "../src/tui/components/job-table.js";
import { handleTuiKey } from "../src/tui/index.js";

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

// ---------- theme.ts ----------
test("colorizeStatus: 已知状态用对应颜色着色，未知状态用白色", () => {
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
    assert.ok(out !== status, `${status} 应被着色（含 ANSI 转义）`);
  }
  // 未知状态：chalk.white 着色（level>=1 时 white 也加 ANSI），文本保留
  const unknown = colorizeStatus("unknown");
  assert.equal(stripAnsi(unknown), "unknown");
  assert.ok(unknown !== "unknown", "未知状态应经 chalk.white 着色");
});

// ---------- status-bar.ts ----------
test("renderStatusBar: running 态显示绿色，含 active 计数和分支", () => {
  const queue: QueueFile = {
    maxConcurrent: 2,
    paused: false,
    entries: [
      {
        queueId: "qa",
        jobId: "a",
        workspace: "/tmp",
        extra: "",
        status: "running",
        createdAt: "",
        priority: 0,
      },
      {
        queueId: "qb",
        jobId: "b",
        workspace: "/tmp",
        extra: "",
        status: "queued",
        createdAt: "",
        priority: 0,
      },
      {
        queueId: "qc",
        jobId: "c",
        workspace: "/tmp",
        extra: "",
        status: "running",
        createdAt: "",
        priority: 0,
      },
    ],
    updatedAt: "",
  };
  const out = renderStatusBar(queue, "main");
  assert.match(out, /running/);
  assert.match(out, /active=2\/2/);
  assert.match(out, /main/);
  assert.ok(!out.includes("[PAUSED]"));
});

test("renderStatusBar: paused 态显示 [PAUSED]，无分支时不追加", () => {
  const queue: QueueFile = {
    maxConcurrent: 1,
    paused: true,
    entries: [],
    updatedAt: "",
  };
  const out = renderStatusBar(queue, null);
  assert.match(out, /\[PAUSED\]/);
  assert.match(out, /active=0\/1/);
  assert.ok(!out.includes(" · main"));
});

// ---------- detail-pane.ts ----------
test("renderDetailPane: 无选中任务显示占位提示", () => {
  const out = renderDetailPane(undefined);
  assert.match(out, /选择任务/);
});

test("renderDetailPane: 有 error 字段时着红显示", () => {
  const out = renderDetailPane(makeJob({ error: "boom" }));
  assert.match(out, /boom/);
  assert.ok(out.includes("\x1b[31m"), "error 应含红色 ANSI");
});

test("renderDetailPane: 缺 phase/attempt 时兜底", () => {
  const out = renderDetailPane(
    makeJob({ phase: undefined as unknown as string, attempt: undefined }),
  );
  const plain = stripAnsi(out);
  assert.match(plain, /—/); // phase 兜底 "—"
  assert.match(plain, /Attempt:\s*0/); // attempt 兜底 0
});

// ---------- job-table.ts: buildRows ----------
test("buildRows: terminal 状态带 totalSeconds<60 显示秒", () => {
  const rows = buildRows([makeJob({ status: "done", totalSeconds: 42 })]);
  assert.equal(rows[0].elapsed, "42s");
});

test("buildRows: terminal 状态带 totalSeconds>=60 显示分秒", () => {
  const rows = buildRows([makeJob({ status: "failed", totalSeconds: 125 })]);
  assert.equal(rows[0].elapsed, "2m 5s");
});

test("buildRows: 非 terminal 状态走 fmtElapsed(createdAt)", () => {
  const rows = buildRows([makeJob({ status: "running" })]);
  assert.match(rows[0].elapsed, /^\d+s$/); // 5s 前创建
});

test("buildRows: 缺 updatedAt 显示 —，缺 phase/attempt 兜底", () => {
  const rows = buildRows([
    makeJob({
      updatedAt: "",
      phase: undefined as unknown as string,
      attempt: undefined,
    }),
  ]);
  assert.equal(rows[0].updated, "—");
  assert.equal(rows[0].phase, "");
  assert.equal(rows[0].attempt, 0); // undefined ?? 0
});

// ---------- job-table.ts: renderJobTable ----------
test("renderJobTable: 空任务显示占位", () => {
  assert.match(renderJobTable([], 0, 10, 120), /暂无任务/);
});

test("renderJobTable: 渲染表头、分隔行和数据行", () => {
  const rows = buildRows([makeJob({ jobId: "job-z" })]);
  const out = renderJobTable(rows, 0, 10, 120);
  const lines = out.split("\n");
  assert.match(lines[0], /Job/); // 表头
  assert.match(lines[1], /─/); // 分隔
  assert.match(lines[2], /job-z/); // 数据行
});

test("renderJobTable: selectedIndex 高亮对应行（inverse）", () => {
  const rows = buildRows([makeJob({ jobId: "a" }), makeJob({ jobId: "b" })]);
  const out = renderJobTable(rows, 1, 10, 120);
  const dataLines = out.split("\n").slice(2); // 跳过表头+分隔
  assert.ok(dataLines[1].includes("\x1b[7m"), "第二行应含 inverse ANSI 高亮");
  assert.ok(!dataLines[0].includes("\x1b[7m"), "第一行不高亮");
});

test("renderJobTable: 行数超过 maxRows 时滚动并显示 more 提示", () => {
  const rows = buildRows([
    makeJob({ jobId: "a" }),
    makeJob({ jobId: "b" }),
    makeJob({ jobId: "c" }),
  ]);
  // selectedIndex=2 触发滚动窗口下移，maxRows=1 只显示 1 行 + more 提示
  const out = renderJobTable(rows, 2, 1, 120);
  assert.match(out, /2 more/);
});

test("renderJobTable: 窄屏(cols<=60)不压缩列宽", () => {
  const rows = buildRows([makeJob({ jobId: "x".repeat(40) })]);
  // cols=50 不触发压缩（条件 cols > 60 为假），原样渲染不报错即通过
  const out = renderJobTable(rows, 0, 10, 50);
  assert.match(out, /Job/);
});

// ---------- job-table.ts: truncateDisplay width=0 边界 ----------
test("truncateDisplay: width=0 时 limit=0，只输出省略号", () => {
  const out = truncateDisplay("abc", 0);
  assert.equal(out, "…");
});

// ---------- index.ts: handleTuiKey ----------
test("handleTuiKey: up 上移并 clamp 到 0", () => {
  const state = {
    jobs: [makeJob(), makeJob()],
    selectedIndex: 1,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("up", state, () => {});
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.needsRedraw, true);
  // 再 up 不越界
  handleTuiKey("up", state, () => {});
  assert.equal(state.selectedIndex, 0);
});

test("handleTuiKey: down 下移并 clamp 到末尾", () => {
  const state = {
    jobs: [makeJob(), makeJob()],
    selectedIndex: 0,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("down", state, () => {});
  assert.equal(state.selectedIndex, 1);
  // 再 down 不越界
  handleTuiKey("down", state, () => {});
  assert.equal(state.selectedIndex, 1);
});

test("handleTuiKey: quit 置 stopped=true，不重绘", () => {
  const state = {
    jobs: [],
    selectedIndex: 0,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("quit", state, () => {});
  assert.equal(state.stopped, true);
  assert.equal(state.needsRedraw, false); // quit 不触发重绘
});

test("handleTuiKey: unknown 动作无副作用", () => {
  const state = {
    jobs: [makeJob()],
    selectedIndex: 0,
    stopped: false,
    needsRedraw: false,
  };
  handleTuiKey("unknown", state, () => {});
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.stopped, false);
  assert.equal(state.needsRedraw, false);
});
