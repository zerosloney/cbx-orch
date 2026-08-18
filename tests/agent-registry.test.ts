import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agentDirs,
  buildArgsFromSpec,
  collectAgents,
  discoverAgents,
  probeAgents,
  resolveRegisteredExecutor,
  validateAgentSpec,
} from "../src/agent-registry.js";
import { resolveExecutor } from "../src/executors/builtin.js";
import { createJob, executeJob, setupFake } from "./helpers.js";

const VALID_SPEC = {
  name: "gemini",
  aliases: ["gca"],
  label: "Gemini CLI",
  candidates: ["gemini"],
  args: ["-p", "{prompt}", "--output-format", "json"],
  autoArgs: ["--yolo"],
  planArgs: ["--approval-mode", "plan"],
  maxTurnsArg: "--max-turns",
};

test("validateAgentSpec accepts a full spec and derives envVar from name", () => {
  const spec = validateAgentSpec(VALID_SPEC, "gemini.json");
  assert.equal(spec.name, "gemini");
  assert.equal(spec.envVar, "CBX_GEMINI");
  assert.deepEqual(spec.aliases, ["gca"]);
});

test("validateAgentSpec rejects malformed specs with file context", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /必须是 JSON 对象/],
    [{ ...VALID_SPEC, name: "Gemini" }, /name 必须匹配/],
    [{ ...VALID_SPEC, name: "qwen" , label: undefined }, /label 不能为空/],
    [{ ...VALID_SPEC, candidates: [] }, /candidates 必须是非空字符串数组/],
    [{ ...VALID_SPEC, args: ["-p", 5] }, /args 必须是字符串数组/],
    [{ ...VALID_SPEC, aliases: ["ok", 3] }, /aliases 必须是字符串数组/],
    [{ ...VALID_SPEC, envVar: "cbx-gemini" }, /envVar 必须匹配/],
    [{ ...VALID_SPEC, autoArgs: "--yolo" }, /autoArgs 必须是字符串数组/],
    [{ ...VALID_SPEC, maxTurnsArg: 5 }, /maxTurnsArg 必须是字符串/],
    [{ ...VALID_SPEC, version: 2 }, /version 必须是字符串/],
  ];
  for (const [raw, pattern] of cases)
    assert.throws(() => validateAgentSpec(raw, "spec.json"), pattern);
});

test("buildArgsFromSpec renders placeholders and appends mode/turn flags", () => {
  const spec = validateAgentSpec(VALID_SPEC, "gemini.json");
  assert.deepEqual(
    buildArgsFromSpec(spec, { prompt: "hi", permissionMode: "default", maxTurns: 7 }),
    ["-p", "hi", "--output-format", "json", "--max-turns", "7"],
  );
  assert.deepEqual(
    buildArgsFromSpec(spec, { prompt: "hi", permissionMode: "auto", maxTurns: 7 }),
    ["-p", "hi", "--output-format", "json", "--max-turns", "7", "--yolo"],
  );
  assert.deepEqual(
    buildArgsFromSpec(spec, { prompt: "hi", permissionMode: "dontAsk", maxTurns: 7 }),
    ["-p", "hi", "--output-format", "json", "--max-turns", "7", "--yolo"],
  );
  assert.deepEqual(
    buildArgsFromSpec(spec, { prompt: "hi", permissionMode: "plan", maxTurns: 7 }),
    ["-p", "hi", "--output-format", "json", "--max-turns", "7", "--approval-mode", "plan"],
  );
  const minimal = validateAgentSpec(
    { name: "plain", label: "Plain", candidates: ["plain-cli"], args: ["run", "{prompt}"] },
    "plain.json",
  );
  assert.deepEqual(
    buildArgsFromSpec(minimal, { prompt: "go", permissionMode: "auto", maxTurns: 3 }),
    ["run", "go"],
  );
});

async function tempWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "cbx-agents-"));
}

async function writeSpec(workspace: string, file: string, raw: unknown): Promise<void> {
  await mkdir(agentDirs(workspace).workspace, { recursive: true });
  await writeFile(
    path.join(agentDirs(workspace).workspace, file),
    JSON.stringify(raw),
    "utf8",
  );
}

test("collectAgents discovers workspace specs and keeps builtins non-overridable", async () => {
  const workspace = await tempWorkspace();
  await writeSpec(workspace, "gemini.json", VALID_SPEC);
  await writeSpec(workspace, "bad.json", { name: "no-label" });
  await writeSpec(workspace, "conflict.json", { ...VALID_SPEC, name: "qwen", label: "Qwen" });

  const { agents, errors } = await collectAgents(workspace);
  const names = agents.map((a) => a.spec.name);
  assert.ok(names.includes("gemini"));
  assert.ok(names.includes("codebuddy"));
  assert.equal(agents.filter((a) => a.spec.name === "gemini")[0].source, "workspace");
  // 与内置同名的 spec 被拒绝而非覆盖
  assert.ok(!names.includes("qwen") || resolveExecutor("qwen") !== undefined);
  assert.equal(agents.filter((a) => a.spec.name === "qwen" && a.source === "workspace").length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes("bad.json")));
  assert.ok(errors.some((e) => e.includes("conflict.json") && e.includes("qwen")));
});

test("resolveRegisteredExecutor resolves specs by name/alias and falls back to undefined", async () => {
  const workspace = await tempWorkspace();
  await writeSpec(workspace, "gemini.json", VALID_SPEC);
  assert.equal((await resolveRegisteredExecutor("gemini", workspace))?.name, "gemini");
  assert.equal((await resolveRegisteredExecutor("gca", workspace))?.name, "gemini");
  assert.equal((await resolveRegisteredExecutor("codebuddy", workspace))?.name, "codebuddy");
  assert.equal(await resolveRegisteredExecutor("nonexistent", workspace), undefined);
});

test("probeAgents reports availability via envVar override and missing binaries", async () => {
  const workspace = await tempWorkspace();
  await writeSpec(workspace, "gemini.json", VALID_SPEC);
  await writeSpec(workspace, "ghost.json", {
    name: "ghost",
    label: "Ghost CLI",
    candidates: ["cbx-ghost-missing-cli-xyz"],
    args: ["run", "{prompt}"],
  });
  const script = path.join(workspace, "fake-agent.mjs");
  await writeFile(script, "process.exit(0);\n", "utf8");
  const previous = process.env.CBX_GEMINI;
  process.env.CBX_GEMINI = script;
  const previousGhost = process.env.CBX_GHOST;
  delete process.env.CBX_GHOST;
  try {
    const { agents } = await collectAgents(workspace);
    const probes = await probeAgents(agents);
    const gemini = probes.find((p) => p.name === "gemini");
    assert.ok(gemini?.available);
    assert.deepEqual(gemini?.command, [process.execPath, script]);
    const ghost = probes.find((p) => p.name === "ghost");
    assert.ok(!ghost?.available);
    assert.ok(ghost?.error?.includes("Ghost CLI"));
    const discovered = await discoverAgents(workspace);
    assert.equal(discovered.probes.length, agents.length);
  } finally {
    if (previous === undefined) delete process.env.CBX_GEMINI;
    else process.env.CBX_GEMINI = previous;
    if (previousGhost !== undefined) process.env.CBX_GHOST = previousGhost;
  }
});

test("probeAgents flags env override pointing to a nonexistent path", async () => {
  const workspace = await tempWorkspace();
  await writeSpec(workspace, "ghost.json", {
    name: "ghost",
    label: "Ghost CLI",
    candidates: ["cbx-ghost-missing-cli-xyz"],
    args: ["run", "{prompt}"],
  });
  const previous = process.env.CBX_GHOST;
  process.env.CBX_GHOST = path.join(workspace, "no-such-file.mjs");
  try {
    const { agents } = await collectAgents(workspace);
    const ghost = (await probeAgents(agents)).find((p) => p.name === "ghost");
    assert.ok(!ghost?.available);
    assert.ok(ghost?.error?.includes("CBX_GHOST"));
  } finally {
    if (previous === undefined) delete process.env.CBX_GHOST;
    else process.env.CBX_GHOST = previous;
  }
});

test("file-registered executor executes a full job end to end", async () => {
  const { workspace, script } = await setupFake();
  // 把测试用的 fake 执行器注册为文件 spec，证明新链路（spec 发现 → runner 接线 → spawn）可用。
  await writeSpec(workspace, "fakecli.json", {
    name: "fakecli",
    label: "Fake CLI",
    candidates: ["fakecli"],
    args: ["run", "{prompt}"],
  });
  process.env.CBX_FAKECLI = script;
  const job = await createJob({
    workspace,
    task: "spec 注册执行器冒烟",
    review: false,
    isolated: false,
    executor: "fakecli",
    permissionMode: "auto",
    maxTurns: 5,
    timeoutMs: 30_000,
    maxRetries: 0,
    jobId: "spec-executor-smoke",
  });
  process.env.FAKE_JOB_DIR = job.directory;
  try {
    const result = await executeJob(workspace, job.jobId);
    assert.equal(result.status, "done");
    const { agents } = await collectAgents(workspace);
    assert.ok(agents.some((a) => a.spec.name === "fakecli" && a.source === "workspace"));
  } finally {
    delete process.env.CBX_FAKECLI;
  }
});
