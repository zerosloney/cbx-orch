import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfig } from "../src/storage.js";
import {
  createJob,
  listJobs,
  loadConfig,
  loadState,
  mergeConfig,
  readEventsIncremental,
} from "./helpers.js";

test("createJob persists task contract and state", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  const job = await createJob({
    workspace,
    task: "实现功能",
    testCommand: "npm test",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    jobId: "test-job",
  });
  assert.equal(job.jobId, "test-job");
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
  assert.match(
    await readFile(path.join(job.directory, "request.md"), "utf8"),
    /实现功能/,
  );
  assert.equal(
    existsSync(path.join(job.directory, "context-snapshot.md")),
    false,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(job.directory, "context.json"), "utf8"))
      .adaptive,
    undefined,
  );
});

test("readEventsIncremental returns events after cursor and skips partial tail", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-"));
  const job = await createJob({
    workspace,
    task: "游标",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "cursor-job",
  });
  const eventsFile = path.join(job.directory, "events.ndjson");
  await writeFile(
    eventsFile,
    [
      JSON.stringify({ event: "a", n: 0 }),
      JSON.stringify({ event: "a", n: 1 }),
      JSON.stringify({ event: "a", n: 2 }),
      "", // trailing newline split artifact
      "{partial", // line index 3: concurrent write mid-flight, truncated
    ].join("\n"),
    "utf8",
  );

  // since=0: three valid lines, stop at partial; next_offset points past line 2
  const first = await readEventsIncremental(workspace, job.jobId, 0);
  assert.equal(first.events.length, 3);
  assert.equal(first.next_offset, 3);

  // since=3: partial line still there, returns nothing, offset unchanged
  const second = await readEventsIncremental(
    workspace,
    job.jobId,
    first.next_offset,
  );
  assert.equal(second.events.length, 0);
  assert.equal(second.next_offset, 3);

  // worker appends completion of partial line (now valid), plus one more
  await writeFile(
    eventsFile,
    [
      JSON.stringify({ event: "a", n: 0 }),
      JSON.stringify({ event: "a", n: 1 }),
      JSON.stringify({ event: "a", n: 2 }),
      JSON.stringify({ event: "a", n: 3 }),
      JSON.stringify({ event: "a", n: 4 }),
      "",
    ].join("\n"),
    "utf8",
  );

  const third = await readEventsIncremental(
    workspace,
    job.jobId,
    second.next_offset,
  );
  assert.equal(third.events.length, 2);
  assert.equal(third.next_offset, 5);
  assert.equal(JSON.parse(third.events[1]).n, 4);
});

test(".cbx.json provides defaults and tasks can be listed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-config-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      testCommand: "npm test",
      review: true,
      isolated: true,
      maxRetries: 3,
      approval: { beforeRun: true },
      reviewExecutor: "opencode",
    }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  const defaults = mergeConfig(config, {});
  assert.equal(defaults.review, true);
  assert.equal(defaults.approvalBeforeRun, true);
  assert.equal(defaults.reviewExecutor, "opencode");
  await createJob({
    workspace,
    task: "配置任务",
    review: defaults.review,
    isolated: defaults.isolated,
    permissionMode: defaults.permissionMode,
    maxTurns: defaults.maxTurns,
    timeoutMs: defaults.timeoutMs,
    maxRetries: defaults.maxRetries,
    approvalBeforeRun: defaults.approvalBeforeRun,
    jobId: "config-job",
  });
  assert.equal((await listJobs(workspace))[0].jobId, "config-job");
});

test("mergeConfig defaults to isolated execution while preserving explicit values", () => {
  assert.equal(mergeConfig({}, {}).isolated, true);
  assert.equal(mergeConfig({ isolated: false }, {}).isolated, false);
  assert.equal(mergeConfig({}, { isolated: false }).isolated, false);
  assert.equal(mergeConfig({ isolated: true }, {}).isolated, true);
  assert.equal(mergeConfig({}, { isolated: true }).isolated, true);
});

test("loadRuntimeConfig accepts the four execution profiles", async () => {
  for (const profile of [
    "fast",
    "verified",
    "governed",
    "untrusted",
  ] as const) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-profile-"));
    await writeFile(
      path.join(workspace, ".cbx.json"),
      JSON.stringify({ profile }),
      "utf8",
    );
    assert.equal((await loadRuntimeConfig(workspace)).profile, profile);
  }
});

test("loadRuntimeConfig rejects an unknown execution profile", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-profile-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ profile: "strict" }),
    "utf8",
  );
  await assert.rejects(
    () => loadRuntimeConfig(workspace),
    /未知 execution profile。可选值：fast、verified、governed、untrusted。/,
  );
});

test("mergeConfig applies profile defaults without overriding explicit values", () => {
  const expected = {
    fast: {
      isolated: false,
      review: false,
      dependencyGuard: false,
      approvalBeforeComplete: false,
      trustMode: "trusted",
    },
    verified: {
      isolated: true,
      review: true,
      dependencyGuard: false,
      approvalBeforeComplete: false,
      trustMode: "trusted",
    },
    governed: {
      isolated: true,
      review: true,
      dependencyGuard: true,
      approvalBeforeComplete: true,
      trustMode: "trusted",
    },
    untrusted: {
      isolated: true,
      review: true,
      dependencyGuard: true,
      approvalBeforeComplete: true,
      trustMode: "untrusted",
    },
  } as const;
  for (const profile of Object.keys(expected) as (keyof typeof expected)[]) {
    const merged = mergeConfig({ profile }, {});
    assert.equal(merged.profile, profile);
    assert.deepEqual(
      {
        isolated: merged.isolated,
        review: merged.review,
        dependencyGuard: merged.dependencyGuard,
        approvalBeforeComplete: merged.approvalBeforeComplete,
        trustMode: merged.trustMode,
      },
      expected[profile],
    );
  }

  const explicit = mergeConfig(
    {
      profile: "governed",
      isolated: false,
      review: false,
      dependencyGuard: false,
      approval: { beforeComplete: false },
      execution: { trustMode: "trusted" },
    },
    {
      profile: "untrusted",
      isolated: false,
      review: false,
      dependencyGuard: false,
      approvalBeforeComplete: false,
      trustMode: "trusted",
    },
  );
  assert.equal(explicit.profile, "untrusted");
  assert.equal(explicit.isolated, false);
  assert.equal(explicit.review, false);
  assert.equal(explicit.dependencyGuard, false);
  assert.equal(explicit.approvalBeforeComplete, false);
  assert.equal(explicit.trustMode, "trusted");
});

test("mergeConfig keeps current defaults when profile is unset", () => {
  const merged = mergeConfig({}, {});
  assert.equal(merged.profile, undefined);
  assert.equal(merged.isolated, true);
  assert.equal(merged.review, false);
  assert.equal(merged.dependencyGuard, false);
  assert.equal(merged.approvalBeforeComplete, false);
  assert.equal(merged.trustMode, "trusted");
});

test("untrusted mode requires a configured runner plugin (no runner → rejected)", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-untrusted-"));
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "不可信任务",
        review: false,
        isolated: true,
        permissionMode: "auto",
        maxTurns: 5,
        trustMode: "untrusted",
      }),
    /execution\.runner/,
  );
});

test("dontAsk permission mode requires an explicit unsafe opt-in", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-dontask-"));
  await assert.rejects(
    () =>
      createJob({
        workspace,
        task: "不安全",
        review: false,
        isolated: false,
        permissionMode: "dontAsk",
        maxTurns: 5,
      }),
    /dangerously-skip-permissions/,
  );
  const job = await createJob({
    workspace,
    task: "显式放行",
    review: false,
    isolated: false,
    permissionMode: "dontAsk",
    allowUnsafePermissions: true,
    maxTurns: 5,
    jobId: "dontask-ok",
  });
  assert.equal(job.jobId, "dontask-ok");
});
