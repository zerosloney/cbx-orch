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

test("MCP cbx_status 查询不存在任务抛 E_NOT_FOUND", async () => {
  const { workspace } = await setupFake();
  await assert.rejects(
    callTool("cbx_status", { job_id: "no-such-job", workspace }),
    /不存在/,
  );
});

test("MCP cbx_review 查询不存在任务抛明确错误", async () => {
  const { workspace } = await setupFake();
  await assert.rejects(
    callTool("cbx_review", { job_id: "no-such-review", workspace }),
    /不存在/,
  );
});

test("MCP cbx_artifact 拒绝非证据文件", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "artifact 白名单",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    jobId: "mcp-artifact-job",
  });
  await assert.rejects(
    callTool("cbx_artifact", {
      job_id: job.jobId,
      artifact: "secret.env",
      workspace,
    }),
    /不允许/,
  );
});

test("MCP cbx_result 读取未完成任务抛明确错误", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  const job = await createJob({
    workspace,
    task: "result 不存在",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    jobId: "mcp-result-job",
  });
  await assert.rejects(
    callTool("cbx_result", { job_id: job.jobId, workspace }),
    /ENOENT|不存在/,
  );
});

test("MCP cbx_start 参数校验：空任务、无效 max_turns、无效 permission_mode", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  await assert.rejects(
    callTool("cbx_start", { task: "   ", workspace }),
    /task 必须是非空字符串/,
  );
  await assert.rejects(
    callTool("cbx_start", { task: "x", max_turns: 0, workspace }),
    /max_turns 必须是正整数/,
  );
  await assert.rejects(
    callTool("cbx_start", {
      task: "x",
      permission_mode: "superuser",
      workspace,
    }),
    /permission_mode/,
  );
});

test("MCP cbx_continue 参数校验：extra_rounds 越界、refresh_baseline 非布尔", async () => {
  const { workspace } = await setupFake();
  await initializeGitWorkspace(workspace);
  await createJob({
    workspace,
    task: "continue 校验",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 3,
    timeoutMs: 10_000,
    jobId: "mcp-continue-validate-job",
  });
  await assert.rejects(
    callTool("cbx_continue", {
      job_id: "mcp-continue-validate-job",
      extra_rounds: 0,
      workspace,
    }),
    /extra_rounds/,
  );
  await assert.rejects(
    callTool("cbx_continue", {
      job_id: "mcp-continue-validate-job",
      refresh_baseline: "yes",
      workspace,
    }),
    /refresh_baseline/,
  );
});

test("MCP cbx_list_workspaces 空 root 返回空列表", async () => {
  const { workspace } = await setupFake();
  const result = (await callTool("cbx_list_workspaces", {
    root: workspace,
  })) as { workspaces: unknown[] };
  assert.deepEqual(result.workspaces, []);
});
