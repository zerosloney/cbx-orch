import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJob } from "../src/core.js";

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

// ---------- cbx ws：跨 workspace 汇总 ----------

test("cbx ws --workspace A --workspace B 输出两 workspace 汇总", async () => {
  const wsA = await mkdtemp(path.join(os.tmpdir(), "cbx-ws-a-"));
  const wsB = await mkdtemp(path.join(os.tmpdir(), "cbx-ws-b-"));
  await createJob({
    workspace: wsA,
    task: "A任务",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "ws-a-job",
  });
  await createJob({
    workspace: wsB,
    task: "B任务",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "ws-b-job",
  });
  const out = spawnSync(
    process.execPath,
    [cliPath, "ws", "--workspace", wsA, "--workspace", wsB, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout) as {
    workspaces: Array<{
      path: string;
      name: string;
      jobsByStatus: Record<string, number>;
      queueDepth: number;
    }>;
    default: string;
  };
  assert.equal(body.workspaces.length, 2);
  assert.equal(body.workspaces[0].jobsByStatus.queued, 1);
  assert.equal(body.workspaces[1].jobsByStatus.queued, 1);
  assert.equal(body.default, wsA);
});

test("cbx ws 单 workspace 向后兼容（默认 .）", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-ws-single-"));
  const out = spawnSync(
    process.execPath,
    [cliPath, "ws", "--workspace", workspace, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout) as { workspaces: unknown[] };
  assert.equal(body.workspaces.length, 1);
});

test("cbx ws --workspaces-dir 扫描含 .cbx 的子目录", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbx-ws-scan-"));
  const subA = path.join(root, "proj-a");
  const subB = path.join(root, "proj-b");
  const empty = path.join(root, "not-cbx");
  await mkdir(path.join(subA, ".cbx"), { recursive: true });
  await mkdir(path.join(subB, ".cbx"), { recursive: true });
  await mkdir(empty, { recursive: true });
  const out = spawnSync(
    process.execPath,
    [cliPath, "ws", "--workspaces-dir", root, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout) as {
    workspaces: Array<{ path: string }>;
  };
  // 只含 .cbx 子目录（proj-a/proj-b），不含 not-cbx
  assert.equal(body.workspaces.length, 2);
  const names = body.workspaces.map((w) => w.path).sort();
  assert.deepEqual(names, [subA, subB].sort());
});

// ---------- cbx list --all / health --all ----------

test("cbx list --all 跨 workspace 合并任务并带前缀", async () => {
  const wsA = await mkdtemp(path.join(os.tmpdir(), "cbx-lall-a-"));
  const wsB = await mkdtemp(path.join(os.tmpdir(), "cbx-lall-b-"));
  await createJob({
    workspace: wsA,
    task: "A",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "lall-a",
  });
  await createJob({
    workspace: wsB,
    task: "B",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    jobId: "lall-b",
  });
  const out = spawnSync(
    process.execPath,
    [
      cliPath,
      "list",
      "--all",
      "--workspace",
      wsA,
      "--workspace",
      wsB,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const jobs = JSON.parse(out.stdout) as Array<{ jobId: string }>;
  assert.equal(jobs.length, 2);
  const joined = jobs.map((j) => j.jobId).join("\n");
  assert.match(joined, /\[cbx-lall-a[^\]]*\] lall-a/);
  assert.match(joined, /\[cbx-lall-b[^\]]*\] lall-b/);
});

test("cbx health --all 输出每 workspace 指标", async () => {
  const wsA = await mkdtemp(path.join(os.tmpdir(), "cbx-hall-a-"));
  const wsB = await mkdtemp(path.join(os.tmpdir(), "cbx-hall-b-"));
  const out = spawnSync(
    process.execPath,
    [cliPath, "health", "--all", "--workspace", wsA, "--workspace", wsB],
    { encoding: "utf8" },
  );
  assert.equal(out.status, 0, out.stderr);
  const body = JSON.parse(out.stdout) as {
    workspaces: Array<{ workspace: string; status: string }>;
  };
  assert.equal(body.workspaces.length, 2);
  for (const w of body.workspaces) assert.equal(w.status, "ok");
});
