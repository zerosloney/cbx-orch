import test from "node:test";
import assert from "node:assert/strict";
import {
  colorizeStatus,
  renderHealth,
  renderJobDetail,
  renderJobsTable,
  renderQueueTable,
} from "../src/formatting.js";

test("colorizeStatus maps known statuses", () => {
  assert.ok(colorizeStatus("done").includes("done"));
  assert.ok(colorizeStatus("failed").includes("failed"));
  assert.ok(colorizeStatus("running").includes("running"));
});

test("renderJobsTable empty", () => {
  const out = renderJobsTable([]);
  assert.match(out, /暂无任务/);
});

test("renderJobsTable renders job row", () => {
  const jobs = [
    {
      jobId: "job-abc",
      status: "running",
      phase: "test",
      workspace: "/tmp",
      jobDir: "/tmp/.cbx/jobs/job-abc",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date().toISOString(),
      attempt: 2,
      reviewVerdict: "PASS",
    },
  ];
  const out = renderJobsTable(jobs as unknown as Parameters<typeof renderJobsTable>[0]);
  assert.match(out, /job-abc/);
  assert.match(out, /running/);
  assert.match(out, /test/);
  assert.match(out, /PASS/);
});

test("renderQueueTable shows paused", () => {
  const q = {
    maxConcurrent: 2,
    paused: true,
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  const out = renderQueueTable(q as unknown as Parameters<typeof renderQueueTable>[0]);
  assert.match(out, /PAUSED/);
  assert.match(out, /队列为空/);
});

test("renderJobDetail shows fields", () => {
  const state = {
    jobId: "job-xyz",
    status: "failed",
    phase: "execute",
    workspace: "/tmp",
    jobDir: "/tmp/.cbx/jobs/job-xyz",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T01:00:00Z",
    attempt: 1,
    error: "timeout",
  };
  const out = renderJobDetail(state as unknown as Parameters<typeof renderJobDetail>[0]);
  assert.match(out, /job-xyz/);
  assert.match(out, /failed/);
  assert.match(out, /timeout/);
});

test("renderHealth shows metrics", () => {
  const out = renderHealth({
    status: "ok",
    metrics: {
      queueDepth: 3,
      failedJobs: 1,
      retryingJobs: 0,
      pendingDeliveries: 2,
      deliveryFailures: 0,
      jobsByStatus: { done: 5, running: 1, failed: 1 },
    },
  });
  assert.match(out, /ok/);
  assert.match(out, /3/);
  assert.match(out, /done/);
});
