import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJob, executeJob, listArtifacts, readArtifact } from "../src/core.js";

// ---- runner 事件流脱敏：governance.redactFields/redactPatterns 覆盖 events.ndjson ----

test("runner 事件统一脱敏：toolArgs 字段与正文/argv 中的密钥均被遮蔽", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-redact-"));
  const binaryDirectory = await mkdtemp(path.join(os.tmpdir(), "cbx-redact-bin-"));
  const script = path.join(binaryDirectory, "fake-redact-codebuddy.mjs");
  await writeFile(
    script,
    [
      'import { mkdir, writeFile } from "node:fs/promises";',
      "const args = process.argv.slice(2);",
      'const prompt = args.at(-1) ?? "";',
      "const jobDir = process.env.FAKE_JOB_DIR;",
      "// 模拟 codebuddy stream-json：tool_use 携带 toolArgs.token（对象级字段脱敏路径）",
      'console.log(JSON.stringify({ type: "tool_use", name: "Edit", input: { token: "obj-level-secret-xyz", path: "a.txt" } }));',
      "// 文本 delta 携带行内密钥（pattern 级全文脱敏路径）",
      'console.log(JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "inline sk-live-999888 leaked" } }));',
      "if (jobDir) {",
      "  await mkdir(jobDir, { recursive: true });",
      '  if (prompt.includes("context handshake")) {',
      '    await writeFile(jobDir + "/understanding.json", JSON.stringify({ interpretedGoal: "goal", plannedFiles: [], acceptanceCriteria: [], assumptions: [], blockingQuestions: [] }));',
      "  } else {",
      '    await writeFile(jobDir + "/handback.md", "ok\\n");',
      '    await writeFile(process.cwd() + "/redact-change.txt", "changed\\n");',
      "  }",
      "}",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  process.env.CBX_CODEBUDDY = script;
  process.env.FAKE_JOB_DIR = "";
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({
      governance: {
        redactFields: ["token"],
        redactPatterns: ["sk-[a-z0-9-]+"],
      },
    }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "任务正文包含密钥 sk-live-999888",
    review: false,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 10_000,
    maxRetries: 0,
    jobId: "redact-events",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  const events = await readFile(path.join(job.directory, "events.ndjson"), "utf8");
  // 对象级：executor_stream_event 的 toolArgs.token → [REDACTED]
  assert.doesNotMatch(events, /obj-level-secret-xyz/);
  assert.match(events, /"token":"\[REDACTED\]"/);
  // pattern 级：流文本与 process_started argv（任务正文/prompt）中的 sk- 密钥全文遮蔽
  assert.doesNotMatch(events, /sk-live-999888/);
  assert.match(events, /\[REDACTED\]/);
});

// ---- artifacts 层 jobId 校验：阻断 `..` 穿越 ----

test("readArtifact/listArtifacts 拒绝包含路径成分的 jobId", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-artifact-guard-"));
  await assert.rejects(readArtifact(workspace, "..", "state.json"), /无效的任务 ID/);
  await assert.rejects(readArtifact(workspace, "a/b", "state.json"), /无效的任务 ID/);
  await assert.rejects(listArtifacts(workspace, ".."), /无效的任务 ID/);
});
