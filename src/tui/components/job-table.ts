import chalk from "chalk";
import type { JobState } from "../../types.js";
import { colorizeStatus } from "../theme.js";

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

function truncateDisplay(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let result = "";
  let w = 0;
  for (const ch of s) {
    const cw = stripAnsi(ch).length || 1;
    if (w + cw > width - 1) {
      result += "…";
      break;
    }
    result += ch;
    w += cw;
  }
  return result;
}

function fmtElapsed(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600_000)
    return Math.floor(ms / 60_000) + "m " + Math.floor((ms % 60_000) / 1000) + "s";
  return (
    Math.floor(ms / 3600_000) +
    "h " +
    Math.floor((ms % 3600_000) / 60_000) +
    "m"
  );
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
