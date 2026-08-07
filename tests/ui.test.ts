import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jobDir } from "../src/core.js";
import { buildTimeline, readAgentLogIncremental, readExecutorStatus } from "../src/ui.js";

test("buildTimeline returns empty stages for a job with no events", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-empty";
  await mkdir(jobDir(workspace, jobId), { recursive: true });
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 0);
  assert.equal(timeline.currentStage, null);
  assert.equal(timeline.startedAt, null);
  assert.equal(timeline.finishedAt, null);
  assert.equal(timeline.elapsedSec, 0);
});

test("buildTimeline parses queued → running → done state changes with phases", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-tl";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const events = [
    { event: "job.state_changed", jobId, status: "queued", phase: "queued", at: "2026-08-06T10:00:00.000Z" },
    { event: "job.state_changed", jobId, status: "running", phase: "executor", at: "2026-08-06T10:00:05.000Z" },
    { event: "job.state_changed", jobId, status: "done", phase: "done", at: "2026-08-06T10:00:30.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 3);
  assert.equal(timeline.stages[0].name, "queued");
  assert.equal(timeline.stages[0].durationMs, 5000);
  assert.equal(timeline.stages[1].name, "running");
  assert.equal(timeline.stages[1].durationMs, 25000);
  assert.equal(timeline.stages[2].name, "done");
  assert.equal(timeline.stages[2].endedAt, null);
  assert.equal(timeline.currentStage, "done");
  assert.equal(timeline.finishedAt, "2026-08-06T10:00:30.000Z");
});

test("buildTimeline falls back to stage_started/finished for legacy jobs (pre-0.10.2)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-tl-legacy";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  // 老格式:0.10.2 之前的 jobs 只写 stage_started/stage_finished,没有 job.state_changed
  const events = [
    { event: "executor_metadata", source: "builtin", name: "codebuddy", at: "2026-08-06T10:00:00.000Z" },
    { event: "process_started", command: ["codebuddy"], at: "2026-08-06T10:00:00.000Z" },
    { event: "stage_started", jobId, stage: "implementation", executor: "codebuddy", index: 0, total: 1, at: "2026-08-06T10:00:01.000Z" },
    { event: "stage_finished", jobId, stage: "implementation", executor: "codebuddy", index: 0, exitCode: 0, reviewVerdict: "PASS", at: "2026-08-06T10:00:30.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const timeline = await buildTimeline(workspace, jobId);
  assert.equal(timeline.stages.length, 1);
  assert.equal(timeline.stages[0].name, "implementation");
  assert.equal(timeline.stages[0].durationMs, 29000);
  assert.match(timeline.stages[0].phase ?? "", /codebuddy.*PASS/);
  assert.equal(timeline.finishedAt, "2026-08-06T10:00:30.000Z");
});

test("readExecutorStatus reads pid/heartbeat and reports no process when files are missing", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-exec";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const status = await readExecutorStatus(workspace, jobId);
  assert.equal(status.pid, null);
  assert.equal(status.alive, null);
  assert.equal(status.heartbeatAt, null);
  assert.equal(status.command, null);
});

test("readExecutorStatus extracts the latest process_started command from events", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-exec2";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const events = [
    { event: "process_started", command: ["codebuddy", "-p", "first"], at: "2026-08-06T10:00:00.000Z" },
    { event: "process_finished", returncode: 0, at: "2026-08-06T10:00:10.000Z" },
    { event: "process_started", command: ["codebuddy", "-p", "second prompt"], at: "2026-08-06T10:00:15.000Z" },
  ];
  await writeFile(path.join(dir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const status = await readExecutorStatus(workspace, jobId);
  // last process_started wins (we want the most recent command shown in UI)
  assert.equal(status.command, "codebuddy -p second prompt");
});

test("readAgentLogIncremental returns empty content for missing log and trims oversized output", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ui-"));
  const jobId = "job-log";
  const dir = jobDir(workspace, jobId);
  await mkdir(dir, { recursive: true });
  const empty = await readAgentLogIncremental(workspace, jobId);
  assert.equal(empty.content, "");
  assert.equal(empty.nextOffset, 0);
  assert.equal(empty.truncated, false);

  const huge = "x".repeat(1024 * 1024);
  await writeFile(path.join(dir, "agent.log"), huge, "utf8");
  const result = await readAgentLogIncremental(workspace, jobId, 0, 4096);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 4096);
  assert.equal(result.nextOffset, huge.length);
});
