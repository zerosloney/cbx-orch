import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setupFake, createJob, executeJob, loadState } from "./helpers.js";
import {
  CodeBuddyStreamFilter,
  QwenStreamFilter,
  LineStreamAccumulator,
} from "../src/log-filter.js";
import { bumpTokenUsage } from "../src/state.js";
import { persistedMetrics } from "../src/storage.js";

const ctx = { jobId: "job-1", executor: "codebuddy" };

test("CodeBuddyStreamFilter accumulates summary usage only (per-message usage skipped)", () => {
  const filter = new CodeBuddyStreamFilter();
  // message_start 携带逐消息 usage（嵌套在 message.usage）——与会话总量叠加会重复计数，必须跳过。
  filter.processLine(
    JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 100, output_tokens: 1 } },
    }),
    ctx,
  );
  // message_delta 的 usage.output_tokens 是单条消息累计值，同样跳过。
  filter.processLine(
    JSON.stringify({
      type: "message_delta",
      delta: { type: "text_delta", text: "x" },
      usage: { output_tokens: 42 },
    }),
    ctx,
  );
  // 会话汇总行：result.usage 计入。
  filter.processLine(
    JSON.stringify({ type: "result", usage: { input_tokens: 30, output_tokens: 20 } }),
    ctx,
  );
  // 轮汇总行：turn_end.tokensNum 计入。
  filter.processLine(JSON.stringify({ type: "turn_end", tokensNum: 10 }), ctx);

  const flushed = filter.flush(ctx);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].kind, "system_notice");
  // 50 + 10 = 60（message_start/message_delta 的逐消息 usage 不计）
  assert.equal(flushed[0].meta?.tokensNum, 60);

  // flush 后计数清零：再 flush 不吐事件。
  assert.deepEqual(filter.flush(ctx), []);
});

test("QwenStreamFilter accumulates OpenAI-style usage chunk", () => {
  const filter = new QwenStreamFilter();
  filter.processLine(
    JSON.stringify({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } }),
    ctx,
  );
  const flushed = filter.flush(ctx);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].meta?.tokensNum, 250);
});

test("usage-less streams flush nothing (silent absence, not 0-event noise)", () => {
  for (const filter of [new CodeBuddyStreamFilter(), new QwenStreamFilter()]) {
    filter.processLine("plain text", ctx);
    assert.deepEqual(filter.flush(ctx), []);
  }
});

test("LineStreamAccumulator flush propagates filter usage event (wired to runChild flush path)", () => {
  const accumulator = new LineStreamAccumulator(new CodeBuddyStreamFilter());
  accumulator.feed(
    JSON.stringify({ type: "turn_end", tokensNum: 77 }) + "\n",
    ctx,
  );
  const events = accumulator.flush(ctx);
  assert.equal(events.length, 1);
  assert.equal(events[0].meta?.tokensNum, 77);
});

test("e2e: token usage flows to state, result.json and metrics", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_TOKEN_USAGE = "1";
  const job = await createJob({
    workspace,
    task: "token usage e2e",
    testCommand: 'node -e "process.exit(0)"',
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 10_000,
    jobId: "token-usage-e2e",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  // 只计会话汇总行 result（50）；fake 的 message_start/message_delta 逐消息 usage 跳过。
  assert.equal(state.tokenUsage, 50);

  // result.json 暴露同值。
  const result = JSON.parse(
    await readFile(path.join(job.directory, "result.json"), "utf8"),
  );
  assert.equal(result.tokenUsage, 50);

  // 事件流含 flush 汇总的 system_notice 事件（审计可见）。
  const events = (await readFile(path.join(job.directory, "events.ndjson"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const usageEvent = events.find(
    (e) => e.event === "executor_stream_event" && e.meta?.tokensNum === 50,
  );
  assert.ok(usageEvent, "usage summary event should be persisted in events.ndjson");

  // metrics 聚合跨任务 token。
  const metrics = await persistedMetrics(workspace);
  assert.equal(metrics.tokensUsed, 50);

  // 幂等累计：再次 bump（模拟 review 调用记账）叠加。
  await bumpTokenUsage(workspace, job.jobId, 49);
  assert.equal((await loadState(workspace, job.jobId)).tokenUsage, 99);
  assert.equal((await persistedMetrics(workspace)).tokensUsed, 99);
});

test("bumpTokenUsage ignores non-positive input", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "noop bump",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 1,
    jobId: "noop-bump",
  });
  await bumpTokenUsage(workspace, job.jobId, 0);
  await bumpTokenUsage(workspace, job.jobId, Number.NaN);
  assert.equal((await loadState(workspace, job.jobId)).tokenUsage, undefined);
});
