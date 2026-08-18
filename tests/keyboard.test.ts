import assert from "node:assert/strict";
import test from "node:test";
import { startKeyboardListener, type KeyAction } from "../src/tui/keyboard.js";

function emitKey(name: string, opts: { ctrl?: boolean; shift?: boolean } = {}): void {
  process.stdin.emit("keypress", "", {
    name,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
  });
}

test("keyboard: q 和 ctrl+c 映射为 quit", () => {
  const actions: KeyAction[] = [];
  const cleanup = startKeyboardListener((a) => actions.push(a));
  emitKey("q");
  emitKey("c", { ctrl: true });
  cleanup();
  assert.deepEqual(actions, ["quit", "quit"]);
});

test("keyboard: up/down 方向键和 vim 键 k/j", () => {
  const actions: KeyAction[] = [];
  const cleanup = startKeyboardListener((a) => actions.push(a));
  emitKey("up");
  emitKey("k");
  emitKey("down");
  emitKey("j");
  cleanup();
  assert.deepEqual(actions, ["up", "up", "down", "down"]);
});

test("keyboard: r/p/u/x/a/y/n 映射", () => {
  const actions: KeyAction[] = [];
  const cleanup = startKeyboardListener((a) => actions.push(a));
  emitKey("r");
  emitKey("p");
  emitKey("u");
  emitKey("x");
  emitKey("a");
  emitKey("y");
  emitKey("n");
  cleanup();
  assert.deepEqual(actions, [
    "refresh",
    "pause",
    "resume",
    "cancel",
    "approve",
    "retry",
    "continue",
  ]);
});

test("keyboard: d 无 shift → forget, d 有 shift → purge", () => {
  const actions: KeyAction[] = [];
  const cleanup = startKeyboardListener((a) => actions.push(a));
  emitKey("d");
  emitKey("d", { shift: true });
  cleanup();
  assert.deepEqual(actions, ["forget", "purge"]);
});

test("keyboard: 未绑定键映射为 unknown", () => {
  const actions: KeyAction[] = [];
  const cleanup = startKeyboardListener((a) => actions.push(a));
  emitKey("z");
  emitKey("return");
  cleanup();
  assert.deepEqual(actions, ["unknown", "unknown"]);
});

test("keyboard: cleanup 移除 keypress 监听器", () => {
  const before = process.stdin.listenerCount("keypress");
  const cleanup = startKeyboardListener(() => {});
  const afterAdd = process.stdin.listenerCount("keypress");
  assert.ok(afterAdd > before, "注册后 keypress 监听器应增加");
  cleanup();
  const afterRemove = process.stdin.listenerCount("keypress");
  assert.equal(afterRemove, before, "cleanup 后 keypress 监听器应恢复");
});

test("keyboard: cleanup 移除 emitKeypressEvents 注入的 data 监听器", () => {
  const dataBefore = process.stdin.listenerCount("data");
  const cleanup = startKeyboardListener(() => {});
  const dataAfterAdd = process.stdin.listenerCount("data");
  assert.ok(
    dataAfterAdd >= dataBefore,
    "emitKeypressEvents 可能注入 data 监听器",
  );
  cleanup();
  const dataAfterRemove = process.stdin.listenerCount("data");
  assert.equal(
    dataAfterRemove,
    dataBefore,
    "cleanup 后 data 监听器应恢复到调用前状态",
  );
});
