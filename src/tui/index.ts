import {
  clearScreen,
  getSize,
  hideCursor,
  moveCursor,
  showCursor,
} from "./screen.js";
import { startKeyboardListener, type KeyAction } from "./keyboard.js";
import { renderStatusBar } from "./components/status-bar.js";
import { buildRows, renderJobTable } from "./components/job-table.js";
import { renderDetailPane } from "./components/detail-pane.js";
import type { JobState } from "../types.js";
import type { QueueFile } from "../queue.js";
import { listJobs, listQueue } from "../core.js";
import { capture } from "../process-runner.js";

interface TuiState {
  jobs: JobState[];
  queue: QueueFile;
  gitBranch: string | null;
  selectedIndex: number;
  stopped: boolean;
  needsRedraw: boolean;
}

async function fetchData(workspace: string, state: TuiState): Promise<void> {
  try {
    const [jobs, queue] = await Promise.all([
      listJobs(workspace),
      listQueue(workspace),
    ]);
    state.jobs = jobs;
    state.queue = queue;
    // git branch
    try {
      const result = capture(
        ["git", "branch", "--show-current"],
        workspace,
      );
      state.gitBranch = result.code === 0 ? result.stdout.trim() || null : null;
    } catch {
      state.gitBranch = null;
    }
    // 如果选中索引超出范围，重置
    if (state.selectedIndex >= jobs.length) {
      state.selectedIndex = Math.max(0, jobs.length - 1);
    }
    state.needsRedraw = true;
  } catch {
    /* 静默失败，下次轮询再试 */
  }
}

function draw(state: TuiState): void {
  const { rows } = getSize();
  clearScreen();
  moveCursor(0, 0);

  // 状态栏 1 行
  console.log(renderStatusBar(state.queue, state.gitBranch));

  // 表格：rows - 8（状态栏1 + 表头2 + 详情4 + 提示1）
  const tableHeight = Math.max(5, rows - 8);
  const rowsData = buildRows(state.jobs);
  const { cols } = getSize();
  const table = renderJobTable(rowsData, state.selectedIndex, tableHeight, cols);
  console.log(table);

  // 详情面板
  const selectedJob = state.jobs[state.selectedIndex];
  const detail = renderDetailPane(selectedJob);
  console.log("\n" + detail);

  // 底部提示
  console.log("\n" + "按 ↑/↓ 选择 · r 刷新 · q 退出".replace(/./g, (c) => "\x1b[90m" + c + "\x1b[0m"));

  state.needsRedraw = false;
}

export async function startTui(
  workspace: string,
  intervalMs = 1000,
): Promise<void> {
  const state: TuiState = {
    jobs: [],
    queue: {
      maxConcurrent: 0,
      paused: false,
      entries: [],
      updatedAt: "",
    },
    gitBranch: null,
    selectedIndex: 0,
    stopped: false,
    needsRedraw: true,
  };

  await fetchData(workspace, state);
  hideCursor();

  const stopKeyboard = startKeyboardListener((action: KeyAction) => {
    switch (action) {
      case "quit":
        state.stopped = true;
        break;
      case "up":
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        state.needsRedraw = true;
        break;
      case "down":
        state.selectedIndex = Math.min(
          state.jobs.length - 1,
          state.selectedIndex + 1,
        );
        state.needsRedraw = true;
        break;
      case "refresh":
        state.needsRedraw = true;
        break;
    }
  });

  process.once("SIGINT", () => {
    state.stopped = true;
  });

  // 3 秒轮询拉数据
  const pollTimer = setInterval(() => fetchData(workspace, state), 3000);
  pollTimer.unref();

  // 每秒刷新显示（更新 elapsed）
  const drawTimer = setInterval(() => {
    if (state.needsRedraw) draw(state);
  }, 1000);
  drawTimer.unref();

  // 初始绘制
  draw(state);

  // 等待停止
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (state.stopped) {
        clearInterval(check);
        clearInterval(pollTimer);
        clearInterval(drawTimer);
        resolve();
      }
    }, 100);
  });

  stopKeyboard();
  showCursor();
  clearScreen();
  moveCursor(0, 0);
  console.log("CBX TUI 已退出。");
}
