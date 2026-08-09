import readline from "node:readline";

export type KeyAction = "up" | "down" | "refresh" | "quit" | "unknown";

export function startKeyboardListener(
  onKey: (action: KeyAction) => void,
): () => void {
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
    } else {
      onKey("unknown");
    }
  };

  process.stdin.on("keypress", handler);
  return () => {
    process.stdin.off("keypress", handler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
}
