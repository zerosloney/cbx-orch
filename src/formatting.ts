import chalk, { type ChalkInstance } from "chalk";
import type { JobState } from "./types.js";
import type { QueueFile } from "./queue.js";
import type { AgentProbe } from "./agent-registry.js";
import type { ExecutorStats } from "./executors/stats.js";

const STATUS_COLORS: Record<string, ChalkInstance> = {
  done: chalk.green,
  failed: chalk.red,
  review_failed: chalk.red,
  needs_fix: chalk.red,
  running: chalk.yellow,
  awaiting_approval: chalk.yellow,
  queued: chalk.cyan,
  cancelled: chalk.gray,
};

export function colorizeStatus(status: string): string {
  const color = STATUS_COLORS[status] ?? chalk.white;
  return color(status);
}

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.CBX_JSON);
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥离 ANSI 转义序列正是该函数的目的
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// East Asian Wide / Fullwidth 字符在等宽终端占 2 列。
// intentional-simple: 只覆盖最常见 CJK 区块（中日韩统一表意文字、全角标点、假名、谚文等），
// 不做完整 Unicode EastAsianWidth 表；对终端表格对齐足够，升级可换 string-width。
function charWidth(code: number): number {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}

export function displayWidth(s: string): number {
  let width = 0;
  for (const char of stripAnsi(s))
    width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

function padDisplayEnd(s: string, width: number): string {
  const len = displayWidth(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

export function fmtElapsed(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  return fmtDuration(ms);
}

/** 把毫秒数格式化为 12s / 1m 30s / 1h 2m 形式；非法或负值返回 "—"。 */
export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600_000)
    return (
      Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s"
    );
  return (
    Math.floor(ms / 3600_000) +
    "h " +
    Math.floor((ms % 3600_000) / 60_000) +
    "m"
  );
}

/** 根据 createdAt/updatedAt 计算任务总耗时（终态固定值，非终态当前值）。 */
export function jobElapsedMs(state: { createdAt?: string; updatedAt?: string; status?: string }): number | null {
  if (!state.createdAt) return null;
  const start = Date.parse(state.createdAt);
  if (!Number.isFinite(start)) return null;
  const endIso = state.updatedAt;
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  return end - start;
}

export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function colorizeReview(verdict: string): string {
  if (verdict === "PASS") return chalk.green(verdict);
  if (verdict === "FAIL") return chalk.red(verdict);
  return verdict;
}

/**
 * 终端表格拼装：列宽 = max(表头, 各行显示宽度)，粗体表头 + 分隔线。
 * clampFirstColumn 用于首列可能超长（如 jobId）的表：按终端宽度截断首列，保底 20 列。
 */
function renderTable(
  headers: string[],
  rows: string[][],
  opts?: { clampFirstColumn?: boolean },
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => displayWidth(String(r[i])))),
  );
  if (opts?.clampFirstColumn) {
    const termWidth = process.stdout.columns ?? 120;
    const otherWidth = widths.slice(1).reduce((a, b) => a + b + 2, 0);
    widths[0] = Math.min(widths[0], Math.max(20, termWidth - otherWidth - 2));
  }
  const line = (cells: string[]) =>
    cells.map((c, i) => padDisplayEnd(String(c), widths[i])).join("  ");
  return [
    chalk.bold(line(headers)),
    widths.map((w) => "─".repeat(w)).join("──"),
    ...rows.map((r) => line(r)),
  ].join("\n");
}

export function renderJobsTable(jobs: JobState[]): string {
  if (jobs.length === 0) return chalk.gray("暂无任务");

  const headers = [
    "Job",
    "Status",
    "Phase",
    "Att",
    "Review",
    "Elapsed",
    "Updated",
  ];
  const rows = jobs.map((j) => {
    const terminal = [
      "done",
      "failed",
      "review_failed",
      "cancelled",
      "needs_fix",
    ].includes(j.status);
    const totalSeconds = (j as Record<string, unknown>).totalSeconds;
    const elapsed =
      terminal && typeof totalSeconds === "number"
        ? totalSeconds < 60
          ? `${totalSeconds}s`
          : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
        : fmtElapsed(j.createdAt);
    const review = String(j.reviewVerdict ?? "—");
    return [
      j.jobId,
      colorizeStatus(j.status),
      j.phase ?? "",
      String(j.attempt ?? 0),
      colorizeReview(review),
      elapsed,
      fmtTime(j.updatedAt),
    ];
  });

  return renderTable(headers, rows, { clampFirstColumn: true });
}

export function renderAgentsTable(
  probes: AgentProbe[],
  errors: string[],
  stats?: ReadonlyMap<string, ExecutorStats>,
): string {
  const headers = ["Agent", "Label", "Source", "Binary", "Path", "Runs", "OK%", "AvgTok", "AvgSec"];
  const rows = probes.map((p) => {
    const record = stats?.get(p.name);
    return [
      p.aliases.length ? `${p.name} (${p.aliases.join(",")})` : p.name,
      p.label,
      p.source,
      p.available ? chalk.green("ok") : chalk.red("missing"),
      p.command ? p.command.join(" ") : "—",
      record ? String(record.runs) : "—",
      record ? `${Math.round(record.successRate * 100)}%` : "—",
      record?.avgTokens != null ? String(record.avgTokens) : "—",
      record?.avgDurationMs != null
        ? String(Math.round(record.avgDurationMs / 1000))
        : "—",
    ];
  });
  const table = renderTable(headers, rows);
  const hints = [
    table,
    chalk.gray("新增 agent：在 .cbx/agents/（项目）或 ~/.cbx/agents/（用户）放置 spec JSON，无需修改代码。"),
    chalk.gray("Runs/OK%/AvgTok/AvgSec 为该执行器在本 workspace 的历史战绩（终态任务；auto 路由战绩决胜与 cheapest/fastest 策略的数据源）。"),
  ];
  if (errors.length)
    hints.push(chalk.yellow(`以下 spec 注册失败：\n${errors.map((e) => `  - ${e}`).join("\n")}`));
  return hints.join("\n");
}

export function renderQueueTable(queue: QueueFile): string {
  const header = `Queue: ${queue.paused ? chalk.yellow("PAUSED") : chalk.green("running")} · maxConcurrent=${queue.maxConcurrent}`;
  const entries = queue.entries ?? [];
  if (entries.length === 0) return `${header}\n${chalk.gray("队列为空")}`;

  const rows = entries.map((e) => [
    e.jobId,
    colorizeStatus(e.status),
    e.priority ? String(e.priority) : "",
    fmtElapsed(e.createdAt),
    e.error ? chalk.red(e.error.slice(0, 40)) : "",
  ]);

  const headers = ["Job", "Status", "Pri", "Created", "Error"];

  return [header, renderTable(headers, rows)].join("\n");
}

export function renderJobDetail(state: JobState): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("Job:")}     ${state.jobId}`);
  lines.push(`${chalk.bold("Status:")}   ${colorizeStatus(state.status)}`);
  lines.push(`${chalk.bold("Phase:")}    ${state.phase ?? "—"}`);
  lines.push(`${chalk.bold("Attempt:")}  ${state.attempt ?? 0}`);
  const review = String(state.reviewVerdict ?? "—");
  lines.push(`${chalk.bold("Review:")}   ${colorizeReview(review)}`);
  lines.push(`${chalk.bold("Created:")}  ${state.createdAt ?? "—"}`);
  lines.push(`${chalk.bold("Updated:")}  ${state.updatedAt ?? "—"}`);
  const error = state.error;
  if (typeof error === "string")
    lines.push(`${chalk.bold("Error:")}    ${chalk.red(error)}`);
  return lines.join("\n");
}

export function renderHealth(result: {
  status: string;
  metrics: Record<string, unknown>;
  worktreeOrphans?: Array<{ worktree: string; jobId: string }>;
}): string {
  const m = result.metrics as Record<string, number>;
  const lines: string[] = [];
  lines.push(
    `${chalk.bold("Status:")} ${result.status === "ok" ? chalk.green("ok") : chalk.red(result.status)}`,
  );
  lines.push("");
  const orphanCount = result.worktreeOrphans?.length;
  const items: [string, number | undefined][] = [
    ["Queue depth", m.queueDepth],
    ["Failed jobs", m.failedJobs],
    ["Retrying jobs", m.retryingJobs],
    ["Tokens used", m.tokensUsed],
    ["Orphan worktrees", orphanCount],
    ["Pending deliveries", m.pendingDeliveries],
    ["Delivery failures", m.deliveryFailures],
  ];
  for (const [label, value] of items) {
    const num = value ?? 0;
    const colored =
      (label === "Failed jobs" || label === "Delivery failures") && num > 0
        ? chalk.red(String(num))
        : chalk.cyan(String(num));
    lines.push(`  ${label.padEnd(20)} ${colored}`);
  }
  if (orphanCount && orphanCount > 0 && result.worktreeOrphans) {
    lines.push("");
    lines.push(
      `${chalk.bold("Orphan worktrees:")} ${chalk.yellow(`cbx clean --orphans 可清理`)}`,
    );
    for (const orphan of result.worktreeOrphans) {
      lines.push(`  ${orphan.worktree}`);
    }
  }
  if (m.jobsByStatus && typeof m.jobsByStatus === "object") {
    lines.push("");
    lines.push(chalk.bold("Jobs by status:"));
    for (const [status, count] of Object.entries(
      m.jobsByStatus as Record<string, number>,
    )) {
      lines.push(
        `  ${padDisplayEnd(colorizeStatus(status), 20)} ${chalk.cyan(String(count))}`,
      );
    }
  }
  return lines.join("\n");
}

interface ExportResult {
  status?: string;
  phase?: string;
  stages?: Array<{
    name: string;
    executor: string;
    exitCode: number;
    reviewVerdict?: string | null;
  }>;
  acceptanceEvidence?: Array<{ criterion: string; status: string }>;
  error?: string | null;
  handback?: string;
  updatedAt?: string;
  /** 原始 test.log 内容（来自工件）— 渲染时解析为摘要 */
  testLog?: string;
  /** 原始 review.md 内容（来自工件）— 渲染时按 handback 风格截断 */
  review?: string;
  /** 原始 complete.patch 内容（来自工件）— 渲染时计算 files/insertions/deletions */
  completePatch?: string;
}

/** 截断长文本到指定行数（保留完整行）。 */
function truncateLines(text: string | undefined, maxLines: number): string {
  if (!text) return "";
  const lines = text.split("\n").filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines).join("\n") + "\n…（已截断）";
}

/**
 * 测试日志摘要：行数 + 探测常见通过/失败计数（mocha "X passing"、jest "Tests: X passed"、
 * 简单 "X failed" / "FAILED" / "OK"）+ 末尾若干行原文。返回的对象在 text/markdown
 * 两种渲染路径上都会被消费，因此探测口径必须保持一致。
 */
export interface TestLogSummary {
  lineCount: number;
  /** mocha/jest 风格：分别给出通过/失败计数；探测不到时为 null */
  passed: number | null;
  failed: number | null;
  /** 末尾 N 行原文（保留换行符），供终端一眼看出失败点 */
  tail: string;
}

export function summarizeTestLog(text: string, tailLines = 20): TestLogSummary {
  if (!text) return { lineCount: 0, passed: null, failed: null, tail: "" };
  const allLines = text.split("\n");
  const lineCount = allLines.length;
  let passed: number | null = null;
  let failed: number | null = null;
  // mocha: "  42 passing (1s)" / "  3 failing"
  for (const line of allLines) {
    const m1 = line.match(/(\d+)\s+passing\b/i);
    if (m1 && passed == null) passed = Number(m1[1]);
    const m2 = line.match(/(\d+)\s+failing\b/i);
    if (m2 && failed == null) failed = Number(m2[1]);
  }
  // jest: "Tests:       2 failed, 5 passed, 7 total"
  const summaryLine = allLines.find((l) => /Tests:\s+\d/i.test(l));
  if (summaryLine) {
    const p = summaryLine.match(/(\d+)\s+passed/);
    const f = summaryLine.match(/(\d+)\s+failed/);
    if (p) passed = Number(p[1]);
    if (f) failed = Number(f[1]);
  }
  // 兜底：未找到结构化计数时，如果存在 "FAILED" / "OK" 给出单值
  if (passed == null && failed == null) {
    if (/\bOK\b/.test(text) && !/FAILED|FAILURES|Errors?:/i.test(text)) {
      passed = 0; // 至少表示"全部通过"——具体个数未知
    } else if (/\bFAILED\b/.test(text) || /Tests failed/i.test(text)) {
      failed = 1;
    }
  }
  const tail = allLines.slice(Math.max(0, allLines.length - tailLines)).join("\n");
  return { lineCount, passed, failed, tail };
}

/**
 * complete.patch 统计：以 `git diff` 输出为输入，解析 `diff --git` 出现次数得到
 * 变更文件数，并对 `+` / `-` 开头的行（排除 `+++` / `---` 文件头）求和得到
 * 新增/删除行数。空 patch 返回全 0。
 */
export interface PatchStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function summarizePatch(text: string): PatchStats {
  const result: PatchStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  if (!text) return result;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) result.filesChanged += 1;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      // 文件头标记行，不计入新增/删除
    } else if (line.startsWith("+")) result.insertions += 1;
    else if (line.startsWith("-")) result.deletions += 1;
  }
  return result;
}

export function renderExport(
  state: JobState,
  result: ExportResult | null,
  format: "text" | "markdown",
): string {
  if (format === "text") {
    const lines: string[] = [renderJobDetail(state)];
    // Elapsed: 终态用 createdAt..updatedAt 固定值，非终态用 createdAt..now。
    const elapsed = jobElapsedMs(state);
    if (elapsed != null) {
      lines.push(`${chalk.bold("Elapsed:")}  ${fmtDuration(elapsed)}`);
    }
    if (result) {
      if (result.stages && result.stages.length) {
        lines.push("");
        lines.push(chalk.bold("Stages:"));
        for (const s of result.stages)
          lines.push(
            `  ${s.name} / ${s.executor} / ${colorizeReview(String(s.reviewVerdict ?? (s.exitCode === 0 ? "PASS" : "FAIL")))}`,
          );
      }
      if (result.acceptanceEvidence && result.acceptanceEvidence.length) {
        lines.push("");
        lines.push(chalk.bold("Acceptance:"));
        for (const ev of result.acceptanceEvidence)
          lines.push(
            `  ${ev.status === "evidence_available" ? chalk.green("✓") : chalk.gray("✗")} ${ev.criterion}`,
          );
      }
      const handback = truncateLines(result.handback, 15);
      if (handback) {
        lines.push("");
        lines.push(chalk.bold("Handback:"));
        lines.push(handback);
      }
      const test = result.testLog ? summarizeTestLog(result.testLog) : null;
      if (test && test.lineCount > 0) {
        lines.push("");
        lines.push(chalk.bold("Test:"));
        const passStr =
          test.passed != null
            ? `${chalk.green(String(test.passed) + " passed")}`
            : chalk.gray("passed ?");
        const failStr =
          test.failed != null
            ? `${test.failed > 0 ? chalk.red(String(test.failed) + " failed") : chalk.gray("0 failed")}`
            : chalk.gray("failed ?");
        lines.push(`  ${test.lineCount} lines · ${passStr} · ${failStr}`);
        if (test.tail) {
          lines.push("");
          lines.push(test.tail);
        }
      }
      const review = truncateLines(result.review, 15);
      if (review) {
        lines.push("");
        // 段头加 "notes" 后缀以区分 renderJobDetail 里的 Review 裁决行。
        lines.push(chalk.bold("Review notes:"));
        lines.push(review);
      }
      const patch = result.completePatch ? summarizePatch(result.completePatch) : null;
      if (patch && patch.filesChanged > 0) {
        lines.push("");
        lines.push(chalk.bold("Patch:"));
        lines.push(
          `  ${chalk.cyan(String(patch.filesChanged) + " files")} · ${chalk.green("+" + patch.insertions)} · ${chalk.red("-" + patch.deletions)}`,
        );
      }
    } else {
      lines.push("");
      lines.push(chalk.gray("（无 result.json，仅任务状态）"));
    }
    return lines.join("\n");
  }
  // markdown
  const md: string[] = [`# 任务 ${state.jobId}`, ""];
  md.push(`- 状态：\`${state.status}\``);
  md.push(`- 阶段：\`${state.phase ?? "—"}\``);
  md.push(`- 尝试次数：${state.attempt}`);
  const elapsed = jobElapsedMs(state);
  if (elapsed != null) md.push(`- 耗时：\`${fmtDuration(elapsed)}\``);
  if (state.reviewVerdict) md.push(`- 审查：\`${state.reviewVerdict}\``);
  if (state.error) md.push(`- 错误：\`${state.error}\``);
  if (result) {
    if (result.stages && result.stages.length) {
      md.push("", "## Stages", "");
      md.push("| Stage | Executor | Verdict |");
      md.push("|-------|----------|---------|");
      for (const s of result.stages)
        md.push(
          `| ${s.name} | ${s.executor} | ${s.reviewVerdict ?? (s.exitCode === 0 ? "PASS" : "FAIL")} |`,
        );
    }
    if (result.acceptanceEvidence && result.acceptanceEvidence.length) {
      md.push("", "## Acceptance", "");
      for (const ev of result.acceptanceEvidence)
        md.push(
          `- [${ev.status === "evidence_available" ? "x" : " "}] ${ev.criterion}`,
        );
    }
    const handback = truncateLines(result.handback, 15);
    if (handback) {
      md.push("", "## Handback", "");
      md.push("```", handback, "```");
    }
    const test = result.testLog ? summarizeTestLog(result.testLog) : null;
    if (test && test.lineCount > 0) {
      md.push("", "## Test", "");
      const passed = test.passed != null ? String(test.passed) : "?";
      const failed = test.failed != null ? String(test.failed) : "?";
      md.push(`- 行数：${test.lineCount}`);
      md.push(`- 通过：${passed} · 失败：${failed}`);
      if (test.tail) {
        md.push("", "```", test.tail, "```");
      }
    }
    const review = truncateLines(result.review, 15);
    if (review) {
      md.push("", "## Review notes", "");
      md.push("```", review, "```");
    }
    const patch = result.completePatch ? summarizePatch(result.completePatch) : null;
    if (patch && patch.filesChanged > 0) {
      md.push("", "## Patch", "");
      md.push(`- 变更文件：${patch.filesChanged}`);
      md.push(`- 新增：+${patch.insertions} · 删除：-${patch.deletions}`);
    }
  } else {
    md.push("", "_（无 result.json，仅任务状态）_");
  }
  return md.join("\n");
}

export function renderWorkspacesTable(
  workspaces: Array<{
    path: string;
    name: string;
    jobsByStatus: Record<string, number>;
    queueDepth: number;
    paused: boolean;
    activeExecutors: number;
    gitBranch: string | null;
    error?: string;
  }>,
): string {
  if (workspaces.length === 0) return chalk.gray("无 workspace");
  const total = (w: { jobsByStatus: Record<string, number> }): number =>
    Object.values(w.jobsByStatus).reduce((a, b) => a + b, 0);
  const headers = ["Workspace", "Jobs", "Active", "Queue", "Paused", "Branch"];
  const rows = workspaces.map((w) => [
    w.name,
    String(total(w)),
    String(w.activeExecutors),
    String(w.queueDepth),
    w.paused ? chalk.yellow("paused") : "—",
    w.gitBranch ?? (w.error ? chalk.red("error") : "—"),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => displayWidth(String(r[i])))),
  );
  const line = (cells: string[]): string =>
    "  " +
    cells
      .map((c, i) => padDisplayEnd(c, widths[i]))
      .join("  ")
      .trimEnd();
  const out = [
    line(headers),
    "  " + widths.map((w) => "-".repeat(w)).join("  "),
  ];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}
