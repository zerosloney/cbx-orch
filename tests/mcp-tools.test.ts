import assert from "node:assert/strict";
import test from "node:test";
import { createJob } from "../src/core.js";
import { initializeGitWorkspace, setupFake } from "./helpers.js";
// callTool(name, args): workspace 从 args.workspace 读取
import { callTool } from "../src/mcp-server.js";

test("MCP cbx_clean 工具：无 worktree 时返回 cleaned:false（幂等）", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "clean 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    maxRetries: 0,
    keepWorktree: false,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "mcp-clean-job",
  });
  // isolated=false → 无 worktree；cleanupWorktree 幂等，不抛错
  const result = (await callTool("cbx_clean", {
    job_id: job.jobId,
    workspace,
  })) as { job_id: string; cleaned: boolean };
  assert.equal(result.job_id, job.jobId);
  assert.equal(result.cleaned, false);
});

test("MCP cbx_clean reason 字段缺失时使用默认 mcp:cbx_clean 格式（不抛错）", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "clean reason 测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    maxRetries: 0,
    keepWorktree: false,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "mcp-clean-reason-job",
  });
  const result = (await callTool("cbx_clean", {
    job_id: job.jobId,
    workspace,
  })) as { job_id: string; cleaned: boolean };
  assert.equal(result.job_id, job.jobId);
  assert.equal(result.cleaned, false);
});

test("MCP 未知工具 cbx_foobar 抛出 Error（包含'未知工具'）", async () => {
  await assert.rejects(
    callTool("cbx_foobar", { job_id: "fake" }),
    (err: unknown) =>
      err instanceof Error && /未知工具/.test(err.message),
    "未知工具名应抛出包含 '未知工具' 的 Error",
  );
});

test("MCP cbx_clean 幂等：同一 job 多次调用结果一致", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "幂等测试",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    maxRetries: 0,
    keepWorktree: false,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "mcp-idempotent-job",
  });
  const r1 = (await callTool("cbx_clean", {
    job_id: job.jobId,
    workspace,
  })) as { cleaned: boolean };
  const r2 = (await callTool("cbx_clean", {
    job_id: job.jobId,
    workspace,
  })) as { cleaned: boolean };
  assert.equal(r1.cleaned, r2.cleaned, "幂等：两次调用结果一致");
});
