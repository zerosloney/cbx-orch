import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTaskContract,
  validateStageDependencies,
} from "../src/validation.js";
import { groupStagesByDependency } from "../src/execution.js";
import type { TaskStage } from "../src/validation.js";

function stage(name: string, deps?: string[]): TaskStage {
  return { name, executor: "codebuddy", task: `do ${name}`, dependsOn: deps };
}

// ---- groupStagesByDependency：按依赖分层 ----

test("groupStagesByDependency: single stage returns single layer", () => {
  const layers = groupStagesByDependency([stage("only")]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].length, 1);
});

test("groupStagesByDependency: no dependencies returns single flat layer", () => {
  const layers = groupStagesByDependency([stage("a"), stage("b"), stage("c")]);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].length, 3);
});

test("groupStagesByDependency: linear chain produces separate layers", () => {
  // a → b → c
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b", ["a"]),
    stage("c", ["b"]),
  ]);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers.map((l) => l.map((s) => s.name)),
    [["a"], ["b"], ["c"]],
  );
});

test("groupStagesByDependency: diamond dependency groups parallel stages", () => {
  // a → (b, c parallel) → d
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b", ["a"]),
    stage("c", ["a"]),
    stage("d", ["b", "c"]),
  ]);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers[0].map((s) => s.name),
    ["a"],
  );
  // b and c in same layer (order may vary)
  const layer1Names = layers[1].map((s) => s.name).sort();
  assert.deepEqual(layer1Names, ["b", "c"]);
  assert.deepEqual(
    layers[2].map((s) => s.name),
    ["d"],
  );
});

test("groupStagesByDependency: multiple independent roots in layer 0", () => {
  // a, b independent; c depends on both
  const layers = groupStagesByDependency([
    stage("a"),
    stage("b"),
    stage("c", ["a", "b"]),
  ]);
  assert.equal(layers.length, 2);
  const layer0 = layers[0].map((s) => s.name).sort();
  assert.deepEqual(layer0, ["a", "b"]);
  assert.deepEqual(
    layers[1].map((s) => s.name),
    ["c"],
  );
});

// ---- validateStageDependencies：悬空与循环依赖 ----

test("validateStageDependencies: accepts valid DAG", () => {
  assert.doesNotThrow(() =>
    validateStageDependencies([stage("a"), stage("b", ["a"])]),
  );
});

test("validateStageDependencies: rejects dangling dependency", () => {
  assert.throws(
    () => validateStageDependencies([stage("a", ["nonexistent"])]),
    /依赖不存在的 stage/,
  );
});

test("validateStageDependencies: rejects self-dependency via normalizeTaskContract", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: ["a"] }],
      }),
    /不能依赖自身/,
  );
});

test("validateStageDependencies: rejects simple cycle A→B→A", () => {
  assert.throws(
    () => validateStageDependencies([stage("a", ["b"]), stage("b", ["a"])]),
    /循环依赖/,
  );
});

test("validateStageDependencies: rejects longer cycle A→B→C→A", () => {
  assert.throws(
    () =>
      validateStageDependencies([
        stage("a", ["c"]),
        stage("b", ["a"]),
        stage("c", ["b"]),
      ]),
    /循环依赖/,
  );
});

test("validateStageDependencies: accepts diamond (no cycle)", () => {
  assert.doesNotThrow(() =>
    validateStageDependencies([
      stage("a"),
      stage("b", ["a"]),
      stage("c", ["a"]),
      stage("d", ["b", "c"]),
    ]),
  );
});

// ---- normalizeTaskContract 集成：dependsOn 透传 ----

test("normalizeTaskContract: preserves dependsOn field", () => {
  const result = normalizeTaskContract({
    stages: [
      { name: "a", executor: "e", task: "t" },
      { name: "b", executor: "e", task: "t", dependsOn: ["a"] },
    ],
  });
  assert.deepEqual(result?.stages?.[1].dependsOn, ["a"]);
});

test("normalizeTaskContract: deduplicates dependsOn entries", () => {
  const result = normalizeTaskContract({
    stages: [
      { name: "a", executor: "e", task: "t" },
      { name: "b", executor: "e", task: "t", dependsOn: ["a", "a", "a"] },
    ],
  });
  assert.deepEqual(result?.stages?.[1].dependsOn, ["a"]);
});

test("normalizeTaskContract: rejects empty dependsOn array", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: [] }],
      }),
    /dependsOn 必须是非空字符串数组/,
  );
});

test("normalizeTaskContract: rejects non-string dependsOn element", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", dependsOn: [123] }],
      } as unknown as Parameters<typeof normalizeTaskContract>[0]),
    /dependsOn 必须是非空字符串数组/,
  );
});

test("normalizeTaskContract: rejects unknown stage field", () => {
  assert.throws(
    () =>
      normalizeTaskContract({
        stages: [{ name: "a", executor: "e", task: "t", bogus: true }],
      } as unknown as Parameters<typeof normalizeTaskContract>[0]),
    /不支持字段/,
  );
});

test("createJob: adaptive + dependsOn 组合被显式拒绝", async () => {
  // adaptive 循环由 manager 每轮自选 stage，dependsOn 会被静默忽略；
  // 显式拒绝优于接受语义错误的配置（静默忽略会让失败传播/handback 聚合缺失）。
  const { createJob } = await import("../src/core.js");
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cbx-adaptive-dep-"));
  await assert.rejects(
    createJob({
      workspace,
      task: "adaptive with deps",
      review: true,
      isolated: false,
      permissionMode: "auto",
      maxTurns: 5,
      jobId: "adaptive-dep",
      adaptive: { enabled: true, maxRounds: 4 },
      taskContract: {
        goal: "g",
        stages: [
          stage("a"),
          { name: "b", executor: "codebuddy", task: "t", dependsOn: ["a"] },
        ],
      },
    } as Parameters<typeof createJob>[0]),
    /暂不支持.*dependsOn/,
  );
});
