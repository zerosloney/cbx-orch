import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  setupFake,
  createJob,
  health,
  listJobs,
  listQueue,
  loadConfig,
  loadState,
  pauseQueue,
  readArtifact,
  serveQueue,
  acquireServiceLease,
  loadPersistedQueue,
  savePersistedStateAndQueue,
  BUILTIN_EXECUTORS,
  findExecutable,
} from "./helpers.js";

test("persistent serve loop reclaims dead workers on startup and stops cleanly", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "serve 恢复",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    jobId: "serve-recovery",
  });
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx", "queue.json"),
    JSON.stringify({
      maxConcurrent: 1,
      paused: true,
      updatedAt: new Date().toISOString(),
      entries: [
        {
          queueId: "dead-serve-worker",
          jobId: job.jobId,
          workspace,
          extra: "",
          status: "running",
          createdAt: new Date().toISOString(),
          pid: 2_147_483_647,
          priority: 0,
        },
      ],
    }),
    "utf8",
  );
  const service = await serveQueue(workspace, 50);
  assert.equal((await listQueue(workspace)).entries[0].status, "queued");
  await assert.rejects(() => serveQueue(workspace, 50), /已有活跃 serve 实例/);
  await service.stop();
});

test("expired service leases fence the previous owner", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-lease-fencing-"));
  const first = await acquireServiceLease(workspace, "test-lease", 80);
  await assert.rejects(
    () => acquireServiceLease(workspace, "test-lease", 80),
    /已有活跃 serve 实例/,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await acquireServiceLease(workspace, "test-lease", 80);
  assert.equal(await first.renew(), false);
  assert.equal(await second.renew(), true);
  await second.release();
});

test("SQLite migrates legacy jobs, queue, and delivery failures without losing artifacts", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "cbx-sqlite-migration-"),
  );
  const jobDir = path.join(workspace, ".cbx", "jobs", "legacy-job");
  await mkdir(jobDir, { recursive: true });
  const state = {
    jobId: "legacy-job",
    status: "failed",
    phase: "testing",
    workspace,
    jobDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    attempt: 2,
  };
  await writeFile(
    path.join(jobDir, "state.json"),
    JSON.stringify(state),
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx", "queue.json"),
    JSON.stringify({
      maxConcurrent: 2,
      paused: false,
      updatedAt: state.updatedAt,
      entries: [
        {
          queueId: "legacy-entry",
          jobId: state.jobId,
          workspace,
          extra: "",
          status: "failed",
          createdAt: state.createdAt,
          priority: 0,
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx", "delivery-failures.ndjson"),
    JSON.stringify({ type: "delivery.failed", at: state.updatedAt }) + "\n",
    "utf8",
  );
  assert.equal((await listJobs(workspace))[0].jobId, state.jobId);
  assert.equal((await listQueue(workspace)).entries[0].queueId, "legacy-entry");
  const snapshot = await health(workspace);
  assert.equal(snapshot.metrics.failedJobs, 1);
  assert.equal(snapshot.metrics.deliveryFailures, 1);
});

test("strict configuration rejects unknown and unsafe nested fields", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-config-schema-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ approval: { beforeRun: true, beforeComplete: true } }),
    "utf8",
  );
  assert.deepEqual((await loadConfig(workspace)).approval, {
    beforeRun: true,
    beforeComplete: true,
  });
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ approval: { beforeComplete: "yes" } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /approval\.beforeComplete/);
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ notifications: { timeoutMs: 10 } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /notifications\.timeoutMs/);
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { unknown: true } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /governance 不支持字段/);
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      adaptive: { enabled: true, maxRounds: 3, managerExecutor: "opencode" },
    }),
    "utf8",
  );
  assert.deepEqual((await loadConfig(workspace)).adaptive, {
    enabled: true,
    maxRounds: 3,
    managerExecutor: "opencode",
  });
  for (const [adaptive, error] of [
    [{ unknown: true }, /adaptive 不支持字段/],
    [{ enabled: "yes" }, /adaptive\.enabled/],
    [{ maxRounds: 0 }, /adaptive\.maxRounds/],
    [{ managerExecutor: "" }, /adaptive\.managerExecutor/],
  ] as const) {
    await writeFile(
      path.join(workspace, ".cbx.json"),
      JSON.stringify({ adaptive }),
      "utf8",
    );
    await assert.rejects(() => loadConfig(workspace), error);
  }
});

test("templates config accepts valid entries and rejects invalid shapes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-tpl-schema-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      templates: {
        bugfix: {
          task: "修复 review.md 中的问题",
          test: "npm test",
          review: true,
        },
        feature: { task: "实现新功能", executor: "opencode" },
      },
    }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  assert.equal(config.templates?.bugfix.task, "修复 review.md 中的问题");
  assert.equal(config.templates?.bugfix.test, "npm test");
  assert.equal(config.templates?.bugfix.review, true);
  assert.equal(config.templates?.feature.executor, "opencode");

  // 缺 task → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ templates: { bad: { test: "npm test" } } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /templates\.bad\.task/);
  // 未知模板键 → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ templates: { bad: { task: "x", unknown: 1 } } }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig(workspace),
    /templates\.bad 不支持字段/,
  );
  // 错类型 → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ templates: { bad: { task: "x", review: "yes" } } }),
    "utf8",
  );
  await assert.rejects(() => loadConfig(workspace), /templates\.bad\.review/);
});

test("retention prunes expired delivery failure artifacts and SQLite records together", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-retention-"));
  await mkdir(path.join(workspace, ".cbx"), { recursive: true });
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { retentionDays: 1 } }),
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx", "delivery-failures.ndjson"),
    JSON.stringify({
      type: "delivery.failed",
      at: "2000-01-01T00:00:00.000Z",
    }) + "\n",
    "utf8",
  );
  assert.equal((await health(workspace)).metrics.deliveryFailures, 0);
  assert.equal(
    await readFile(
      path.join(workspace, ".cbx", "delivery-failures.ndjson"),
      "utf8",
    ),
    "",
  );
});

test("paired state and queue write rolls back both records when queue update fails", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-atomic-"));
  const job = await createJob({
    workspace,
    task: "原子更新",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "atomic",
  });
  await pauseQueue(workspace);
  const beforeState = await loadState(workspace, job.jobId);
  const beforeQueue = await loadPersistedQueue(workspace, {
    maxConcurrent: 2,
    paused: false,
    entries: [],
    updatedAt: "",
  });
  const db = new Database(path.join(workspace, ".cbx", "state.sqlite"));
  // 故障注入点跟随存储模型迁移：queue 落在 queue_meta（v4 行级拆分后），挂在旧 queue_state 表不再生效。
  db.exec(
    "CREATE TRIGGER fail_atomic_queue BEFORE UPDATE ON queue_meta BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END",
  );
  try {
    await assert.rejects(
      () =>
        savePersistedStateAndQueue(
          workspace,
          job.jobId,
          { ...beforeState, status: "done" },
          { ...beforeQueue, paused: false },
        ),
      /injected queue failure/,
    );
  } finally {
    db.close();
  }
  assert.equal((await loadState(workspace, job.jobId)).status, "queued");
  assert.equal((await listQueue(workspace)).paused, true);
});

test("CLI --template expands task from config and unknown template errors", async () => {
  const { workspace } = await setupFake();
  const cliPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "cli.js",
  );
  // 未配置模板 → 报错并提示
  const missing = spawnSync(
    process.execPath,
    [
      cliPath,
      "run",
      "--template",
      "nope",
      "--workspace",
      workspace,
      "--test",
      'node -e "process.exit(0)"',
      "--no-review",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CBX_CODEBUDDY: process.env.CBX_CODEBUDDY },
    },
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /模板不存在：nope/);

  // 配置模板 → start 用模板 task 创建 job 并返回 jobId
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      templates: { bugfix: { task: "修复 review.md 中的问题" } },
    }),
    "utf8",
  );
  const ok = spawnSync(
    process.execPath,
    [
      cliPath,
      "start",
      "--template",
      "bugfix",
      "--workspace",
      workspace,
      "--test",
      'node -e "process.exit(0)"',
      "--no-review",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CBX_CODEBUDDY: process.env.CBX_CODEBUDDY },
    },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const created = JSON.parse(ok.stdout) as { jobId: string; status: string };
  assert.equal(created.status, "queued");
  // request.md 内容来自模板 task
  const request = await readArtifact(workspace, created.jobId, "request.md");
  assert.match(request, /修复 review\.md 中的问题/);
});

test("notifications.filters accepts valid config and rejects invalid shapes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-notif-schema-"));
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      notifications: {
        webhook: "https://example.test/cbx-events",
        filters: {
          events: ["job.state_changed"],
          jobIds: ["job-1"],
          statuses: ["done"],
        },
      },
    }),
    "utf8",
  );
  const config = await loadConfig(workspace);
  assert.equal(
    config.notifications?.webhook,
    "https://example.test/cbx-events",
  );
  assert.deepEqual(config.notifications?.filters, {
    events: ["job.state_changed"],
    jobIds: ["job-1"],
    statuses: ["done"],
  });

  // 未知 filters 键 → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      notifications: { webhook: "https://x", filters: { unknown: ["x"] } },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig(workspace),
    /notifications\.filters 不支持字段/,
  );
  // 空数组 → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      notifications: { webhook: "https://x", filters: { statuses: [] } },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig(workspace),
    /notifications\.filters\.statuses 必须是非空字符串数组/,
  );
  // 元素错类型 → 拒绝
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      notifications: { webhook: "https://x", filters: { events: [1] } },
    }),
    "utf8",
  );
  await assert.rejects(
    () => loadConfig(workspace),
    /notifications\.filters\.events 必须是非空字符串数组/,
  );
  // 无 filters 时向后兼容（全量推送）
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      notifications: { webhook: "https://example.test/cbx-events" },
    }),
    "utf8",
  );
  assert.equal((await loadConfig(workspace)).notifications?.filters, undefined);
});

test("findExecutable wraps .ps1/.js/.mjs/.cjs paths via env override and passes plain binaries as-is", () => {
  const spec = BUILTIN_EXECUTORS[0]; // codebuddy
  const envVar = spec.envVar;
  const saved = process.env[envVar];
  try {
    // .ps1 → powershell.exe 包装
    process.env[envVar] = path.join(os.tmpdir(), "fake-codebuddy.ps1");
    assert.deepEqual(findExecutable(spec), [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      process.env[envVar],
    ]);

    // 大写扩展名同样识别（lowercase 归一化）
    process.env[envVar] = "C:\\fake\\CODEBUDDY.PS1";
    assert.deepEqual(findExecutable(spec), [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\fake\\CODEBUDDY.PS1",
    ]);

    // .mjs / .cjs / .js → node 包装
    for (const ext of [".mjs", ".cjs", ".js"]) {
      process.env[envVar] = path.join(os.tmpdir(), `fake-codebuddy${ext}`);
      assert.deepEqual(
        findExecutable(spec),
        [process.execPath, process.env[envVar]],
        `${ext} should resolve to node wrapper`,
      );
    }

    // 无扩展名 / 未知扩展 → 原样返回
    process.env[envVar] = "/usr/local/bin/codebuddy";
    assert.deepEqual(findExecutable(spec), ["/usr/local/bin/codebuddy"]);
  } finally {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
  }
});

test(
  "findExecutable resolves binary via PowerShell Get-Command on win32",
  { skip: process.platform !== "win32" },
  async () => {
    // 临时 .cmd 放进 PATH，验证 Get-Command 解析完整路径 + .cmd 不做包装
    const tmpBin = await mkdtemp(path.join(os.tmpdir(), "cbx-fakebin-"));
    const fakePath = path.join(tmpBin, "fakebin.cmd");
    await writeFile(fakePath, "@echo off\r\n", "utf8");
    const spec = {
      ...BUILTIN_EXECUTORS[0],
      candidates: ["fakebin"],
      envVar: "CBX_TEST_FAKEBIN_PATH",
    };
    delete process.env[spec.envVar];
    const savedPath = process.env.PATH;
    process.env.PATH = tmpBin + path.delimiter + (savedPath ?? "");
    try {
      const result = findExecutable(spec);
      assert.equal(
        result[0].toLowerCase(),
        fakePath.toLowerCase(),
        `expected Get-Command to resolve ${fakePath}, got ${result[0]}`,
      );
      assert.equal(result.length, 1, ".cmd should pass through unwrapped");
    } finally {
      process.env.PATH = savedPath;
      delete process.env[spec.envVar];
    }
  },
);
