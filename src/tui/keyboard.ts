import readline from "node:readline";

export type KeyAction =
  | "up"
  | "down"
  | "refresh"
  | "pause"
  | "resume"
  | "cancel"
  | "approve"
  | "retry"
  | "continue"
  | "forget"
  | "purge"
  | "quit"
  | "unknown";

export function startKeyboardListener(
  onKey: (action: KeyAction) => void,
): () => void {
  type StdinListener = Parameters<typeof process.stdin.off>[1];
  const dataListeners = (): StdinListener[] =>
    process.stdin.listeners("data") as StdinListener[];
  const existingDataListeners = new Set(dataListeners());
  const wasFlowing = process.stdin.readableFlowing;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const handler = (_str: string, key: readline.Key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onKey("quit");
    } else if (key.name === "up" || key.name === "k") {
      onKey("up");
    } else if (key.name === "down" || key.name === "j") {
      onKey("down");
    } else if (key.name === "r") {
      onKey("refresh");
    } else if (key.name === "p") {
      onKey("pause");
    } else if (key.name === "u") {
      onKey("resume");
    } else if (key.name === "x") {
      onKey("cancel");
    } else if (key.name === "a") {
      onKey("approve");
    } else if (key.name === "y") {
      onKey("retry");
    } else if (key.name === "n") {
      onKey("continue");
    } else if (key.name === "d") {
      // `d` = forget（保留 worktree）；`D` (Shift) = purge（连 worktree 一起删）。
      // forget/purge 是不可逆操作，上层实现"armed 状态 + 3s 内再按一次"双击确认。
      onKey(key.shift ? "purge" : "forget");
    } else {
      onKey("unknown");
    }
  };

  process.stdin.on("keypress", handler);
  const ownedDataListeners = dataListeners().filter(
    (listener) => !existingDataListeners.has(listener),
  );
  return () => {
    process.stdin.off("keypress", handler);
    for (const listener of ownedDataListeners)
      process.stdin.off("data", listener);
    if (wasFlowing !== true && process.stdin.listenerCount("data") === 0)
      process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
}
