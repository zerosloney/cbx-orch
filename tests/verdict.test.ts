import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  parseReviewJson,
  parseReviewVerdict,
} from "../src/verdict.js";
import { createJob, executeJob, jobDir } from "../src/core.js";
import { setupFake } from "./helpers.js";

// ---------- parseReviewVerdict 单元 ----------

test("结构化 review.json 优先于 review.md 首行", () => {
  // review.md 说 PASS，review.json 说 FAIL → 结构化判定胜出
  assert.equal(
    parseReviewVerdict("VERDICT: PASS\n细节...\n", {
      version: 1,
      verdict: "FAIL",
    }),
    "FAIL",
  );
  assert.equal(
    parseReviewVerdict("VERDICT: FAIL\n", { version: 1, verdict: "PASS" }),
    "PASS",
  );
});

test("review.md 首行旧契约回退解析（PASS/FAIL）", () => {
  assert.equal(parseReviewVerdict("VERDICT: PASS\n问题清单\n", undefined), "PASS");
  assert.equal(parseReviewVerdict("VERDICT: FAIL\n", undefined), "FAIL");
  // 大小写不敏感 + BOM 容忍
  assert.equal(parseReviewVerdict("\uFEFFverdict: pass\n", undefined), "PASS");
});

test("无 review.json 且首行无法解析 → UNKNOWN", () => {
  assert.equal(parseReviewVerdict("", undefined), "UNKNOWN");
  assert.equal(parseReviewVerdict("分析如下...\n", undefined), "UNKNOWN");
});

test("畸形 review.json 回退首行解析", () => {
  for (const bad of [
    { version: 2, verdict: "PASS" },
    { version: 1, verdict: "WARN" },
    { verdict: "PASS" },
    "PASS",
    null,
    [],
  ]) {
    assert.equal(parseReviewJson(bad), undefined, `应拒绝：${JSON.stringify(bad)}`);
  }
  // 畸形 JSON → 首行判定仍生效（回退路径）
  assert.equal(parseReviewVerdict("VERDICT: PASS\n", { version: 2, verdict: "PASS" }), "PASS");
  assert.equal(parseReviewVerdict("VERDICT: FAIL\n", { verdict: "FAIL" }), "FAIL");
});

test("parseReviewJson 只接受严格形状", () => {
  assert.deepEqual(parseReviewJson({ version: 1, verdict: "PASS" }), {
    version: 1,
    verdict: "PASS",
  });
  assert.deepEqual(parseReviewJson({ version: 1, verdict: "FAIL" }), {
    version: 1,
    verdict: "FAIL",
  });
  // 多余字段容忍（前向兼容）
  assert.deepEqual(
    parseReviewJson({ version: 1, verdict: "PASS", reason: "ok" }),
    { version: 1, verdict: "PASS" },
  );
});

// ---------- 集成：stage review 走结构化判定 ----------

test("stage review 支持 review.json 结构化判定（覆盖 md 首行）", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  // review.md 首行 PASS 但 review.json 说 FAIL → 结构化判定胜出，任务进入 needs_fix
  process.env.FAKE_REVIEW_JSON = "1";
  process.env.FAKE_REVIEW_JSON_VERDICT = "FAIL";
  const job = await createJob({
    workspace,
    task: "结构化审查",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    jobId: "structured-review-job",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.reviewVerdict, "FAIL");
  assert.match(String(state.error ?? ""), /审查发现问题/);
});

test("stage review review.json PASS 走完成路径", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  process.env.FAKE_REVIEW_JSON = "1";
  const job = await createJob({
    workspace,
    task: "结构化审查通过",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "structured-review-pass",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, "PASS");
});

test("stage review 无 review.json 时回退 md 首行（向后兼容）", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_VERDICT = "PASS";
  delete process.env.FAKE_REVIEW_JSON;
  const job = await createJob({
    workspace,
    task: "首行判定兼容",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "legacy-verdict-job",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, "PASS");
});

test("stage review 首行无法解析仍 fail-closed（记 review_verdict_unparsable 事件）", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_REVIEW_CONTENT = "无法解析的审查输出\n";
  delete process.env.FAKE_REVIEW_JSON;
  const job = await createJob({
    workspace,
    task: "不可解析判定",
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 10_000,
    testCommand: 'node -e "process.exit(0)"',
    jobId: "unparsable-verdict-job",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "reviewing");
  // 事件流含 review_verdict_unparsable（可排障信号）
  const events = await readFile(
    path.join(jobDir(workspace, job.jobId), "events.ndjson"),
    "utf8",
  );
  assert.match(events, /review_verdict_unparsable/);
});
