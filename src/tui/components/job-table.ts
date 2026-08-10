import chalk from "chalk";
import type { JobState } from "../../types.js";
import { colorizeStatus } from "../theme.js";
import { fmtElapsed } from "../../formatting.js";

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function displayWidth(s: string): number {
  return stripAnsi(s).length;
}

function padDisplayEnd(s: string, width: number): string {
  const len = displayWidth(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

// 按显示宽度截断，正确处理 ANSI 转义：转义序列不计宽度但原样保留。
// 算法：用正则把串切成 [ansi, text, ansi, text, ...]，遍历累加 text 的显示宽度，
// 到达 width-1（留 1 给省略号）后停止，已累积的 ansi+text 原样输出 + "…"。
// 旧实现逐码元 stripAnsi(ch) 对单码元无效，会把 \x1b[31m 的 5 个码元各计 1 宽，导致带色串截断错位。
// 导出仅供测试覆盖（@internal）。
export function truncateDisplay(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  const limit = Math.max(0, width - 1); // 留 1 给省略号
  // intentional-simple: 正则切分 ANSI(组1) 与 非ANSI 文本(组2)，按显示顺序交替。
  const tokens = s.match(/\x1b\[[0-9;]*m|[^]/g) ?? [];
  let result = "";
  let w = 0;
  for (const tok of tokens) {
    if (tok === "") continue;
    // ANSI 转义序列不计宽度，原样保留。
    if (tok.charCodeAt(0) === 0x1b) {
      result += tok;
      continue;
    }
    if (w >= limit) break;
    result += tok;
    w += tok.length;
  }
  return result + "…";
}

export interface TableRow {
  jobId: string;
  status: string;
  phase: string;
  attempt: number;
  elapsed: string;
  updated: string;
}

export function buildRows(jobs: JobState[]): TableRow[] {
  return jobs.map((j) => {
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
    return {
      jobId: j.jobId,
      status: colorizeStatus(j.status),
      phase: j.phase ?? "",
      attempt: j.attempt ?? 0,
      elapsed,
      updated: j.updatedAt ? new Date(j.updatedAt).toLocaleTimeString() : "—",
    };
  });
}

export function renderJobTable(
  rows: TableRow[],
  selectedIndex: number,
  maxRows: number,
  cols: number,
): string {
  if (rows.length === 0) return chalk.gray("暂无任务");

  const headers = ["Job", "Status", "Phase", "Att", "Elapsed", "Updated"];
  const widths = [28, 12, 16, 4, 10, 10];
  const totalWidth = widths.reduce((a, b) => a + b + 2, 0);

  if (totalWidth > cols && cols > 60) {
    widths[0] = Math.max(16, cols - (totalWidth - widths[0] + 2));
  }

  const lines: string[] = [];
  lines.push(
    chalk.bold(headers.map((h, i) => padDisplayEnd(h, widths[i])).join("  ")),
  );
  lines.push(widths.map((w) => "─".repeat(w)).join("──"));

  const start = Math.max(0, Math.min(selectedIndex, rows.length - maxRows));
  const end = Math.min(rows.length, start + maxRows);
  const visible = rows.slice(start, end);

  for (let i = 0; i < visible.length; i++) {
    const r = visible[i];
    const isSelected = start + i === selectedIndex;
    const cells = [
      truncateDisplay(r.jobId, widths[0]),
      padDisplayEnd(r.status, widths[1]),
      truncateDisplay(r.phase, widths[2]),
      padDisplayEnd(String(r.attempt), widths[3]),
      padDisplayEnd(r.elapsed, widths[4]),
      padDisplayEnd(r.updated, widths[5]),
    ];
    let line = cells.map((c, j) => padDisplayEnd(c, widths[j])).join("  ");
    if (isSelected) line = chalk.inverse(line);
    lines.push(line);
  }

  if (rows.length > maxRows) {
    lines.push(chalk.gray(`  ... ${rows.length - maxRows} more`));
  }

  return lines.join("\n");
}
