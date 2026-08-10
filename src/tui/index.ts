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

interface TuiKeyState {
  jobs: JobState[];
  selectedIndex: number;
  stopped: boolean;
  needsRedraw: boolean;
}

type IntervalScheduler = (
  callback: () => void,
  intervalMs: number,
) => ReturnType<typeof setInterval>;

export function handleTuiKey(
  action: KeyAction,
  state: TuiKeyState,
  refresh: () => void | Promise<void>,
): void {
  switch (action) {
    case "quit":
      state.stopped = true;
      break;
    case "up":
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      state.needsRedraw = true;
      break;
    case "down":
      // 下界 0：空 jobs 时 jobs.length-1=-1，Math.min 会得 -1，需 clamp。
      state.selectedIndex = Math.max(
        0,
        Math.min(state.jobs.length - 1, state.selectedIndex + 1),
      );
      state.needsRedraw = true;
      break;
    case "refresh":
      state.needsRedraw = true;
      void refresh();
      break;
  }
}

export function scheduleTuiPoll(
  refresh: () => void | Promise<void>,
  intervalMs: number,
  schedule: IntervalScheduler = setInterval,
): ReturnType<typeof setInterval> {
  const timer = schedule(() => void refresh(), intervalMs);
  timer.unref();
  return timer;
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
  const { rows, cols } = getSize();
  clearScreen();
  moveCursor(0, 0);

  // 状态栏 1 行
  console.log(renderStatusBar(state.queue, state.gitBranch));

  // 详情面板：先算行数（无选中1行；选中4行；含error5行），动态决定表格高度避免小屏溢出。
  const selectedJob = state.jobs[state.selectedIndex];
  const detail = renderDetailPane(selectedJob);
  const detailLines = detail.split("\n").length;
  // 表格总占 = 表头2 + 数据 tableHeight + 溢出标记0/1；其余固定 = 状态栏1 + 空行2 + 详情 + 提示1
  const tableHeight = Math.max(3, rows - detailLines - 7);
  const rowsData = buildRows(state.jobs);
  const table = renderJobTable(rowsData, state.selectedIndex, tableHeight, cols);
  console.log(table);

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
  const onSigint = (): void => {
    state.stopped = true;
  };
  let stopKeyboard: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let drawTimer: ReturnType<typeof setInterval> | undefined;
  let stopCheckTimer: ReturnType<typeof setInterval> | undefined;

  hideCursor();
  try {
    stopKeyboard = startKeyboardListener((action: KeyAction) => {
      handleTuiKey(action, state, () => fetchData(workspace, state));
    });
    process.once("SIGINT", onSigint);

    // 按调用方配置的间隔轮询拉数据。
    pollTimer = scheduleTuiPoll(
      () => fetchData(workspace, state),
      intervalMs,
    );

    // 每秒刷新显示（更新 elapsed）
    drawTimer = setInterval(() => {
      if (state.needsRedraw) draw(state);
    }, 1000);
    drawTimer.unref();

    // 初始绘制
    draw(state);

    // 等待停止
    await new Promise<void>((resolve) => {
      stopCheckTimer = setInterval(() => {
        if (state.stopped) resolve();
      }, 100);
      stopCheckTimer.unref();
    });
  } finally {
    if (stopCheckTimer) clearInterval(stopCheckTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (drawTimer) clearInterval(drawTimer);
    process.removeListener("SIGINT", onSigint);
    stopKeyboard?.();
    showCursor();
    clearScreen();
    moveCursor(0, 0);
    console.log("CBX TUI 已退出。");
  }
}
