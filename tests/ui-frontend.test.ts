import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// =============================================================================
// ui/app.js 前端逻辑测试
// 用 node:vm 沙箱加载浏览器脚本，注入最小 DOM/fetch/EventSource 桩，
// 直接调用 app.js 顶层的纯函数（esc/fmtElapsed/totalJobs/rowAttr/rowHtml/updateCards）。
// =============================================================================

interface StubElement {
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  className: string;
  value: string;
  style: Record<string, unknown>;
  children: unknown[];
  scrollTop: number;
  scrollHeight: number;
  dataset: Record<string, string>;
  classList: { add(): void; remove(): void; contains(): boolean };
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(): void;
  removeChild(): void;
  querySelector(): StubElement;
  querySelectorAll(): unknown[];
}

function stubElement(): StubElement {
  return {
    hidden: false,
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    style: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    querySelector() {
      return stubElement();
    },
    querySelectorAll() {
      return [];
    },
  };
}

/** 加载 app.js 到 vm 沙箱，返回 { ctx, els }：ctx 暴露顶层函数，els 记录按选择器缓存的元素桩。 */
async function loadApp(): Promise<{
  ctx: Record<string, unknown>;
  els: Map<string, StubElement>;
}> {
  const source = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "ui",
      "app.js",
    ),
    "utf8",
  );
  const els = new Map<string, StubElement>();
  const documentStub = {
    querySelector: (selector: string): StubElement => {
      if (!els.has(selector)) els.set(selector, stubElement());
      return els.get(selector)!;
    },
    querySelectorAll: () => [] as unknown[],
  };
  const fakeFetch = async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/workspaces"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ workspaces: [], default: "." }),
      };
    if (u.includes("/api/jobs"))
      return { ok: true, status: 200, json: async () => [] };
    if (u.includes("/api/queue"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ maxConcurrent: 2, paused: false, entries: [] }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const context = {
    console: { log() {}, error() {} },
    document: documentStub,
    window: {},
    location: { search: "" },
    history: { replaceState() {} },
    fetch: fakeFetch,
    EventSource: class {
      onmessage: ((event: { data: string }) => void) | null = null;
    },
    URLSearchParams,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "app.js" });
  return { ctx: context as unknown as Record<string, unknown>, els };
}

// ---------- esc：HTML 转义（XSS 防线） ----------

test("app.js esc escapes HTML special characters", async () => {
  const { ctx } = await loadApp();
  const esc = ctx.esc as (s: string) => string;
  assert.equal(
    esc("<script>alert(1)</script>"),
    "&lt;script&gt;alert(1)&lt;/script&gt;",
  );
  assert.equal(esc("a & b"), "a &amp; b");
  assert.equal(esc("plain"), "plain");
  assert.equal(esc(String(123)), "123");
});

// ---------- fmtElapsed：时长格式化 ----------

test("app.js fmtElapsed formats durations and handles invalid input", async () => {
  const { ctx } = await loadApp();
  const fmtElapsed = ctx.fmtElapsed as (
    iso: string | undefined | null,
  ) => string;
  assert.equal(fmtElapsed(undefined), "—");
  assert.equal(fmtElapsed("not-a-date"), "—");
  const past = new Date(Date.now() - 5_000).toISOString();
  assert.match(fmtElapsed(past), /5s/);
  const pastMin = new Date(Date.now() - 65_000).toISOString();
  assert.match(fmtElapsed(pastMin), /1m/);
  const pastHour = new Date(Date.now() - 3_600_000).toISOString();
  assert.match(fmtElapsed(pastHour), /1h/);
  // 未来时间戳（时钟偏差）应返回占位符而非负数
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(fmtElapsed(future), "—");
});

// ---------- totalJobs：状态计数 ----------

test("app.js totalJobs sums status counts and handles missing map", async () => {
  const { ctx } = await loadApp();
  const totalJobs = ctx.totalJobs as (w: Record<string, unknown>) => number;
  assert.equal(
    totalJobs({ jobsByStatus: { queued: 2, running: 1, done: 5 } }),
    8,
  );
  assert.equal(totalJobs({}), 0);
  assert.equal(totalJobs({ jobsByStatus: null }), 0);
});

// ---------- rowAttr：CSS 选择器转义 ----------

test("app.js rowAttr escapes unsafe characters for CSS selectors", async () => {
  const { ctx } = await loadApp();
  const rowAttr = ctx.rowAttr as (id: string) => string;
  assert.equal(rowAttr("job-1"), "job-1");
  assert.equal(rowAttr('a"b'), 'a\\"b');
  assert.equal(rowAttr("a<b"), "a\\<b");
});

// ---------- rowHtml：任务行渲染（含转义） ----------

test("app.js rowHtml renders job row with escaping and elapsed", async () => {
  const { ctx } = await loadApp();
  const rowHtml = ctx.rowHtml as (j: Record<string, unknown>) => string;
  const html = rowHtml({
    jobId: "<img src=x onerror=alert(1)>",
    status: "running",
    phase: "executing",
    attempt: 2,
    reviewVerdict: "PASS",
    createdAt: new Date(Date.now() - 3_000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.ok(html.includes("&lt;img"), "jobId 必须被转义");
  assert.ok(!html.includes("<img"), "未转义的 jobId 不得出现");
  assert.ok(html.includes("s-running"), "status 类名");
  assert.ok(html.includes("v-PASS"), "review verdict 类名");
  assert.ok(html.includes(">2<"), "attempt");
  assert.ok(html.includes("data-id"), "data-id 属性");
});

// ---------- updateCards：仪表盘卡片状态 ----------

test("app.js updateCards reflects running/failed/paused states", async () => {
  const { ctx, els } = await loadApp();
  const updateCards = ctx.updateCards as (
    jobs: Array<Record<string, unknown>>,
    q: Record<string, unknown>,
  ) => void;
  const jobs = [
    { status: "running" },
    { status: "failed" },
    { status: "done" },
  ];
  const queue = {
    maxConcurrent: 4,
    paused: false,
    entries: [{ status: "running" }, { status: "queued" }],
  };
  updateCards(jobs, queue);
  // 真实 DOM 的 textContent 赋值会把 number 强转为 string；桩里保持原值，断言时显式转换。
  assert.equal(String(els.get("#c-total")!.textContent), "3");
  assert.equal(String(els.get("#c-running")!.textContent), "1 / 4");
  assert.equal(String(els.get("#c-failed")!.textContent), "1");
  assert.equal(String(els.get("#c-health")!.textContent), "1个失败");
  assert.ok(els.get("#c-failed")!.className.includes("s-failed"));

  // paused 状态：队列卡显示暂停标记，健康卡显示"暂停"
  updateCards([], { maxConcurrent: 2, paused: true, entries: [] });
  assert.equal(String(els.get("#c-queue")!.textContent), "0 (暂停)");
  assert.equal(String(els.get("#c-health")!.textContent), "暂停");
  assert.ok(els.get("#c-queue")!.className.includes("s-running"));
});
