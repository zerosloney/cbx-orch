import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
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
  invokeExecutor,
  locateExecutable,
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

test("findExecutable wraps .ps1/.js/.mjs/.cjs paths via env override and passes plain binaries as-is", async () => {
  const spec = BUILTIN_EXECUTORS[0]; // codebuddy
  const envVar = spec.envVar;
  const saved = process.env[envVar];
  const dir = await mkdtemp(path.join(os.tmpdir(), "cbx-wrap-"));
  // locateExecutable 要求 envVar 覆盖路径真实存在；不存在的路径由 invokeExecutor 短路报错（另有测试锁定）。
  const makeFile = async (name: string) => {
    const file = path.join(dir, name);
    await writeFile(file, "", "utf8");
    return file;
  };
  try {
    // .ps1 → powershell.exe 包装
    process.env[envVar] = await makeFile("fake-codebuddy.ps1");
    assert.deepEqual(await findExecutable(spec), [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      process.env[envVar],
    ]);

    // 大写扩展名同样识别（lowercase 归一化）
    process.env[envVar] = await makeFile("CODEBUDDY.PS1");
    assert.deepEqual(await findExecutable(spec), [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      process.env[envVar],
    ]);

    // .mjs / .cjs / .js → node 包装
    for (const ext of [".mjs", ".cjs", ".js"]) {
      process.env[envVar] = await makeFile(`fake-codebuddy${ext}`);
      assert.deepEqual(
        await findExecutable(spec),
        [process.execPath, process.env[envVar]],
        `${ext} should resolve to node wrapper`,
      );
    }

    // 无扩展名 / 未知扩展 → 原样返回
    process.env[envVar] = await makeFile("codebuddy-plain");
    assert.deepEqual(await findExecutable(spec), [process.env[envVar]]);
  } finally {
    if (saved === undefined) delete process.env[envVar];
    else process.env[envVar] = saved;
  }
});

test(
  "findExecutable resolves binary on PATH via PATHEXT expansion on win32",
  { skip: process.platform !== "win32" },
  async () => {
    // 临时 .cmd 放进 PATH，验证 PATH×PATHEXT 展开解析完整路径 + .cmd 不做包装
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
      const result = await findExecutable(spec);
      assert.equal(
        result[0].toLowerCase(),
        fakePath.toLowerCase(),
        `expected PATH expansion to resolve ${fakePath}, got ${result[0]}`,
      );
      assert.equal(result.length, 1, ".cmd should pass through unwrapped");
    } finally {
      process.env.PATH = savedPath;
      delete process.env[spec.envVar];
    }
  },
);

test("locateExecutable returns null for missing envVar override and PATH misses", async () => {
  const spec = {
    ...BUILTIN_EXECUTORS[0],
    candidates: ["cbx-no-such-bin-xyz"],
    envVar: "CBX_TEST_LOCATE_MISS",
  };
  const saved = process.env[spec.envVar];
  try {
    // envVar 指向不存在的路径 → null（区别于 findExecutable 的裸名兜底）
    process.env[spec.envVar] = path.join(os.tmpdir(), "cbx-no-such-file.xyz");
    assert.equal(await locateExecutable(spec), null);
    // envVar 未设置且 PATH 未命中 → null
    delete process.env[spec.envVar];
    assert.equal(await locateExecutable(spec), null);
    // findExecutable 兜底行为不变：返回裸名交给 spawn
    assert.deepEqual(await findExecutable(spec), ["cbx-no-such-bin-xyz"]);
  } finally {
    if (saved === undefined) delete process.env[spec.envVar];
    else process.env[spec.envVar] = saved;
  }
});

test(
  "locateExecutable redirects npm .cmd shims to sibling .ps1 (win32 spawn EINVAL guard)",
  { skip: process.platform !== "win32" },
  async () => {
    // Node 20+ 无 shell spawn .cmd 抛 EINVAL（CVE-2024-27980）；npm shim 三件套
    // 同目录必有 .ps1，必须重定向，否则 Windows 上 npm 全局安装的 agent 全部无法本地执行。
    const tmpBin = await mkdtemp(path.join(os.tmpdir(), "cbx-shim-"));
    const cmdPath = path.join(tmpBin, "shimagent.cmd");
    const ps1Path = path.join(tmpBin, "shimagent.ps1");
    await writeFile(cmdPath, "@echo off\r\n", "utf8");
    await writeFile(ps1Path, "Write-Output ok\r\n", "utf8");
    const spec = {
      ...BUILTIN_EXECUTORS[0],
      candidates: ["shimagent"],
      envVar: "CBX_TEST_SHIM_AGENT",
    };
    delete process.env[spec.envVar];
    const savedPath = process.env.PATH;
    process.env.PATH = tmpBin + path.delimiter + (savedPath ?? "");
    try {
      // PATH 命中 .cmd → 重定向到同目录 .ps1 的 powershell 包装
      assert.deepEqual(await locateExecutable(spec), [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ps1Path,
      ]);
      // envVar 直接指向 .cmd → 同样重定向
      process.env[spec.envVar] = cmdPath;
      assert.deepEqual((await locateExecutable(spec))![5], ps1Path);
      // 旁边没有 .ps1 的自定义 .cmd → 保持原样（调用方自行用 envVar 指向 .ps1/.exe）
      await unlink(ps1Path);
      assert.deepEqual(await locateExecutable(spec), [cmdPath]);
    } finally {
      process.env.PATH = savedPath;
      delete process.env[spec.envVar];
    }
  },
);

test("invokeExecutor returns friendly Chinese guidance instead of raw ENOENT", async () => {
  // 本地 spawn 前短路：二进制缺失时不再依赖 spawn 的英文 ENOENT，
  // 而是返回与 cbx agents 探测一致的中文指引（事件流形状保持 process_started/finished 配对）。
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-enoent-"));
  const directory = path.join(workspace, ".cbx", "jobs", "enoent-probe");
  await mkdir(directory, { recursive: true });
  const spec = BUILTIN_EXECUTORS[0];
  const saved = process.env[spec.envVar];
  process.env[spec.envVar] = path.join(workspace, "no-such-binary.cmd");
  try {
    const result = await invokeExecutor(
      "codebuddy",
      workspace,
      directory,
      workspace,
      "hi",
      "auto",
      5,
      1_000,
    );
    assert.equal(result.code, -1);
    assert.ok(result.output.includes(`${spec.envVar} 指向的路径不存在`), result.output);
    const events = await readFile(path.join(directory, "events.ndjson"), "utf8");
    assert.match(events, /"event":"process_started"/);
    assert.match(events, /"event":"process_finished","returncode":-1/);
  } finally {
    if (saved === undefined) delete process.env[spec.envVar];
    else process.env[spec.envVar] = saved;
  }
});
