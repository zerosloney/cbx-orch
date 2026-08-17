import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendEvent,
  flushEventBuffer,
  pendingEventBufferLines,
} from "../src/runner.js";

test("appendEvent 批量缓冲，flush 后整批落盘", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-evbuf-"));
  const file = path.join(dir, "events.ndjson");
  for (let i = 0; i < 10; i += 1)
    appendEvent(file, { event: "executor_stream_event", n: i });
  // 未到阈值：全部留在内存缓冲，文件尚未创建
  assert.equal(pendingEventBufferLines(file), 10);
  assert.equal(existsSync(file), false);
  flushEventBuffer(file);
  assert.equal(pendingEventBufferLines(file), 0);
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 10);
  assert.match(lines[0], /executor_stream_event/);
  // flush 幂等：空缓冲再次调用不报错
  flushEventBuffer(file);
});

test("行数阈值（128）触发自动 flush", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-evbuf-lines-"));
  const file = path.join(dir, "events.ndjson");
  for (let i = 0; i < 128; i += 1)
    appendEvent(file, { event: "executor_stream_event", n: i });
  assert.equal(pendingEventBufferLines(file), 0);
  assert.equal(
    (await readFile(file, "utf8")).trim().split("\n").length,
    128,
  );
  // 阈值后新事件继续进入缓冲，直到下一次阈值/显式 flush
  appendEvent(file, { event: "process_finished" });
  assert.equal(pendingEventBufferLines(file), 1);
  flushEventBuffer(file);
  assert.equal(
    (await readFile(file, "utf8")).trim().split("\n").length,
    129,
  );
});

test("字节阈值（64KB）触发自动 flush", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-evbuf-bytes-"));
  const file = path.join(dir, "events.ndjson");
  const big = { event: "executor_stream_event", data: "x".repeat(1000) };
  // 每条 ~1KB，70 条远超 64KB → 必然在途中自动 flush
  for (let i = 0; i < 70; i += 1) appendEvent(file, big);
  const buffered = pendingEventBufferLines(file);
  const onDisk = (await readFile(file, "utf8")).trim().split("\n").length;
  assert.equal(buffered + onDisk, 70);
  // 每条 ~1KB：63+ 条即超 64KB 阈值，途中必然已自动 flush（磁盘 >0 且缓冲 <70）
  assert.ok(buffered < 70, `应已触发自动 flush：缓冲 ${buffered}`);
  assert.ok(onDisk >= 60, `应已大部分落盘：磁盘 ${onDisk}，缓冲 ${buffered}`);
});

test("进程正常退出时 exit 钩子 flush 残留缓冲", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cbx-evbuf-exit-"));
  const file = path.join(dir, "events.ndjson");
  const runnerUrl = pathToFileURL(
    path.join(process.cwd(), "dist", "src", "runner.js"),
  ).href;
  const script = `
    import { appendEvent } from ${JSON.stringify(runnerUrl)};
    appendEvent(${JSON.stringify(file)}, { event: "executor_stream_event", n: 1 });
    appendEvent(${JSON.stringify(file)}, { event: "process_finished" });
  `;
  const out = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const content = readFileSync(file, "utf8");
  assert.match(content, /executor_stream_event/);
  assert.match(content, /process_finished/);
});

