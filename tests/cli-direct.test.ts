import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.js";
import { createJob, cancelJob } from "../src/core.js";

async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode = 0;

  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalIsTTY = process.stdin.isTTY;

  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__TEST_EXIT_${code}`);
  }) as typeof process.exit;

  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  (process.stdin as unknown as { isTTY: boolean }).isTTY = true;

  try {
    await main(args);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("__TEST_EXIT_")) {
      // process.exit() 被调用，属于预期行为
    } else {
      throw e;
    }
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    (process.stdin as unknown as { isTTY: boolean }).isTTY = originalIsTTY;
  }

  return { code: exitCode, stdout: logs.join("\n"), stderr: errors.join("\n") };
}

async function doctorWorkspace(
  config: Record<string, unknown>,
  git = false,
): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-doctor-"));
  const agents = path.join(workspace, ".cbx", "agents");
  await mkdir(agents, { recursive: true });
  const executable = path.join(workspace, "doctor-agent.mjs");
  await writeFile(executable, "process.exit(0);\n", "utf8");
  await writeFile(
    path.join(agents, "doctorfake.json"),
    JSON.stringify({
      name: "doctorfake",
      label: "Doctor Fake",
      candidates: [executable],
      args: ["{prompt}"],
    }),
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ executor: "doctorfake", ...config }),
    "utf8",
  );
  if (git) {
    const result = spawnSync("git", ["init", "-b", "main"], {
      cwd: workspace,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  return workspace;
}

// =============================================================================
// 基础命令（无 job 依赖）
// =============================================================================

test("cli direct: help", async () => {
  const { code, stdout } = await runMain(["help"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("用法：cbx"));
  assert.ok(stdout.includes("doctor"));
  assert.ok(stdout.includes("templates"));
  assert.ok(stdout.includes("--profile fast|verified|governed|untrusted"));
});

test("cli direct: version", async () => {
  const { code, stdout } = await runMain(["version"]);
  assert.equal(code, 0);
  assert.ok(/^\d+\.\d+\.\d+/.test(stdout.trim()));
});

test("cli direct: list empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["list", "--workspace", ws]);
  assert.equal(code, 0);
  const jobs = JSON.parse(stdout);
  assert.ok(Array.isArray(jobs));
});

test("cli direct: list --all cross workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["list", "--all", "--workspace", ws]);
  assert.equal(code, 0);
  const combined = JSON.parse(stdout);
  assert.ok(Array.isArray(combined));
});

test("cli direct: health empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["health", "--workspace", ws]);
  assert.equal(code, 0);
  const h = JSON.parse(stdout);
  assert.equal(h.status, "ok");
});

test("cli direct: health --all cross workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["health", "--all", "--workspace", ws]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result.workspaces));
});

test("cli direct: dispatch empty workspace", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["dispatch", "--workspace", ws]);
  assert.equal(code, 0);
  const q = JSON.parse(stdout);
  assert.ok(Array.isArray(q.entries));
});

test("cli direct: queue list/pause/resume", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({ maxConcurrent: 1 }), "utf8");

  const { code: c1, stdout: out1 } = await runMain(["queue", "--workspace", ws]);
  assert.equal(c1, 0);
  assert.equal(JSON.parse(out1).paused, false);

  const { code: c2 } = await runMain(["queue", "pause", "--workspace", ws]);
  assert.equal(c2, 0);

  const { code: c3 } = await runMain(["queue", "resume", "--workspace", ws]);
  assert.equal(c3, 0);
});

test("cli direct: ws command", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({}), "utf8");
  const { code, stdout } = await runMain(["ws", "--workspace", ws]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.ok(result.workspaces);
});

test("cli direct: stop-review-gate", async () => {
  const { code, stdout } = await runMain(["stop-review-gate"]);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "");
});

test("cli direct: doctor human output reports status and checks", async () => {
  const ws = await doctorWorkspace({ profile: "fast" }, true);
  const { code, stdout } = await runMain(["doctor", "--workspace", ws]);
  assert.equal(code, 0);
  assert.match(stdout, /Status: PASS/);
  assert.match(stdout, /runtime/);
  assert.match(stdout, /executor/);
});

test("cli direct: doctor --json returns a report", async () => {
  const ws = await doctorWorkspace({ profile: "fast" }, true);
  const { code, stdout } = await runMain([
    "doctor",
    "--workspace",
    ws,
    "--json",
  ]);
  assert.equal(code, 0);
  const report = JSON.parse(stdout) as { checks?: unknown[]; status?: string };
  assert.ok(Array.isArray(report.checks));
  assert.equal(report.status, "pass");
});

test("cli direct: doctor exits 1 when verified profile lacks a test", async () => {
  const ws = await doctorWorkspace({ profile: "verified" }, true);
  const { code, stdout } = await runMain(["doctor", "--workspace", ws]);
  assert.equal(code, 1);
  assert.match(stdout, /profile/);
  assert.match(stdout, /testCommand/);
});

test("cli direct: doctor exits 0 for fast profile on non-Git workspace", async () => {
  const ws = await doctorWorkspace({ profile: "fast" });
  const { code, stdout } = await runMain(["doctor", "--workspace", ws]);
  assert.equal(code, 0);
  assert.match(stdout, /Status: WARN/);
  assert.match(stdout, /git/);
});

// =============================================================================
// 错误路径（参数缺失 / job 不存在）
// =============================================================================

test("cli direct: batch missing task", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["batch", "--workspace", ws]), /请至少提供一个任务/);
});

test("cli direct: batch unsupported --job-id", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["batch", "--workspace", ws, "--job-id", "x"]), /不支持 --job-id/);
});

test("cli direct: forget missing --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["forget", "--workspace", ws, "test-job"]), /forget 会删除/);
});

test("cli direct: purge missing --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["purge", "--workspace", ws, "test-job"]), /purge 会删除/);
});

test("cli direct: export invalid format", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await assert.rejects(runMain(["export", "--workspace", ws, "--format", "xml", job.jobId]), /必须是 text 或 markdown/);
});

test("cli direct: status nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["status", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: logs nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["logs", "--workspace", ws, "nonexistent"]), /ENOENT/);
});

test("cli direct: files nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["files", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.ok(Array.isArray(JSON.parse(stdout)));
});

test("cli direct: result nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["result", "--workspace", ws, "nonexistent"]), /ENOENT/);
});

test("cli direct: review nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["review", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("尚无 review.md"));
});

test("cli direct: cancel nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["cancel", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: clean nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["clean", "--workspace", ws, "nonexistent"]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).jobId, "nonexistent");
});

test("cli direct: retry nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["retry", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: approve nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["approve", "--workspace", ws, "nonexistent"]), /不存在/);
});

test("cli direct: continue nonexistent job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(runMain(["continue", "--workspace", ws, "nonexistent"]), /不存在/);
});

// =============================================================================
// 需要 job 的正常路径
// =============================================================================

test("cli direct: start command", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain(["start", "--workspace", ws, "--task", "test task"]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "queued");
  assert.ok(result.jobId);
});

test("cli direct: start forwards dependencyGuard to context", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain([
    "start", "--workspace", ws, "--task", "dependency guard task",
    "--no-isolated", "--dependency-guard",
  ]);
  assert.equal(code, 0);
  const { jobId } = JSON.parse(stdout) as { jobId: string };
  const context = JSON.parse(
    await readFile(path.join(ws, ".cbx", "jobs", jobId, "context.json"), "utf8"),
  ) as { dependencyGuard?: boolean };
  assert.equal(context.dependencyGuard, true);
});

test("cli direct: start forwards profile to context", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain([
    "start", "--workspace", ws, "--task", "profile task", "--profile", "fast", "--no-isolated",
  ]);
  assert.equal(code, 0);
  const { jobId } = JSON.parse(stdout) as { jobId: string };
  const context = JSON.parse(
    await readFile(path.join(ws, ".cbx", "jobs", jobId, "context.json"), "utf8"),
  ) as { profile?: string; isolated?: boolean };
  assert.equal(context.profile, "fast");
  assert.equal(context.isolated, false);
});

test("cli direct: verified profile rejects missing test or explicit review override", async () => {
  const missingTestWorkspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(
    runMain([
      "run", "--workspace", missingTestWorkspace, "--task", "verified task", "--profile", "verified",
    ]),
    /verified profile 要求 testCommand 非空/,
  );

  const noReviewWorkspace = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(
    runMain([
      "run", "--workspace", noReviewWorkspace, "--task", "verified task", "--profile", "verified",
      "--no-review", "--test", "npm test",
    ]),
    /verified profile 要求 review=true/,
  );
});

test("cli direct: unknown profile is rejected with stable error", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await assert.rejects(
    runMain([
      "start", "--workspace", ws, "--task", "unknown profile", "--profile", "strict",
    ]),
    /未知 execution profile。可选值：fast、verified、governed、untrusted。/,
  );
});

test("cli direct: run with --ci exits 2 on failure", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code } = await runMain([
    "run", "--workspace", ws, "--task", "test", "--executor", "codebuddy",
    "--timeout-ms", "100", "--max-turns", "1", "--no-isolated", "--ci",
  ]);
  assert.equal(code, 2);
});

test("cli direct: run with --template missing", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(path.join(ws, ".cbx.json"), JSON.stringify({ templates: {} }), "utf8");
  await assert.rejects(runMain(["run", "--workspace", ws, "--template", "missing"]), /模板不存在/);
});

test("cli direct: templates lists human and JSON output, including empty config", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({
      templates: {
        bugfix: {
          task: "修复登录流程中的问题",
          profile: "verified",
          test: "npm test",
        },
      },
    }),
    "utf8",
  );

  const human = await runMain(["templates", "--workspace", ws]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /bugfix/);
  assert.match(human.stdout, /profile=verified/);
  assert.match(human.stdout, /修复登录流程中的问题/);

  const json = await runMain(["templates", "--workspace", ws, "--json"]);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), {
    templates: [
      {
        name: "bugfix",
        task: "修复登录流程中的问题",
        profile: "verified",
        test: "npm test",
      },
    ],
  });

  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ templates: {} }),
    "utf8",
  );
  const emptyHuman = await runMain(["templates", "--workspace", ws]);
  assert.equal(emptyHuman.code, 0);
  assert.equal(emptyHuman.stdout, "暂无任务模板");
  const emptyJson = await runMain(["templates", "--workspace", ws, "--json"]);
  assert.equal(emptyJson.code, 0);
  assert.deepEqual(JSON.parse(emptyJson.stdout), { templates: [] });
});

test("cli direct: template profile persists and explicit CLI profile overrides it", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({
      templates: {
        verified: {
          task: "模板档位任务",
          profile: "verified",
          test: "npm test",
          review: true,
        },
      },
    }),
    "utf8",
  );

  const fromTemplate = await runMain([
    "start",
    "--workspace",
    ws,
    "--template",
    "verified",
  ]);
  assert.equal(fromTemplate.code, 0);
  const first = JSON.parse(fromTemplate.stdout) as { jobId: string };
  const firstContext = JSON.parse(
    await readFile(
      path.join(ws, ".cbx", "jobs", first.jobId, "context.json"),
      "utf8",
    ),
  ) as { profile?: string; testCommand?: string };
  assert.equal(firstContext.profile, "verified");
  assert.equal(firstContext.testCommand, "npm test");

  const explicit = await runMain([
    "start",
    "--workspace",
    ws,
    "--template",
    "verified",
    "--profile",
    "fast",
    "--no-isolated",
  ]);
  assert.equal(explicit.code, 0);
  const second = JSON.parse(explicit.stdout) as { jobId: string };
  const secondContext = JSON.parse(
    await readFile(
      path.join(ws, ".cbx", "jobs", second.jobId, "context.json"),
      "utf8",
    ),
  ) as { profile?: string };
  assert.equal(secondContext.profile, "fast");
});

test("cli direct: unknown template profile is rejected by config validation", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  await writeFile(
    path.join(ws, ".cbx.json"),
    JSON.stringify({ templates: { invalid: { task: "x", profile: "strict" } } }),
    "utf8",
  );
  await assert.rejects(
    runMain(["templates", "--workspace", ws]),
    /未知 execution profile。可选值：fast、verified、governed、untrusted。/,
  );
});

test("cli direct: batch normal execution", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain([
    "batch", "--workspace", ws, "--task", "task1", "--task", "task2",
    "--timeout-ms", "100", "--max-turns", "1",
  ]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.total, 2);
  assert.ok(Array.isArray(result.jobs));
});

test("cli direct: batch forwards profile to created jobs", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code, stdout } = await runMain([
    "batch", "--workspace", ws, "--task", "batch profile task",
    "--profile", "fast", "--no-isolated",
  ]);
  assert.equal(code, 0);
  const summary = JSON.parse(stdout) as { jobs: Array<{ jobId: string }> };
  const context = JSON.parse(
    await readFile(path.join(ws, ".cbx", "jobs", summary.jobs[0].jobId, "context.json"), "utf8"),
  ) as { profile?: string };
  assert.equal(context.profile, "fast");
});

test("cli direct: batch --wait exits 2 on unfinished", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const { code } = await runMain([
    "batch", "--workspace", ws, "--task", "task1",
    "--timeout-ms", "100", "--max-turns", "1",
    "--wait", "--wait-timeout-ms", "1000",
  ]);
  assert.equal(code, 2);
});

test("cli direct: export normal execution", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["export", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("test") || stdout.includes(job.jobId));
});

test("cli direct: status existing job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["status", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const state = JSON.parse(stdout);
  assert.equal(state.jobId, job.jobId);
});

test("cli direct: review existing job without review.md", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["review", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  assert.ok(stdout.includes("尚无 review.md"));
});

test("cli direct: forget --yes", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await cancelJob(ws, job.jobId);
  const { code, stdout } = await runMain(["forget", "--workspace", ws, "--yes", job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: clean existing job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["clean", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: retry cancelled job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  await cancelJob(ws, job.jobId);
  const { code, stdout } = await runMain(["retry", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: cancel existing queued job", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["cancel", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
});

test("cli direct: continue background", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const job = await createJob({ workspace: ws, task: "test", review: false, isolated: false, permissionMode: "auto", maxTurns: 1 });
  const { code, stdout } = await runMain(["continue", "--workspace", ws, job.jobId]);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.jobId, job.jobId);
  assert.equal(result.status, "queued");
});

test("cli direct: run --task-file", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "cbx-cli-d-"));
  const taskFile = path.join(ws, "task.txt");
  await writeFile(taskFile, "从文件读取的任务", "utf8");
  const { code, stderr } = await runMain([
    "run", "--workspace", ws, "--task-file", taskFile,
    "--executor", "codebuddy", "--timeout-ms", "100", "--max-turns", "1", "--no-isolated",
  ]);
  assert.equal(code, 0);
  assert.ok(!stderr.includes("请提供非空的 --task"));
});
