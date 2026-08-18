import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  setupFake,
  createAdaptiveJob,
  createJob,
  executeJob,
  readArtifact,
  CONTEXT_PACK_MAX_CHARS,
  parseContextPack,
  createHumanGate,
  extendRoundLimit,
  parseHumanGate,
  resolveHumanGate,
} from "./helpers.js";

test("explicit skipReview keeps the legacy task contract completion path", async () => {
  const { workspace } = await setupFake();
  const job = await createJob({
    workspace,
    task: "显式跳过审查",
    taskContract: {
      acceptanceCriteria: ["保持跳审语义"],
      stages: [
        {
          name: "implementation",
          executor: "codebuddy",
          task: "实现",
          skipReview: true,
        },
      ],
    },
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    jobId: "skip-structured-audit",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "done");
  assert.equal(state.reviewVerdict, null);
  assert.equal(existsSync(path.join(job.directory, "audit.json")), false);
});

test("adaptive manager executes one stage then deterministically completes", async () => {
  const { workspace } = await setupFake();
  const job = await createAdaptiveJob(workspace, "adaptive-success");
  const promptFile = path.join(workspace, "adaptive-prompts.txt");
  process.env.FAKE_JOB_DIR = job.directory;
  process.env.FAKE_PROMPT_FILE = promptFile;
  const state = await executeJob(workspace, job.jobId, "operator supplement");
  assert.equal(state.status, "done");
  assert.equal(state.adaptiveRound, 2);
  assert.deepEqual(
    (state.adaptiveRounds as Array<{ action: string }>).map(
      (item) => item.action,
    ),
    ["execute", "done"],
  );
  assert.equal((state.stages as unknown[]).length, 1);
  const context = JSON.parse(
    await readFile(path.join(job.directory, "context.json"), "utf8"),
  );
  assert.deepEqual(context.adaptive, {
    enabled: true,
    maxRounds: 4,
    managerExecutor: "codebuddy",
  });
  const prompts = await readFile(promptFile, "utf8");
  assert.match(prompts, /manager-context\.json/);
  assert.doesNotMatch(prompts, /MANAGER_INPUT:/);
  const packs = await Promise.all(
    ["manager", "executor", "auditor"].map((role) =>
      readArtifact(workspace, job.jobId, `${role}-context.json`).then(
        JSON.parse,
      ),
    ),
  );
  assert.deepEqual(
    packs.map((pack) => pack.role),
    ["manager", "executor", "auditor"],
  );
  for (const pack of packs) {
    assert.equal(pack.projection, true);
    assert.ok(JSON.stringify(pack).length <= CONTEXT_PACK_MAX_CHARS);
    assert.doesNotMatch(
      JSON.stringify(pack),
      /agent\.log|MANAGER_INPUT|trajectory/i,
    );
    assert.ok(
      pack.artifacts.every((artifact: { sha256: string }) =>
        /^[a-f0-9]{64}$/.test(artifact.sha256),
      ),
    );
    assert.deepEqual(parseContextPack(pack), pack);
  }
  assert.equal(packs[0].userInstructions, "operator supplement");
});

test("context packs redact role inputs and strict parsers reject unknown fields", async () => {
  const { workspace } = await setupFake();
  await writeFile(
    path.join(workspace, ".cbx.json"),
    JSON.stringify({ governance: { redactPatterns: ["SECRET-[A-Z]+"] } }),
    "utf8",
  );
  const job = await createJob({
    workspace,
    task: "secret context",
    taskContract: { goal: "use SECRET-TOKEN", acceptanceCriteria: ["safe"] },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 2 },
    jobId: "context-pack-redaction",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  assert.equal(
    (await executeJob(workspace, job.jobId, "instruction SECRET-INPUT")).status,
    "done",
  );
  for (const role of ["manager", "executor", "auditor"])
    assert.doesNotMatch(
      await readArtifact(workspace, job.jobId, `${role}-context.json`),
      /SECRET-/,
    );
  assert.throws(
    () =>
      parseContextPack({
        version: 1,
        projection: true,
        role: "manager",
        taskContract: null,
        verifiedProgress: null,
        audit: null,
        recentFailure: null,
        userInstructions: "",
        artifacts: [],
        current: { round: 1, maxRounds: 2, remainingRounds: 1 },
        history: [],
      }),
    /不支持字段/,
  );
  const gate = createHumanGate("needs_input", { questions: ["answer?"] });
  assert.equal(
    resolveHumanGate(gate, "safe", (value) => value).status,
    "resolved",
  );
  assert.throws(() => parseHumanGate({ ...gate, unknown: true }), /不支持字段/);
  assert.throws(() => extendRoundLimit(100, 1), /不能超过 100/);
});

test("adaptive done without evidence is blocked by the existing completion gate", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "done";
  const job = await createAdaptiveJob(workspace, "adaptive-no-evidence");
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
  assert.equal(state.adaptiveRound, 1);
});

test("adaptive done cannot bypass the completion gate through a dormant static skipReview stage", async () => {
  const { workspace } = await setupFake();
  process.env.FAKE_MANAGER_ACTIONS = "done";
  const job = await createJob({
    workspace,
    task: "adaptive dormant stage",
    taskContract: {
      goal: "adaptive goal",
      acceptanceCriteria: ["adaptive criterion"],
      stages: [
        {
          name: "dormant",
          executor: "codebuddy",
          task: "not executed",
          skipReview: true,
        },
      ],
    },
    testCommand: 'node -e "process.exit(0)"',
    review: true,
    isolated: false,
    permissionMode: "auto",
    maxTurns: 10,
    timeoutMs: 2_000,
    maxRetries: 0,
    adaptive: { enabled: true, maxRounds: 1 },
    jobId: "adaptive-dormant-skip-review",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  const state = await executeJob(workspace, job.jobId);
  assert.equal(state.status, "needs_fix");
  assert.equal(state.phase, "verification_gate");
});

test("adaptive ask and blocked decisions map to explicit needs_fix phases", async () => {
  for (const [action, phase, field] of [
    ["ask", "adaptive_ask", "blockingQuestions"],
    ["blocked", "adaptive_blocked", "blockedReason"],
  ] as const) {
    const { workspace } = await setupFake();
    process.env.FAKE_MANAGER_ACTIONS = action;
    const job = await createAdaptiveJob(workspace, `adaptive-${action}`);
    process.env.FAKE_JOB_DIR = job.directory;
    const state = await executeJob(workspace, job.jobId);
    assert.equal(state.status, "needs_fix");
    assert.equal(state.phase, phase);
    assert.ok(state[field]);
    assert.equal(
      (state.humanGate as { reason: string; status: string }).reason,
      "needs_input",
    );
    assert.equal((state.humanGate as { status: string }).status, "waiting");
  }
});

test("adaptive manager rejects invalid decisions and worktree mutation", async () => {
  for (const [action, status, phase] of [
    ["invalid", "needs_fix", "adaptive_manager_decision"],
    ["mutate", "failed", "adaptive_manager_safety"],
  ] as const) {
    const { workspace } = await setupFake();
    process.env.FAKE_MANAGER_ACTIONS = action;
    if (action === "mutate")
      spawnSync("git", ["init", "-b", "main"], {
        cwd: workspace,
        encoding: "utf8",
      });
    const job = await createAdaptiveJob(workspace, `adaptive-${action}`);
    process.env.FAKE_JOB_DIR = job.directory;
    const state = await executeJob(workspace, job.jobId);
    assert.equal(state.status, status);
    assert.equal(state.phase, phase);
    await assert.rejects(
      () =>
        readArtifact(workspace, job.jobId, "manager-decision-candidate.json"),
      /不允许读取/,
    );
  }
});
